/**
 * Benchmark of the CPU simulator on the real frog: ms per physics step standing free, in the naenae as the page plays
 * it, in a hard synthetic swing, a poke and a throw, split by phase (each block's beforeStep / afterStep, the Rapier
 * step, the core's own work), with the robustness numbers of each phase.
 *
 *   SIM_BENCH=1 npx vitest run src/sim/perf.test.ts
 *
 * SIM_AB='[{"name":"a","settings":{}},{"name":"b","settings":{"iterations":1}}]' builds several variants and steps
 * them in lockstep, frame by frame, so they share whatever else the machine is doing (timings on a laptop drift by 2x
 * within minutes; side by side they compare).
 */
import fs from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, it } from "vitest";
import type { BoneName, PhysicsParams, RigSpec } from "../contracts";
import { parseModel } from "../character/asset";
import { createCharacter } from "../character/character";
import { DEFAULT_RETARGETER, registerBuiltins as registerMotion } from "../motion/blocks";
import { createRetargetPipeline } from "../motion/core";
import { bindRig } from "../motion/rig";
import { recordingOf, TrackPlayer, type Track } from "../motion/track";
import { createFrogSim, initPhysics, type LabFrogSim } from ".";
import { untextured } from "./testModel";

const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
const GLB = new URL("../../public/models/naiwa.glb", import.meta.url);
const position = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
const round = (v: number, d = 3) => Number(v.toFixed(d));

/** A hard dance-like pose at time t: the hips bob and sway, the torso bends and twists, the arms swing wide and into
 *  the belly, the legs step. */
function swing(spec: RigSpec, t: number, out: Map<BoneName, THREE.Matrix4>) {
  const rest = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
  const w = 2 * Math.PI * 1.1;
  const turn: Partial<Record<BoneName, THREE.Euler>> = {
    spine: new THREE.Euler(0.25 * Math.sin(w * t), 0.2 * Math.sin(0.5 * w * t), 0.15 * Math.cos(w * t)),
    chest: new THREE.Euler(0.2 * Math.sin(w * t + 0.5), 0, 0.1 * Math.sin(w * t)),
    head: new THREE.Euler(0.2 * Math.sin(2 * w * t), 0.3 * Math.sin(w * t), 0),
    upperarm_L: new THREE.Euler(1.2 * Math.sin(w * t), 0, 0.8 * Math.cos(w * t)),
    upperarm_R: new THREE.Euler(-1.2 * Math.sin(w * t), 0, -0.8 * Math.cos(w * t)),
    forearm_L: new THREE.Euler(0.9 + 0.8 * Math.sin(2 * w * t), 0, 0),
    forearm_R: new THREE.Euler(0.9 - 0.8 * Math.sin(2 * w * t), 0, 0),
    thigh_L: new THREE.Euler(0.4 * Math.max(0, Math.sin(w * t)), 0, 0),
    thigh_R: new THREE.Euler(0.4 * Math.max(0, -Math.sin(w * t)), 0, 0),
    shin_L: new THREE.Euler(-0.5 * Math.max(0, Math.sin(w * t)), 0, 0),
    shin_R: new THREE.Euler(-0.5 * Math.max(0, -Math.sin(w * t)), 0, 0),
  };
  const lift = new THREE.Matrix4().makeTranslation(0.04 * Math.sin(w * t), 0.03 * Math.abs(Math.sin(w * t)), 0);
  for (const b of spec.bones) {
    const local = b.parent ? rest.get(b.parent)!.clone().invert().multiply(b.restWorld) : b.restWorld.clone();
    const e = turn[b.name];
    if (e) local.multiply(new THREE.Matrix4().makeRotationFromEuler(e));
    const parent = b.parent ? out.get(b.parent) : null;
    const m = out.get(b.name) ?? new THREE.Matrix4();
    out.set(b.name, parent ? m.multiplyMatrices(parent, local) : m.multiplyMatrices(lift, local));
  }
}

interface Variant {
  name: string;
  settings?: Record<string, number | string | boolean>;
  /** JS run on the built sim (sim, RAPIER), for experiments. */
  exp?: string;
  /** Set as globalThis.__simExp while the variant is built (switches for experiments). */
  pre?: Record<string, unknown>;
}

/** One variant under test: its sim, its timers, its probes. */
class Bench {
  readonly times = new Map<string, number>();
  total = 0;
  steps = 0;
  private bones = new Map<BoneName, THREE.Matrix4>();
  private limbs = new Map<string, Float32Array>();
  worst = { volume: 0, inverted: 0, deviation: 0, penetration: 0 };
  /** Worst inverted cells per part. */
  invertedBy: Record<string, number> = {};
  /** Events the sim emitted (land, squish, ball…). */
  events: Record<string, number> = {};
  top = 0;

