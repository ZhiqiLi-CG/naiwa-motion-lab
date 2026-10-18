/**
 * Synthetic moving-camera footage for tests and the Lab job's self-test: a dance track (as if seen by a still camera)
 * seen again through a known camera — a pan with a tilt and a zoom, then a cut to another framing and camera angle
 * that pans back — with a camera estimate that drifts like a real one and detector noise on the landmarks.
 */
import type { Track } from "../../../motion/track";
import { copyFrames, rotateWorld } from "./frames";

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648 - 0.5);

/** A dance looped to at least `seconds`. */
export function looped(t: Track, seconds: number): Track {
  const frames = [];
  while (frames.length < seconds * t.fps) frames.push(...copyFrames(t.frames));
  return { ...t, frames, duration: frames.length / t.fps };
}

export interface Scenario {
  raw: Track;
  cut: number;
  turn: number;
}

/** The truth seen through a moving camera with a cut, the camera estimate drifting, detector noise. */
export function film(truth: Track, seed = 1): Scenario {
  const n = truth.frames.length, cut = Math.round(n * 0.55);
  const rnd = rng(seed);
  const turn = (40 * Math.PI) / 180;
  // Within shot A: pan left 25 % of the picture, tilt, zoom in 25 %. Shot B: framed smaller and off-centre, the camera
  // turned 40° round the person, then panning right.
  const camA = (k: number) => ({ s: 1 + (0.25 * k) / cut, tx: -0.25 * (k / cut) + 0.03 * Math.sin(k / 9), ty: 0.04 * Math.sin(k / 23) });
  const camB = (k: number) => ({ s: 1 + 0.05 * Math.sin((k - cut) / 30), tx: (0.15 * (k - cut)) / (n - cut), ty: 0 });
  const frameB = { s: 0.7, tx: 0.15, ty: -0.05 };
  let driftX = 0, driftY = 0, driftS = 0;
  const camera: { shift: [number, number]; scale: number }[] = [];
  const frames = truth.frames.map((f, k) => {
    const g = { world: f.world.map((p) => [p[0] + rnd() * 0.02, p[1] + rnd() * 0.02, p[2] + rnd() * 0.02, p[3]]), image: f.image.map((p) => [p[0] + rnd() * 0.008, p[1] + rnd() * 0.008, p[2], p[3]]) };
    const inB = k >= cut;
    const c = inB ? camB(k) : camA(k);
    // The camera estimate: the truth plus a random walk (about 0.1 % of the picture per frame), restarted at the cut.
    if (k === cut) driftX = driftY = driftS = 0;
    if (k !== 0 && k !== cut) (driftX += rnd() * 0.002), (driftY += rnd() * 0.002), (driftS += rnd() * 0.002);
    camera.push({ shift: [c.tx + driftX, c.ty + driftY], scale: c.s * (1 + driftS) });
    for (const p of g.image) {
      let x = p[0], y = p[1];
      if (inB) (x = frameB.s * (x - 0.5) + 0.5 + frameB.tx), (y = frameB.s * (y - 0.5) + 0.5 + frameB.ty);
      p[0] = c.s * (x - 0.5) + 0.5 + c.tx;
      p[1] = c.s * (y - 0.5) + 0.5 + c.ty;
      p[2] *= c.s * (inB ? frameB.s : 1);
    }
    if (inB) rotateWorld(g, -turn);
    return g;
  });
  return { raw: { ...truth, frames, camera, cuts: [cut] }, cut, turn };
}

