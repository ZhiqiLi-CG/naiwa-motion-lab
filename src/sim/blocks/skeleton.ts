/**
 * The frog's rigid skeleton: one Rapier body per core bone (root excepted) joined by spherical joints with motors
 * and limits, and the roly-poly joint that rights the hips.
 *
 * free mode: every bone is dynamic; the motors hold the rest pose (as strongly as the frog's tone).
 * driven mode: the torso (hips … head) follows the pose targets kinematically; the limbs stay dynamic and their motors
 * pull them to the targets, so a hand that meets the belly presses into it instead of passing through.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { CORE_BONES, type CoreBone, type HitRegion, type RigBone, type RigSpec } from "../contracts";
import type { BoneShape, SimBone } from "./api";
import { segmentDistance, type TriMesh } from "./geometry";

/* Collision groups: membership << 16 | filter. */
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

export const TORSO: readonly CoreBone[] = ["hips", "spine", "chest", "head"];

interface Joint {
  mass: number;
  /** Motor stiffness holding the rest pose at full tone, and pulling to the targets in driven mode (N·m/rad). Rapier's
   *  soft motors lose much of their static stiffness under a heavy load, hence the large values for the legs. */
  hold: number;
  drive: number;
  /** Limits (degrees): swing away from the rest direction, twist about the bone. */
  swing: number;
  twist: number;
}
const JOINTS: Record<string, Joint> = {
  hips: { mass: 2, hold: 0, drive: 0, swing: 0, twist: 0 },
  spine: { mass: 1.5, hold: 3000, drive: 0, swing: 40, twist: 30 },
  chest: { mass: 1.5, hold: 3000, drive: 0, swing: 40, twist: 30 },
  head: { mass: 1, hold: 1500, drive: 0, swing: 60, twist: 70 },
  upperarm: { mass: 0.4, hold: 120, drive: 120, swing: 100, twist: 70 },
  forearm: { mass: 0.3, hold: 80, drive: 80, swing: 140, twist: 60 },
  hand: { mass: 0.15, hold: 30, drive: 30, swing: 80, twist: 40 },
  thigh: { mass: 0.8, hold: 5000, drive: 1500, swing: 100, twist: 40 },
  shin: { mass: 0.5, hold: 5000, drive: 1500, swing: 140, twist: 20 },
  foot: { mass: 0.4, hold: 3000, drive: 800, swing: 60, twist: 20 },
};
const jointOf = (name: CoreBone) => JOINTS[name.replace(/_[LR]$/, "")];

const ANG_AXES = [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ] as const;
const ONE = new THREE.Vector3(1, 1, 1);
export const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });
export const q4 = (q: THREE.Quaternion) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const DEG = Math.PI / 180;

export class Bone implements SimBone {
  joint: RAPIER.ImpulseJoint | null = null;
  readonly shapes: BoneShape[] = [];
  readonly restInverse: THREE.Matrix4;
  readonly torso: boolean;
  readonly region: HitRegion;
  /** The child's rest orientation in the parent's frame, and the joint's anchor there. */
  readonly restRel = new THREE.Quaternion();
  readonly anchor = new THREE.Vector3();
  /** Driven-mode target, and the pose the blend into driven mode starts from. */
  readonly targetPos: THREE.Vector3;
  readonly targetRot: THREE.Quaternion;
  readonly fromPos = new THREE.Vector3();
  readonly fromRot = new THREE.Quaternion();
  /** Motor stiffness now set. */
  stiffness = -1;

  constructor(
    readonly name: CoreBone,
    readonly body: RAPIER.RigidBody,
    readonly parent: Bone | null,
    readonly restPos: THREE.Vector3,
    readonly restRot: THREE.Quaternion,
    readonly scale: THREE.Vector3,
    readonly tail: THREE.Vector3,
  ) {
    this.restInverse = new THREE.Matrix4().compose(restPos, restRot, ONE).invert();
    this.torso = TORSO.includes(name);
    this.region = name === "head" ? "head" : /arm|hand/.test(name) ? "arm" : /thigh|shin|foot/.test(name) ? "leg" : "body";
    this.targetPos = restPos.clone();
    this.targetRot = restRot.clone();
    if (parent) {
      this.restRel.copy(parent.restRot).invert().multiply(restRot);
      this.anchor.copy(restPos).applyMatrix4(parent.restInverse);
    }
  }

  pose(out: THREE.Matrix4): THREE.Matrix4 {
    const t = this.body.translation(), r = this.body.rotation();
    return out.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), ONE);
  }
}

/** The flesh around a limb bone: its typical thickness and the surface points belonging to the bone. */
export interface BoneFlesh {
  radius: number;
  points: Float32Array;
}

