/**
 * A person's MediaPipe pose (33 world + 33 image landmarks) → BodyPose for the frog. One code path for the webcam,
 * uploaded videos and dance tracks, so a recorded dancer and a live one look the same on the frog.
 *
 * Directions, not positions: the person's limb and torso directions are copied onto the frog's stubby body (rig.ts
 * keeps them out of its belly). Image landmarks give hops and squats (feet leaving / nearing their floor line).
 */
import * as THREE from "three";
import type { Expression, ExpressionWeights } from "../contracts";
import { bentLeg, idlePose, mirrorPose, restArm, rot, sideSign, SIDES, straightLeg, type BodyPose, type Side } from "./pose";

/** 33 × [x, y, z, visibility]; empty when nobody was found in the frame. */
export type Landmarks = number[][];
export interface LandmarkFrame {
  world: Landmarks;
  image: Landmarks;
}

/** MediaPipe pose landmark indices. */
export const LM = {
  nose: 0, earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
} as const;
const FEET = [27, 28, 29, 30, 31, 32];
const ARM = { L: [11, 13, 15], R: [12, 14, 16] } as const;
const LEG = { L: [23, 25, 27], R: [24, 26, 28] } as const;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const ramp = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Person-to-frog scale of vertical motion: a person's torso (~0.5 m) moving by 1 → this many frog meters. */
const HOP_GAIN = 0.5;
/** The nose sits a little below the ear line in a level head; undo that so a level head is level. */
const HEAD_LEVEL = -0.25;

export interface RetargetOptions {
  /** Fixed floor line (image y of the feet when standing), known for recorded tracks; live it is tracked. */
  floor?: number;
}

export class Retargeter {
  private yaw: number | null = null;
  private floor: number | null;
  private hipBase: number | null = null;
  private readonly fixedFloor: boolean;
  private readonly expr: Record<Expression, number> = { laugh: 0, tongue: 0, blink: 0, surprise: 0 };

  constructor(opts: RetargetOptions = {}) {
    this.floor = opts.floor ?? null;
    this.fixedFloor = opts.floor !== undefined;
  }

