/**
 * Flesh block "mpm-flesh": every part of the frog as neo-Hookean material points (MLS-MPM), on WebGPU when there is a
 * usable GPU, else on CPU workers: the same algorithm, two backends (mpm/kernels.ts, mpm/shaders.ts).
 *
 * Coupling with the bones is two-way. A particle attached to a bone (by the coupling block, through ParticleView)
 * becomes part of that rigid body: its mass and inertia are added to the body's, and on the grid it is a moving
 * boundary the free flesh pushes and pulls on; the impulses the free flesh gives it go back to the body.
 * Contacts are resolved on the grid (floor, the limbs' flesh as capsules, balls; the balls and limbs feel them too),
 * so this block covers the collision slot. The rendered surface is embedded in the particles.
 *
 * Latency: after the bones step, the flesh's frame over that step is submitted; before the next step its results
 * are read (the GPU works while the page renders, the CPU workers likewise) and its impulses go to the bones within
 * that step. So positions() and surface() are those of the step before (16 ms), the GPU's sometimes two when its
 * readback is late, and the bones feel the flesh one step late.
 */
import type RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsParams, SimParameter } from "../../contracts";
import type { BlockDefinition, FleshBlock, ParticleView, Scene, Settings, SimPart } from "../api";
import { backendLabel, chooseBackend, deviceProbe, unavailableReason, type BackendKind } from "./device";
import type { MpmBackend } from "./mpm/backend";
import { CarriedMass } from "./mpm/carriedMass";
import { CpuBackend } from "./mpm/cpu/cpuBackend";
import { FrameBuilder } from "./mpm/frame";
import { GpuBackend } from "./mpm/gpuBackend";
import type { FrameOutput } from "./mpm/layout";
import { lame, regionFactors, stiffnessScale, substepsFor, viscosityScale, type MaterialSettings } from "./mpm/material";
import { MpmModel, type PartModel } from "./mpm/model";

/** One part's particles as the other blocks see them. */
class PartView implements ParticleView {
  readonly count: number;
  readonly rest: Float32Array;
  private xyz: Float32Array;
  private version = -1;

  constructor(private flesh: MpmFlesh, readonly pm: PartModel) {
    this.count = pm.count;
    this.rest = pm.rest;
    this.xyz = pm.rest.slice();
  }

  /** Back to rest until the next results arrive. */
  reset() {
    this.xyz.set(this.rest);
    this.version = -1;
  }

  positions() {
    const out = this.flesh.output;
    if (out && this.version !== this.flesh.version) {
      this.version = this.flesh.version;
      const P = out.positions, f = this.pm.first;
      for (let i = 0; i < this.count; i++) {
        this.xyz[i * 3] = P[(f + i) * 4];
        this.xyz[i * 3 + 1] = P[(f + i) * 4 + 1];
        this.xyz[i * 3 + 2] = P[(f + i) * 4 + 2];
      }
    }
    return this.xyz;
  }
  mass() {
    return this.flesh.model.particleMass;
  }
  applyImpulse(i: number, x: number, y: number, z: number) {
    const m = this.flesh.model.particleMass;
    this.flesh.frame.addVelocity(this.pm.first + i, x / m, y / m, z / m);
  }
  setPosition(i: number, x: number, y: number, z: number) {
    this.flesh.frame.setPosition(this.pm.first + i, x, y, z);
  }
  setVelocity(i: number, x: number, y: number, z: number) {
    this.flesh.frame.setVelocity(this.pm.first + i, x, y, z);
  }
  attach(i: number, body: RAPIER.RigidBody) {
    this.flesh.attach(this, i, body);
  }
  detach(i: number) {
    this.flesh.detach(this.pm.first + i);
  }
  attachedTo(i: number) {
    return this.flesh.attached.get(this.pm.first + i)?.body ?? null;
  }
}

interface Riding {
  body: RAPIER.RigidBody;
  /** Where it was added to the body's mass, in the body's frame. */
  local: [number, number, number];
  /** Attached since the last frame was submitted (the backend does not know yet). */
  pending: boolean;
}

