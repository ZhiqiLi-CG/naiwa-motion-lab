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
import { CORE_BONES, type BodyMode, type BoneName, type CoreBone, type FootContacts, type HitRegion, type PhysicsParams, type RigBone, type RigSpec } from "../../contracts";
import type { BlockDefinition, BoneShape, Scene, SimBone, SkeletonBlock } from "../api";
import { TriMesh, segmentDistance } from "../geometry";

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
  hips: { mass: 3, hold: 0, drive: 0, swing: 0, twist: 0 },
  spine: { mass: 3, hold: 3000, drive: 0, swing: 40, twist: 30 },
  chest: { mass: 3, hold: 3000, drive: 0, swing: 40, twist: 30 },
  head: { mass: 2, hold: 1500, drive: 0, swing: 60, twist: 70 },
  // The arms' drive carries their flesh too (it rides on the bones): three times the hold, or a fast dance's hands
  // lagged and swung past their targets by half again (狗熊哆嗦毛: hand 8.7 cm off its target on median, 4.4 now).
  upperarm: { mass: 0.6, hold: 120, drive: 360, swing: 100, twist: 70 },
  forearm: { mass: 0.4, hold: 80, drive: 240, swing: 140, twist: 60 },
  hand: { mass: 0.2, hold: 30, drive: 90, swing: 80, twist: 40 },
  thigh: { mass: 1.5, hold: 5000, drive: 1500, swing: 100, twist: 40 },
  shin: { mass: 1, hold: 5000, drive: 1500, swing: 140, twist: 20 },
  foot: { mass: 1, hold: 3000, drive: 800, swing: 60, twist: 20 },
};
const jointOf = (name: CoreBone) => JOINTS[name.replace(/_[LR]$/, "")];

