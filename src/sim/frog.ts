/**
 * 奶蛙's body in Rapier 0.21: a rigid skeleton (one body per core bone, spherical joints with motors) inside a
 * volumetric soft body filling the Body surface. The flesh's deep particles are attached to the torso bones, the
 * rest is free to jiggle; a coarse copy of the surface embedded in the cells collides with the world.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import {
  CORE_BONES,
  type BodyMode,
  type BoneName,
  type CoreBone,
  type FrogEvent,
  type FrogEventKind,
  type FrogHit,
  type FrogSim,
  type GrabHandle,
  type HitRegion,
  type PhysicsParams,
  type RigSpec,
} from "../contracts";
import { TriMesh, coarseSkin } from "./geometry";

let ready: Promise<void> | null = null;
/** Load Rapier's WebAssembly (once). */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init());
}

/** Fixed physics step; a frame runs as many as its time needs, at most MAX_STEPS. */
export const SIM_DT = 1 / 60;
const MAX_STEPS = 3;
/** About this many flesh particles, whatever the size of the body. */
const TARGET_PARTICLES = 450;
const FLESH_MASS = 14;
const BONE_MASS: Partial<Record<CoreBone, number>> = {
  hips: 2, spine: 1.5, chest: 1.5, head: 1, upperarm_L: 0.4, upperarm_R: 0.4, forearm_L: 0.3, forearm_R: 0.3,
  hand_L: 0.15, hand_R: 0.15, thigh_L: 0.8, thigh_R: 0.8, shin_L: 0.5, shin_R: 0.5, foot_L: 0.4, foot_R: 0.4,
};
const TORSO: CoreBone[] = ["hips", "spine", "chest", "head"];
const MAX_BALLS = 24;
const MAX_THROW_SPEED = 9;

/* Collision groups: membership << 16 | filter. */
const G_FLOOR = 1, G_FLESH = 2, G_TORSO = 4, G_LIMB = 8, G_BALL = 16, G_LIMB_FLESH = 32;
const groups = (member: number, filter: number) => (member << 16) | filter;
const FLOOR_GROUPS = groups(G_FLOOR, G_FLESH | G_TORSO | G_LIMB | G_BALL);
const FLESH_GROUPS = groups(G_FLESH, G_FLOOR | G_BALL | G_LIMB_FLESH);
const TORSO_GROUPS = groups(G_TORSO, G_FLOOR | G_BALL);
const LIMB_GROUPS = groups(G_LIMB, G_FLOOR | G_BALL);
const LIMB_FLESH_GROUPS = groups(G_LIMB_FLESH, G_FLESH);
const BALL_GROUPS = groups(G_BALL, G_FLOOR | G_FLESH | G_TORSO | G_LIMB | G_BALL);
const RAY_GROUPS = groups(G_BALL, G_FLESH | G_LIMB);

const ANG_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ];

interface Bone {
  name: CoreBone;
  body: RAPIER.RigidBody;
  parent: Bone | null;
  joint: RAPIER.ImpulseJoint | null;
  restPos: THREE.Vector3;
  restRot: THREE.Quaternion;
  scale: THREE.Vector3;
  region: HitRegion;
  /** Motor stiffness at full stubbornness (N·m/rad), and the one now set. */
  hold: number;
  stiffness: number;
  /** Driven-mode target, and the pose the blend into driven mode starts from. */
  targetPos: THREE.Vector3;
  targetRot: THREE.Quaternion;
  fromPos: THREE.Vector3;
  fromRot: THREE.Quaternion;
}

interface Ball {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
  speed: number;
}