export class Skeleton {
  readonly bones = new Map<CoreBone, Bone>();
  readonly byCollider = new Map<number, Bone>();
  private upright: RAPIER.RigidBody;
  private uprightJoint: RAPIER.ImpulseJoint;
  private uprightStiffness = -1;
  private raw: RAPIER.World["impulseJoints"]["raw"];

  constructor(
    private world: RAPIER.World,
    spec: RigSpec,
    body: TriMesh,
    limbFlesh: Map<CoreBone, BoneFlesh>,
  ) {
    this.raw = world.impulseJoints.raw;
    const specBones = new Map(spec.bones.map((b) => [b.name, b]));
    for (const name of CORE_BONES) {
      if (name === "root") continue;
      const rb = specBones.get(name);
      if (!rb) throw new Error(`sim: rig has no bone ${name}`);
      const restPos = new THREE.Vector3(), restRot = new THREE.Quaternion(), scale = new THREE.Vector3();
      rb.restWorld.decompose(restPos, restRot, scale);
      const rigid = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(restPos.x, restPos.y, restPos.z)
          .setRotation(q4(restRot))
          .setAngularDamping(0.5)
          .setLinearDamping(0.05),
      );
      const parent = rb.parent && rb.parent !== "root" ? this.bones.get(rb.parent as CoreBone) ?? null : null;
      const bone = new Bone(name, rigid, parent, restPos, restRot, scale, rb.tail.clone());
      this.bones.set(name, bone);
      this.addColliders(bone, rb, body, limbFlesh.get(name));
      if (parent) this.join(bone, parent);
    }
    const hips = this.bone("hips");
    this.upright = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hips.restPos.x, hips.restPos.y, hips.restPos.z),
    );
    const zero = { x: 0, y: 0, z: 0 };
    // No locked axes: the joint only acts through its tilt motors.
    this.uprightJoint = world.createImpulseJoint(
      RAPIER.JointData.generic(zero, zero, { x: 1, y: 0, z: 0 }, 0 as RAPIER.JointAxesMask), this.upright, hips.body, true,
    );
    this.uprightJoint.setLocalFrame2(zero, q4(hips.restRot.clone().invert()));
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      this.raw.jointConfigureMotorModel(this.uprightJoint.handle, axis, RAPIER.MotorModel.ForceBased);
    }
  }

  bone(name: CoreBone): Bone {
    const b = this.bones.get(name);
    if (!b) throw new Error(`sim: rig has no bone ${name}`);
    return b;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Building                                                                                                     */
  /* ---------------------------------------------------------------------------------------------------------- */

  /** The core collider carries the bone's mass and meets the floor and balls. Inside soft flesh it is the hard bone:
   *  a capsule half as thick as the flesh around it (torso: half as deep as the Body around it); a foot's is its flesh
   *  shrunk a little, a flat sole to stand on. A limb bone also gets a contact capsule as thick as its flesh over the
   *  flesh's length, trimmed to where it is clear of the Body at rest, which presses into the Body's flesh. */
  private addColliders(bone: Bone, rb: RigBone, body: TriMesh, flesh: BoneFlesh | undefined) {
    const { mass } = jointOf(bone.name);
    const head = bone.restPos, tail = rb.tail;
    if (bone.torso) {
      let depth = Infinity;
      for (let s = 0; s <= 8; s++) {
        const p = head.clone().lerp(tail, s / 8);
        depth = Math.min(depth, -body.signedDistance(p.x, p.y, p.z));
      }
      this.capsule(bone, head, tail, Math.max(0.02, Math.min(rb.radius, depth * 0.5)), "core", mass);
      return;
    }
    if (flesh && /foot/.test(bone.name)) this.sole(bone, flesh.points, mass);
    else this.capsule(bone, head, tail, flesh ? 0.45 * flesh.radius : rb.radius, "core", mass);

    // The contact capsule spans the flesh along the bone (a hand's reaches the finger tips).
    const r = 0.9 * (flesh?.radius ?? rb.radius);
    const dir = tail.clone().sub(head).normalize();
    let t0 = 0, t1 = head.distanceTo(tail);
    if (flesh) {
      t0 = Infinity;
      t1 = -Infinity;
      for (let i = 0; i < flesh.points.length; i += 3) {
        const t = (flesh.points[i] - head.x) * dir.x + (flesh.points[i + 1] - head.y) * dir.y + (flesh.points[i + 2] - head.z) * dir.z;
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
      }
      t0 = Math.max(0, t0 + r);
      t1 = Math.max(t0, t1 - r);
    }
    const at = (t: number) => head.clone().addScaledVector(dir, t);
    let start = -1;
    for (let s = 16; s >= 0; s--) {
      const p = at(t0 + ((t1 - t0) * s) / 16);
      if (body.signedDistance(p.x, p.y, p.z) > r + 0.01) start = s;
      else break;
    }
    if (start >= 0 && start < 16) this.capsule(bone, at(t0 + ((t1 - t0) * start) / 16), at(t1), r, "contact", 0);
  }

  private capsule(bone: Bone, a: THREE.Vector3, b: THREE.Vector3, radius: number, role: "core" | "contact", mass: number) {
    const la = a.clone().applyMatrix4(bone.restInverse), lb = b.clone().applyMatrix4(bone.restInverse);
    const len = la.distanceTo(lb);
    const dir = len > 1e-6 ? lb.clone().sub(la).normalize() : new THREE.Vector3(0, 1, 0);
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const mid = la.clone().add(lb).multiplyScalar(0.5);
    const c = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(len / 2, radius)
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation(q4(rot))
        .setMass(mass)
        .setFriction(0.9)
        .setCollisionGroups(role === "core" ? GROUPS.core : GROUPS.contact),
      bone.body,
    );
    this.byCollider.set(c.handle, bone);
    bone.shapes.push({ kind: "capsule", role, a: la, b: lb, radius });
  }

  private sole(bone: Bone, points: Float32Array, mass: number) {
    const c = new THREE.Vector3();
    for (let i = 0; i < points.length; i += 3) c.add(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
    c.multiplyScalar(3 / points.length);
    const local = new Float32Array(points.length);
    const p = new THREE.Vector3();
    for (let i = 0; i < points.length; i += 3) {
      // Shrunk towards its middle by 12%, but only 4% downwards: the flesh under a sole is thin.
      p.set(points[i], points[i + 1], points[i + 2]).sub(c);
      p.set(p.x * 0.88, p.y * (p.y < 0 ? 0.96 : 0.88), p.z * 0.88).add(c).applyMatrix4(bone.restInverse);
      local.set([p.x, p.y, p.z], i);
    }
    const desc = RAPIER.ColliderDesc.convexHull(local);
    if (!desc) throw new Error(`sim: no sole for ${bone.name}`);
    const col = this.world.createCollider(desc.setMass(mass).setFriction(0.9).setCollisionGroups(GROUPS.core), bone.body);
    this.byCollider.set(col.handle, bone);
    bone.shapes.push({ kind: "hull", role: "core", points: local });
  }

  private join(bone: Bone, parent: Bone) {
    const joint = this.world.createImpulseJoint(
      RAPIER.JointData.spherical(v3(bone.anchor), { x: 0, y: 0, z: 0 }), parent.body, bone.body, true,
    );
    // Frame 1 is the child's rest orientation, so the motors' zero is the rest pose (driven mode moves it).
    joint.setLocalFrame1(v3(bone.anchor), q4(bone.restRel));
    // Rapier hands spherical joints back as generic ones, without the motor methods: use the raw set.
    const { swing, twist } = jointOf(bone.name);
    for (const axis of ANG_AXES) {
      this.raw.jointConfigureMotorModel(joint.handle, axis, RAPIER.MotorModel.ForceBased);
      const lim = (axis === RAPIER.JointAxis.AngY ? twist : swing) * DEG;
      this.raw.jointSetLimits(joint.handle, axis, -lim, lim);
    }
    bone.joint = joint;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Driving                                                                                                      */
  /* ---------------------------------------------------------------------------------------------------------- */

  private setMotors(bone: Bone, k: number) {
    // Reconfigured only on change; little damping, since Rapier's soft motors trade static stiffness for damping.
    if (!bone.joint || Math.abs(k - bone.stiffness) < 1e-3 * (k + 1)) return;
    bone.stiffness = k;
    for (const axis of ANG_AXES) this.raw.jointConfigureMotorPosition(bone.joint.handle, axis, 0, k, 0.2 * Math.sqrt(k));
  }

  /** Free mode: every joint holds the rest pose at `tone` (0..1) of its strength, and the hips are pulled upright with
   *  `upright` N·m/rad once they lean. */
  balance(tone: number, upright: number) {
    for (const b of this.bones.values()) this.setMotors(b, jointOf(b.name).hold * tone);
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
    const k = upright * THREE.MathUtils.smoothstep(tilt, 0.1, 0.3);
    if (Math.abs(k - this.uprightStiffness) < 0.5) return;
    this.uprightStiffness = k;
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      this.raw.jointConfigureMotorPosition(this.uprightJoint.handle, axis, 0, k, 0.1 * k);
    }
  }

  /** Driven mode: the torso moves to its targets, blended in (w 0..1) from where it was when driven mode began; the
   *  limbs' motors pull them to their targets, clamped to the joint limits. */
  drive(w: number) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), rel = new THREE.Quaternion();
    for (const b of this.bones.values()) {
      if (b.torso) {
        p.lerpVectors(b.fromPos, b.targetPos, w);
        q.slerpQuaternions(b.fromRot, b.targetRot, w);
        b.body.setNextKinematicTranslation(v3(p));
        b.body.setNextKinematicRotation(q4(q));
      } else if (b.joint && b.parent) {
        rel.copy(b.parent.targetRot).invert().multiply(b.targetRot);
        const delta = b.restRel.clone().invert().multiply(rel);
        clampRotation(delta, jointOf(b.name));
        b.joint.setLocalFrame1(v3(b.anchor), q4(rel.copy(b.restRel).multiply(delta).slerp(b.restRel, 1 - w)));
        this.setMotors(b, jointOf(b.name).drive);
      }
    }
  }

  setMode(driven: boolean) {
    for (const b of this.bones.values()) {
      const t = b.body.translation(), r = b.body.rotation();
      b.fromPos.set(t.x, t.y, t.z);
      b.fromRot.set(r.x, r.y, r.z, r.w);
      if (!b.torso && b.joint) b.joint.setLocalFrame1(v3(b.anchor), q4(b.restRel));
      if (!b.torso) continue;
      const lv = b.body.linvel(), av = b.body.angvel();
      b.body.setBodyType(driven ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
      if (!driven) {
        b.body.setLinvel(lv, true);
        b.body.setAngvel(av, true);
      }
    }
    this.uprightStiffness = -1;
  }

  /** Mass-weighted velocity of the bones. */
  velocity(): THREE.Vector3 {
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

  addVelocity(dv: THREE.Vector3) {
    for (const b of this.bones.values()) {
      const lv = b.body.linvel();
      b.body.setLinvel({ x: lv.x + dv.x, y: lv.y + dv.y, z: lv.z + dv.z }, true);
    }
  }

  reset() {
    for (const b of this.bones.values()) {
      b.body.setTranslation(v3(b.restPos), true);
      b.body.setRotation(q4(b.restRot), true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.fromPos.copy(b.restPos);
      b.fromRot.copy(b.restRot);
      b.targetPos.copy(b.restPos);
      b.targetRot.copy(b.restRot);
      b.joint?.setLocalFrame1(v3(b.anchor), q4(b.restRel));
    }
  }
}

/** Clamp a rotation (bone frame, +Y along the bone) to the joint's swing and twist limits, measured as Rapier's
 *  motors and limits measure angles (twice the asin of the quaternion's components). */
function clampRotation(q: THREE.Quaternion, { swing, twist }: Joint) {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const s = Math.sin((swing * DEG) / 2), t = Math.sin((twist * DEG) / 2);
  q.x = THREE.MathUtils.clamp(q.x, -s, s);
  q.z = THREE.MathUtils.clamp(q.z, -s, s);
  q.y = THREE.MathUtils.clamp(q.y, -t, t);
  q.w = Math.sqrt(Math.max(0, 1 - q.x * q.x - q.y * q.y - q.z * q.z));
  q.normalize();
}

/** Each limb bone's flesh: the limb surface vertices belonging to that bone (the nearest bone; a foot is everything
 *  below the ankle, heel included), and their median distance to it. */
export function limbFlesh(spec: RigSpec): Map<CoreBone, BoneFlesh> {
  const out = new Map<CoreBone, BoneFlesh>();
  const bones = new Map(spec.bones.map((b) => [b.name, b]));
  const p = new THREE.Vector3();
  for (const limb of spec.limbs ?? []) {
    const segs = limb.bones.filter((n) => bones.has(n) && /arm|hand|thigh|shin|foot/.test(n)).map((n) => {
      const b = bones.get(n)!;
      const head = new THREE.Vector3().setFromMatrixPosition(b.restWorld);
      return { name: n as CoreBone, head, tail: b.tail, d: [] as number[], pts: [] as number[] };
    });
    if (!segs.length) continue;
    const foot = segs.find((s) => /foot/.test(s.name));
    const V = limb.positions;
    for (let v = 0; v < V.length / 3; v++) {
      p.set(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]);
      let best = segs[0], bd = Infinity;
      for (const s of segs) {
        const d = segmentDistance(p, s.head, s.tail);
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
      best.d.push(bd);
      (foot && p.y < foot.head.y ? foot : best).pts.push(p.x, p.y, p.z);
    }
    for (const s of segs) {
      if (!s.d.length || !s.pts.length) continue;
      s.d.sort((a, b) => a - b);
      out.set(s.name, { radius: s.d[s.d.length >> 1], points: new Float32Array(s.pts) });
    }
  }
  return out;
}
