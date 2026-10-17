/**
 * 奶蛙's body in Rapier 0.21: a rigid skeleton inside soft flesh. The Body and each limb are volumetric soft bodies
 * whose deep particles ride on their bones; every region has its own softness. See skeleton.ts and flesh.ts.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type {
  BodyMode,
  BoneName,
  CoreBone,
  FleshRegion,
  FrogEvent,
  FrogEventKind,
  FrogHit,
  FrogSim,
  GrabHandle,
  HitRegion,
  PhysicsParams,
  RigSpec,
} from "../contracts";
import { Flesh, REGION_SOFTNESS, type FleshInput, type FleshTuning } from "./flesh";
import { TriMesh } from "./geometry";
import { GROUPS, Skeleton, TORSO, limbFlesh, type Bone } from "./skeleton";

let ready: Promise<void> | null = null;
/** Load Rapier's WebAssembly (once). */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

/** Fixed physics step; a frame runs as many as its time needs, at most MAX_STEPS. */
export const SIM_DT = 1 / 60;
const MAX_STEPS = 3;
/** kg/m³: a 1 m frog of about 15 kg (a big plush toy, not a pond of water). */
const FLESH_DENSITY = 190;
const MAX_BALLS = 24;
const MAX_THROW_SPEED = 9;

/** How the flesh is built; the dev page compares variants, the app uses the defaults. */
export interface SimTuning {
  body: Partial<FleshTuning>;
  limb: Partial<FleshTuning>;
}

type PartTuning = Omit<FleshTuning, "mass" | "collisionGroups">;
const DEFAULT_BODY: PartTuning = {
  particles: 400, cellModel: RAPIER.SoftBodyCellModel.Volume, shapeMatching: false, volumePreservation: true,
  pgsIterations: 3, depth: 0.05, depthSoft: 0.07,
};
const DEFAULT_LIMB: PartTuning = {
  particles: 60, cellModel: RAPIER.SoftBodyCellModel.Volume, shapeMatching: false, volumePreservation: true,
  pgsIterations: 3, depth: 0.012, depthSoft: 0.02,
};

/** Numbers about the simulation, for tests and the dev page. */
export interface FrogStats {
  particles: number;
  attached: number;
  cells: number;
  /** Body volume against its rest volume. */
  volumeRatio: number;
  /** Mean distance (m) of the Body's free flesh from where its bones would carry it: how much it is jiggling. */
  deformation: number;
  time: number;
}

export type DebugFrogSim = FrogSim & {
  readLimbs(out: Map<string, Float32Array>): void;
  stats(): FrogStats;
  readonly flesh: readonly Flesh[];
  readonly skeleton: Skeleton;
};

export function createFrogSim(spec: RigSpec, params: PhysicsParams, tuning?: Partial<SimTuning>): DebugFrogSim {
  return new Frog(spec, params, tuning);
}

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpLog = (a: number, b: number, t: number) => a * Math.pow(b / a, t);
const hitRegion = (r: FleshRegion): HitRegion => (r === "hand" ? "arm" : r === "foot" ? "leg" : r);

interface Ball {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
  speed: number;
}

interface Grab {
  hand: RAPIER.RigidBody;
  flesh: Flesh;
  particles: number[];
  start: THREE.Vector3;
  target: THREE.Vector3;
}

class Frog implements DebugFrogSim {
  readonly skeleton: Skeleton;
  readonly flesh: Flesh[] = [];
  private world: RAPIER.World;
  private queue = new RAPIER.EventQueue(true);
  private floor: RAPIER.Collider;
  private body: Flesh;
  private fleshByCollider = new Map<number, Flesh>();
  private rootFromHips: THREE.Matrix4;
  private rootTarget: THREE.Matrix4 | null = null;
  private params: PhysicsParams;
  private mode: BodyMode = "free";
  private accumulator = 0;
  private time = 0;
  private driveBlend = 1;
  private balls: Ball[] = [];
  private grabs = new Set<Grab>();
  private listeners = new Set<(e: FrogEvent) => void>();
  /** Floor contacts of the frog's colliders, how long it has been in the air and how fast it fell. */
  private floorContacts = 0;
  private airTime = 0;
  private fallSpeed = 0;
  /** Time since the frog was knocked about (landing, throw): its limbs stay floppy for a moment. */
  private sinceKnock = 10;
  private deformation = 0;
  private squished = false;

