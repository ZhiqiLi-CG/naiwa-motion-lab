/**
 * BodyPose: what the frog should do, independent of any rig. Dances and the camera/video retargeting both produce it;
 * rig.ts turns it into bone rotations for the bound skeleton (keeping limbs out of the belly and feet on the floor).
 *
 * Frame: the frog's own canonical axes, +X its left, +Y up, +Z forward (towards the default camera).
 */
import * as THREE from "three";
import type { Expression, ExpressionWeights } from "../contracts";

export type Side = "L" | "R";
export const SIDES: readonly Side[] = ["L", "R"];

/** Finger curls (rad, towards the palm) of thumb, index, middle, ring, and the index–middle spread. */
export type Fingers = [number, number, number, number, number];
export const FINGERS = {
  relaxed: [0.15, 0.25, 0.3, 0.35, 0],
  open: [0, -0.05, -0.05, -0.05, 0.05],
  fist: [1.0, 1.5, 1.5, 1.5, 0],
  peace: [1.1, -0.05, -0.05, 1.5, 0.2],
  point: [1.0, -0.05, 1.5, 1.5, 0],
} satisfies Record<string, Fingers>;

export interface PalmGoal {
  /** Where the palm faces, unit, in the chest's frame. */
  dir: THREE.Vector3;
  /** 0 = the hand follows the forearm … 1 = the palm faces dir. */
  weight: number;
}

/** Hold a spot of the belly with this hand (IK onto the belly surface). */
export interface BellyHold {
  /** 0 = off … 1 = the hand is on the belly. */
  weight: number;
  /** 0 = level of the hips joint … 1 = level of the chest joint. */
  height: number;
  /** Radians around the belly from its front centre towards the hand's own side (0 front … π/2 side). */
  around: number;
  /** Lift off the surface (m), for pats. */
  lift: number;
}

export interface ArmGoal {
  /** Upper arm direction, unit, in the chest's frame. */
  upper: THREE.Vector3;
  /** Forearm direction, unit, in the chest's frame. */
  fore: THREE.Vector3;
  palm: PalmGoal | null;
  belly: BellyHold | null;
  /** 0..1: the hand is above the head (lifted above the frog's head however short its arms are). */
  overhead: number;
  fingers: Fingers;
}

export interface LegGoal {
  /** Thigh and shin directions, unit, in the frog's own (yaw-free) frame. */
  thigh: THREE.Vector3;
  shin: THREE.Vector3;
  /** Foot pitch, radians, toes down > 0 (0 = sole flat on the floor). */
  toe: number;
}

export interface BodyPose {
  /** Each relative to its parent's frame (hips relative to the frog). */
  hips: THREE.Quaternion;
  spine: THREE.Quaternion;
  chest: THREE.Quaternion;
  head: THREE.Quaternion;
  arm: Record<Side, ArmGoal>;
  leg: Record<Side, LegGoal>;
  /** Height above the planted feet (m), e.g. a hop. */
  lift: number;
  /** Sideways step from home (m, + towards its left = the viewer's right). */
  shift: number;
  /** Heading around +Y (rad, + turns to its left). */
  yaw: number;
  expressions: ExpressionWeights;
}

export const sideSign = (s: Side): number => (s === "L" ? 1 : -1);
export const otherSide = (s: Side): Side => (s === "L" ? "R" : "L");

/** Unit vector, given for the frog's left side and mirrored in x for the right. */
export function dir(x: number, y: number, z: number, side: Side = "L"): THREE.Vector3 {
  return new THREE.Vector3(x * sideSign(side), y, z).normalize();
}

const EULER = new THREE.Euler(0, 0, 0, "YXZ");
/** Rotation from body-friendly angles (rad): bend forward, lean to its left, turn to its left. */
export function rot(bend: number, lean = 0, turn = 0): THREE.Quaternion {
  EULER.set(bend, turn, -lean, "YXZ");
  return new THREE.Quaternion().setFromEuler(EULER);
}

export function restArm(side: Side): ArmGoal {
  return { upper: dir(0.35, -0.94, 0.05, side), fore: dir(0.15, -0.95, 0.25, side), palm: null, belly: null, overhead: 0, fingers: [...FINGERS.relaxed] };
}

export function straightLeg(side: Side): LegGoal {
  return { thigh: dir(0.06, -1, 0, side), shin: dir(0, -1, 0, side), toe: 0 };
}

/** Bent knee: the knee goes forward and a little out by `bend` (rad), the shin comes back under it. */
export function bentLeg(side: Side, bend: number, out = 0.25): LegGoal {
  const s = Math.sin(bend);
  const c = Math.cos(bend);
  return { thigh: dir(0.06 + out * s, -c, s, side), shin: dir(0.04, -c, -s * 0.85, side), toe: 0 };
}

