/**
 * What every particle solver of the library shares, so each solver file holds only its own idea.
 *
 * Each part is filled with tetrahedra on a lattice (lattice.ts); its nodes are the particles, kept in plain typed
 * arrays (`Piece`), which implement the ParticleView the built-in coupling, interaction, output and metrics blocks
 * use. A solver only advances the free particles by one step (`PieceSolver.step`). Around it, `ParticleFlesh`:
 *
 *   1. moves the attached particles with their bodies (positions from the body's pose, velocities from the motion);
 *   2. calls the solver, which treats them as fixed and adds the impulse the flesh exerted on them to `reaction`;
 *   3. damps the free flesh's velocity relative to its target (the jiggle decays, moving the frog is not damped);
 *   4. hands each body the reactions of its particles (two-way: the flesh pulls on the bones). The attached particles'
 *      own weight and inertia ride on the body as a mass-only collider (Rapier then treats them implicitly, which
 *      stays stable when the flesh outweighs a bone);
 *   5. lets a piece sleep once its bodies sleep and its free flesh is still.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsParams, SimParameter } from "../../contracts";
import type { BlockDefinition, FleshBlock, ParticleView, Scene, Settings, SimPart } from "../../sim/api";
import { TriMesh } from "../../sim/geometry";
import { nearestBone, particleAttributes } from "../../sim/parts";
import { cellForParticles, embeddedSurface, tetVolume, tetrahedralise, type TetMesh } from "./lattice";
import { symEigen3 } from "./linalg";
import { DENSITY, dampingRate, regionStiffness } from "./material";

/** A ParticleView that also gives its velocities and size (for collision and metrics blocks of the library). */
export interface SimParticles extends ParticleView {
  velocities(): Float32Array;
  /** Half the particle spacing (m): how far a particle stands for the flesh around it. */
  readonly radius: number;
  /** The rendered surface (same vertex order as the part) and how it is embedded: vertex v is Σⱼ weight[4v+j] ×
   *  particle tets[4·tet[v]+j]. */
  surface(): Float32Array;
  readonly mesh: Pick<TetMesh, "tets" | "embedTet" | "embedWeight">;
}

export function isSimParticles(view: ParticleView): view is SimParticles {
  return typeof (view as SimParticles).velocities === "function";
}

/** Free particles slower than this (m/s) for SLEEP_STEPS steps, with every body they ride on asleep, go to sleep. */
const SLEEP_SPEED = 0.01;
const SLEEP_STEPS = 30;

/** One part's particles: the nodes of its tetrahedra. */
export class Piece implements SimParticles {
  readonly count: number;
  readonly rest: Float32Array;
  /** Positions and velocities (world, xyz). */
  readonly x: Float32Array;
  readonly v: Float32Array;
  readonly m: Float64Array;
  /** Inverse mass, 0 for attached particles (the solvers treat them as fixed). */
  readonly w: Float64Array;
  readonly fixed: Uint8Array;
  /** Impulse (N·s) the flesh exerted on each attached particle this step, which its body receives. */
  readonly reaction: Float64Array;
  readonly radius: number;
  readonly region: Uint8Array;
  readonly softness: Float32Array;
  readonly restVolume: number;
  /** Stiffness factor of each tetrahedron from its region (material.ts), updated by setParams. */
  readonly tetStiffness: Float64Array;
  /** Tetrahedra and edges with at least one free particle: the only ones a solver needs to touch. */
  activeTets = new Uint32Array(0);
  activeEdges = new Uint32Array(0);
  /** Active tetrahedra with an attached particle: the only ones that pull on the bones. */
  boundaryTets = new Uint32Array(0);
  /** Bumped whenever a particle is attached or detached. */
  version = 0;
  sleeping = false;
  private quiet = 0;
  private synced = -1;
  private body: (RAPIER.RigidBody | null)[];
  /** Offset of an attached particle in its body's frame. */
  private local: Float64Array;
  /** Whether an attached particle's mass rides on its (dynamic) body. */
  private carried: Uint8Array;
  private carriers = new Map<RAPIER.RigidBody, RAPIER.Collider>();
  /** The body of the bone nearest to each particle at rest (where a free particle's damping goes). */
  private home: RAPIER.RigidBody[];
  private surfaceOut: Float32Array;