interface Grab {
  hand: RAPIER.RigidBody;
  particles: number[];
  start: THREE.Vector3;
  target: THREE.Vector3;
}

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });
const q4 = (q: THREE.Quaternion) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpLog = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const t = clamp01(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function regionOf(name: CoreBone): HitRegion {
  if (name === "head") return "head";
  if (/arm|hand/.test(name)) return "arm";
  if (/thigh|shin|foot/.test(name)) return "leg";
  return "body";
}

/** Numbers about the simulation, for tests and the dev page. */
export interface FrogStats {
  particles: number;
  attached: number;
  cells: number;
  volumeRatio: number;
  /** Mean distance (m) of the free flesh from where its bones would carry it: how much it is jiggling. */
  deformation: number;
  time: number;
}

export function createFrogSim(spec: RigSpec, params: PhysicsParams): FrogSim & { stats(): FrogStats } {
  return new Frog(spec, params);
}

class Frog implements FrogSim {
  private world: RAPIER.World;
  private queue = new RAPIER.EventQueue(true);
  private floor: RAPIER.Collider;
  private bones = new Map<CoreBone, Bone>();
  private boneByCollider = new Map<number, Bone>();
  private flesh: RAPIER.SoftBody;
  private fleshCollider: RAPIER.Collider;
  private restParticles: Float32Array;
  /** Per particle: the torso bone it rides on, or -1 for free flesh. */
  private attachedTo: Int8Array;
  /** Free particles' rest offsets in the frame of their nearest torso bone (for the deformation measure). */
  private freeParticles: number[] = [];
  private freeBone: Bone[] = [];
  private freeOffset: THREE.Vector3[] = [];
  /** Per Body vertex: hit region. */
  private vertexRegion: HitRegion[];
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
  /** Floor contacts of the frog's colliders, and how long it has been in the air. */
  private floorContacts = 0;
  private airTime = 0;
  private fallSpeed = 0;
  /** Time since the frog was knocked about (landing, throw): its limbs stay floppy for a moment. */
  private sinceKnock = 10;
  private deformation = 0;
  private squished = false;
  private bodyOut: Float32Array;
  /** Kinematic reference keeping world up, jointed to the hips, and the tilt stiffness now set. */
  private upright!: RAPIER.RigidBody;
  private uprightJoint!: RAPIER.ImpulseJoint;
  private uprightStiffness = -1;

  constructor(
    private spec: RigSpec,
    params: PhysicsParams,
  ) {
    this.params = { ...params };
    this.world = new RAPIER.World({ x: 0, y: -9.81 * params.gravity, z: 0 });
    const ip = this.world.integrationParameters;
    // Fast hits get a fixed budget instead of up to 4 extra substeps (which made frame times spike).
    ip.softBodiesMaxExtraSubsteps = 1;
    this.world.timestep = SIM_DT;

    this.floor = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(30, 1, 30)
        .setTranslation(0, -1, 0)
        .setFriction(0.9)
        .setCollisionGroups(FLOOR_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
    );
    // Walls keep the frog and the balls in the play area.
    for (const [x, z, hx, hz] of [[6.5, 0, 0.5, 7], [-6.5, 0, 0.5, 7], [0, 6.5, 7, 0.5], [0, -6.5, 7, 0.5]]) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 6, hz).setTranslation(x, 6, z).setCollisionGroups(FLOOR_GROUPS),
      );
    }

    const surface = new TriMesh(spec.body.positions, spec.body.indices);
    this.buildSkeleton(surface);
    const hips = this.bone("hips");
    const root = spec.bones.find((b) => b.name === "root");
    const hipsRest = new THREE.Matrix4().compose(hips.restPos, hips.restRot, hips.scale);
    this.rootFromHips = hipsRest.clone().invert().multiply(root ? root.restWorld : new THREE.Matrix4());

    const cell = Math.cbrt((4.7 * surface.volume()) / TARGET_PARTICLES);
    const desc = RAPIER.SoftBodyDesc.volumetric(spec.body.positions, spec.body.indices, cell, true);
    if (!desc) throw new Error("sim: the Body surface cannot be filled with cells (is it closed?)");
    desc
      .setNoSurfaceCollider()
      .setMass(FLESH_MASS)
      .setParticleRadius(0.01)
      .setVolumePreservation(true)
      .setVolumeFactor(params.bellySize)
      .setMaterial(this.material(params));
    this.flesh = this.world.createSoftBody(desc);
    this.restParticles = this.flesh.particlePositions();

    const skin = coarseSkin(surface, this.restParticles, this.flesh.boundary());
    const proxy = this.flesh.rootBody();
    const o = proxy.translation();
    for (let i = 0; i < skin.positions.length; i += 3) {
      skin.positions[i] -= o.x;
      skin.positions[i + 1] -= o.y;
      skin.positions[i + 2] -= o.z;
    }
    const skinDesc = RAPIER.ColliderDesc.trimesh(
      skin.positions,
      skin.indices,
      RAPIER.TriMeshFlags.DEFORMABLE | RAPIER.TriMeshFlags.ORIENTED,
    );
    if (!skinDesc) throw new Error("sim: no collision skin");
    skinDesc.setDensity(0).setFriction(0.8).setRestitution(0.1).setCollisionGroups(FLESH_GROUPS);
    const collider = this.world.createDeformableCollider(skinDesc, RAPIER.SoftMeshBinding.skinned(), proxy);
    if (!collider) throw new Error("sim: the collision skin cannot be bound to the flesh");
    this.fleshCollider = collider;

    this.buildUpright();
    this.attachedTo = this.attachFlesh(surface);
    this.vertexRegion = this.bodyRegions();
    this.bodyOut = new Float32Array(spec.body.positions.length);
    this.setParams(params);
  }

  private bone(name: CoreBone): Bone {
    const b = this.bones.get(name);
    if (!b) throw new Error(`sim: rig has no bone ${name}`);
    return b;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Building                                                                                                     */
  /* ---------------------------------------------------------------------------------------------------------- */

  private buildSkeleton(surface: TriMesh) {
    const specBones = new Map(this.spec.bones.map((b) => [b.name, b]));
    for (const name of CORE_BONES) {
      if (name === "root") continue;
      const rb = specBones.get(name);
      if (!rb) throw new Error(`sim: rig has no bone ${name}`);
      const restPos = new THREE.Vector3(), restRot = new THREE.Quaternion(), scale = new THREE.Vector3();
      rb.restWorld.decompose(restPos, restRot, scale);
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(restPos.x, restPos.y, restPos.z)
          .setRotation(q4(restRot))
          .setAngularDamping(0.5)
          .setLinearDamping(0.05),
      );
      const parent = rb.parent && rb.parent !== "root" ? this.bones.get(rb.parent as CoreBone) ?? null : null;
      const torso = TORSO.includes(name);
      const bone: Bone = {
        name, body, parent, joint: null, restPos, restRot, scale, region: regionOf(name),
        hold: torso ? 600 : /thigh|shin|foot/.test(name) ? 500 : 40,
        stiffness: -1,
        targetPos: restPos.clone(), targetRot: restRot.clone(), fromPos: restPos.clone(), fromRot: restRot.clone(),
      };
      this.bones.set(name, bone);
      this.addBoneColliders(bone, rb.tail, rb.radius, surface, torso);
      if (parent) {
        const toParent = new THREE.Matrix4().compose(parent.restPos, parent.restRot, new THREE.Vector3(1, 1, 1)).invert();
        const anchor = restPos.clone().applyMatrix4(toParent);
        const rel = parent.restRot.clone().invert().multiply(restRot);
        const joint = this.world.createImpulseJoint(
          RAPIER.JointData.spherical(v3(anchor), { x: 0, y: 0, z: 0 }), parent.body, body, true,
        );
        // Frame 1 is the child's rest orientation, so the motors' zero is the rest pose.
        joint.setLocalFrame1(v3(anchor), q4(rel));
        // Rapier hands back spherical joints as generic ones, without the motor methods: use the raw set.
        for (const axis of ANG_AXES) {
          this.world.impulseJoints.raw.jointConfigureMotorModel(joint.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
        }
        bone.joint = joint;
      }
    }
  }

  /** A capsule along the bone carries its mass and meets the floor and balls; limbs get a second capsule, trimmed
   *  to where the bone has left the body, that presses into the flesh. */
  private addBoneColliders(bone: Bone, tail: THREE.Vector3, radius: number, surface: TriMesh, torso: boolean) {
    const head = bone.restPos;
    const toLocal = new THREE.Matrix4().compose(head, bone.restRot, new THREE.Vector3(1, 1, 1)).invert();
    const mass = BONE_MASS[bone.name] ?? 0.3;
    let r = radius;
    if (torso) {
      // Bones inside the flesh stay well inside it: half the depth of the flesh around them.
      let depth = Infinity;
      for (let s = 0; s <= 8; s++) {
        const p = head.clone().lerp(tail, s / 8);
        depth = Math.min(depth, -surface.signedDistance(p.x, p.y, p.z));
      }
      r = Math.max(0.02, Math.min(radius, depth * 0.5));
    }
    const add = (a: THREE.Vector3, b: THREE.Vector3, rad: number, groups: number, m: number) => {
      const la = a.clone().applyMatrix4(toLocal), lb = b.clone().applyMatrix4(toLocal);
      const len = la.distanceTo(lb);
      const dir = lb.clone().sub(la).normalize();
      const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), len > 1e-6 ? dir : new THREE.Vector3(0, 1, 0));
      const mid = la.add(lb).multiplyScalar(0.5);
      const c = this.world.createCollider(
        RAPIER.ColliderDesc.capsule(len / 2, rad)
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation(q4(rot))
          .setMass(m)
          .setFriction(0.9)
          .setCollisionGroups(groups),
        bone.body,
      );
      this.boneByCollider.set(c.handle, bone);
    };
    add(head, tail, r, torso ? TORSO_GROUPS : LIMB_GROUPS, mass);
    if (torso) return;
    const margin = 0.01;
    let start = -1;
    for (let s = 16; s >= 0; s--) {
      const p = head.clone().lerp(tail, s / 16);
      if (surface.signedDistance(p.x, p.y, p.z) > r + margin) start = s;
      else break;
    }
    if (start >= 0 && start < 16) add(head.clone().lerp(tail, start / 16), tail, r, LIMB_FLESH_GROUPS, 0);
  }

  /** The roly-poly: a joint from a kinematic reference to the hips, free in translation and heading, whose tilt
   *  motors pull the hips upright. Motors are implicit springs, so any stubbornness stays stable. */
  private buildUpright() {
    const hips = this.bone("hips");
    this.upright = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hips.restPos.x, hips.restPos.y, hips.restPos.z),
    );
    const zero = { x: 0, y: 0, z: 0 };
    const j = this.world.createImpulseJoint(
      RAPIER.JointData.generic(zero, zero, { x: 1, y: 0, z: 0 }, 0 as RAPIER.JointAxesMask), this.upright, hips.body, true,
    );
    j.setLocalFrame2(zero, q4(hips.restRot.clone().invert()));
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      this.world.impulseJoints.raw.jointConfigureMotorModel(j.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
    }
    this.uprightJoint = j;
  }

  /** Deep particles ride on the nearest torso bone; the flesh layer over them is free, thickest where the Body is
   *  softest (the belly). */
  private attachFlesh(surface: TriMesh): Int8Array {
    const n = this.flesh.numParticles();
    const attached = new Int8Array(n).fill(-1);
    const P = this.restParticles;
    const soft = this.spec.body.softness;
    const V = this.spec.body.positions;
    const torso = TORSO.map((name) => {
      const b = this.bone(name);
      const tail = this.spec.bones.find((s) => s.name === name)!.tail;
      return { b, head: b.restPos, tail };
    });
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      let softness = 0.3;
      if (soft) {
        let best = Infinity;
        for (let v = 0; v < soft.length; v++) {
          const d = (V[v * 3] - p.x) ** 2 + (V[v * 3 + 1] - p.y) ** 2 + (V[v * 3 + 2] - p.z) ** 2;
          if (d < best) {
            best = d;
            softness = soft[v];
          }
        }
      }
      let nearest = 0, nd = Infinity;
      torso.forEach((t, k) => {
        const d = segmentDistance(p, t.head, t.tail);
        if (d < nd) {
          nd = d;
          nearest = k;
        }
      });
      const depth = -surface.signedDistance(p.x, p.y, p.z);
      const bone = torso[nearest].b;
      if (depth > 0.05 + 0.07 * softness) {
        this.flesh.attachParticle(i, bone.body);
        attached[i] = nearest;
      } else {
        const inv = new THREE.Matrix4().compose(bone.restPos, bone.restRot, new THREE.Vector3(1, 1, 1)).invert();
        this.freeParticles.push(i);
        this.freeBone.push(bone);
        this.freeOffset.push(p.clone().applyMatrix4(inv));
      }
    }
    return attached;
  }

  private bodyRegions(): HitRegion[] {
    const V = this.spec.body.positions, soft = this.spec.body.softness;
    const head = this.bone("head"), hips = this.bone("hips"), chest = this.bone("chest");
    const out: HitRegion[] = [];
    const p = new THREE.Vector3();
    for (let v = 0; v < V.length / 3; v++) {
      p.set(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]);
      if (p.y > head.restPos.y - 0.02) out.push("head");
      else if (soft ? soft[v] > 0.55 : p.y > hips.restPos.y && p.y < chest.restPos.y && p.z > 0.05) out.push("belly");
      else out.push("body");
    }
    return out;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Parameters and modes                                                                                         */
  /* ---------------------------------------------------------------------------------------------------------- */

  private material(p: PhysicsParams): RAPIER.SoftBodyMaterial {
    const m = new RAPIER.SoftBodyMaterial();
    const f = lerpLog(14, 3, clamp01(p.softness));
    const z = lerpLog(0.9, 0.06, clamp01(p.bounciness));
    m.edgeSoftness = { naturalFrequency: f, dampingRatio: z };
    m.bendSoftness = { naturalFrequency: f, dampingRatio: z };
    m.volumeSoftness = { naturalFrequency: f * 2, dampingRatio: z };
    m.shapeMatchingSoftness = { naturalFrequency: f, dampingRatio: z };
    return m;
  }

  setParams(p: PhysicsParams): void {
    this.params = { ...p };
    this.world.gravity = { x: 0, y: -9.81 * Math.max(0, p.gravity), z: 0 };
    this.flesh.setMaterial(this.material(p));
    this.flesh.setVolumeFactor(Math.min(2, Math.max(0.5, p.bellySize)));
    this.flesh.wakeUp();
    for (const b of this.bones.values()) b.body.wakeUp();
  }

  setMode(m: BodyMode): void {
    if (m === this.mode) return;
    this.mode = m;
    for (const b of this.bones.values()) {
      const t = b.body.translation(), r = b.body.rotation();
      b.fromPos.set(t.x, t.y, t.z);
      b.fromRot.set(r.x, r.y, r.z, r.w);
      if (m === "driven") {
        b.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      } else {
        const lv = b.body.linvel(), av = b.body.angvel();
        b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        b.body.setLinvel(lv, true);
        b.body.setAngvel(av, true);
      }
    }
    this.driveBlend = m === "driven" ? 0 : 1;
    this.flesh.wakeUp();
  }

  setTargets(boneWorld: Map<BoneName, THREE.Matrix4>): void {
    const s = new THREE.Vector3();
    for (const [name, m] of boneWorld) {
      if (name === "root") {
        (this.rootTarget ??= new THREE.Matrix4()).copy(m);
        continue;
      }
      const b = this.bones.get(name as CoreBone);
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
    if (this.mode === "driven") this.drive();
    else this.balance();
    for (const g of this.grabs) this.moveGrab(g);
    for (const b of this.balls) b.speed = Math.hypot(...Object.values(b.body.linvel()));
    const comVel = this.frogVelocity();
    this.world.step(this.queue);
    this.time += SIM_DT;
    this.sinceKnock += SIM_DT;
    this.events(comVel);
    this.cullBalls();
  }

  /** Kinematic bones move to their targets (blended in from where they were when driven mode began). */
  private drive() {
    this.driveBlend = Math.min(1, this.driveBlend + SIM_DT / 0.35);
    const w = this.driveBlend * this.driveBlend * (3 - 2 * this.driveBlend);
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const b of this.bones.values()) {
      p.lerpVectors(b.fromPos, b.targetPos, w);
      q.slerpQuaternions(b.fromRot, b.targetRot, w);
      b.body.setNextKinematicTranslation(v3(p));
      b.body.setNextKinematicRotation(q4(q));
    }
  }

  /** Free mode: joints hold the rest pose and the torso rights itself, as hard as stubbornness says; right after a
   *  knock the limbs go floppy and the frog gathers itself again. */
  private balance() {
    const raw = this.world.impulseJoints.raw;
    const s = clamp01(this.params.stubbornness);
    const recover = clamp01((this.sinceKnock - 0.4) / 1.2);
    const tone = lerp(0.04, 1, s) * lerp(0.15, 1, recover);
    for (const b of this.bones.values()) {
      const k = b.hold * tone;
      // Reconfigured only on change; low damping, since Rapier's soft motors lose static stiffness to damping.
      if (!b.joint || Math.abs(k - b.stiffness) < 1e-3 * b.hold) continue;
      b.stiffness = k;
      for (const axis of ANG_AXES) raw.jointConfigureMotorPosition(b.joint.handle, axis as number, 0, k, 0.2 * Math.sqrt(k));
    }
    const hips = this.bone("hips");
    const t = hips.body.translation(), r = hips.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w).multiply(hips.restRot.clone().invert());
    // The reference turns with the frog's heading, so only the tilt is pulled back.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z));
    this.upright.setNextKinematicTranslation(t);
    this.upright.setNextKinematicRotation(q4(yaw));
    // Standing on its feet it balances by itself; the pull only engages once it leans (else it fights the legs).
    const tilt = new THREE.Vector3(0, 1, 0).applyQuaternion(q).angleTo(new THREE.Vector3(0, 1, 0));
    const k = 150 * s * lerp(0.3, 1, recover) * THREE.MathUtils.smoothstep(tilt, 0.1, 0.3);
    if (Math.abs(k - this.uprightStiffness) < 0.5) return;
    this.uprightStiffness = k;
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      raw.jointConfigureMotorPosition(this.uprightJoint.handle, axis as number, 0, k, 0.1 * k);
    }
  }

  private frogVelocity(): THREE.Vector3 {
    let m = 0;
    const v = new THREE.Vector3();
    for (const b of this.bones.values()) {
      const bm = b.body.mass(), lv = b.body.linvel();
      v.x += lv.x * bm;
      v.y += lv.y * bm;
      v.z += lv.z * bm;
      m += bm;
    }
    return v.multiplyScalar(1 / Math.max(m, 1e-6));
  }

  private events(comVel: THREE.Vector3) {
    const frogHandles = (h: number) => h === this.fleshCollider.handle || this.boneByCollider.has(h);
    this.queue.drainCollisionEvents((h1, h2, started) => {
      const floor = this.floor.handle;
      if (h1 === floor || h2 === floor) {
        const other = h1 === floor ? h2 : h1;
        if (!frogHandles(other)) return;
        this.floorContacts = Math.max(0, this.floorContacts + (started ? 1 : -1));
        if (started && this.floorContacts === 1 && this.airTime > 0.25 && this.mode === "free") {
          const strength = clamp01(this.fallSpeed / 7);
          if (strength > 0.08) {
            this.sinceKnock = 0;
            this.emit("land", this.lowestPoint(), strength);
          }
        }
        return;
      }
      if (!started) return;
      const ball = this.balls.find((b) => b.collider.handle === h1 || b.collider.handle === h2);
      if (!ball) return;
      const other = ball.collider.handle === h1 ? h2 : h1;
      if (!frogHandles(other)) return;
      const t = ball.body.translation();
      const point = new THREE.Vector3(t.x, t.y, t.z);
      const bone = this.boneByCollider.get(other);
      this.emit("ball", point, clamp01(ball.speed / 12), bone ? bone.region : this.regionAt(point));
    });
    if (this.floorContacts === 0) {
      this.airTime += SIM_DT;
      this.fallSpeed = Math.max(this.fallSpeed, -comVel.y);
    } else {
      this.airTime = 0;
      this.fallSpeed = 0;
    }
    // Squish: how far the free flesh is from where the bones would carry it.
    const P = this.flesh.particlePositions();
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const pose = new Map<Bone, THREE.Matrix4>();
    let sum = 0;
    this.freeParticles.forEach((i, k) => {
      const b = this.freeBone[k];
      let bm = pose.get(b);
      if (!bm) {
        const t = b.body.translation(), r = b.body.rotation();
        bm = m.clone().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), one);
        pose.set(b, bm);
      }
      p.copy(this.freeOffset[k]).applyMatrix4(bm);
      sum += Math.hypot(P[i * 3] - p.x, P[i * 3 + 1] - p.y, P[i * 3 + 2] - p.z);
    });
    this.deformation = sum / Math.max(1, this.freeParticles.length);
    if (!this.squished && this.deformation > 0.03) {
      this.squished = true;
      this.emit("squish", this.lowestPoint(), clamp01(this.deformation / 0.09));
    } else if (this.squished && this.deformation < 0.018) this.squished = false;
  }

  private lowestPoint(): THREE.Vector3 {
    const c = this.flesh.centerOfMass();
    return new THREE.Vector3(c.x, 0, c.z);
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
    for (const b of this.bones.values()) {
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
    this.bodyOut.set(this.flesh.meshVertices(0));
    return this.bodyOut;
  }

  raycast(ray: THREE.Ray): FrogHit | null {
    const hit = this.world.castRayAndGetNormal(
      new RAPIER.Ray(v3(ray.origin), v3(ray.direction)), 100, true, undefined, RAY_GROUPS,
    );
    if (!hit) return null;
    const point = ray.at(hit.timeOfImpact, new THREE.Vector3());
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    const bone = this.boneByCollider.get(hit.collider.handle);
    return { point, normal, region: bone ? bone.region : this.regionAt(point) };
  }

  private regionAt(point: THREE.Vector3): HitRegion {
    const V = this.flesh.meshVertices(0);
    let best = Infinity, region: HitRegion = "body";
    for (let v = 0; v < V.length / 3; v++) {
      const d = (V[v * 3] - point.x) ** 2 + (V[v * 3 + 1] - point.y) ** 2 + (V[v * 3 + 2] - point.z) ** 2;
      if (d < best) {
        best = d;
        region = this.vertexRegion[v];
      }
    }
    return region;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Interactions                                                                                                 */
  /* ---------------------------------------------------------------------------------------------------------- */

  /** Impulse on the free flesh around a point, fading smoothly to nothing at radius. */
  private push(point: THREE.Vector3, dv: THREE.Vector3, radius: number) {
    const P = this.flesh.particlePositions();
    for (const i of this.freeParticles) {
      const d = Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) / radius;
      if (d >= 1) continue;
      const w = (1 - d * d) ** 2;
      const m = this.flesh.particleMass(i) * w;
      this.flesh.applyParticleImpulse(i, { x: dv.x * m, y: dv.y * m, z: dv.z * m }, true);
    }
  }

  poke(hit: FrogHit, strength: number, direction: THREE.Vector3): void {
    const s = clamp01(strength);
    this.push(hit.point, direction.clone().normalize().multiplyScalar(lerp(1.5, 5, s)), 0.14);
    this.emit("poke", hit.point.clone(), s, hit.region);
  }

  slap(point: THREE.Vector3, velocity: THREE.Vector3): void {
    const speed = Math.min(velocity.length(), 20);
    if (speed < 1e-3) return;
    this.push(point, velocity.clone().setLength(speed * 0.35), 0.26);
    this.emit("slap", point.clone(), clamp01(speed / 12), this.regionAt(point));
  }

  grab(hit: FrogHit): GrabHandle {
    const P = this.flesh.particlePositions();
    const near = this.freeParticles
      .map((i) => ({ i, d: Math.hypot(P[i * 3] - hit.point.x, P[i * 3 + 1] - hit.point.y, P[i * 3 + 2] - hit.point.z) }))
      .sort((a, b) => a.d - b.d);
    const picked = near.filter((n, k) => k < 3 || n.d < 0.08).slice(0, 8).map((n) => n.i);
    const hand = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hit.point.x, hit.point.y, hit.point.z),
    );
    for (const i of picked) this.flesh.attachParticle(i, hand);
    const g: Grab = { hand, particles: picked, start: hit.point.clone(), target: hit.point.clone() };
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
    // At most 12 m/s, so nothing is torn through the floor or flung apart within one step.
    const max = 12 * SIM_DT;
    if (step.length() > max) step.setLength(max);
    g.hand.setNextKinematicTranslation(v3(cur.add(step)));
  }

  private release(g: Grab, velocity: THREE.Vector3) {
    if (!this.grabs.delete(g)) return;
    for (const i of g.particles) this.flesh.detachParticle(i);
    const t = g.hand.translation();
    this.world.removeRigidBody(g.hand);
    const v = velocity.clone();
    if (v.length() > MAX_THROW_SPEED) v.setLength(MAX_THROW_SPEED);
    if (this.mode === "free" && v.length() > 1.2) {
      // The whole frog carries the throw, not only the pinched flesh.
      const dv = v.clone().sub(this.frogVelocity()).multiplyScalar(0.85);
      for (const b of this.bones.values()) {
        const lv = b.body.linvel();
        b.body.setLinvel({ x: lv.x + dv.x, y: lv.y + dv.y, z: lv.z + dv.z }, true);
      }
      const M = this.flesh.mass();
      this.flesh.applyImpulse({ x: dv.x * M, y: dv.y * M, z: dv.z * M }, true);
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
        .setCollisionGroups(BALL_GROUPS)
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
    for (const b of this.bones.values()) {
      b.body.setTranslation(v3(b.restPos), true);
      b.body.setRotation(q4(b.restRot), true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.fromPos.copy(b.restPos);
      b.fromRot.copy(b.restRot);
      b.targetPos.copy(b.restPos);
      b.targetRot.copy(b.restRot);
    }
    const P = this.restParticles;
    for (let i = 0; i < P.length / 3; i++) {
      this.flesh.setParticlePosition(i, { x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
      this.flesh.setParticleVelocity(i, { x: 0, y: 0, z: 0 });
    }
    this.rootTarget = null;
    this.sinceKnock = 10;
    this.flesh.wakeUp();
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
    return {
      particles: this.flesh.numParticles(),
      attached: this.attachedTo.filter((a) => a >= 0).length,
      cells: this.flesh.numCells(),
      volumeRatio: this.flesh.volume() / this.flesh.restVolume(),
      deformation: this.deformation,
      time: this.time,
    };
  }
}