export function idlePose(): BodyPose {
  return {
    hips: new THREE.Quaternion(),
    spine: new THREE.Quaternion(),
    chest: new THREE.Quaternion(),
    head: new THREE.Quaternion(),
    arm: { L: restArm("L"), R: restArm("R") },
    leg: { L: straightLeg("L"), R: straightLeg("R") },
    lift: 0,
    shift: 0,
    yaw: 0,
    expressions: {},
  };
}

/** Normalised lerp of unit vectors (falls back to a when they are opposite). */
function nlerp(a: THREE.Vector3, b: THREE.Vector3, w: number): THREE.Vector3 {
  const v = a.clone().lerp(b, w);
  return v.lengthSq() < 1e-8 ? a.clone() : v.normalize();
}

function blendBelly(a: BellyHold | null, b: BellyHold | null, w: number): BellyHold | null {
  if (!a && !b) return null;
  const A = a ?? { ...(b as BellyHold), weight: 0 };
  const B = b ?? { ...(a as BellyHold), weight: 0 };
  const l = (x: number, y: number) => x + (y - x) * w;
  return { weight: l(A.weight, B.weight), height: l(A.height, B.height), around: l(A.around, B.around), lift: l(A.lift, B.lift) };
}

function blendPalm(a: PalmGoal | null, b: PalmGoal | null, w: number): PalmGoal | null {
  if (!a && !b) return null;
  const A = a ?? { dir: b!.dir, weight: 0 };
  const B = b ?? { dir: a!.dir, weight: 0 };
  return { dir: nlerp(A.dir, B.dir, w), weight: A.weight + (B.weight - A.weight) * w };
}

export function blendArm(a: ArmGoal, b: ArmGoal, w: number): ArmGoal {
  if (w <= 0) return a;
  if (w >= 1) return b;
  return {
    upper: nlerp(a.upper, b.upper, w),
    fore: nlerp(a.fore, b.fore, w),
    palm: blendPalm(a.palm, b.palm, w),
    belly: blendBelly(a.belly, b.belly, w),
    overhead: a.overhead + (b.overhead - a.overhead) * w,
    fingers: a.fingers.map((x, i) => x + (b.fingers[i] - x) * w) as Fingers,
  };
}

function blendLeg(a: LegGoal, b: LegGoal, w: number): LegGoal {
  return { thigh: nlerp(a.thigh, b.thigh, w), shin: nlerp(a.shin, b.shin, w), toe: a.toe + (b.toe - a.toe) * w };
}

/** a → b by w (0..1). Yaw is blended along the shorter way round. */
export function blendPose(a: BodyPose, b: BodyPose, w: number): BodyPose {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const expressions: ExpressionWeights = {};
  for (const k of new Set([...Object.keys(a.expressions), ...Object.keys(b.expressions)]) as Set<Expression>) {
    const x = a.expressions[k] ?? 0;
    expressions[k] = x + ((b.expressions[k] ?? 0) - x) * w;
  }
  const dyaw = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return {
    hips: a.hips.clone().slerp(b.hips, w),
    spine: a.spine.clone().slerp(b.spine, w),
    chest: a.chest.clone().slerp(b.chest, w),
    head: a.head.clone().slerp(b.head, w),
    arm: { L: blendArm(a.arm.L, b.arm.L, w), R: blendArm(a.arm.R, b.arm.R, w) },
    leg: { L: blendLeg(a.leg.L, b.leg.L, w), R: blendLeg(a.leg.R, b.leg.R, w) },
    lift: a.lift + (b.lift - a.lift) * w,
    shift: a.shift + (b.shift - a.shift) * w,
    yaw: a.yaw + dyaw * w,
    expressions,
  };
}

const mirrorV = (v: THREE.Vector3) => new THREE.Vector3(-v.x, v.y, v.z);
/** Reflection through the YZ plane: x → -x, as a rotation conjugated by the reflection. */
const mirrorQ = (q: THREE.Quaternion) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

function mirrorArm(a: ArmGoal): ArmGoal {
  const palm = a.palm && { dir: mirrorV(a.palm.dir), weight: a.palm.weight };
  return { upper: mirrorV(a.upper), fore: mirrorV(a.fore), palm, belly: a.belly && { ...a.belly }, overhead: a.overhead, fingers: [...a.fingers] };
}
function mirrorLeg(l: LegGoal): LegGoal {
  return { thigh: mirrorV(l.thigh), shin: mirrorV(l.shin), toe: l.toe };
}

/** The pose as seen in a mirror: left and right swapped. */
export function mirrorPose(p: BodyPose): BodyPose {
  return {
    hips: mirrorQ(p.hips),
    spine: mirrorQ(p.spine),
    chest: mirrorQ(p.chest),
    head: mirrorQ(p.head),
    arm: { L: mirrorArm(p.arm.R), R: mirrorArm(p.arm.L) },
    leg: { L: mirrorLeg(p.leg.R), R: mirrorLeg(p.leg.L) },
    lift: p.lift,
    shift: -p.shift,
    yaw: -p.yaw,
    expressions: { ...p.expressions },
  };
}