  constructor(private world: RAPIER.World, readonly part: SimPart, readonly mesh: TetMesh) {
    const n = mesh.nodes.length / 3;
    this.count = n;
    this.rest = mesh.nodes;
    this.x = mesh.nodes.slice();
    this.v = new Float32Array(n * 3);
    this.m = new Float64Array(n);
    this.w = new Float64Array(n);
    this.fixed = new Uint8Array(n);
    this.reaction = new Float64Array(n * 3);
    this.body = new Array(n).fill(null);
    this.local = new Float64Array(n * 3);
    this.carried = new Uint8Array(n);
    this.radius = mesh.cell / 2;
    this.surfaceOut = new Float32Array(part.positions.length);
    this.tetStiffness = new Float64Array(mesh.tets.length / 4).fill(1);
    // Lumped masses: a quarter of each tetrahedron's mass to each of its nodes, scaled to the part's true mass (the
    // lattice reaches a little past the surface).
    const T = mesh.tets;
    let volume = 0;
    for (let t = 0; t < T.length; t += 4) {
      const vt = tetVolume(this.rest, T[t], T[t + 1], T[t + 2], T[t + 3]);
      volume += vt;
      for (let k = 0; k < 4; k++) this.m[T[t + k]] += vt / 4;
    }
    this.restVolume = volume;
    const scale = (DENSITY * new TriMesh(part.positions, part.indices).volume()) / volume;
    for (let i = 0; i < n; i++) {
      this.m[i] *= scale;
      this.w[i] = 1 / this.m[i];
    }
    const p = new THREE.Vector3();
    this.home = Array.from({ length: n }, (_, i) => nearestBone(part, p.fromArray(this.rest, i * 3)).bone.body);
    const { region, softness } = particleAttributes(part, this.rest);
    this.region = region;
    this.softness = softness;
    this.sync();
  }

  /* ParticleView ------------------------------------------------------------------------------------------------ */

  positions() {
    return this.x;
  }
  velocities() {
    return this.v;
  }
  mass(i: number) {
    return this.m[i];
  }
  applyImpulse(i: number, x: number, y: number, z: number) {
    if (this.fixed[i]) return;
    this.v[i * 3] += x * this.w[i];
    this.v[i * 3 + 1] += y * this.w[i];
    this.v[i * 3 + 2] += z * this.w[i];
    this.wake();
  }
  setPosition(i: number, x: number, y: number, z: number) {
    const d = Math.abs(this.x[i * 3] - x) + Math.abs(this.x[i * 3 + 1] - y) + Math.abs(this.x[i * 3 + 2] - z);
    this.x[i * 3] = x;
    this.x[i * 3 + 1] = y;
    this.x[i * 3 + 2] = z;
    if (d > 1e-4) this.wake();
  }
  setVelocity(i: number, x: number, y: number, z: number) {
    const d = Math.abs(this.v[i * 3] - x) + Math.abs(this.v[i * 3 + 1] - y) + Math.abs(this.v[i * 3 + 2] - z);
    this.v[i * 3] = x;
    this.v[i * 3 + 1] = y;
    this.v[i * 3 + 2] = z;
    if (d > 1e-3) this.wake();
  }
  attach(i: number, body: RAPIER.RigidBody) {
    const t = body.translation(), q = body.rotation();
    // local = R⁻¹ (x − t)
    const dx = this.x[i * 3] - t.x, dy = this.x[i * 3 + 1] - t.y, dz = this.x[i * 3 + 2] - t.z;
    rotate(-q.x, -q.y, -q.z, q.w, dx, dy, dz, this.local, i * 3);
    this.body[i] = body;
    this.fixed[i] = 1;
    this.w[i] = 0;
    this.carried[i] = body.isDynamic() ? 1 : 0;
    this.version++;
    this.wake();
  }
  detach(i: number) {
    if (!this.body[i]) return;
    this.body[i] = null;
    this.fixed[i] = 0;
    this.w[i] = 1 / this.m[i];
    this.carried[i] = 0;
    this.version++;
    this.wake();
  }
  attachedTo(i: number) {
    return this.body[i];
  }

  wake() {
    this.sleeping = false;
    this.quiet = 0;
  }

  /* The step around the solver ----------------------------------------------------------------------------------- */

  /** After attachments changed: the active tetrahedra and edges, and the mass each body carries. True if changed. */
  sync(): boolean {
    if (this.synced === this.version) return false;
    this.synced = this.version;
    const T = this.mesh.tets, E = this.mesh.edges, F = this.fixed;
    const tets: number[] = [], edges: number[] = [], boundary: number[] = [];
    for (let t = 0; t < T.length / 4; t++) {
      const fixed = F[T[t * 4]] + F[T[t * 4 + 1]] + F[T[t * 4 + 2]] + F[T[t * 4 + 3]];
      if (fixed < 4) tets.push(t);
      if (fixed > 0 && fixed < 4) boundary.push(t);
    }
    this.boundaryTets = Uint32Array.from(boundary);
    for (let e = 0; e < E.length / 2; e++) if (!(F[E[e * 2]] && F[E[e * 2 + 1]])) edges.push(e);
    this.activeTets = Uint32Array.from(tets);
    this.activeEdges = Uint32Array.from(edges);
    this.updateCarriers();
    return true;
  }

