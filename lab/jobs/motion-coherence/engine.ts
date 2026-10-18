/**
 * What the motion-coherence job runs in Node, bundled by job.mjs (esbuild) from the page's own sources: the coherence
 * algorithm (src/algorithms/motion/coherence), its landmark metrics, and the frog's metrics from playing a track
 * through a retargeter (the same pipeline the page uses), all folded into one score.
 */
import { existsSync } from "node:fs";
import { registerBuiltins } from "../../../src/motion/blocks";
import { createRetargetPipeline } from "../../../src/motion/core";
import { recordingOf, TrackPlayer, type Track } from "../../../src/motion/track";
import type { RetargetMetrics } from "../../../src/motion/api";
import type { Binding } from "../../../src/motion/rig";
import { registerMotionLibrary } from "../../../src/algorithms/motion/index";
import { GLB, glbRig, testRig } from "../../../src/algorithms/motion/rigs";
import { AUTO, coherence, compare, DEFAULTS, type CoherenceParams, type CoherenceReport } from "../../../src/algorithms/motion/coherence";
import { film, looped } from "../../../src/algorithms/motion/coherence/synthetic";

export { AUTO, DEFAULTS, film, looped };
export type { CoherenceParams, CoherenceReport, Track };

let rig: Promise<Binding> | null = null;
/** The frog: naiwa.glb when run from the repository (the page's frog), else the test skeleton. */
export function frog(): Promise<Binding> {
  registerBuiltins();
  registerMotionLibrary();
  rig ??= existsSync(GLB) ? glbRig() : Promise.resolve(testRig());
  return rig;
}

/** The whole track (up to a minute) played at 60 fps through a retargeter; its metrics averaged over 2 s windows. */
export async function frogMetrics(track: Track, retargeter = "direction-copy"): Promise<RetargetMetrics> {
  const b = await frog();
  const p = createRetargetPipeline(b, { id: retargeter, settings: {} }, recordingOf(track));
  const player = new TrackPlayer(track, () => p);
  const windows: RetargetMetrics[] = [];
  const seconds = Math.min(60, Math.max(4, track.frames.length / track.fps));
  for (let i = 1; i <= seconds * 60; i++) {
    const g = player.goal(i / 60, 1 / 60, false);
    if (g) p.pose(g, 1 / 60);
    if (i % 120 === 0 && p.metrics()) windows.push(p.metrics()!);
  }
  const mean = (k: keyof RetargetMetrics) => windows.reduce((a, w) => a + w[k], 0) / Math.max(1, windows.length);
  return { fidelity: mean("fidelity"), jerk: mean("jerk"), footSlide: mean("footSlide"), penetration: Math.max(0, ...windows.map((w) => w.penetration)) };
}

/** The numbers the job reports (lower is better for every one). */
export type Numbers = Record<string, number>;

/** Landmark and frog numbers of a track; `contactsFrom`/`reference` from the coherent result so before and after are
 *  measured alike. */
async function numbers(t: Track, landmark: ReturnType<typeof compare>["after"], retargeter: string): Promise<Numbers> {
  const f = await frogMetrics(t, retargeter);
  return {
    "jerk m/s³": landmark.jerk,
    "travel jerk m/s³": landmark.travelJerk,
    "foot slide cm/s": landmark.footSlide * 100,
    "speed at cuts m/s": landmark.cutSpeed,
    "bone length variation %": landmark.boneCV,
    "distance from the person cm": landmark.fidelity ?? 0,
    "frog jerk m/s³": f.jerk,
    "frog foot slide cm/s": f.footSlide * 100,
    "frog direction error °": f.fidelity,
  };
}

/**
 * One score, lower is better: the coherence numbers relative to the input's (so each counts about the same), plus a
 * penalty for drifting from the person (more than 5 cm) or for the frog copying them worse than before.
 */
export function score(n: Numbers, input: Numbers): number {
  const keys = ["jerk m/s³", "travel jerk m/s³", "foot slide cm/s", "speed at cuts m/s", "bone length variation %", "frog jerk m/s³", "frog foot slide cm/s"];
  const floor: Record<string, number> = { "foot slide cm/s": 0.5, "speed at cuts m/s": 0.2, "frog foot slide cm/s": 0.5 };
  let s = 0;
  for (const k of keys) s += n[k] / Math.max(floor[k] ?? 1e-3, input[k]);
  s /= keys.length;
  s += Math.max(0, n["distance from the person cm"] - 5) / 5;
  s += Math.max(0, n["frog direction error °"] - input["frog direction error °"]) / 10;
  return s;
}

export interface Evaluation {
  track: Track;
  report: CoherenceReport;
  before: Numbers;
  after: Numbers;
  score: number;
}

/** Make a track coherent with the given parameters and measure it against the track as it came. */
export async function evaluate(input: Track, params: Partial<CoherenceParams>, retargeter = "direction-copy"): Promise<Evaluation> {
  const result = coherence(input, { ...DEFAULTS, ...params });
  const { before, after } = compare(input, result, { ...DEFAULTS, ...params });
  const nb = await numbers(input, before, retargeter), na = await numbers(result.track, after, retargeter);
  return { track: result.track, report: result.report, before: nb, after: na, score: score(na, nb) };
}

/** The worst stretches of a track for a brief: one-second windows ranked by the hips' jerk and speed. */
export function hotspots(t: Track, count = 6): { from: number; to: number; travelJerk: number; peakSpeed: number }[] {
  const fps = t.fps, n = t.frames.length, aspect = t.aspect ?? 1;
  const hip = (k: number) => {
    const f = t.frames[k];
    if (!f || f.image.length < 33) return null;
    return [((f.image[23][0] + f.image[24][0]) / 2) * aspect, (f.image[23][1] + f.image[24][1]) / 2];
  };
  const out: { from: number; to: number; travelJerk: number; peakSpeed: number }[] = [];
  const W = Math.max(4, Math.round(fps));
  for (let a = 0; a + W <= n; a += Math.round(W / 2)) {
    let j = 0, jn = 0, peak = 0;
    for (let k = a + 1; k + 2 < a + W; k++) {
      const p = [hip(k - 1), hip(k), hip(k + 1), hip(k + 2)];
      if (p.some((x) => !x)) continue;
      const [q0, q1, q2, q3] = p as number[][];
      j += Math.hypot(q3[0] - 3 * q2[0] + 3 * q1[0] - q0[0], q3[1] - 3 * q2[1] + 3 * q1[1] - q0[1]) * fps ** 3;
      jn++;
      peak = Math.max(peak, Math.hypot(q2[0] - q1[0], q2[1] - q1[1]) * fps);
    }
    if (jn) out.push({ from: a, to: a + W, travelJerk: j / jn, peakSpeed: peak });
  }
  return out.sort((x, y) => y.travelJerk - x.travelJerk).slice(0, count);
}