  constructor(spec: RigSpec, params: PhysicsParams, tuning: Partial<SimTuning> = {}) {
    this.params = { ...params };
    this.world = new RAPIER.World({ x: 0, y: -9.81 * params.gravity, z: 0 });
    // Fast hits get one extra substep at most: Rapier's default (4) made frame times spike.
    this.world.integrationParameters.softBodiesMaxExtraSubsteps = 1;
    this.world.timestep = SIM_DT;
    this.floor = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(30, 1, 30)
        .setTranslation(0, -1, 0)
        .setFriction(0.9)
        .setCollisionGroups(GROUPS.floor)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    );
    // Walls keep the frog and the balls in the play area.
    for (const [x, z, hx, hz] of [[6.5, 0, 0.5, 7], [-6.5, 0, 0.5, 7], [0, 6.5, 7, 0.5], [0, -6.5, 7, 0.5]]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 6, hz).setTranslation(x, 6, z).setCollisionGroups(GROUPS.floor),
      );
    }

    const bodySurface = new TriMesh(spec.body.positions, spec.body.indices);
    this.skeleton = new Skeleton(this.world, spec, bodySurface, limbFlesh(spec));
    const hips = this.skeleton.bone("hips");
    const root = spec.bones.find((b) => b.name === "root");
    this.rootFromHips = new THREE.Matrix4()
      .compose(hips.restPos, hips.restRot, hips.scale)
      .invert()
      .multiply(root ? root.restWorld : new THREE.Matrix4());

    const material = this.material(params);
    // A part may be skinned to bones the simulation does not have (fingers, root): it rides on their nearest
    // simulated ancestor.
    const parentOf = new Map(spec.bones.map((b) => [b.name, b.parent]));
    const ridden = (names: readonly BoneName[]) => {
      const out = new Set<Bone>();
      for (let n of names) {
        let b: BoneName | null | undefined = n;
        while (b && !this.skeleton.bones.has(b as CoreBone)) b = n === "root" ? "hips" : parentOf.get(b);
        n = b ?? "hips";
        out.add(this.skeleton.bone(n as CoreBone));
      }
      return [...out];
    };
    const parts: [FleshInput, FleshTuning][] = [[
      { name: spec.body.name ?? "body", ...spec.body, bones: ridden(spec.body.bones ?? TORSO) },
      { mass: FLESH_DENSITY * bodySurface.volume(), collisionGroups: GROUPS.body, ...DEFAULT_BODY, ...tuning.body },
    ]];
    for (const limb of spec.limbs ?? []) {
      const volume = new TriMesh(limb.positions, limb.indices).volume();
      parts.push([
        { ...limb, bones: ridden(limb.bones) },
        { mass: FLESH_DENSITY * volume, collisionGroups: GROUPS.limbFlesh, ...DEFAULT_LIMB, ...tuning.limb },
      ]);
    }
    for (const [input, t] of parts) {
      const f = new Flesh(this.world, input, t, material);
      this.flesh.push(f);
      this.fleshByCollider.set(f.collider.handle, f);
    }
    this.body = this.flesh[0];
    this.setParams(params);
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Parameters and modes                                                                                         */
  /* ---------------------------------------------------------------------------------------------------------- */

  /** Softness sets how fast the flesh springs back (Hz), bounciness how little it is damped. */
  private spring(p: PhysicsParams) {
    return { f: lerpLog(14, 3, clamp01(p.softness)), z: lerpLog(0.9, 0.06, clamp01(p.bounciness)) };
  }

  private material(p: PhysicsParams): RAPIER.SoftBodyMaterial {
    const { f, z } = this.spring(p);
    const m = new RAPIER.SoftBodyMaterial();
    m.edgeSoftness = { naturalFrequency: f, dampingRatio: z };
    m.bendSoftness = { naturalFrequency: f, dampingRatio: z };
    m.volumeSoftness = { naturalFrequency: f * 2, dampingRatio: z };
    m.shapeMatchingSoftness = { naturalFrequency: f, dampingRatio: z };
    return m;
  }

  setParams(p: PhysicsParams): void {
    this.params = { ...p, regionSoftness: { ...p.regionSoftness } };
    this.world.gravity = { x: 0, y: -9.81 * Math.max(0, p.gravity), z: 0 };
    const material = this.material(p);
    const { f, z } = this.spring(p);
    for (const flesh of this.flesh) {
      flesh.soft.setMaterial(material);
      for (const [region, c] of flesh.clusters) {
        const r = clamp01(p.regionSoftness?.[region] ?? REGION_SOFTNESS[region]);
        // The softest region springs at the slider's rate, firm ones up to 2.5 times faster.
        flesh.soft.setClusterEdgeSoftness(c, { naturalFrequency: f * lerpLog(2.5, 1, r), dampingRatio: z });
      }
      flesh.soft.wakeUp();
    }
    this.body.soft.setVolumeFactor(Math.min(2, Math.max(0.5, p.bellySize)));
    for (const b of this.skeleton.bones.values()) b.body.wakeUp();
  }

  setMode(m: BodyMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.skeleton.setKinematic(m === "driven");
    this.driveBlend = m === "driven" ? 0 : 1;
    for (const f of this.flesh) f.soft.wakeUp();
  }

  setTargets(boneWorld: Map<BoneName, THREE.Matrix4>): void {
    const s = new THREE.Vector3();
    for (const [name, m] of boneWorld) {
      if (name === "root") {
        (this.rootTarget ??= new THREE.Matrix4()).copy(m);
        continue;
      }
      const b = this.skeleton.bones.get(name as CoreBone);
      if (b) m.decompose(b.targetPos, b.targetRot, s);
    }
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Stepping                                                                                                     */
  /* ---------------------------------------------------------------------------------------------------------- */

  step(dt: number): void {
    this.accumulator = Math.min(this.accumulator + Math.max(0, dt), MAX_STEPS * SIM_DT);
    while (this.accumulator >= SIM_DT) {
      this.accumulator -= SIM_DT;
      this.substep();
    }
  }

  private substep() {
    if (this.mode === "driven") {
      this.driveBlend = Math.min(1, this.driveBlend + SIM_DT / 0.35);
      this.skeleton.drive(THREE.MathUtils.smoothstep(this.driveBlend, 0, 1));
    } else {
      // Stubbornness sets the frog's tone; right after a knock it goes floppy and gathers itself again.
      const s = clamp01(this.params.stubbornness);
      const recover = clamp01((this.sinceKnock - 0.4) / 1.2);
      this.skeleton.balance(lerp(0.04, 1, s) * lerp(0.15, 1, recover), 150 * s * lerp(0.3, 1, recover));
    }
    for (const g of this.grabs) this.moveGrab(g);
    for (const b of this.balls) {
      const v = b.body.linvel();
      b.speed = Math.hypot(v.x, v.y, v.z);
    }
    const fall = -this.skeleton.velocity().y;
    this.world.step(this.queue);
    this.time += SIM_DT;
    this.sinceKnock += SIM_DT;
    this.events(fall);
    this.cullBalls();
  }

  private isFrog(handle: number) {
    return this.fleshByCollider.has(handle) || this.skeleton.byCollider.has(handle);
  }

  private events(fall: number) {
    const floor = this.floor.handle;
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (h1 === floor || h2 === floor) {
        if (!this.isFrog(h1 === floor ? h2 : h1)) return;
        this.floorContacts = Math.max(0, this.floorContacts + (started ? 1 : -1));
        if (started && this.floorContacts === 1 && this.airTime > 0.25 && this.mode === "free") {
          const strength = clamp01(this.fallSpeed / 7);
          if (strength > 0.08) {
            this.sinceKnock = 0;
            this.emit("land", this.groundPoint(), strength);
          }
        }
        return;
      }
      if (!started) return;
      const ball = this.balls.find((b) => b.collider.handle === h1 || b.collider.handle === h2);
      if (!ball) return;
      const other = ball.collider.handle === h1 ? h2 : h1;
      if (!this.isFrog(other)) return;
      const t = ball.body.translation();
      const point = new THREE.Vector3(t.x, t.y, t.z);
      this.emit("ball", point, clamp01(ball.speed / 12), this.regionOf(other, point));
    });
    if (this.floorContacts === 0) {
      this.airTime += SIM_DT;
      this.fallSpeed = Math.max(this.fallSpeed, fall);
    } else {
      this.airTime = 0;
      this.fallSpeed = 0;
    }
    this.deformation = this.body.deformation();
    if (!this.squished && this.deformation > 0.03) {
      this.squished = true;
      this.emit("squish", this.groundPoint(), clamp01(this.deformation / 0.09));
    } else if (this.squished && this.deformation < 0.018) this.squished = false;
  }

  private groundPoint(): THREE.Vector3 {
    const c = this.body.soft.centerOfMass();
    return new THREE.Vector3(c.x, 0, c.z);
  }

  private regionOf(collider: number, point: THREE.Vector3): HitRegion {
    const flesh = this.fleshByCollider.get(collider);
    if (flesh) return hitRegion(flesh.regionAt(point));
    return this.skeleton.byCollider.get(collider)?.region ?? "body";
  }

  private emit(kind: FrogEventKind, point: THREE.Vector3, strength: number, region?: HitRegion) {
    const e: FrogEvent = { kind, point, strength: clamp01(strength), region };
    for (const cb of this.listeners) cb(e);
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Reading                                                                                                      */
  /* ---------------------------------------------------------------------------------------------------------- */

  readBones(out: Map<BoneName, THREE.Matrix4>): void {
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const b of this.skeleton.bones.values()) {
      const t = b.body.translation(), r = b.body.rotation();
      p.set(t.x, t.y, t.z);
      q.set(r.x, r.y, r.z, r.w);
      let m = out.get(b.name);
      if (!m) out.set(b.name, (m = new THREE.Matrix4()));
      m.compose(p, q, b.scale);
    }
    let root = out.get("root");
    if (!root) out.set("root", (root = new THREE.Matrix4()));
    if (this.mode === "driven" && this.rootTarget) root.copy(this.rootTarget);
    else root.multiplyMatrices(out.get("hips")!, this.rootFromHips);
  }

  readBody(): Float32Array {
    return this.body.read();
  }

  readLimbs(out: Map<string, Float32Array>): void {
    for (const f of this.flesh) if (f !== this.body) out.set(f.name, f.read());
  }

  raycast(ray: THREE.Ray): FrogHit | null {
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(v3(ray.origin), v3(ray.direction)), 100, true, undefined, GROUPS.ray,
    );
    if (!hit) return null;
    const point = ray.at(hit.timeOfImpact, new THREE.Vector3());
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    return { point, normal, region: this.regionOf(hit.collider.handle, point) };
  }

  /** The flesh a hit belongs to: the part with a free particle nearest to the point, among the ones of its region. */
  private fleshAt(point: THREE.Vector3, region?: HitRegion): Flesh {
    const limb = region === "arm" || region === "leg";
    const candidates = region ? this.flesh.filter((f) => (f === this.body) !== limb) : this.flesh;
    let best = this.body, bd = Infinity;
    for (const f of candidates.length ? candidates : this.flesh) {
      const P = f.soft.particlePositions();
      for (const i of f.free) {
        const d = (P[i * 3] - point.x) ** 2 + (P[i * 3 + 1] - point.y) ** 2 + (P[i * 3 + 2] - point.z) ** 2;
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Interactions                                                                                                 */
  /* ---------------------------------------------------------------------------------------------------------- */

  poke(hit: FrogHit, strength: number, direction: THREE.Vector3): void {
    const s = clamp01(strength);
    const flesh = this.fleshAt(hit.point, hit.region);
    const radius = flesh === this.body ? 0.14 : 0.08;
    flesh.push(hit.point, direction.clone().normalize().multiplyScalar(lerp(1.5, 5, s)), radius);
    this.emit("poke", hit.point.clone(), s, hit.region);
  }

  slap(point: THREE.Vector3, velocity: THREE.Vector3): void {
    const speed = Math.min(velocity.length(), 20);
    if (speed < 1e-3) return;
    const dv = velocity.clone().setLength(speed * 0.35);
    for (const f of this.flesh) f.push(point, dv, 0.26);
    this.emit("slap", point.clone(), clamp01(speed / 12), hitRegion(this.fleshAt(point).regionAt(point)));
  }

  grab(hit: FrogHit): GrabHandle {
    const flesh = this.fleshAt(hit.point, hit.region);
    const particles = flesh.nearestFree(hit.point, flesh === this.body ? 0.08 : 0.05);
    const hand = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hit.point.x, hit.point.y, hit.point.z),
    );
    for (const i of particles) flesh.soft.attachParticle(i, hand);
    const g: Grab = { hand, flesh, particles, start: hit.point.clone(), target: hit.point.clone() };
    this.grabs.add(g);
    this.emit("grab", hit.point.clone(), 0.5, hit.region);
    return {
      move: (target) => {
        g.target.copy(target);
        g.target.y = Math.max(g.target.y, 0.03);
        // Held by its bones in driven mode, the frog only lets its flesh be pulled so far.
        if (this.mode === "driven") {
          const off = g.target.clone().sub(g.start);
          if (off.length() > 0.22) g.target.copy(g.start).add(off.setLength(0.22));
        }
      },
      release: (velocity) => this.release(g, velocity),
    };
  }

  private moveGrab(g: Grab) {
    const t = g.hand.translation();
    const cur = new THREE.Vector3(t.x, t.y, t.z);
    const step = g.target.clone().sub(cur);
    // At most 12 m/s, so nothing is pulled through the floor or flung apart within one step.
    const max = 12 * SIM_DT;
    if (step.length() > max) step.setLength(max);
    g.hand.setNextKinematicTranslation(v3(cur.add(step)));
  }

  private release(g: Grab, velocity: THREE.Vector3) {
    if (!this.grabs.delete(g)) return;
    for (const i of g.particles) g.flesh.soft.detachParticle(i);
    const t = g.hand.translation();
    this.world.removeRigidBody(g.hand);
    const v = velocity.clone();
    if (v.length() > MAX_THROW_SPEED) v.setLength(MAX_THROW_SPEED);
    if (this.mode === "free" && v.length() > 1.2) {
      // The whole frog carries the throw, not only the pinched flesh.
      const dv = v.clone().sub(this.skeleton.velocity()).multiplyScalar(0.85);
      this.skeleton.addVelocity(dv);
      for (const f of this.flesh) {
        const M = f.soft.mass();
        f.soft.applyImpulse({ x: dv.x * M, y: dv.y * M, z: dv.z * M }, true);
      }
      this.sinceKnock = 0;
    }
    this.emit("release", new THREE.Vector3(t.x, t.y, t.z), clamp01(v.length() / MAX_THROW_SPEED));
  }

  throwBall(origin: THREE.Vector3, velocity: THREE.Vector3, radius = 0.07): void {
    if (this.balls.length >= MAX_BALLS) this.removeBall(this.balls[0]);
    const v = velocity.clone();
    if (v.length() > 25) v.setLength(25);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setLinvel(v.x, v.y, v.z)
        .setCcdEnabled(true)
        .setLinearDamping(0.05)
        .setAngularDamping(0.3),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setMass(0.25 * (radius / 0.07) ** 3)
        .setRestitution(0.6)
        .setFriction(0.5)
        .setCollisionGroups(GROUPS.ball)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    );
    this.balls.push({ body, collider, radius, speed: v.length() });
  }

  private removeBall(b: Ball) {
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
    for (const g of [...this.grabs]) this.release(g, new THREE.Vector3());
    this.skeleton.reset();
    for (const f of this.flesh) f.reset();
    this.rootTarget = null;
    this.sinceKnock = 10;
  }

  onEvent(cb: (e: FrogEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.listeners.clear();
    this.queue.free();
    this.world.free();
  }

  stats(): FrogStats {
    let particles = 0, free = 0, cells = 0;
    for (const f of this.flesh) {
      particles += f.soft.numParticles();
      free += f.free.length;
      cells += f.soft.numCells();
    }
    return {
      particles, attached: particles - free, cells,
      volumeRatio: this.body.soft.volume() / this.body.soft.restVolume(),
      deformation: this.deformation,
      time: this.time,
    };
  }
}