export class MpmFlesh implements FleshBlock {
  readonly model: MpmModel;
  readonly frame: FrameBuilder;
  readonly attached = new Map<number, Riding>();
  /** The newest results and a counter that changes with them. */
  output: FrameOutput | null = null;
  version = 0;
  /** Page-thread time of the last step (ms: collecting, of which waiting for the workers; building and submitting),
   *  and the device's time for its frame. */
  timing = { collectMs: 0, submitMs: 0, waitMs: 0, deviceMs: 0, substeps: 0 };
  private views = new Map<SimPart, PartView>();
  private carried = new CarriedMass();
  private material: MaterialSettings;
  private params: PhysicsParams;
  private surfaces = new Map<SimPart, { xyz: Float32Array; version: number }>();
  private maxSpeed = 0;

  constructor(private scene: Scene, settings: Readonly<Settings>, model: MpmModel, readonly backend: MpmBackend) {
    this.model = model;
    this.frame = new FrameBuilder(scene.parts, model.particleMass);
    this.material = materialOf(settings);
    this.params = scene.params;
    for (const pm of this.model.parts) this.views.set(pm.part, new PartView(this, pm));
    backend.setState(this.model.initialState());
  }

  get kind(): BackendKind {
    return this.backend.kind;
  }

  particles(part: SimPart): ParticleView {
    const v = this.views.get(part);
    if (!v) throw new Error(`sim/gpu: no flesh for ${part.name}`);
    return v;
  }