/** Damping of the drive motors in driven mode (times √stiffness): a little more than the hold's, against overshoot. */
const DRIVE_DAMPING = 0.3;
/** A planted foot's hold (pinFeet): N/m and N·s/m against moving, N·m/rad against turning. */
const PIN_STIFFNESS = 6000;
const PIN_DAMPING = 2 * Math.sqrt(PIN_STIFFNESS * 2);
const PIN_TURN = 300;
/** How far (m) a leg's flesh must be outside the Body at rest to belong to its contact shape (see addColliders). */
const LEG_CLEARANCE = 0.01;
/** Lean (rad) the frog may stand at by itself before the upright pull engages. */
const TILT_FREE = 0.08;
/** Smallest radius of gyration of a bone (m). */
const GYRATION = 0.15;
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
  /** Driven-mode target, and the pose a blend to the targets starts from (entering driven mode, a new motion). */
  readonly targetPos: THREE.Vector3;
  readonly targetRot: THREE.Quaternion;
  readonly fromPos = new THREE.Vector3();
  readonly fromRot = new THREE.Quaternion();
  /** A limb's joint: the motors' goal as last commanded, and where a blend starts (parent frame). */
  readonly commandRel = new THREE.Quaternion();
  readonly fromRel = new THREE.Quaternion();
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
    this.commandRel.copy(this.restRel);
    this.fromRel.copy(this.restRel);
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
  private uprightJoint: RAPIER.ImpulseJoint;
  private world0: RAPIER.RigidBody;
  /** Feet held where they touched down while the motion has them planted. */
  private pins = new Map<CoreBone, RAPIER.ImpulseJoint>();
  private uprightStiffness = -1;
  private raw: RAPIER.World["impulseJoints"]["raw"];

  constructor(
    private world: RAPIER.World,
    spec: RigSpec,
    body: TriMesh,
    limbFlesh: Map<CoreBone, BoneFlesh>,
    private groups: { core: number; contact: number },
  ) {
    this.raw = world.impulseJoints.raw;
    const specBones = new Map(spec.bones.map((b) => [b.name, b]));
    for (const name of CORE_BONES) {
      if (name === "root") continue;
      const rb = specBones.get(name);
      if (!rb) throw new Error(`sim: rig has no bone ${name}`);
      const restPos = new THREE.Vector3(), restRot = new THREE.Quaternion(), scale = new THREE.Vector3();
      rb.restWorld.decompose(restPos, restRot, scale);
      const length = restPos.distanceTo(rb.tail), radius = limbFlesh.get(name)?.radius ?? rb.radius;
      const { mass } = jointOf(name);
      // The bone carries the mass of what is firm around it (bone, muscle) as a solid cylinder over the flesh's
      // thickness; its colliders add none. Its inertia is at least that of a GYRATION-radius ring: the flesh riding on
      // it turns with it, but the joint solver does not see that, and stiff motors on near-weightless links made the
      // skeleton buzz and walk off on its own.
      const inertia = (i: number) => Math.max(i, mass * GYRATION * GYRATION);
      const across = inertia((mass * (3 * radius * radius + length * length)) / 12), along = inertia((mass * radius * radius) / 2);
      const rigid = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(restPos.x, restPos.y, restPos.z)
          .setRotation(q4(restRot))
          .setAdditionalMassProperties(mass, { x: 0, y: length / 2, z: 0 }, { x: across, y: along, z: across }, { x: 0, y: 0, z: 0, w: 1 })
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
    // The upright pull: a joint from the world to the hips that only acts through its tilt motors (no locked axes).
    const world0 = (this.world0 = world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    const zero = { x: 0, y: 0, z: 0 };
    this.uprightJoint = world.createImpulseJoint(
      RAPIER.JointData.generic(zero, zero, { x: 1, y: 0, z: 0 }, 0 as RAPIER.JointAxesMask), world0, hips.body, true,
    );
    this.uprightJoint.setLocalFrame2(zero, q4(hips.restRot.clone().invert()));
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      this.raw.jointConfigureMotorModel(this.uprightJoint.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
    }
  }

  /** Driven mode: a foot the motion has planted is held at its pose when it touched down, by a stiff spring joint to
   *  the world (stiff against the leg's motors, soft enough that a target out of reach does not fight the kinematic
   *  hips); it lets go when the motion lifts it. The leg's motors alone let the planted foot skid 4-5 cm at each
   *  lift-off and overshoot on landing. */
  pinFeet(contacts: FootContacts | null) {
    for (const name of ["foot_L", "foot_R"] as const) {
      const want = !!contacts?.[name], pin = this.pins.get(name);
      if (want && !pin) {
        const foot = this.bones.get(name);
        if (!foot) continue;
        const t = foot.body.translation(), r = foot.body.rotation();
        const zero = { x: 0, y: 0, z: 0 };
        const joint = this.world.createImpulseJoint(
          RAPIER.JointData.generic(v3(t), zero, { x: 1, y: 0, z: 0 }, 0 as RAPIER.JointAxesMask), this.world0, foot.body, true,
        );
        joint.setLocalFrame1(v3(t), { x: r.x, y: r.y, z: r.z, w: r.w });
        for (const axis of [RAPIER.JointAxis.LinX, RAPIER.JointAxis.LinY, RAPIER.JointAxis.LinZ]) {
          this.raw.jointConfigureMotorModel(joint.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
          this.raw.jointConfigureMotorPosition(joint.handle, axis as number, 0, PIN_STIFFNESS, PIN_DAMPING);
        }
        for (const axis of ANG_AXES) {
          this.raw.jointConfigureMotorModel(joint.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
          this.raw.jointConfigureMotorPosition(joint.handle, axis as number, 0, PIN_TURN, 0.2 * Math.sqrt(PIN_TURN));
        }
        this.pins.set(name, joint);
      } else if (!want && pin) {
        this.world.removeImpulseJoint(pin, true);
        this.pins.delete(name);
      }
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
   *  shrunk a little, a flat sole to stand on. A limb bone also gets a contact shape, its flesh clear of the Body at
   *  rest, which presses into the Body's flesh. */
  private addColliders(bone: Bone, rb: RigBone, body: TriMesh, flesh: BoneFlesh | undefined) {
    const head = bone.restPos, tail = rb.tail;
    if (bone.torso) {
      let depth = Infinity;
      for (let s = 0; s <= 8; s++) {
        const p = head.clone().lerp(tail, s / 8);
        depth = Math.min(depth, -body.signedDistance(p.x, p.y, p.z));
      }
      this.capsule(bone, head, tail, Math.max(0.02, Math.min(rb.radius, depth * 0.5)), "core");
      return;
    }
    if (flesh && /foot/.test(bone.name)) this.sole(bone, flesh.points);
    else this.capsule(bone, head, tail, flesh ? 0.45 * flesh.radius : rb.radius, "core");

    // The contact shape: a capsule as thick as the flesh along the bone, trimmed to where it is clear of the Body at
    // rest. That leaves a thigh with none (it joins the Body along its length), and the belly sagged over the thighs
    // and swallowed them (up to 10 cm in a squat): a leg's contact shape is the hull of its flesh that is clear of the
    // Body at rest by LEG_CLEARANCE instead (closer, it rests against the Body's collision skin and tips the frog
    // back). Solvers that work with capsules (the GPU example, the library's SDF contacts) still get the capsule.
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
    const clear: number[] = [];
    if (flesh && /thigh|shin/.test(bone.name)) {
      for (let i = 0; i < flesh.points.length; i += 3) {
        const [x, y, z] = [flesh.points[i], flesh.points[i + 1], flesh.points[i + 2]];
        if (body.signedDistance(x, y, z) > LEG_CLEARANCE) clear.push(x, y, z);
      }
    }
    const hull = clear.length >= 12 && this.hull(bone, Float32Array.from(clear), "contact");
    const at = (t: number) => head.clone().addScaledVector(dir, t);
    let start = -1;
    for (let s = 16; s >= 0; s--) {
      const p = at(t0 + ((t1 - t0) * s) / 16);
      if (body.signedDistance(p.x, p.y, p.z) > r + 0.01) start = s;
      else break;
    }
    if (start >= 0 && start < 16) this.capsule(bone, at(t0 + ((t1 - t0) * start) / 16), at(t1), r, "contact", !hull);
  }

  private capsule(bone: Bone, a: THREE.Vector3, b: THREE.Vector3, radius: number, role: "core" | "contact", collide = true) {
    const la = a.clone().applyMatrix4(bone.restInverse), lb = b.clone().applyMatrix4(bone.restInverse);
    const len = la.distanceTo(lb);
    const dir = len > 1e-6 ? lb.clone().sub(la).normalize() : new THREE.Vector3(0, 1, 0);
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const mid = la.clone().add(lb).multiplyScalar(0.5);
    if (!collide) {
      bone.shapes.push({ kind: "capsule", role, a: la, b: lb, radius });
      return;
    }
    const c = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(len / 2, radius)
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation(q4(rot))
        .setDensity(0)
        .setFriction(0.9)
        .setCollisionGroups(role === "core" ? this.groups.core : this.groups.contact)
        // The hard bones' floor and ball contacts become events (the feet stand on their soles).
        .setActiveEvents(role === "core" ? RAPIER.ActiveEvents.COLLISION_EVENTS : RAPIER.ActiveEvents.NONE),
      bone.body,
    );
    this.byCollider.set(c.handle, bone);
    bone.shapes.push({ kind: "capsule", role, a: la, b: lb, radius, collider: c });
  }

  private hull(bone: Bone, points: Float32Array, role: "core" | "contact"): boolean {
    const local = new Float32Array(points.length);
    const p = new THREE.Vector3();
    for (let i = 0; i < points.length; i += 3) p.fromArray(points, i).applyMatrix4(bone.restInverse).toArray(local, i);
    const desc = RAPIER.ColliderDesc.convexHull(local);
    if (!desc) return false;
    const col = this.world.createCollider(
      desc.setDensity(0).setFriction(0.9).setCollisionGroups(role === "core" ? this.groups.core : this.groups.contact),
      bone.body,
    );
    this.byCollider.set(col.handle, bone);
    bone.shapes.push({ kind: "hull", role, points: local, collider: col });
    return true;
  }

  private sole(bone: Bone, points: Float32Array) {
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
    const col = this.world.createCollider(
      desc.setDensity(0).setFriction(0.9).setCollisionGroups(this.groups.core).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      bone.body,
    );
    this.byCollider.set(col.handle, bone);
    bone.shapes.push({ kind: "hull", role: "core", points: local, collider: col });
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
      this.raw.jointConfigureMotorModel(joint.handle, axis as number, RAPIER.MotorModel.ForceBased as number);
      const lim = (axis === RAPIER.JointAxis.AngY ? twist : swing) * DEG;
      this.raw.jointSetLimits(joint.handle, axis as number, -lim, lim);
    }
    bone.joint = joint;
  }

  /* ---------------------------------------------------------------------------------------------------------- */
  /* Driving                                                                                                      */
  /* ---------------------------------------------------------------------------------------------------------- */

  private setMotors(bone: Bone, k: number, damping = 0.2) {
    // Reconfigured only on change; little damping, since Rapier's soft motors trade static stiffness for damping.
    if (!bone.joint || Math.abs(k - bone.stiffness) < 1e-3 * (k + 1)) return;
    bone.stiffness = k;
    for (const axis of ANG_AXES) this.raw.jointConfigureMotorPosition(bone.joint.handle, axis as number, 0, k, damping * Math.sqrt(k));
  }

  /** Free mode: every joint holds the rest pose at `tone` (0..1) of its strength, and the hips are held upright with
   *  `k` N·m/rad against the tilt and `c` N·m·s/rad against its speed (the floor's answer to a standing animal's
   *  balance; the turn about the vertical stays free). A joint motor, so the solver applies it implicitly: stable
   *  however light the hips are against that stiffness. */
  balance(tone: number, k: number, c: number) {
    for (const b of this.bones.values()) this.setMotors(b, jointOf(b.name).hold * tone);
    // Standing on its feet the frog keeps its balance by itself and comes to rest (Rapier lets it sleep); the pull
    // only engages once it leans further than that (a steady pull at rest pushes the feet along the floor).
    const r = this.bone("hips").body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).multiply(this.bone("hips").restRot.clone().invert()));
    const engage = THREE.MathUtils.smoothstep(Math.acos(Math.min(1, up.y)), TILT_FREE, 2.5 * TILT_FREE);
    k *= engage;
    c *= engage;
    if (Math.abs(k - this.uprightStiffness) < 1e-3 * (k + 1)) return;
    this.uprightStiffness = k;
    for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngZ]) {
      this.raw.jointConfigureMotorPosition(this.uprightJoint.handle, axis as number, 0, k, c);
    }
  }

  /** Driven mode: the torso moves to its targets, blended in (w 0..1) from where it was when the blend began; the
   *  limbs' motors pull them to their targets, clamped to the joint limits. Either moves at most MAX_SPEED / MAX_TURN:
   *  far above any dance, so it only catches a jump in the targets, which would otherwise teleport the bones within
   *  one step and tear the flesh around them. The torso's bones share one fraction, so it keeps its shape. */
  drive(w: number, dt: number) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), rel = new THREE.Quaternion();
    const torso = [...this.bones.values()].filter((b) => b.torso).map((b) => ({
      b,
      pos: new THREE.Vector3().lerpVectors(b.fromPos, b.targetPos, w),
      rot: new THREE.Quaternion().slerpQuaternions(b.fromRot, b.targetRot, w),
    }));
    let f = 1;
    for (const { b, pos, rot } of torso) {
      const t = b.body.translation(), r = b.body.rotation();
      f = Math.min(f, (MAX_SPEED * dt) / Math.max(1e-9, pos.distanceTo(p.set(t.x, t.y, t.z))));
      f = Math.min(f, (MAX_TURN * dt) / Math.max(1e-9, rot.angleTo(q.set(r.x, r.y, r.z, r.w))));
    }
    for (const { b, pos, rot } of torso) {
      const t = b.body.translation(), r = b.body.rotation();
      b.body.setNextKinematicTranslation(v3(p.set(t.x, t.y, t.z).lerp(pos, f)));
      b.body.setNextKinematicRotation(q4(q.set(r.x, r.y, r.z, r.w).slerp(rot, f)));
    }
    for (const b of this.bones.values()) {
      if (b.torso || !b.joint || !b.parent) continue;
      rel.copy(b.parent.targetRot).invert().multiply(b.targetRot);
      const delta = b.restRel.clone().invert().multiply(rel);
      clampRotation(delta, jointOf(b.name));
      rel.copy(b.fromRel).slerp(q.copy(b.restRel).multiply(delta), w);
      b.commandRel.slerp(rel, Math.min(1, (MAX_TURN * dt) / Math.max(1e-9, b.commandRel.angleTo(rel))));
      b.joint.setLocalFrame1(v3(b.anchor), q4(b.commandRel));
      this.setMotors(b, jointOf(b.name).drive, DRIVE_DAMPING);
    }
  }

  /** Free mode: the joints' goal eases from the pose they were in when free mode began to rest (w 0..1). */
  relax(w: number) {
    const rel = new THREE.Quaternion();
    for (const b of this.bones.values()) {
      if (!b.joint || !b.parent) continue;
      rel.slerpQuaternions(b.fromRel, b.restRel, w);
      if (rel.angleTo(b.commandRel) < 1e-4) continue;
      b.commandRel.copy(rel);
      b.joint.setLocalFrame1(v3(b.anchor), q4(rel));
    }
  }

  /** Blend from where the bones are now (a new motion, or entering driven mode). */
  startBlend() {
    for (const b of this.bones.values()) {
      const t = b.body.translation(), r = b.body.rotation();
      b.fromPos.set(t.x, t.y, t.z);
      b.fromRot.set(r.x, r.y, r.z, r.w);
      b.fromRel.copy(b.commandRel);
    }
  }

  setMode(driven: boolean) {
    const q = new THREE.Quaternion(), r = new THREE.Quaternion();
    for (const b of this.bones.values()) {
      // Driven, a limb's goal starts at rest and blends to the targets. Free, every joint's goal starts at the pose the
      // bone is in and eases to rest (relax): set at once, the leg motors straightened a squat within two steps and
      // threw the torso up at 4 m/s, tearing the flesh off the floor.
      if (driven || !b.parent) b.commandRel.copy(b.restRel);
      else {
        const p = b.parent.body.rotation(), c = b.body.rotation();
        b.commandRel.copy(q.set(p.x, p.y, p.z, p.w).invert().multiply(r.set(c.x, c.y, c.z, c.w)));
      }
      if (b.joint && (driven ? !b.torso : true)) b.joint.setLocalFrame1(v3(b.anchor), q4(b.commandRel));
    }
    this.startBlend();
    for (const b of this.bones.values()) {
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
    this.pinFeet(null);
    for (const b of this.bones.values()) {
      b.body.setTranslation(v3(b.restPos), true);
      b.body.setRotation(q4(b.restRot), true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.fromPos.copy(b.restPos);
      b.fromRot.copy(b.restRot);
      b.targetPos.copy(b.restPos);
      b.targetRot.copy(b.restRot);
      b.commandRel.copy(b.restRel);
      b.fromRel.copy(b.restRel);
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

/* ------------------------------------------------------------------------------------------------------------------ */
/* The skeleton block                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** The balance's stiffness at full stubbornness, in units of gravity's toppling stiffness m·g·h. */
const BALANCE = 4;

/** What the balance works against: gravity's toppling stiffness m·g·h (h: rest centre of mass over the floor) and the
 *  frog's moment of inertia about its feet, m·h², bones and flesh together. */
function standing(scene: Scene): { mgh: number; inertia: number } {
  let m = 0, my = 0;
  for (const b of scene.skeleton.bones.values()) {
    m += b.body.mass();
    my += b.body.mass() * b.restPos.y;
  }
  for (const part of scene.parts) {
    const view = scene.flesh.particles(part);
    for (let i = 0; i < view.count; i++) {
      m += view.mass(i);
      my += view.mass(i) * view.rest[i * 3 + 1];
    }
  }
  const h = my / Math.max(m, 1e-6);
  return { mgh: m * 9.81 * scene.params.gravity * h, inertia: m * h * h };
}

/** Seconds to blend from where the bones are into driven mode. */
const DRIVE_BLEND = 0.35;
/** Seconds the joints take to ease to rest when free mode begins. */
const RELAX = 0.5;
/** Fastest the driven bones may move (m/s, rad/s): well above a dance's (狗熊哆嗦毛 turns the hips at ~13 rad/s). */
const MAX_SPEED = 6;
const MAX_TURN = 25;

/** Free mode: the frog's tone (stubbornness) holds the rest pose and rights it; a knock makes it floppy for a moment.
 *  Driven mode: the torso follows the targets, the limbs' motors pull them there. */
class RigidSkeleton implements SkeletonBlock {
  readonly skeleton: Skeleton;
  private mode: BodyMode = "free";
  private params: PhysicsParams;
  private driveBlend = 1;
  private relaxBlend = 1;
  /** Feet the motion has planted (driven mode). */
  private contacts: FootContacts | null = null;
  /** Time since the frog was knocked about (landing, throw). */
  private sinceKnock = 10;
  private rootFromHips: THREE.Matrix4;
  private standing: { mgh: number; inertia: number } | null = null;

  constructor(scene: Scene) {
    // The stiff joint motors need a second PGS iteration to settle; with one the legs buzz and the standing frog
    // creeps across the floor and never sleeps (whatever flesh solver rides on it).
    const ip = scene.world.integrationParameters;
    ip.numInternalPgsIterations = Math.max(ip.numInternalPgsIterations, 2);
    const spec = scene.spec;
    this.params = scene.params;
    const body = new TriMesh(spec.body.positions, spec.body.indices);
    this.skeleton = new Skeleton(scene.world, spec, body, limbFlesh(spec), scene.collisionGroups);
    const root = spec.bones.find((b) => b.name === "root");
    this.rootFromHips = this.skeleton.bone("hips").restInverse.clone().multiply(root ? root.restWorld : new THREE.Matrix4());
  }

  get bones(): ReadonlyMap<CoreBone, SimBone> {
    return this.skeleton.bones;
  }

  setParams(p: PhysicsParams) {
    this.params = p;
    for (const b of this.skeleton.bones.values()) b.body.wakeUp();
  }

  setMode(mode: BodyMode) {
    this.mode = mode;
    this.skeleton.setMode(mode === "driven");
    this.driveBlend = mode === "driven" ? 0 : 1;
    this.relaxBlend = mode === "driven" ? 1 : 0;
  }

  transition() {
    if (this.mode !== "driven") return;
    this.skeleton.startBlend();
    this.driveBlend = 0;
  }

  setTargets(boneWorld: ReadonlyMap<BoneName, THREE.Matrix4>, contacts?: FootContacts) {
    this.contacts = contacts ?? null;
    const s = new THREE.Vector3();
    for (const [name, m] of boneWorld) {
      const b = this.skeleton.bones.get(name as CoreBone);
      if (b) m.decompose(b.targetPos, b.targetRot, s);
    }
  }

  knock() {
    this.sinceKnock = 0;
  }

  velocity() {
    return this.skeleton.velocity();
  }

  addVelocity(dv: THREE.Vector3) {
    this.skeleton.addVelocity(dv);
  }

  /** The root rides with the hips in both modes (in driven mode the hips may still be catching up with a target). */
  root(out: THREE.Matrix4) {
    return this.skeleton.bone("hips").pose(out).multiply(this.rootFromHips);
  }

  beforeStep(scene: Scene) {
    // Feet are held only once the blend into a motion is done (a new motion starts from where the bones are).
    this.skeleton.pinFeet(this.mode === "driven" && this.driveBlend >= 1 ? this.contacts : null);
    if (this.mode === "driven") {
      this.driveBlend = Math.min(1, this.driveBlend + scene.dt / DRIVE_BLEND);
      this.skeleton.drive(THREE.MathUtils.smoothstep(this.driveBlend, 0, 1), scene.dt);
    } else {
      // Stubbornness sets the tone; right after a knock the frog goes floppy and gathers itself again.
      const s = clamp01(this.params.stubbornness);
      const recover = clamp01((this.sinceKnock - 0.4) / 1.2);
      // Balance stiffness in units of what gravity does to the leaning frog (m·g·h per radian): above 1 it stands.
      const { mgh, inertia } = (this.standing ??= standing(scene));
      const k = BALANCE * s * lerp(0.3, 1, recover) * mgh;
      this.skeleton.balance(lerp(0.04, 1, s) * lerp(0.15, 1, recover), k, 2 * Math.sqrt(k * inertia));
      if (this.relaxBlend < 1) {
        this.relaxBlend = Math.min(1, this.relaxBlend + scene.dt / RELAX);
        this.skeleton.relax(THREE.MathUtils.smoothstep(this.relaxBlend, 0, 1));
      }
    }
    this.sinceKnock += scene.dt;
  }

  reset() {
    this.skeleton.reset();
    this.sinceKnock = 10;
  }
}

export const rigidSkeleton: BlockDefinition<"skeleton"> = {
  id: "rapier-skeleton",
  slot: "skeleton",
  name: { zh: "刚体骨骼", en: "Rigid skeleton" },
  summary: {
    zh: "每根骨头一个 Rapier 刚体，球铰带马达和限位；自由模式靠肌张力站稳、自己回正，驱动模式跟随姿态目标。",
    en: "One Rapier rigid body per bone, ball joints with motors and limits; free mode holds itself up and rights itself, driven mode follows the pose targets.",
  },
  device: "cpu",
  parameters: [],
  create: (scene) => new RigidSkeleton(scene),
};
