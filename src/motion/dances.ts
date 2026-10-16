/**
 * Built-in procedural dances (original choreography for this body: short arms, huge belly, small head). Each is a
 * seamless loop: every oscillation fits a whole number of times into the duration and envelopes return to their start.
 */
import * as THREE from "three";
import { bentLeg, blendArm, dir, FINGERS, idlePose, rot, sideSign, SIDES, type ArmGoal, type BellyHold, type BodyPose, type Side } from "./pose";

export interface ProceduralDance {
  id: string;
  name: string;
  duration: number;
  pose(t: number): BodyPose;
}

const TAU = Math.PI * 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
/** Eased keyframes [time, value]; holds before the first and after the last key. */
function keys(t: number, k: [number, number][]): number {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t > k[i][0]) continue;
    const [t0, v0] = k[i - 1], [t1, v1] = k[i];
    return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
  }
  return k[k.length - 1][1];
}
/** Smooth bump 0 → 1 → 0 centred at c with half-width w. */
const bump = (t: number, c: number, w: number) => {
  const x = Math.abs(t - c) / w;
  return x >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
};
const wave = (t: number, hz: number, phase = 0) => Math.sin(TAU * (hz * t + phase));
/** 0..1, 1 on every beat of a hz pulse, sharpened. */
const onBeat = (t: number, hz: number, sharp = 2) => Math.pow(0.5 + 0.5 * Math.cos(TAU * hz * t), sharp);
/** Ballistic hop of height h between t0 and t1. */
const arc = (t: number, t0: number, t1: number, h: number) => {
  if (t <= t0 || t >= t1) return 0;
  const x = (t - t0) / (t1 - t0);
  return 4 * h * x * (1 - x);
};

type V = [number, number, number];
function arm(side: Side, upper: V, fore: V, more: Partial<ArmGoal> = {}): ArmGoal {
  return { upper: dir(...upper, side), fore: dir(...fore, side), palm: null, belly: null, fingers: FINGERS.relaxed, ...more };
}
const hold = (height: number, around: number, lift = 0, weight = 1): BellyHold => ({ weight, height, around, lift });
/** Palm towards the camera. */
const palmFront = () => ({ dir: new THREE.Vector3(0, 0, 1), weight: 1 });

/** Bend spread over hips, spine and chest (a fat body bends everywhere a bit). */
function torso(p: BodyPose, bend: number, lean = 0, turn = 0) {
  p.hips = rot(bend * 0.25, lean * 0.3, turn * 0.3);
  p.spine = rot(bend * 0.35, lean * 0.35, turn * 0.35);
  p.chest = rot(bend * 0.4, lean * 0.35, turn * 0.35);
}

const peaceArm = (side: Side, kick = 0): ArmGoal =>
  arm(side, [0.8, -0.2, 0.45], [0.1, 1, 0.15 + 0.4 * kick], { palm: palmFront(), fingers: FINGERS.peace });
const akimbo = (side: Side): ArmGoal => arm(side, [0.95, -0.25, -0.35], [-0.35, -0.6, 0.35], { fingers: FINGERS.fist });

