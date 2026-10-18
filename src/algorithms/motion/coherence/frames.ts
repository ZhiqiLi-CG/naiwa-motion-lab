/**
 * What the coherence steps share: a track's frames copied for editing, landmark indices, the person's hips, torso
 * length and heading, rotations of the world landmarks about the vertical, and robust statistics.
 *
 * Image landmarks are picture fractions (x of the width, y of the height); lengths in the picture are measured with x
 * scaled by the aspect (width / height), so they are isotropic. World landmarks are MediaPipe's: metres, hip-centred,
 * x right, y down, z away from the camera.
 */
import type { LandmarkFrame } from "../../../motion/api";
import type { Track } from "../../../motion/track";

export type Frame = LandmarkFrame;

export const N = 33;
export const HIP_L = 23, HIP_R = 24, SH_L = 11, SH_R = 12;
/** Left/right landmark pairs (face, arms and hands, legs and feet). */
export const PAIRS: readonly [number, number][] = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];
/** Each foot's landmarks: ankle, heel, toe. */
export const FOOT = { L: [27, 29, 31], R: [28, 30, 32] } as const;

export const present = (f: Frame) => f.world.length >= N && f.image.length >= N;

/** A deep copy of a track's frames. */
export const copyFrames = (frames: Frame[]): Frame[] => frames.map((f) => ({ world: f.world.map((p) => p.slice()), image: f.image.map((p) => p.slice()) }));

export const aspectOf = (t: Track) => t.aspect ?? 1;

/** Hip centre in the picture (x scaled by the aspect, y). */
export function hip(f: Frame, aspect: number): [number, number] {
  return [((f.image[HIP_L][0] + f.image[HIP_R][0]) / 2) * aspect, (f.image[HIP_L][1] + f.image[HIP_R][1]) / 2];
}

/** Shoulder centre to hip centre in the picture (isotropic units of the picture height). */
export function torso(f: Frame, aspect: number): number {
  const s = [((f.image[SH_L][0] + f.image[SH_R][0]) / 2) * aspect, (f.image[SH_L][1] + f.image[SH_R][1]) / 2];
  const h = hip(f, aspect);
  return Math.hypot(s[0] - h[0], s[1] - h[1]);
}

/** The person's heading about the vertical from the hip and shoulder lines of the world landmarks (rad). */
export function heading(f: Frame): number {
  const w = f.world;
  const x = w[HIP_L][0] - w[HIP_R][0] + w[SH_L][0] - w[SH_R][0];
  const z = w[HIP_L][2] - w[HIP_R][2] + w[SH_L][2] - w[SH_R][2];
  return Math.atan2(z, x);
}

export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Rotate the world landmarks about the vertical (in place): heading() grows by `angle`. */
export function rotateWorld(f: Frame, angle: number): void {
  if (!angle) return;
  const c = Math.cos(angle), s = Math.sin(angle);
  for (const p of f.world) {
    const x = p[0], z = p[2];
    p[0] = x * c - z * s;
    p[2] = x * s + z * c;
  }
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))];
}

/** The typical torso length of a track's frames (picture heights). */
export function typicalTorso(frames: Frame[], aspect: number): number {
  const t = median(frames.filter(present).map((f) => torso(f, aspect)));
  return Number.isFinite(t) && t > 1e-3 ? t : 0.25;
}

/** Shots: [from, to) frame ranges between cuts. */
export function shots(n: number, cuts: number[]): [number, number][] {
  const cs = [...new Set(cuts.filter((c) => c > 0 && c < n))].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let from = 0;
  for (const c of cs) out.push([from, c]), (from = c);
  out.push([from, n]);
  return out;
}

/** A torso is about half a metre: picture units → metres for the readouts. */
export const TORSO_M = 0.5;
