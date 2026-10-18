/**
 * The simulation core: a small fixed-step loop over the blocks of a simulator (api.ts), plus what every simulator
 * shares: the Rapier world with the floor and the balls, pose targets in, bones and surfaces out, ray casts, the
 * user's pokes, slaps, grabs and throws, and the events they cause.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type {
  BodyMode, BoneName, FrogEvent, FrogEventKind, FrogHit, FrogSim, GrabHandle, HitRegion, PhysicsParams, RigSpec,
  SimulatorOptions,
} from "../contracts";
import { FLESH_REGIONS } from "../contracts";
import { SLOTS, type Block, type Metrics, type Scene, type SimBall, type SimPart, type Slot, type SlotBlocks } from "./api";
import { rayHitMesh } from "./geometry";
import { resolveParts } from "./parts";
import { resolve } from "./registry";

/** Fixed physics step; a frame runs as many as its time needs, at most MAX_STEPS (slower frames drop time: on a busy
 *  machine three steps a frame made the frames slower still, and the page spiralled down to a few frames a second). */
export const SIM_DT = 1 / 60;
const MAX_STEPS = 2;
const MAX_BALLS = 24;
const MAX_THROW_SPEED = 9;

/* Collision groups: membership << 16 | filter. Blocks get theirs through the scene. */
const G = { floor: 1, body: 2, limbFlesh: 4, core: 8, contact: 16, ball: 32 };
const groups = (member: number, filter: number) => (member << 16) | filter;
export const GROUPS = {
  floor: groups(G.floor, G.body | G.limbFlesh | G.core | G.ball),
  body: groups(G.body, G.floor | G.ball | G.contact),
  limbFlesh: groups(G.limbFlesh, G.floor | G.ball),
  core: groups(G.core, G.floor | G.ball),
  contact: groups(G.contact, G.body),
  ball: groups(G.ball, G.floor | G.body | G.limbFlesh | G.core | G.ball),
};

export interface SimStats extends Partial<Metrics> {
  particles: number;
  cells: number;
  volumeRatio: number;
  /** Simulated time (s). */
  time: number;
}

/** The FrogSim the page uses, with what the lab shows on top. */
export type LabFrogSim = FrogSim & {
  readLimbs(out: Map<string, Float32Array>): void;
  /** Particles, cells, volume, and the quality metrics (a pass over the flesh: a few times a second). */
  stats(): SimStats;
  /** Resolves when every block is built (some build asynchronously, e.g. on the GPU). */
  readonly ready: Promise<void>;
  readonly scene: Scene;
};

/**
 * Build the frog with a simulator (an assembly of blocks, api.ts). options.blocks swaps blocks by slot; settings are
 * matched to the blocks' declared parameters by key.
 */
export function createFrogSim(
  spec: RigSpec,
  params: PhysicsParams,
  options: SimulatorOptions & { blocks?: Partial<Record<Slot, string>> },
): LabFrogSim {
  return new Core(spec, params, options);
}

const hitRegion = (r: string): HitRegion => (r === "hand" ? "arm" : r === "foot" ? "leg" : (r as HitRegion));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

class Core implements LabFrogSim {
  readonly ready: Promise<void>;
  readonly scene: Scene;
  private world: RAPIER.World;
  private queue = new RAPIER.EventQueue(true);
  private floor: RAPIER.Collider;
  private blocks: Partial<SlotBlocks> = {};
  private order: Block[] = [];
  private built = false;
  private parts: SimPart[] = [];
  private params: PhysicsParams;
  private mode: BodyMode = "free";
  private balls: SimBall[] = [];
  private ballOf = new Map<number, SimBall>();
  private fleshOf = new Map<number, SimPart>();
  private listeners = new Set<(e: FrogEvent) => void>();
  private accumulator = 0;
  private time = 0;
  /** Contacts of the frog with the floor (Rapier's and reported ones), time in the air, fall speed. */
  private floorContacts = 0;
  private reportedFloor = false;
  private airTime = 0;
  private fallSpeed = 0;
  private squished = false;