  /** The frog pose for one frame (dt seconds after the previous), or null when no usable person is in it. */
  pose(frame: LandmarkFrame, aspect: number, dt: number, mirror: boolean): BodyPose | null {
    const { world, image } = frame;
    if (world.length < 33 || image.length < 33) return null;
    if (Math.min(world[11][3], world[12][3]) < 0.3) return null;
    // MediaPipe world: x right, y down, z away from the camera; the frog: x its left (= image right), y up, z to us.
    const W = world.map((p) => new THREE.Vector3(p[0], -p[1], -p[2]));
    const vis = (i: number) => world[i][3];

    // Heading from the hip and shoulder lines (unwrapped so turning round keeps going).
    const across = W[LM.hipL].clone().sub(W[LM.hipR]).add(W[LM.shoulderL].clone().sub(W[LM.shoulderR]));
    let yaw = Math.atan2(-across.z, across.x);
    if (this.yaw !== null) yaw = this.yaw + Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    this.yaw = yaw;
    const unturn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    const Q = W.map((p) => p.applyQuaternion(unturn));

    const p = idlePose();
    p.yaw = yaw;

    // Torso: the chest frame from the shoulders and the hip→shoulder line; the hips take part of the bend.
    const hipMid = Q[LM.hipL].clone().add(Q[LM.hipR]).multiplyScalar(0.5);
    const shMid = Q[LM.shoulderL].clone().add(Q[LM.shoulderR]).multiplyScalar(0.5);
    const torsoLen = Math.max(1e-3, shMid.distanceTo(hipMid));
    const shoulderW = Math.max(1e-3, Q[LM.shoulderL].distanceTo(Q[LM.shoulderR]));
    const up = shMid.clone().sub(hipMid).normalize();
    const C = frameFrom(Q[LM.shoulderL].clone().sub(Q[LM.shoulderR]), up);
    const bend = Math.atan2(up.z, up.y);
    limitAngle(C, 1.1);
    const pelvis = Q[LM.hipL].clone().sub(Q[LM.hipR]).normalize();
    const H = rot(bend * 0.3, -0.8 * Math.asin(clamp(pelvis.y, -0.5, 0.5)), 0.6 * Math.atan2(-pelvis.z, pelvis.x));
    const S = H.clone().slerp(C, 0.5);
    p.hips = H;
    p.spine = H.clone().invert().multiply(S);
    p.chest = S.clone().invert().multiply(C);

    // Head from the ears and nose, relative to the chest, a little calmer than the person's.
    const earMid = Q[LM.earL].clone().add(Q[LM.earR]).multiplyScalar(0.5);
    const across2 = Q[LM.earL].clone().sub(Q[LM.earR]);
    const face = Q[LM.nose].clone().sub(earMid);
    const G = frameFrom(across2, face.clone().cross(across2).normalize()).multiply(rot(HEAD_LEVEL));
    const head = C.clone().invert().multiply(G);
    p.head = new THREE.Quaternion().slerp(head, 0.8);
    limitAngle(p.head, 0.7);

    // Arms in the chest frame; hands near the belly become a belly hold.
    const toChest = C.clone().invert();
    const holds: Record<Side, number> = { L: 0, R: 0 };
    const peace: Record<Side, number> = { L: 0, R: 0 };
    const high: Record<Side, number> = { L: 0, R: 0 };
    for (const s of SIDES) {
      const [sh, el, wr] = ARM[s];
      const w = ramp(Math.min(vis(el), vis(wr)), 0.3, 0.7);
      const rest = restArm(s);
      const upper = Q[el].clone().sub(Q[sh]).applyQuaternion(toChest).normalize();
      const fore = Q[wr].clone().sub(Q[el]).applyQuaternion(toChest).normalize();
      const r = Q[wr].clone().sub(hipMid).applyQuaternion(toChest);
      const h = r.y / torsoLen;
      const lateral = (sideSign(s) * r.x) / (shoulderW / 2);
      const front = r.z / torsoLen;
      const elbowLow = Q[el].y < Q[wr].y ? 1 : 0;
      const hold = w * ramp(h, -0.15, 0.05) * (1 - ramp(h, 0.6, 0.8)) * (1 - ramp(Math.abs(lateral), 1.0, 1.4)) * ramp(front, -0.05, 0.1) * (1 - ramp(front, 0.5, 0.7));
      holds[s] = hold;
      peace[s] = w * elbowLow * ramp(h, 0.95, 1.1) * (1 - ramp(h, 1.5, 1.7)) * (1 - ramp(Math.abs(lateral), 2.2, 2.8));
      high[s] = w * ramp(h, 1.5, 1.7);
      p.arm[s] = {
        upper: rest.upper.clone().lerp(upper, w).normalize(),
        fore: rest.fore.clone().lerp(fore, w).normalize(),
        palm: null,
        belly: { weight: hold, height: clamp(0.1 + 0.85 * h, 0.05, 0.75), around: clamp(0.3 + 0.8 * lateral, 0.35, 1.4), lift: 0 },
        fingers: [0.1, 0, 0, 0.05, 0.05],
      };
    }

    // Legs in the frog's own (yaw-free) frame; legs out of the picture stand still.
    let legsSeen = 1;
    for (const s of SIDES) {
      const [hp, kn, an] = LEG[s];
      const w = ramp(Math.min(vis(kn), vis(an)), 0.4, 0.75);
      legsSeen = Math.min(legsSeen, w);
      const rest = straightLeg(s);
      p.leg[s] = {
        thigh: rest.thigh.clone().lerp(Q[kn].clone().sub(Q[hp]).normalize(), w).normalize(),
        shin: rest.shin.clone().lerp(Q[an].clone().sub(Q[kn]).normalize(), w).normalize(),
        toe: 0,
      };
    }

    // Hops and squats: the feet rising off their floor line, or (feet unseen) the hips moving off their usual height.
    const I = (i: number) => new THREE.Vector2(image[i][0] * aspect, image[i][1]);
    const torsoImg = Math.max(1e-3, I(LM.shoulderL).add(I(LM.shoulderR)).multiplyScalar(0.5).distanceTo(I(LM.hipL).add(I(LM.hipR)).multiplyScalar(0.5)));
    const feet = FEET.filter((i) => image[i][3] > 0.5 && image[i][1] < 0.99).map((i) => image[i][1]);
    let hop = 0;
    if (feet.length >= 2 && legsSeen > 0.5) {
      const y = Math.max(...feet);
      if (!this.fixedFloor) this.floor = this.floor === null ? y : Math.max(y, this.floor - 0.25 * torsoImg * dt);
      hop = Math.max(0, ((this.floor ?? y) - y) / torsoImg - 0.04);
    } else {
      const hipY = (image[LM.hipL][1] + image[LM.hipR][1]) / 2;
      this.hipBase = this.hipBase === null ? hipY : this.hipBase + (hipY - this.hipBase) * (1 - Math.exp(-dt / 1.5));
      const d = (this.hipBase - hipY) / torsoImg;
      hop = Math.max(0, d - 0.06);
      const squat = Math.max(0, -d - 0.06);
      if (squat > 0) for (const s of SIDES) p.leg[s] = bentLeg(s, Math.min(1.1, squat * 2.5), 0.4);
    }
    p.lift = Math.min(0.35, hop * HOP_GAIN);

    // Big gestures → faces: hands on the belly (more so bent over) laugh, both hands up by the head (peace signs) stick the
    // tongue out,
    // hands on the cheeks or way up are a surprise.
    const onBelly = Math.min(holds.L, holds.R);
    const nose = Q[LM.nose];
    const cheeks = Math.min(...SIDES.map((s) => 1 - ramp(Q[ARM[s][2]].distanceTo(nose) / torsoLen, 0.25, 0.4)));
    const target: ExpressionWeights = {
      laugh: Math.max(onBelly * (0.45 + 0.55 * ramp(bend, 0.15, 0.5)), 0.5 * Math.max(holds.L, holds.R) * ramp(bend, 0.2, 0.5)),
      tongue: Math.min(peace.L, peace.R),
      surprise: Math.max(cheeks, 0.8 * Math.min(high.L, high.R), Math.min(1, hop * 3) * 0.5),
    };
    for (const k of ["laugh", "tongue", "surprise"] as const) {
      const goal = target[k] ?? 0;
      const tau = goal > this.expr[k] ? 0.08 : 0.3;
      this.expr[k] += (goal - this.expr[k]) * (1 - Math.exp(-dt / tau));
      p.expressions[k] = this.expr[k];
    }
    return mirror ? mirrorPose(p) : p;
  }
}

/** Rotation whose +X is `across` and +Y is `up` (across made orthogonal to up). */
function frameFrom(across: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const y = up.clone().normalize();
  const x = across.clone().addScaledVector(y, -across.dot(y)).normalize();
  const z = x.clone().cross(y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Clamp a rotation's angle (in place). */
function limitAngle(q: THREE.Quaternion, max: number): void {
  const angle = 2 * Math.acos(clamp(Math.abs(q.w), -1, 1));
  if (angle > max) q.copy(new THREE.Quaternion().slerp(q, max / angle));
}