  /** Velocities of a part's particles (xyz), for the metrics. */
  velocities(part: SimPart): Float32Array {
    const pm = (this.particles(part) as PartView).pm, out = new Float32Array(pm.count * 3), V = this.output?.velocities;
    if (V) for (let i = 0; i < pm.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = V[(pm.first + i) * 4 + k];
    return out;
  }

  surface(part: SimPart): Float32Array {
    const out = this.output;
    if (!out) return part.positions;
    let s = this.surfaces.get(part);
    if (!s) this.surfaces.set(part, (s = { xyz: new Float32Array(part.positions.length), version: -1 }));
    if (s.version !== this.version) {
      s.version = this.version;
      const first = (this.particles(part) as PartView).pm.vertexFirst, S = out.surface;
      for (let v = 0; v < s.xyz.length / 3; v++) for (let k = 0; k < 3; k++) s.xyz[v * 3 + k] = S[(first + v) * 4 + k];
    }
    return s.xyz;
  }

  volumeRatio(part: SimPart): number {
    const out = this.output;
    if (!out) return 1;
    const pm = (this.particles(part) as PartView).pm;
    let sum = 0;
    for (let i = 0; i < pm.count; i++) sum += out.positions[(pm.first + i) * 4 + 3];
    return sum / pm.count;
  }

  attach(view: PartView, i: number, body: RAPIER.RigidBody) {
    const g = view.pm.first + i;
    if (this.attached.has(g)) this.detach(g);
    const P = view.positions(), t = body.translation(), r = body.rotation();
    const local = new THREE.Vector3(P[i * 3] - t.x, P[i * 3 + 1] - t.y, P[i * 3 + 2] - t.z)
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
    this.carried.add(body, local.x, local.y, local.z, this.model.particleMass);
    this.attached.set(g, { body, local: [local.x, local.y, local.z], pending: true });
    this.frame.attach(g, body, true);
  }

  detach(g: number) {
    const r = this.attached.get(g);
    if (!r) return;
    this.carried.add(r.body, r.local[0], r.local[1], r.local[2], -this.model.particleMass);
    this.attached.delete(g);
    this.frame.detach(g, r.body, !r.pending);
  }

  addVelocity(dv: THREE.Vector3) {
    this.frame.throwAll(dv);
  }

  stats() {
    return { particles: this.model.particles, cells: this.model.nodes, volumeRatio: this.volumeRatio(this.scene.parts[0]) };
  }

  setParams(p: PhysicsParams) {
    this.params = p;
  }

  setSettings(s: Readonly<Settings>) {
    this.material = materialOf(s);
  }

  /** Before the bones step: take the newest results and give the bones (and balls) their impulses, applied within
   *  this step like gravity is. */
  beforeStep(scene: Scene) {
    const t0 = performance.now();
    const out = this.backend.collect();
    this.timing.waitMs = this.backend instanceof CpuBackend ? this.backend.waitMs : 0;
    if (out) {
      this.output = out;
      this.version++;
      this.frame.apply(out, scene);
      if (out.deviceMs !== null) this.timing.deviceMs = out.deviceMs;
      this.maxSpeed = fastest(out.velocities);
    }
    this.timing.collectMs = performance.now() - t0;
  }

  /** After the bones stepped: the flesh's frame over the same step, from where they were to where they are. */
  afterStep(scene: Scene) {
    const t0 = performance.now();
    this.carried.flush();
    this.decideSplats();
    const m = this.model, p = this.params, mat = this.material;
    const regions = regionFactors(p), scale = stiffnessScale(p);
    for (let k = 0; k < regions.length; k++) regions[k] *= scale;
    const substeps = substepsFor(mat, m.dx, scene.dt, Math.max(...regions), viscosityScale(p), this.maxSpeed);
    const { mu, lambda } = lame(mat.youngModulus, mat.poissonRatio);
    const eta = mat.viscosity * viscosityScale(p);
    const grids = m.gridTable(this.centres(), (pm) => ({
      mu, lambda, eta, restScale: pm.part.limb ? 1 : Math.pow(Math.min(2, Math.max(0.5, p.bellySize)), -1 / 3),
    }));
    const input = this.frame.build(scene, substeps, grids, regions, m.nodes, m.particles);
    for (const r of this.attached.values()) r.pending = false;
    this.backend.submit(input);
    this.timing.substeps = substeps;
    this.timing.submitMs = performance.now() - t0;
  }

  /** Attached particles take part in the grid only next to free flesh (the deep ones would only cost time). */
  private decideSplats() {
    const pending = this.frame.pendingAttaches();
    if (!pending.length) return;
    const reach = 2.5 * this.model.dx;
    const cell = (x: number) => Math.floor(x / reach);
    for (const pm of this.model.parts) {
      const mine = pending.filter((g) => g >= pm.first && g < pm.first + pm.count);
      if (!mine.length) continue;
      const free = new Set<string>();
      for (let i = 0; i < pm.count; i++) {
        if (this.attached.has(pm.first + i)) continue;
        free.add(`${cell(pm.rest[i * 3])},${cell(pm.rest[i * 3 + 1])},${cell(pm.rest[i * 3 + 2])}`);
      }
      for (const g of mine) {
        const i = g - pm.first, cx = cell(pm.rest[i * 3]), cy = cell(pm.rest[i * 3 + 1]), cz = cell(pm.rest[i * 3 + 2]);
        let near = false;
        for (let a = -1; a <= 1 && !near; a++) for (let b = -1; b <= 1 && !near; b++) for (let c = -1; c <= 1 && !near; c++) near = free.has(`${cx + a},${cy + b},${cz + c}`);
        this.frame.setSplat(g, near);
      }
    }
  }

  /** Each grid centred on its part's particles (as last read back; the grid's margin covers a frame's motion). */
  private centres(): Float32Array {
    const out = new Float32Array(this.model.parts.length * 3), P = this.output?.positions;
    for (const pm of this.model.parts) {
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < pm.count; i++) {
        const o = (pm.first + i) * 4;
        x += P ? P[o] : pm.rest[i * 3];
        y += P ? P[o + 1] : pm.rest[i * 3 + 1];
        z += P ? P[o + 2] : pm.rest[i * 3 + 2];
      }
      out.set([x / pm.count, y / pm.count, z / pm.count], pm.grid * 3);
    }
    return out;
  }

  reset() {
    this.output = null;
    this.version++;
    this.frame.reset();
    this.backend.setState(this.model.initialState());
    // Everything back at rest, the bones too: the attached particles ride again from their rest places.
    for (const v of this.views.values()) v.reset();
    const keep = [...this.attached];
    for (const [g, r] of keep) {
      r.pending = true;
      this.detach(g);
    }
    for (const [g, r] of keep) {
      const pm = this.model.parts.find((p) => g >= p.first && g < p.first + p.count)!;
      this.attach(this.views.get(pm.part)!, g - pm.first, r.body);
    }
  }

  dispose() {
    this.backend.dispose();
  }
}