  constructor(readonly name: string, readonly sim: LabFrogSim, private spec: RigSpec) {
    // Time every block's beforeStep / afterStep and the Rapier step.
    const core = sim as unknown as { order: Record<string, unknown>[]; blocks: Record<string, unknown> };
    const slotOf = new Map<unknown, string>(Object.entries(core.blocks).map(([slot, b]) => [b, slot]));
    const timed = (key: string, f: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
      const t0 = performance.now();
      const r = f(...a);
      this.times.set(key, (this.times.get(key) ?? 0) + performance.now() - t0);
      return r;
    };
    for (const b of core.order) {
      for (const m of ["beforeStep", "afterStep"]) {
        const f = b[m] as ((...a: unknown[]) => unknown) | undefined;
        if (f) b[m] = timed(`${slotOf.get(b)}.${m}`, f.bind(b));
      }
    }
    const world = sim.scene.world;
    world.step = timed("world.step", world.step.bind(world) as (...a: unknown[]) => unknown) as typeof world.step;
  }

  /** One page frame: the step, then the reads the page does. */
  frame(k: number) {
    const t0 = performance.now();
    this.sim.step(1 / 60);
    this.sim.readBones(this.bones);
    this.sim.readLimbs(this.limbs);
    this.sim.readBody();
    this.total += performance.now() - t0;
    this.steps++;
    this.top = Math.max(this.top, position(this.bones.get("hips")!).y);
    if (k % 30 === 29) {
      const s = this.sim.stats();
      this.worst.volume = Math.max(this.worst.volume, Math.abs(s.volume!.body - 1));
      this.worst.inverted = Math.max(this.worst.inverted, s.invertedCells!);
      this.worst.deviation = Math.max(this.worst.deviation, s.deviation!);
      this.worst.penetration = Math.max(this.worst.penetration, s.penetration!);
      for (const part of this.sim.scene.parts) {
        const n = invertedCells(this.sim, part);
        if (n) this.invertedBy[part.name] = Math.max(this.invertedBy[part.name] ?? 0, n);
      }
    }
  }