  constructor(private spec: RigSpec, params: PhysicsParams, options: SimulatorOptions & { blocks?: Partial<Record<Slot, string>> }) {
    this.params = { ...params };
    this.world = new RAPIER.World({ x: 0, y: -9.81 * params.gravity, z: 0 });
    this.world.timestep = SIM_DT;
    // No extra substeps on fast hits: Rapier's default (4) made frame times spike, and even one cost a sixth of the
    // step in a dance (arms touching the belly count as hits) while balls at 14 m/s stay out of the belly without it.
    this.world.integrationParameters.softBodiesMaxExtraSubsteps = 0;
    this.floor = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(30, 1, 30).setTranslation(0, -1, 0).setFriction(0.9)
        .setCollisionGroups(GROUPS.floor).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    );
    // Walls keep the frog and the balls in the play area.
    for (const [x, z, hx, hz] of [[6.5, 0, 0.5, 7], [-6.5, 0, 0.5, 7], [0, 6.5, 7, 0.5], [0, -6.5, 7, 0.5]]) {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 6, hz).setTranslation(x, 6, z).setCollisionGroups(GROUPS.floor));
    }
    this.scene = this.makeScene();
    this.ready = this.build(resolve(options));
  }

  private makeScene(): Scene {
    const core = this;
    const block = <S extends Slot>(slot: S): SlotBlocks[S] => {
      const b = core.blocks[slot];
      if (!b) throw new Error(`sim: no ${slot} block (not built yet, or covered by another block)`);
      return b as SlotBlocks[S];
    };
    return {
      world: this.world,
      dt: SIM_DT,
      spec: this.spec,
      get params() { return core.params; },
      get mode() { return core.mode; },
      get parts() { return core.parts; },
      floorFriction: 0.9,
      balls: () => this.balls,
      get skeleton() { return block("skeleton"); },
      get flesh() { return block("flesh"); },
      get target() { return block("target"); },
      get coupling() { return block("coupling"); },
      collisionGroups: { body: GROUPS.body, limb: GROUPS.limbFlesh, core: GROUPS.core, contact: GROUPS.contact },
      registerCollider: (collider, part) => this.fleshOf.set(collider.handle, part),
      reportContact: (c) => {
        if (c.with === "floor") this.reportedFloor = true;
        else this.emit("ball", c.ball.body.translation(), this.ballStrength(c.ball), this.regionAt(c.part, c.ball.body.translation()));
      },
    };
  }

  /** Blocks are built in slot order; the parts are resolved once the skeleton exists (they ride on its bones). */
  private async build(resolved: ReturnType<typeof resolve>) {
    for (const slot of SLOTS) {
      const r = resolved.get(slot);
      if (!r) continue;
      const block = await r.def.create(this.scene, r.settings);
      (this.blocks as Record<Slot, Block>)[slot] = block;
      this.order.push(block);
      if (slot === "skeleton") this.parts = resolveParts(this.spec, this.scene.skeleton.bones);
    }
    this.built = true;
    this.setParams(this.params);
    this.scene.skeleton.setMode(this.mode);
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Inputs                                                                                                       */
  /* ---------------------------------------------------------------------------------------------------------- */

  setParams(p: PhysicsParams): void {
    this.params = { ...p, regionSoftness: { ...p.regionSoftness } };
    this.world.gravity = { x: 0, y: -9.81 * Math.max(0, p.gravity), z: 0 };
    if (this.built) for (const b of this.order) b.setParams?.(this.params);
  }

  setMode(m: BodyMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (this.built) this.scene.skeleton.setMode(m);
  }

  setTargets(boneWorld: Map<BoneName, THREE.Matrix4>): void {
    if (this.built) this.scene.skeleton.setTargets(boneWorld);
  }

  transition(): void {
    if (this.built) this.scene.skeleton.transition();
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* The loop                                                                                                     */
  /* ---------------------------------------------------------------------------------------------------------- */

  step(dt: number): void {
    if (!this.built) return;
    this.accumulator = Math.min(this.accumulator + Math.max(0, dt), MAX_STEPS * SIM_DT);
    while (this.accumulator >= SIM_DT) {
      this.accumulator -= SIM_DT;
      this.substep();
    }
  }

  private substep() {
    const fall = -this.scene.skeleton.velocity().y;
    for (const b of this.balls) (b as Ball).speed = new THREE.Vector3().copy(b.body.linvel()).length();
    for (const b of this.order) b.beforeStep?.(this.scene);
    this.world.step(this.queue);
    for (const b of this.order) b.afterStep?.(this.scene);
    this.time += SIM_DT;
    this.contactEvents(fall);
    this.cullBalls();
  }

  private isFrog(handle: number) {
    if (this.fleshOf.has(handle)) return true;
    for (const b of this.scene.skeleton.bones.values()) if (b.shapes.some((s) => s.collider?.handle === handle)) return true;
    return false;
  }

  private contactEvents(fall: number) {
    const floor = this.floor.handle;
    const wasOnFloor = this.floorContacts > 0;
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (h1 === floor || h2 === floor) {
        if (this.isFrog(h1 === floor ? h2 : h1)) this.floorContacts = Math.max(0, this.floorContacts + (started ? 1 : -1));
        return;
      }
      const ball = this.ballOf.get(h1) ?? this.ballOf.get(h2);
      if (!started || !ball) return;
      const other = this.ballOf.has(h1) ? h2 : h1;
      if (!this.isFrog(other)) return;
      const at = ball.body.translation();
      const part = this.fleshOf.get(other);
      this.emit("ball", at, this.ballStrength(ball), part ? this.regionAt(part, at) : this.boneRegion(other));
    });
    const onFloor = this.floorContacts > 0 || this.reportedFloor;
    this.reportedFloor = false;
    if (onFloor && !wasOnFloor && this.airTime > 0.25 && this.mode === "free") {
      const strength = clamp01(this.fallSpeed / 7);
      if (strength > 0.08) {
        this.scene.skeleton.knock();
        this.emit("land", this.groundPoint(), strength);
      }
    }
    if (onFloor) {
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.airTime += SIM_DT;
      this.fallSpeed = Math.max(this.fallSpeed, fall);
    }
    // Squish: the Body's jiggle crossing a threshold.
    const jiggle = this.blocks.coupling?.jiggle(this.parts[0]) ?? 0;
    if (!this.squished && jiggle > 0.03) {
      this.squished = true;
      this.emit("squish", this.groundPoint(), jiggle / 0.09);
    } else if (this.squished && jiggle < 0.018) this.squished = false;
  }

  private ballStrength(b: SimBall) {
    return clamp01((b as Ball).speed / 12);
  }

  private groundPoint(): THREE.Vector3 {
    const t = this.scene.skeleton.bones.get("hips")!.body.translation();
    return new THREE.Vector3(t.x, 0, t.z);
  }

  private emit(kind: FrogEventKind, point: { x: number; y: number; z: number }, strength: number, region?: HitRegion) {
    const e: FrogEvent = { kind, point: new THREE.Vector3(point.x, point.y, point.z), strength: clamp01(strength), region };
    for (const cb of this.listeners) cb(e);
  }

  onEvent(cb: (e: FrogEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Outputs                                                                                                      */
  /* ---------------------------------------------------------------------------------------------------------- */

  readBones(out: Map<BoneName, THREE.Matrix4>): void {
    if (!this.built) return;
    const skeleton = this.scene.skeleton;
    for (const b of skeleton.bones.values()) {
      let m = out.get(b.name);
      if (!m) out.set(b.name, (m = new THREE.Matrix4()));
      b.pose(m);
    }
    let root = out.get("root");
    if (!root) out.set("root", (root = new THREE.Matrix4()));
    skeleton.root(root);
  }

  private surface(part: SimPart): Float32Array {
    return this.blocks.output?.read(part) ?? part.positions;
  }

  readBody(): Float32Array {
    return this.built ? this.surface(this.parts[0]) : this.spec.body.positions;
  }

  readLimbs(out: Map<string, Float32Array>): void {
    for (const p of this.parts) if (p.limb) out.set(p.name, this.surface(p));
  }

  stats(): SimStats {
    if (!this.built) return { particles: 0, cells: 0, volumeRatio: 1, time: 0 };
    return { ...this.scene.flesh.stats(), ...this.blocks.metrics?.measure(this.scene), time: this.time };
  }

  raycast(ray: THREE.Ray): FrogHit | null {
    if (!this.built) return null;
    let best: { t: number; normal: THREE.Vector3; part: SimPart } | null = null;
    for (const part of this.parts) {
      const hit = rayHitMesh(ray, this.surface(part), part.indices);
      if (hit && (!best || hit.t < best.t)) best = { ...hit, part };
    }
    if (!best) return null;
    const point = ray.at(best.t, new THREE.Vector3());
    return { point, normal: best.normal, region: this.regionAt(best.part, point) };
  }

  /** The part whose surface passes nearest to a point (the one a hit belongs to). */
  private partAt(point: THREE.Vector3): SimPart {
    let best = this.parts[0], bd = Infinity;
    for (const part of this.parts) {
      const V = this.surface(part);
      for (let v = 0; v < V.length; v += 3) {
        const d = (V[v] - point.x) ** 2 + (V[v + 1] - point.y) ** 2 + (V[v + 2] - point.z) ** 2;
        if (d < bd) {
          bd = d;
          best = part;
        }
      }
    }
    return best;
  }

  private regionAt(part: SimPart, point: { x: number; y: number; z: number }): HitRegion {
    const V = this.surface(part);
    let best = 0, bd = Infinity;
    for (let v = 0; v < V.length / 3; v++) {
      const d = (V[v * 3] - point.x) ** 2 + (V[v * 3 + 1] - point.y) ** 2 + (V[v * 3 + 2] - point.z) ** 2;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return hitRegion(FLESH_REGIONS[part.regions[best]]);
  }

  private boneRegion(handle: number): HitRegion {
    for (const b of this.scene.skeleton.bones.values()) {
      if (b.shapes.some((s) => s.collider?.handle === handle)) {
        return b.name === "head" ? "head" : /arm|hand/.test(b.name) ? "arm" : /thigh|shin|foot/.test(b.name) ? "leg" : "body";
      }
    }
    return "body";
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* The user's hands                                                                                             */
  /* ---------------------------------------------------------------------------------------------------------- */

  poke(hit: FrogHit, strength: number, direction: THREE.Vector3): void {
    if (!this.built) return;
    const s = clamp01(strength);
    const part = this.partAt(hit.point);
    this.blocks.interaction?.push(part, hit.point, direction.clone().normalize().multiplyScalar(lerp(1.5, 5, s)), part.limb ? 0.08 : 0.14);
    this.emit("poke", hit.point, s, hit.region);
  }

  slap(point: THREE.Vector3, velocity: THREE.Vector3): void {
    if (!this.built) return;
    const speed = Math.min(velocity.length(), 20);
    if (speed < 1e-3) return;
    const dv = velocity.clone().setLength(speed * 0.35);
    for (const part of this.parts) this.blocks.interaction?.push(part, point, dv, 0.26);
    const part = this.partAt(point);
    this.emit("slap", point, speed / 12, this.regionAt(part, point));
  }

  grab(hit: FrogHit): GrabHandle {
    const part = this.partAt(hit.point);
    const pinch = this.blocks.interaction?.grab(part, hit.point);
    const start = hit.point.clone();
    this.emit("grab", hit.point, 0.5, hit.region);
    return {
      move: (target) => {
        const t = target.clone();
        t.y = Math.max(t.y, 0.03);
        // Held by its bones in driven mode, the frog only lets its flesh be pulled so far.
        if (this.mode === "driven" && t.distanceTo(start) > 0.22) t.sub(start).setLength(0.22).add(start);
        pinch?.move(t);
      },
      release: (velocity) => {
        pinch?.release();
        const v = velocity.clone().clampLength(0, MAX_THROW_SPEED);
        if (this.mode === "free" && v.length() > 1.2) {
          // The whole frog carries the throw, not only the pinched flesh.
          const dv = v.clone().sub(this.scene.skeleton.velocity()).multiplyScalar(0.85);
          this.scene.skeleton.addVelocity(dv);
          this.scene.flesh.addVelocity(dv);
          this.scene.skeleton.knock();
        }
        this.emit("release", hit.point, v.length() / MAX_THROW_SPEED);
      },
    };
  }

  throwBall(origin: THREE.Vector3, velocity: THREE.Vector3, radius = 0.07): void {
    if (this.balls.length >= MAX_BALLS) this.removeBall(this.balls[0]);
    const v = velocity.clone().clampLength(0, 25);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z).setLinvel(v.x, v.y, v.z)
        .setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.3),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius).setMass(0.25 * (radius / 0.07) ** 3).setRestitution(0.6).setFriction(0.5)
        .setCollisionGroups(GROUPS.ball).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    const ball: Ball = { body, radius, speed: v.length() };
    this.balls.push(ball);
    this.ballOf.set(collider.handle, ball);
  }

  private removeBall(b: SimBall) {
    for (let i = 0; i < b.body.numColliders(); i++) this.ballOf.delete(b.body.collider(i).handle);
    this.world.removeRigidBody(b.body);
    this.balls.splice(this.balls.indexOf(b), 1);
  }

  private cullBalls() {
    for (const b of [...this.balls]) {
      const t = b.body.translation();
      if (t.y < -2 || Math.abs(t.x) > 8 || Math.abs(t.z) > 8) this.removeBall(b);
    }
  }

  readBalls(): Float32Array {
    const out = new Float32Array(this.balls.length * 4);
    this.balls.forEach((b, k) => {
      const t = b.body.translation();
      out.set([t.x, t.y, t.z, b.radius], k * 4);
    });
    return out;
  }

  clearBalls(): void {
    for (const b of [...this.balls]) this.removeBall(b);
  }

  reset(): void {
    if (!this.built) return;
    for (const b of this.order) b.reset?.();
    this.floorContacts = 0;
  }

  dispose(): void {
    this.listeners.clear();
    const free = () => {
      for (const b of this.order) b.dispose?.();
      this.queue.free();
      this.world.free();
    };
    if (this.built) free();
    // A block that failed to build leaves the others built so far: free them and the world either way.
    else void this.ready.then(free, free);
  }
}

interface Ball extends SimBall {
  speed: number;
}