function materialOf(s: Readonly<Settings>): MaterialSettings {
  return {
    youngModulus: Number(s.youngModulus) * 1000, poissonRatio: Number(s.poissonRatio), density: Number(s.density),
    viscosity: Number(s.viscosity), minSubsteps: Number(s.substeps),
  };
}

function fastest(V: Float32Array): number {
  let m = 0;
  for (let i = 0; i < V.length; i += 4) m = Math.max(m, V[i] * V[i] + V[i + 1] * V[i + 1] + V[i + 2] * V[i + 2]);
  return Math.sqrt(m);
}

/** Defaults that depend on the backend: the CPU gets a coarser grid to stay interactive. */
function parameters(): SimParameter[] {
  const gpu = deviceProbe() ? chooseBackend() === "webgpu" : false;
  return [
    {
      key: "youngModulus", kind: "number", default: 3, min: 0.5, max: 40, step: 0.5, unit: "kPa",
      label: { zh: "杨氏模量", en: "Young's modulus" },
      help: { zh: "肉的硬度（页面的“软”滑块和分部位软度再乘上去）。", en: "How stiff the flesh is (the softness sliders scale it)." },
    },
    {
      key: "poissonRatio", kind: "number", default: 0.4, min: 0, max: 0.45, step: 0.01,
      label: { zh: "泊松比", en: "Poisson ratio" },
      help: { zh: "越接近 0.5 越不可压缩（也越需要子步）。", en: "Closer to 0.5 is less compressible (and needs more substeps)." },
    },
    {
      key: "density", kind: "number", default: 190, min: 50, max: 1100, step: 10, unit: "kg/m³", rebuild: true,
      label: { zh: "密度", en: "Density" },
    },
    {
      key: "viscosity", kind: "number", default: 6, min: 0, max: 40, step: 1, unit: "Pa·s",
      label: { zh: "黏性", en: "Viscosity" },
      help: { zh: "Kelvin–Voigt 黏性阻尼（“弹”滑块再乘上去）。", en: "Kelvin–Voigt viscous damping (the bounciness slider scales it)." },
    },
    {
      key: "gridCell", kind: "number", default: gpu ? 4 : 5, min: 2, max: 6, step: 0.5, unit: "cm", rebuild: true,
      label: { zh: "网格分辨率（单元边长）", en: "Grid resolution (cell size)" },
      help: { zh: "每个单元 2×2×2 个粒子；越小越细，也越慢。", en: "2×2×2 particles per cell; smaller is finer and slower." },
    },
    {
      key: "substeps", kind: "number", default: 4, min: 1, max: 48, step: 1,
      label: { zh: "最少子步", en: "Min substeps" },
      help: { zh: "每 1/60 秒至少这么多子步；CFL 条件需要时自动加。", en: "At least this many per 1/60 s step; more when the CFL condition needs them." },
    },
  ];
}

export const mpmFlesh: BlockDefinition<"flesh"> = {
  id: "mpm-flesh",
  slot: "flesh",
  name: { zh: "MLS-MPM 软体", en: "MLS-MPM flesh" },
  summary: {
    zh: "物质点法（MLS-MPM）：neo-Hookean 粒子在背景网格上求解，骨头上的肉是双向耦合的运动边界，地面、四肢和球的接触在网格上处理；有 GPU 用 WebGPU，没有就用 CPU 并行。",
    en: "Material point method (MLS-MPM): neo-Hookean particles solved on a background grid, the flesh on the bones a two-way moving boundary, contacts with the floor, limbs and balls on the grid; WebGPU when there is a GPU, CPU workers when not.",
  },
  device: "gpu",
  covers: ["collision"],
  get parameters() {
    return parameters();
  },
  available: unavailableReason,
  backend: backendLabel,
  create: async (scene, settings) => {
    const kind = chooseBackend();
    const model = new MpmModel(scene.parts, Number(settings.gridCell) / 100, Number(settings.density));
    const backend = kind === "webgpu" ? await GpuBackend.create(model)
      : await CpuBackend.create(model, kind === "cpu-parallel" ? deviceProbe()?.cpu.workers ?? 1 : 0);
    return new MpmFlesh(scene, settings, model, backend);
  },
};
