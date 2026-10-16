/**
 * The idle stance the frog takes when no motion drives it: breathing, swaying, turning its head to what it looks at,
 * and acting out its moods (hands on the belly when it laughs, wriggling when tickled, woozy after a fall).
 */
import * as THREE from "three";
import type { BoneName } from "../contracts";
import type { LifeOutput } from "./life";
import { forwardKinematics, worldDeltaToLocal, type RestSkeleton } from "./rig";

export interface ArmRest {
  side: 1 | -1;
  upper: BoneName;
  fore: BoneName;
  hand: BoneName;
  /** Lengths of the upper arm and the forearm. */
  l1: number;
  l2: number;
  /** Where the hand rests on the belly (rest world, relative to the spine bone) and the skin normal there. */
  spot: THREE.Vector3;
  normal: THREE.Vector3;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Rotation about world axes: x leans forward, y turns to its left, z rolls. */
function euler(x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion {
  out.setFromAxisAngle(Y, y);
  if (x) out.multiply(_q2.setFromAxisAngle(X, x));
  if (z) out.multiply(_q2.setFromAxisAngle(Z, z));
  return out;
}

export class Stance {
  private local = new Map<BoneName, THREE.Quaternion>();
  private ik = new Map<BoneName, THREE.Quaternion>();
  private first = new Map<BoneName, THREE.Matrix4>();
  private offset = new THREE.Vector3();

  constructor(
    private skel: RestSkeleton,
    private arms: ArmRest[],
  ) {
    for (const b of skel.list) this.local.set(b.name, b.localQuat.clone());
  }

  /**
   * World matrices of the idle stance at time t. look: where the head turns (world), null to face ahead.
   */
  compute(t: number, life: LifeOutput, look: THREE.Vector3 | null, out: Map<BoneName, THREE.Matrix4>): void {
    const s = this.skel;
    const L = this.local;
    for (const b of s.list) L.get(b.name)!.copy(b.localQuat);
    const set = (name: BoneName, x: number, y: number, z: number) => {
      const b = s.byName.get(name);
      if (b) worldDeltaToLocal(b, euler(x, y, z, _q), L.get(name)!);
    };
    const tau = 2 * Math.PI;
    const br = life.breath;
    const shake = life.shake * Math.sin(t * tau * 7.5);
    const squirm = life.squirm;
    const wob = life.dizzy;
    const hold = life.holdBelly;
    const sigh = life.relief * Math.sin(Math.min(1, life.relief) * Math.PI * 0.5);

    // Head turns part of the way towards what it looks at (it is mostly body; it cannot turn far).
    let headYaw = 0, headPitch = 0;
    if (look) {
      const head = s.byName.get("head")!;
      _v.copy(look).sub(new THREE.Vector3().setFromMatrixPosition(head.restWorld));
      headYaw = THREE.MathUtils.clamp(Math.atan2(_v.x, _v.z), -1.2, 1.2) * 0.35;
      headPitch = THREE.MathUtils.clamp(-Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -0.6, 0.6) * 0.3;
    }

    // Torso: sway, breathing, laughing doubled over, squirming, woozy circles, the sigh.
    const sway = Math.sin(t * tau * 0.23);
    set("hips", 0, 0.03 * Math.sin(t * tau * 0.11) + 0.18 * squirm * Math.sin(t * tau * 3.1), 0.018 * sway);
    set("spine", 0.012 * br + 0.16 * hold + 0.04 * shake + 0.05 * sigh - 0.05 * life.startle,
      0.12 * squirm * Math.sin(t * tau * 3.1 + 1), -0.012 * sway + 0.08 * squirm * Math.sin(t * tau * 2.3));
    set("chest", -0.018 * br + 0.13 * hold + 0.06 * shake + 0.05 * sigh - 0.07 * life.startle + 0.1 * wob * Math.sin(t * tau * 1.1),
      0.1 * squirm * Math.sin(t * tau * 3.1 + 2), 0.1 * wob * Math.cos(t * tau * 1.1));
    set("head", headPitch - 0.1 * hold - 0.04 * shake - 0.06 * sigh + 0.12 * wob * Math.sin(t * tau * 1.1 + 1),
      headYaw, 0.14 * wob * Math.cos(t * tau * 1.1 + 1) + 0.03 * Math.sin(t * tau * 0.17));

    // Arms hang and swing a little; startled they fly up; tickled they flap.
    for (const a of this.arms) {
      const flap = squirm * (0.35 + 0.25 * Math.sin(t * tau * 4.2 + (a.side > 0 ? 0 : 1.7)));
      const lift = 0.03 * br + 0.5 * life.startle + flap - 0.06 * sigh;
      set(a.upper, -0.05 * Math.sin(t * tau * 0.23 + a.side), 0, a.side * lift);
      set(a.fore, -0.12 * life.startle - 0.25 * squirm, 0, 0);
    }
    // Knees give a little when it laughs or squirms.
    for (const side of ["L", "R"] as const) {
      const k = 0.08 * hold + 0.1 * squirm + 0.04 * Math.abs(shake);
      set(`thigh_${side}`, -k, 0, 0);
      set(`shin_${side}`, 2 * k, 0, 0);
      set(`foot_${side}`, -k, 0, 0);
    }

    // Laughing bounces it on its feet.
    this.offset.set(0, -0.012 * (0.08 * hold + 0.1 * squirm) - 0.006 * Math.abs(shake), 0);
    const local = (n: BoneName) => L.get(n);
    if (hold > 0.001) {
      forwardKinematics(s, local, this.offset, 0, this.first);
      for (const a of this.arms) this.holdBelly(a, hold);
    }
    forwardKinematics(s, local, this.offset, 0, out);
  }

  /** Two-bone IK of one arm onto its belly spot, blended in by amount. */
  private holdBelly(a: ArmRest, amount: number): void {
    const s = this.skel;
    const W = this.first;
    const upper = s.byName.get(a.upper)!, fore = s.byName.get(a.fore)!;
    const sh = new THREE.Vector3().setFromMatrixPosition(W.get(a.upper)!);
    // The spot rides on the posed spine.
    const spineM = W.get("spine")!;
    const spot = a.spot.clone().applyMatrix4(spineM);
    const n = a.normal.clone().transformDirection(spineM);
    // Wrist sits off the skin, a little outwards so the hand lies on the spot.
    const out = new THREE.Vector3().crossVectors(Y, n).multiplyScalar(a.side).normalize();
    const target = spot.addScaledVector(n, 0.03).addScaledVector(out, 0.035);
    const d = THREE.MathUtils.clamp(target.distanceTo(sh), Math.abs(a.l1 - a.l2) + 1e-3, a.l1 + a.l2 - 1e-3);
    const dir = target.clone().sub(sh).normalize();
    const along = (a.l1 * a.l1 - a.l2 * a.l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.l1 * a.l1 - along * along));
    // Elbows point out and back.
    const pole = new THREE.Vector3(a.side, -0.2, -0.7);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbow = sh.clone().addScaledVector(dir, along).addScaledVector(pole, h);
    const wrist = sh.clone().addScaledVector(dir, d);

    const restDir = (from: BoneName, to: BoneName) =>
      new THREE.Vector3().setFromMatrixPosition(s.byName.get(to)!.restWorld)
        .sub(new THREE.Vector3().setFromMatrixPosition(s.byName.get(from)!.restWorld)).normalize();
    // World rotations that swing each rest bone onto its new direction, then into the parent's posed frame.
    const parentQ = new THREE.Quaternion().setFromRotationMatrix(W.get(upper.parent!)!);
    const qUpper = new THREE.Quaternion()
      .setFromUnitVectors(restDir(a.upper, a.fore), elbow.clone().sub(sh).normalize()).multiply(upper.restWorldQuat);
    const qFore = new THREE.Quaternion()
      .setFromUnitVectors(restDir(a.fore, a.hand), wrist.clone().sub(elbow).normalize()).multiply(fore.restWorldQuat);
    // Hand: along the belly towards its middle, palm (+Z of the hand) against the skin.
    const handY = new THREE.Vector3().crossVectors(n, Y).multiplyScalar(a.side).normalize().addScaledVector(Y, -0.4).normalize();
    const handZ = n.clone().negate();
    const handX = new THREE.Vector3().crossVectors(handY, handZ).normalize();
    handZ.crossVectors(handX, handY);
    const qHand = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(handX, handY, handZ));

    const blend = (name: BoneName, worldQ: THREE.Quaternion, parentWorldQ: THREE.Quaternion) => {
      const l = this.ik.get(name) ?? new THREE.Quaternion();
      this.ik.set(name, l);
      l.copy(parentWorldQ).invert().multiply(worldQ);
      this.local.get(name)!.slerp(l, amount);
    };
    blend(a.upper, qUpper, parentQ);
    blend(a.fore, qFore, qUpper);
    blend(a.hand, qHand, qFore);
  }
}