  report(label: string) {
    const n = this.steps;
    const rows = [...this.times].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / n).toFixed(3)}`);
    const other = this.total - [...this.times.values()].reduce((a, b) => a + b, 0);
    const w = this.worst;
    console.log(
      `${this.name.padEnd(12)} ${label.padEnd(10)} ${(this.total / n).toFixed(2)} ms/frame | ${rows.join(" | ")} | core+reads ${(other / n).toFixed(3)}` +
      ` || worst volume ${round(w.volume)} inverted ${w.inverted} ${JSON.stringify(this.invertedBy)} deviation ${round(w.deviation, 4)}` +
      ` penetration ${round(w.penetration, 4)}`,
    );
    this.times.clear();
    this.total = this.steps = 0;
    this.worst = { volume: 0, inverted: 0, deviation: 0, penetration: 0 };
    this.invertedBy = {};
  }

  /** Head height (of rest), lean (deg) and drift (m) of the hips, jitter, inverted cells. */
  probe(label: string) {
    const rest = new Map(this.spec.bones.map((b) => [b.name, b.restWorld]));
    this.sim.readBones(this.bones);
    const hips = this.bones.get("hips")!;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(hips)
      .multiply(new THREE.Quaternion().setFromRotationMatrix(rest.get("hips")!).invert()));
    const s = this.sim.stats();
    console.log(`${this.name.padEnd(12)} ${label}:`, JSON.stringify({
      head: round(position(this.bones.get("head")!).y / position(rest.get("head")!).y),
      lean: round(THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0))), 1),
      drift: round(position(hips).setY(0).distanceTo(position(rest.get("hips")!).setY(0))),
      jitter: round(s.jitter!, 5), inverted: s.invertedCells, volume: round(s.volume!.body), top: round(this.top, 2),
    }));
  }
}

/** Cells of a part turned inside out. */
function invertedCells(sim: LabFrogSim, part: LabFrogSim["scene"]["parts"][number]): number {
  const cells = sim.scene.flesh.cells?.(part);
  if (!cells) return 0;
  const view = sim.scene.flesh.particles(part), P = view.positions(), R = view.rest;
  const vol = (X: Float32Array, c: number) => {
    const a = cells[c] * 3, b = cells[c + 1] * 3, d = cells[c + 2] * 3, e = cells[c + 3] * 3;
    const u = [X[b] - X[a], X[b + 1] - X[a + 1], X[b + 2] - X[a + 2]], v = [X[d] - X[a], X[d + 1] - X[a + 1], X[d + 2] - X[a + 2]];
    const w = [X[e] - X[a], X[e + 1] - X[a + 1], X[e + 2] - X[a + 2]];
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  let n = 0;
  for (let c = 0; c < cells.length; c += 4) if (vol(R, c) * vol(P, c) < 0) n++;
  return n;
}

let character: ReturnType<typeof createCharacter> | null = null;
beforeAll(async () => {
  await initPhysics();
  if (fs.existsSync(GLB)) character = createCharacter(await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb"), "glb", "models/naiwa.glb");
}, 60000);

describe.skipIf(!process.env.SIM_BENCH || !fs.existsSync(GLB))("benchmark, the real frog", () => {
  it("free standing, the naenae, a hard swing, a poke and a throw: ms per frame", async () => {
    const spec = character!.spec;
    const RAPIER = (await import("@dimforge/rapier3d-compat")).default;
    const variants: Variant[] = JSON.parse(process.env.SIM_AB ?? '[{"name":"default"}]');
    const benches: Bench[] = [];
    for (const v of variants) {
      const t0 = performance.now();
      (globalThis as { __simExp?: unknown }).__simExp = v.pre;
      const sim = createFrogSim(spec, PARAMS, { id: "cpu-constraints", settings: v.settings ?? {} });
      await sim.ready;
      delete (globalThis as { __simExp?: unknown }).__simExp;
      if (v.exp) new Function("sim", "RAPIER", v.exp)(sim, RAPIER);
      const s = sim.stats();
      console.log(`${v.name}: built in ${(performance.now() - t0).toFixed(0)} ms, ${s.particles} particles, ${s.cells} cells`);
      const bench = new Bench(v.name, sim, spec);
      sim.onEvent((e) => (bench.events[e.kind] = (bench.events[e.kind] ?? 0) + 1));
      benches.push(bench);
    }
    /** n frames on every variant in lockstep; before(sim, k) sets the inputs of frame k. */
    const phase = (label: string, n: number, before?: (sim: LabFrogSim, k: number) => void) => {
      for (let k = 0; k < n; k++) {
        for (const b of benches) {
          before?.(b.sim, k);
          b.frame(k);
        }
      }
      for (const b of benches) b.report(label);
    };

    for (const b of benches) b.sim.setMode("free");
    phase("free 0-2s", 120);
    for (const b of benches) b.probe("free 2 s");
    phase("free 2-10s", 480);
    for (const b of benches) b.probe("free 10 s");
    if (process.env.SIM_LONG) {
      phase("free 10-30s", 1200);
      for (const b of benches) b.probe("free 30 s");
    }

    // The naenae as the page plays it (track -> retargeter -> the character's targets).
    const track = JSON.parse(fs.readFileSync("public/dances/naenae.json", "utf8")) as Track;
    registerMotion();
    const pipeline = createRetargetPipeline(bindRig(character!.rig), { id: DEFAULT_RETARGETER, settings: {} }, recordingOf(track));
    const player = new TrackPlayer(track, () => pipeline);
    const targets = new Map<BoneName, THREE.Matrix4>();
    for (const b of benches) b.sim.setMode("driven");
    const inspector = process.env.SIM_PROF ? new (await import("node:inspector")).Session() : null;
    const post = (m: string) => new Promise<any>((ok, no) => inspector!.post(m, {}, (e: unknown, r: unknown) => (e ? no(e) : ok(r))));
    if (inspector) {
      inspector.connect();
      await post("Profiler.enable");
      await post("Profiler.start");
    }
    phase("naenae", 600, (sim, k) => {
      if (sim === benches[0].sim) {
        const goal = player.goal((k / 60) % track.duration, 1 / 60, false);
        character!.targetsFromPose(goal && pipeline.pose(goal, 1 / 60), targets);
      }
      sim.setTargets(targets);
    });
    if (inspector) fs.writeFileSync(process.env.SIM_PROF!, JSON.stringify((await post("Profiler.stop")).profile));
    for (const b of benches) b.probe("naenae end");
    phase("swing", 300, (sim, k) => {
      if (sim === benches[0].sim) swing(spec, k / 60, targets);
      sim.setTargets(targets);
    });

    // Back to free; a poke on the belly, then a throw up and forward: it should land and right itself.
    for (const b of benches) b.sim.setMode("free");
    phase("settle", 180);
    for (const b of benches) {
      const hit = b.sim.raycast(new THREE.Ray(new THREE.Vector3(0, 0.45, 2), new THREE.Vector3(0, 0, -1)));
      if (hit) b.sim.poke(hit, 1, new THREE.Vector3(0, 0, -1));
    }
    phase("poke", 60);
    const grabs = benches.map((b) => {
      const hit = b.sim.raycast(new THREE.Ray(new THREE.Vector3(0, 0.5, 2), new THREE.Vector3(0, 0, -1)));
      return hit ? { hit, g: b.sim.grab(hit) } : null;
    });
    phase("grab", 10, (sim, k) => {
      const g = grabs[benches.findIndex((b) => b.sim === sim)];
      g?.g.move(g.hit.point.clone().add(new THREE.Vector3(0, 0.03 * k, 0.02 * k)));
    });
    for (const g of grabs) g?.g.release(new THREE.Vector3(0, 4, 2));
    for (const b of benches) b.top = 0;
    phase("throw", 300);
    for (const b of benches) b.probe("thrown, 5 s later");
    for (const b of benches) {
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) b.sim.stats();
      console.log(`${b.name}: stats() ${((performance.now() - t0) / 20).toFixed(2)} ms, events ${JSON.stringify(b.events)}`);
      b.sim.dispose();
    }
  }, 600000);
});