  /** Each dynamic body carries its attached particles' mass and inertia as a mass-only collider (no contacts). */
  private updateCarriers() {
    const groups = new Map<RAPIER.RigidBody, number[]>();
    for (let i = 0; i < this.count; i++) {
      const b = this.body[i];
      if (b && this.carried[i]) (groups.get(b) ?? groups.set(b, []).get(b)!).push(i);
    }
    for (const [b, c] of this.carriers) {
      if (!groups.has(b)) c.setMassProperties(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    }
    const L = this.local;
    for (const [b, ids] of groups) {
      let m = 0, cx = 0, cy = 0, cz = 0;
      for (const i of ids) {
        m += this.m[i];
        cx += this.m[i] * L[i * 3];
        cy += this.m[i] * L[i * 3 + 1];
        cz += this.m[i] * L[i * 3 + 2];
      }
      cx /= m; cy /= m; cz /= m;
      // Inertia tensor about the centre of mass, in the body's frame, then its principal axes.
      const I = new Float64Array(9);
      for (const i of ids) {
        const rx = L[i * 3] - cx, ry = L[i * 3 + 1] - cy, rz = L[i * 3 + 2] - cz, mi = this.m[i];
        const r2 = rx * rx + ry * ry + rz * rz;
        I[0] += mi * (r2 - rx * rx); I[4] += mi * (r2 - ry * ry); I[8] += mi * (r2 - rz * rz);
        I[1] -= mi * rx * ry; I[2] -= mi * rx * rz; I[5] -= mi * ry * rz;
      }
      I[3] = I[1]; I[6] = I[2]; I[7] = I[5];
      const { values, vectors } = symEigen3(I);
      const frame = quatFromBasis(vectors);
      const principal = { x: Math.max(values[0], 1e-6), y: Math.max(values[1], 1e-6), z: Math.max(values[2], 1e-6) };
      let c = this.carriers.get(b);
      if (!c) {
        c = this.world.createCollider(
          RAPIER.ColliderDesc.ball(0.005).setMassProperties(m, { x: cx, y: cy, z: cz }, principal, frame).setCollisionGroups(0),
          b,
        );
        this.carriers.set(b, c);
      } else c.setMassProperties(m, { x: cx, y: cy, z: cz }, principal, frame);
    }
  }

  /** Attached particles to where their bodies carry them now; their velocity from that motion. */
  prescribe(h: number) {
    const poses = new Map<RAPIER.RigidBody, number[]>();
    const X = this.x, V = this.v, L = this.local, tmp = new Float64Array(3);
    for (let i = 0; i < this.count; i++) {
      const b = this.body[i];
      if (!b) continue;
      let p = poses.get(b);
      if (!p) {
        const t = b.translation(), q = b.rotation();
        poses.set(b, (p = [t.x, t.y, t.z, q.x, q.y, q.z, q.w]));
      }
      rotate(p[3], p[4], p[5], p[6], L[i * 3], L[i * 3 + 1], L[i * 3 + 2], tmp, 0);
      for (let k = 0; k < 3; k++) {
        const nx = p[k] + tmp[k];
        V[i * 3 + k] = (nx - X[i * 3 + k]) / h;
        X[i * 3 + k] = nx;
      }
    }
  }

  /** Free flesh's velocity relative to its target decays at `rate` (1/s). The momentum it loses goes to the bone
   *  it would ride on (viscous friction in the bones' frame: it slows the jiggle, not the frog). */
  damp(TV: Float32Array | null, rate: number, h: number) {
    const keep = Math.exp(-rate * h), V = this.v, R = this.reaction;
    for (let i = 0; i < this.count; i++) {
      if (this.fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const tv = TV ? TV[i * 3 + k] : 0, before = V[i * 3 + k];
        V[i * 3 + k] = tv + (before - tv) * keep;
        R[i * 3 + k] -= this.m[i] * (V[i * 3 + k] - before);
      }
    }
  }

  /** Each awake dynamic body receives the impulses its particles passed on this step: an attached particle's from the
   *  flesh pulling on it, a free particle's from its damping (to its home bone). */
  applyReactions() {
    const sums = new Map<RAPIER.RigidBody, Float64Array>();
    const R = this.reaction, X = this.x;
    for (let i = 0; i < this.count; i++) {
      const b = this.body[i] ?? this.home[i];
      const jx = R[i * 3], jy = R[i * 3 + 1], jz = R[i * 3 + 2];
      if (jx === 0 && jy === 0 && jz === 0) continue;
      let s = sums.get(b);
      if (!s) {
        if (!b.isDynamic() || b.isSleeping()) continue;
        const t = b.translation();
        sums.set(b, (s = new Float64Array([0, 0, 0, 0, 0, 0, t.x, t.y, t.z])));
      }
      // Impulse, and its moment about the body's origin.
      const rx = X[i * 3] - s[6], ry = X[i * 3 + 1] - s[7], rz = X[i * 3 + 2] - s[8];
      s[0] += jx; s[1] += jy; s[2] += jz;
      s[3] += ry * jz - rz * jy;
      s[4] += rz * jx - rx * jz;
      s[5] += rx * jy - ry * jx;
    }
    for (const [b, s] of sums) {
      b.applyImpulseAtPoint({ x: s[0], y: s[1], z: s[2] }, { x: s[6], y: s[7], z: s[8] }, false);
      b.applyTorqueImpulse({ x: s[3], y: s[4], z: s[5] }, false);
    }
  }

  /** True when the piece may skip this step: its bodies sleep and its free flesh has been still a while. */
  asleep(): boolean {
    let bodiesAwake = false;
    for (let i = 0; i < this.count && !bodiesAwake; i++) {
      const b = this.body[i];
      if (b && !b.isSleeping()) bodiesAwake = true;
    }
    if (bodiesAwake) {
      this.wake();
      return false;
    }
    if (this.sleeping) return true;
    let fastest = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.fixed[i]) fastest = Math.max(fastest, Math.abs(this.v[i * 3]) + Math.abs(this.v[i * 3 + 1]) + Math.abs(this.v[i * 3 + 2]));
    }
    this.quiet = fastest < SLEEP_SPEED ? this.quiet + 1 : 0;
    if (this.quiet > SLEEP_STEPS) {
      this.sleeping = true;
      this.v.fill(0);
    }
    return this.sleeping;
  }

  setParams(p: PhysicsParams) {
    const k = regionStiffness(p), T = this.mesh.tets;
    for (let t = 0; t < this.tetStiffness.length; t++) {
      this.tetStiffness[t] = (k[this.region[T[t * 4]]] + k[this.region[T[t * 4 + 1]]] + k[this.region[T[t * 4 + 2]]] + k[this.region[T[t * 4 + 3]]]) / 4;
    }
    this.wake();
  }

  surface() {
    return embeddedSurface(this.mesh, this.x, this.surfaceOut);
  }

  volume(): number {
    const T = this.mesh.tets;
    let v = 0;
    for (let t = 0; t < T.length; t += 4) v += tetVolume(this.x, T[t], T[t + 1], T[t + 2], T[t + 3]);
    return v;
  }

  reset() {
    this.x.set(this.rest);
    this.v.fill(0);
    this.wake();
  }

  dispose() {
    for (const c of this.carriers.values()) this.world.removeCollider(c, false);
    this.carriers.clear();
  }
}