export const PROCEDURAL_DANCES: ProceduralDance[] = [
  {
    id: "belly-laugh",
    name: "捧腹大笑",
    duration: 4,
    pose(t) {
      const p = idlePose();
      const ha = onBeat(t, 4, 1); // "ha ha ha", four a second
      const back = keys(t, [[1.3, 0], [1.75, 1], [2.45, 1], [2.9, 0]]);
      const sway = keys(t, [[2.6, 0], [3.0, 1], [3.7, 1], [4, 0]]) * 0.16 * wave(t, 1.5);
      const bend = keys(t, [[0, 0.45], [1.3, 0.55], [1.75, -0.22], [2.45, -0.15], [2.9, 0.7], [3.6, 0.6], [4, 0.45]]) + 0.08 * ha;
      torso(p, bend, sway, sway * 0.5);
      // Doubled over, the face still looks up at you; leaning back, the head is thrown back.
      p.head = rot(-0.75 * bend - 0.05 - 0.3 * back + 0.1 * ha, -sway, 0);
      for (const s of SIDES) {
        const pat = 0.012 * onBeat(t, 4, 1) + 0.03 * bump(t, s === "L" ? 3.2 : 3.45, 0.12);
        p.arm[s] = arm(s, [0.6, -0.6, 0.5], [0, -0.5, 1], { belly: hold(0.22 + 0.25 * back, 0.7 + 0.15 * back, pat), fingers: FINGERS.open });
        p.leg[s] = bentLeg(s, (0.18 + 0.12 * ha) * (1 - 0.7 * back), 0.35);
      }
      const stomp = bump(t, 3.05, 0.17) + bump(t, 3.5, 0.17);
      if (stomp > 0) p.leg.R = bentLeg("R", 0.2 + 0.9 * stomp, 0.5);
      p.lift = 0.012 * ha * (1 - back);
      p.expressions = { laugh: 0.85 + 0.15 * ha };
      return p;
    },
  },
  {
    id: "peace",
    name: "比耶",
    duration: 4,
    pose(t) {
      const p = idlePose();
      const kick = onBeat(t, 2, 3); // 120 bpm
      const tilt = 0.28 * Math.sin((TAU * t) / 2);
      const reach = keys(t, [[1.9, 0], [2.2, 1], [2.9, 1], [3.15, 0]]);
      const air = keys(t, [[3.2, 0], [3.35, 1], [3.65, 1], [3.8, 0]]);
      const crouch = bump(t, 3.2, 0.12) + bump(t, 3.85, 0.12);
      torso(p, 0.05 + 0.08 * kick - 0.1 * air, -0.1 * tilt, 0.15 * reach);
      p.head = rot(-0.05 - 0.1 * air, tilt, 0.1 * reach);
      for (const s of SIDES) {
        const base = peaceArm(s, kick);
        const high = arm(s, [0.55, 0.6, 0.35], [0.15, 1, 0.1], { palm: palmFront(), fingers: FINGERS.peace });
        p.arm[s] = blendArm(base, high, air);
        p.leg[s] = bentLeg(s, 0.1 + 0.18 * kick * (1 - air) + 0.6 * crouch, 0.3);
        p.leg[s].toe = 0.4 * air;
      }
      p.arm.R = blendArm(p.arm.R, arm("R", [0.3, 0.15, 1], [0, 1, 0.45], { palm: palmFront(), fingers: FINGERS.peace }), reach);
      p.lift = arc(t, 3.3, 3.75, 0.09);
      p.expressions = { tongue: 1 };
      return p;
    },
  },
  {
    id: "wiggle",
    name: "扭屁股",
    duration: 5,
    pose(t) {
      const p = idlePose();
      const w = keys(t, [[0.5, 0], [0.9, 1], [3.9, 1], [4.3, 0]]);
      const roll = 0.3 * w * wave(t, 2.4);
      const turn = 0.2 * w * wave(t, 2.4, 0.25);
      p.yaw = keys(t, [[0, 0], [0.7, 2.6], [4.1, 2.6], [4.8, 0]]);
      p.hips = rot(0.25 * w, roll, turn);
      p.spine = rot(0.15 * w, -0.8 * roll, -0.6 * turn);
      p.chest = rot(0.1 * w, -0.3 * roll, 0);
      p.head = rot(-0.1 * w, 0.15 * w, -0.85 * w); // looks back at the camera over its right shoulder
      for (const s of SIDES) {
        p.arm[s] = blendArm(arm(s, [0.4, -0.9, 0.1], [0.2, -0.95, 0.2]), akimbo(s), w);
        p.leg[s] = bentLeg(s, 0.12 + 0.3 * w * clamp01((sideSign(s) * roll) / 0.3), 0.3);
      }
      const slap = bump(t, 3.5, 0.15); // a pat on its own bottom
      if (slap > 0) p.arm.R = blendArm(p.arm.R, arm("R", [0.6, -0.6, -0.6], [0.1, -0.4, -1], { fingers: FINGERS.open }), slap);
      p.expressions = { tongue: 0.8 * w, laugh: 0.6 * bump(t, 4.6, 0.35) };
      return p;
    },
  },
  {
    id: "disco",
    name: "蹦迪",
    duration: 3.75,
    pose(t) {
      const p = idlePose();
      const hz = 128 / 60;
      const beat = t * hz;
      const dip = onBeat(t, hz, 2);
      const roof = keys(beat, [[3.7, 0], [4.1, 1], [5.7, 1], [6, 0]]);
      const spin = keys(beat, [[5.8, 0], [6.1, 1], [7.6, 1], [8, 0]]);
      const point = 0.5 + 0.5 * Math.cos((TAU * beat) / 2); // up on even beats, down on odd ones
      p.yaw = keys(beat, [[6, 0], [7.7, TAU]]);
      torso(p, 0.1 * dip - 0.1 * spin, 0.12 * (point - 0.5) * (1 - roof - spin), 0.25 * (point - 0.5) * (1 - roof - spin));
      p.head = rot(0.15 * dip - 0.25 * spin, -0.15 * (point - 0.5), 0);
      for (const s of SIDES) {
        const wide = arm(s, [1, 0.1, 0], [1, 0.2, 0], { fingers: FINGERS.open });
        const up = arm(s, [0.6, 0.75, 0.2], [0.2, 0.6 + 0.4 * dip, 0.3], { fingers: FINGERS.open });
        p.arm[s] = blendArm(blendArm(akimbo(s), up, roof), wide, spin);
        p.leg[s] = bentLeg(s, 0.1 + 0.3 * dip, 0.35);
      }
      const fever = blendArm(
        arm("R", [-0.25, -0.6, 0.75], [-0.4, -0.6, 0.6], { fingers: FINGERS.point }),
        arm("R", [0.55, 0.8, 0.25], [0.45, 0.85, 0.2], { fingers: FINGERS.point }),
        point,
      );
      p.arm.R = blendArm(fever, p.arm.R, Math.max(roof, spin));
      p.lift = (1 - spin) * (arc(beat % 1, 0.2, 0.8, 0.03) * (Math.floor(beat) % 2 === 1 ? 1 : 0)) + arc(beat, 6.1, 7.7, 0.06);
      p.expressions = { laugh: (0.4 + 0.3 * dip) * (1 - spin), surprise: 0.8 * spin };
      return p;
    },
  },
  {
    id: "sway",
    name: "摇摆",
    duration: 4,
    pose(t) {
      const p = idlePose();
      const s = Math.sin((TAU * t) / 2);
      const late = Math.sin(TAU * (t / 2 - 0.08));
      const wings = keys(t, [[1.6, 0], [2.1, 1], [3.6, 1], [4, 0]]);
      torso(p, 0.04, 0.2 * s, 0.08 * late);
      p.hips = rot(0, -0.12 * s, 0);
      p.head = rot(0, -0.18 * late, 0);
      for (const side of SIDES) {
        const sg = sideSign(side);
        const over: ArmGoal = { upper: dir(0.35, 0.92, 0.1, side), fore: new THREE.Vector3(0.15 * sg + 0.5 * s, 1, 0.1).normalize(), palm: null, belly: null, fingers: FINGERS.open };
        const wing = arm(side, [1, -0.05, 0.1], [1, 0.35 * wave(t, 1, side === "L" ? 0 : 0.5), 0.15], { fingers: FINGERS.open });
        p.arm[side] = blendArm(over, wing, wings);
        p.leg[side] = bentLeg(side, 0.06 + 0.3 * clamp01(-sg * s), 0.2);
      }
      p.expressions = { tongue: 0.35, blink: 0.9 * (bump(t, 1, 0.3) + bump(t, 3, 0.3)) };
      return p;
    },
  },
  {
    id: "frog-hop",
    name: "青蛙跳",
    duration: 3.2,
    pose(t) {
      const p = idlePose();
      const n = Math.floor(t / 1.6);
      const u = t - n * 1.6;
      const squat = keys(u, [[0, 0.15], [0.35, 1], [0.45, 0.05], [0.78, 0.05], [0.88, 1], [1.2, 0.35], [1.6, 0.15]]);
      const air = keys(u, [[0.32, 0], [0.45, 1], [0.75, 1], [0.86, 0]]);
      p.yaw = n * Math.PI + keys(u, [[0.42, 0], [0.82, Math.PI]]);
      p.lift = arc(u, 0.42, 0.82, 0.28);
      torso(p, 0.4 * squat * (1 - air) - 0.12 * air);
      p.head = rot(-0.2 * squat - 0.15 * air, 0, 0);
      for (const s of SIDES) {
        const back = arm(s, [0.45, -0.7, -0.6], [0.3, -0.8, -0.5], { fingers: FINGERS.open });
        const up = arm(s, [0.5, 0.85, 0.15], [0.3, 0.95, 0.1], { fingers: FINGERS.open });
        const front = arm(s, [0.7, -0.2, 0.7], [0.4, 0, 1], { fingers: FINGERS.open });
        p.arm[s] = blendArm(blendArm(back, up, air), front, bump(u, 1.0, 0.3));
        p.leg[s] = bentLeg(s, 1.15 * squat, 0.55);
        p.leg[s].toe = 0.6 * air;
      }
      p.expressions = { surprise: 0.9 * air, laugh: bump(u, 1.15, 0.35) };
      return p;
    },
  },
  {
    id: "belly-drum",
    name: "拍肚皮",
    duration: 4,
    pose(t) {
      const p = idlePose();
      const fast = keys(t, [[1.9, 0], [2.1, 1], [2.9, 1], [3.05, 0]]);
      const finale = keys(t, [[3.05, 0], [3.2, 1], [3.8, 1], [4, 0]]);
      const both = Math.pow(Math.max(0, Math.sin(TAU * 2.5 * (t - 3.0))), 0.7) * finale;
      torso(p, -0.12 + 0.1 * finale * both, 0.06 * wave(t, 1), 0);
      p.head = rot(0.12 * onBeat(t, 4, 2) - 0.2 * finale, 0.1 * wave(t, 0.5), 0);
      for (const s of SIDES) {
        const ph = s === "L" ? 0 : 0.5;
        const slow = Math.pow(Math.max(0, Math.sin(TAU * (2 * t + ph))), 0.7);
        const quick = Math.pow(Math.max(0, Math.sin(TAU * (4 * t + ph))), 0.7);
        const lift = (1 - finale) * (0.07 * slow * (1 - fast) + 0.035 * quick * fast) + 0.08 * both;
        p.arm[s] = arm(s, [0.6, -0.6, 0.5], [0, -0.5, 1], { belly: hold(0.3, 0.75, lift), fingers: FINGERS.open });
        p.leg[s] = bentLeg(s, 0.12 + 0.08 * onBeat(t, 2, 2), 0.3);
      }
      p.lift = arc(t, 3.55, 3.85, 0.05);
      p.expressions = { tongue: 0.75 * (1 - finale), laugh: finale };
      return p;
    },
  },
  {
    id: "jiggle",
    name: "抖肚肚",
    duration: 3,
    pose(t) {
      const p = idlePose();
      const on = keys(t, [[0.1, 0], [0.25, 1], [1.15, 1], [1.3, 0], [1.6, 0], [1.75, 1], [2.7, 1], [2.85, 0]]);
      const low = keys(t, [[1.4, 0], [1.7, 1], [2.8, 1], [3, 0]]);
      const shake = on * wave(t, 6);
      p.hips = rot(0.05, 0.08 * shake, 0.32 * shake);
      p.spine = rot(0.05, -0.05 * shake, -0.18 * shake);
      p.chest = rot(0, 0, -0.08 * shake);
      p.head = rot(-0.1 * on, 0.15 * Math.sin(TAU * t / 3), 0);
      for (const s of SIDES) {
        const up = arm(s, [0.75, 0.6, 0.2], [0.3 + 0.25 * shake * sideSign(s), 0.95, 0.1], { fingers: FINGERS.open });
        p.arm[s] = blendArm(up, arm(s, [1, -0.1, 0.2], [0.8, 0.5, 0.3], { fingers: FINGERS.open }), low);
        p.leg[s] = bentLeg(s, 0.15 + 0.5 * low, 0.6);
      }
      p.expressions = { laugh: 0.4 + 0.5 * on * low, surprise: 0.6 * (1 - on) * (1 - low) };
      return p;
    },
  },
  {
    id: "wave",
    name: "招手嗨",
    duration: 3,
    pose(t) {
      const p = idlePose();
      const w = wave(t, 2);
      const bob = onBeat(t, 1, 2);
      torso(p, 0.04 + 0.05 * bob, 0.1, -0.12);
      p.head = rot(0.05 * bob, -0.25, -0.1);
      p.arm.R = arm("R", [0.75, 0.35, 0.35], [0.05 + 0.5 * w, 1, 0.2], { palm: palmFront(), fingers: FINGERS.open });
      p.arm.L = arm("L", [0.6, -0.6, 0.5], [0, -0.5, 1], { belly: hold(0.35, 0.8, 0.01 * bob), fingers: FINGERS.open });
      for (const s of SIDES) p.leg[s] = bentLeg(s, 0.08 + 0.12 * bob, 0.25);
      p.expressions = { laugh: 0.35 + 0.25 * bob, blink: bump(t, 2.2, 0.12) };
      return p;
    },
  },
];