/** out[o..o+3] = q v q⁻¹ for the unit quaternion (qx, qy, qz, qw). */
function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, out: Float64Array, o: number) {
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[o] = vx + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = vy + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** The quaternion of a rotation given by its matrix's columns (V row-major); a reflection is turned into a rotation. */
function quatFromBasis(V: Float64Array): { x: number; y: number; z: number; w: number } {
  const m = Float64Array.from(V);
  const d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (d < 0) for (const k of [2, 5, 8]) m[k] = -m[k];
  const tr = m[0] + m[4] + m[8];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The flesh block around a solver                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A solver's view of one piece: advance its free particles by h. */
export interface PieceSolver {
  /** Write the free particles' new x and v; add the impulse the flesh exerts on each fixed particle to piece.reaction. */
  step(h: number, gravity: readonly [number, number, number]): void;
  /** Particles were attached or detached (piece.activeTets/activeEdges and piece.w changed). */
  attachmentsChanged?(): void;
  setParams?(p: PhysicsParams): void;
  setSettings?(s: Readonly<Settings>): void;
  reset?(): void;
}

export type SolverFactory = (piece: Piece, scene: Scene, settings: Readonly<Settings>) => PieceSolver;

/** The particle-count parameters every solver of the library declares. */
export const PARTICLE_PARAMETERS: SimParameter[] = [
  {
    key: "bodyParticles", kind: "number", default: 250, min: 100, max: 1200, step: 50, rebuild: true,
    label: { zh: "身体粒子数", en: "Body particles" },
    help: { zh: "格点数：越多越细，越慢。", en: "Lattice nodes: more is finer and slower." },
  },
  {
    key: "limbParticles", kind: "number", default: 40, min: 20, max: 200, step: 10, rebuild: true,
    label: { zh: "四肢粒子数", en: "Limb particles" },
  },
];

/** Rapier's internal PGS iterations for the skeleton (see ParticleFlesh). */
const SKELETON_PGS_ITERATIONS = 2;

export class ParticleFlesh implements FleshBlock {
  readonly pieces = new Map<SimPart, { piece: Piece; solver: PieceSolver }>();
  private rate = 0;

  constructor(scene: Scene, settings: Readonly<Settings>, factory: SolverFactory) {
    // The rigid skeleton's stiff motors need a second PGS iteration to settle (the built-in Rapier soft bodies add
    // theirs); with one, the legs buzz and the standing frog creeps across the floor and never sleeps.
    const ip = scene.world.integrationParameters;
    ip.numInternalPgsIterations = Math.max(ip.numInternalPgsIterations, SKELETON_PGS_ITERATIONS);
    for (const part of scene.parts) {
      const particles = Number(part.limb ? settings.limbParticles ?? 40 : settings.bodyParticles ?? 250);
      const volume = new TriMesh(part.positions, part.indices).volume();
      const mesh = tetrahedralise(part.positions, part.indices, cellForParticles(part.positions, part.indices, volume, particles));
      const piece = new Piece(scene.world, part, mesh);
      piece.setParams(scene.params);
      this.pieces.set(part, { piece, solver: factory(piece, scene, settings) });
    }
    this.setParams(scene.params);
  }

  piece(part: SimPart): Piece {
    const p = this.pieces.get(part);
    if (!p) throw new Error(`sim: no flesh for ${part.name}`);
    return p.piece;
  }

  particles(part: SimPart): ParticleView {
    return this.piece(part);
  }
  surface(part: SimPart) {
    return this.piece(part).surface();
  }
  cells(part: SimPart) {
    return this.piece(part).mesh.tets;
  }
  volumeRatio(part: SimPart) {
    const p = this.piece(part);
    return p.volume() / p.restVolume;
  }

  afterStep(scene: Scene) {
    const h = scene.dt, g = scene.world.gravity, gravity = [g.x, g.y, g.z] as const;
    for (const [part, { piece, solver }] of this.pieces) {
      if (piece.sync()) solver.attachmentsChanged?.();
      if (piece.asleep()) continue;
      piece.prescribe(h);
      piece.reaction.fill(0);
      solver.step(h, gravity);
      piece.damp(scene.target.targetVelocities(part), this.rate, h);
      piece.applyReactions();
    }
  }

  addVelocity(dv: THREE.Vector3) {
    for (const { piece } of this.pieces.values()) {
      for (let i = 0; i < piece.count; i++) {
        piece.v[i * 3] += dv.x;
        piece.v[i * 3 + 1] += dv.y;
        piece.v[i * 3 + 2] += dv.z;
      }
      piece.wake();
    }
  }

  stats() {
    let particles = 0, cells = 0;
    for (const { piece } of this.pieces.values()) {
      particles += piece.count;
      cells += piece.mesh.tets.length / 4;
    }
    const body = [...this.pieces.values()][0].piece;
    return { particles, cells, volumeRatio: body.volume() / body.restVolume };
  }

  setParams(p: PhysicsParams) {
    this.rate = dampingRate(p);
    for (const { piece, solver } of this.pieces.values()) {
      piece.setParams(p);
      solver.setParams?.(p);
    }
  }

  setSettings(s: Readonly<Settings>) {
    for (const { piece, solver } of this.pieces.values()) {
      solver.setSettings?.(s);
      piece.wake();
    }
  }

  reset() {
    for (const { piece, solver } of this.pieces.values()) {
      piece.reset();
      solver.reset?.();
    }
  }

  dispose() {
    for (const { piece } of this.pieces.values()) piece.dispose();
  }
}

/** A flesh block definition around a solver: the shared particle parameters first, then the solver's own. */
export function particleFleshBlock(
  def: Omit<BlockDefinition<"flesh">, "slot" | "device" | "create" | "parameters"> & { parameters: SimParameter[]; solver: SolverFactory },
): BlockDefinition<"flesh"> {
  const { solver, parameters, ...rest } = def;
  return {
    ...rest,
    slot: "flesh",
    device: "cpu",
    parameters: [...PARTICLE_PARAMETERS, ...parameters],
    create: (scene, settings) => new ParticleFlesh(scene, settings, solver),
  };
}
