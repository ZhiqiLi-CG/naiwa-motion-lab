/**
 * The one harness every algorithm of the library is measured with (bench.test.ts prints the tables in
 * docs/learn/motion-index.md): a dance track played at 60 fps (the page's display rate) through createRetargetPipeline, the pipeline's own
 * metrics read over consecutive two-second windows, and the cost of the solver and output blocks timed on their own.
 *
 * Filters are measured on the same tracks with seeded detector noise added: how far the filtered landmarks stay from
 * the clean ones (RMSE) and how smooth the frog then moves (jerk), both causally (camera) and on the whole recording.
 */
import type { PersonFrame, RetargetMetrics, Settings, Slot } from "../../motion/api";
import { createRetargetPipeline } from "../../motion/core";
import { resolve } from "../../motion/registry";
import type { Binding } from "../../motion/rig";
import { fk } from "../../motion/rig";
import { recordingOf, TrackPlayer, type Track } from "../../motion/track";
import * as THREE from "three";

const FPS = 60;
/** Seconds played: long enough for three metric windows on every track. */
const PLAY = 6;

export interface RetargetOptions {
  id: string;
  settings?: Settings;
  blocks?: Partial<Record<Slot, string>>;
}

export interface SolverRun extends RetargetMetrics {
  /** Mean milliseconds per frame of the solver and of the output block. */
  solveMs: number;
  outputMs: number;
}

/** Play a track through a retargeter; metrics averaged over three two-second windows (penetration: the worst). */
export function measureRetargeter(rig: Binding, o: RetargetOptions, track: Track): SolverRun {
  const options = { id: o.id, settings: o.settings ?? {}, blocks: o.blocks };
  const p = createRetargetPipeline(rig, options, recordingOf(track));
  const player = new TrackPlayer(track, () => p);
  const windows: RetargetMetrics[] = [];
  const goals = [];
  for (let i = 1; i <= PLAY * FPS; i++) {
    const g = player.goal(i / FPS, 1 / FPS, false);
    if (!g) continue;
    goals.push(g);
    p.pose(g, 1 / FPS);
    if (i % (2 * FPS) === 0) windows.push(p.metrics()!);
  }
  const mean = (k: keyof RetargetMetrics) => windows.reduce((a, w) => a + w[k], 0) / windows.length;

  // Cost: a fresh pipeline's solver and an output block of the same kind, timed over the same goals.
  const q = createRetargetPipeline(rig, options, recordingOf(track));
  const r = resolve(options).get("output")!;
  const output = (r.def.create as (s: typeof q.scene, x: Settings) => { pose(f: ReturnType<typeof q.scene.solver.solve>, dt: number): unknown })(q.scene, r.settings);
  let solve = 0, out = 0;
  for (const g of goals) {
    const t0 = performance.now();
    const frog = q.scene.solver.solve(g);
    const t1 = performance.now();
    output.pose(frog, 1 / 60);
    solve += t1 - t0;
    out += performance.now() - t1;
  }
  return {
    fidelity: mean("fidelity"), jerk: mean("jerk"), footSlide: mean("footSlide"),
    penetration: Math.max(...windows.map((w) => w.penetration)),
    solveMs: solve / goals.length, outputMs: out / goals.length,
  };
}

/** Seeded detector noise: uniform ±2 cm on the world landmarks (σ 11.5 mm), ±1 % of the picture on the image ones. */
export function noisy(track: Track, seed = 1): PersonFrame[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  return track.frames.map((f) => ({
    world: f.world.map((p) => [p[0] + rnd() * 0.04, p[1] + rnd() * 0.04, p[2] + rnd() * 0.04, p[3]]),
    image: f.image.map((p) => [p[0] + rnd() * 0.02, p[1] + rnd() * 0.02, p[2], p[3]]),
    aspect: track.aspect ?? 1,
  }));
}

export interface FilterRun {
  /** RMSE (mm) of the filtered world landmarks against the clean track: live (causal) and on the whole recording. */
  rmseLive: number;
  rmseRecorded: number;
  /** The frog's jerk (m/s³) driven by those landmarks. */
  jerkLive: number;
  jerkRecorded: number;
  /** Mean milliseconds per live frame. */
  liveMs: number;
}

/** A filter block swapped into a retargeter, fed the noisy track (looped twice live, once recorded). */
export function measureFilter(rig: Binding, o: RetargetOptions, track: Track): FilterRun {
  const options = { id: o.id, settings: o.settings ?? {}, blocks: o.blocks };
  const clean = track.frames;
  const input = noisy(track);
  const err = (got: PersonFrame, i: number) => {
    let sum = 0;
    for (let k = 0; k < 33; k++) for (let c = 0; c < 3; c++) sum += (got.world[k][c] - clean[i].world[k][c]) ** 2;
    return sum / 99;
  };
  const jerkOf = (p: ReturnType<typeof createRetargetPipeline>) => p.metrics()!.jerk;

  const live = createRetargetPipeline(rig, options);
  let sq = 0, n = 0, ms = 0;
  for (let loop = 0; loop < 2; loop++) {
    input.forEach((f, i) => {
      const t = (loop * input.length + i) / track.fps;
      const t0 = performance.now();
      const out = live.scene.filter.live(f, t);
      ms += performance.now() - t0;
      if (loop === 1 && out.world.length) (sq += err(out, i)), n++;
      const g = live.scene.goal.goal(out, 1 / track.fps);
      if (g) live.pose(g, 1 / track.fps);
    });
  }
  const rmseLive = Math.sqrt(sq / n) * 1000;
  const jerkLive = jerkOf(live);

  const rec = createRetargetPipeline(rig, options);
  const filtered = rec.recorded(input, track.fps);
  sq = 0;
  n = 0;
  filtered.forEach((f, i) => f.world.length && ((sq += err(f, i)), n++));
  const smoothed: Track = { ...track, frames: filtered };
  const p = createRetargetPipeline(rig, options, recordingOf(smoothed));
  const player = new TrackPlayer(smoothed, () => p);
  for (let i = 1; i <= track.frames.length; i++) {
    const g = player.goal(i / track.fps, 1 / track.fps, false);
    if (g) p.pose(g, 1 / track.fps);
  }
  return { rmseLive, rmseRecorded: Math.sqrt(sq / n) * 1000, jerkLive, jerkRecorded: jerkOf(p), liveMs: ms / (2 * input.length) };
}

/**
 * Foot slide as the page's e2e measures it on the rendered frog (tests/e2e/lib/instrument.js, footSlide), here on the
 * pose targets: heel (ankle) and toe each count while within 1.5 cm of their lowest point of the window, and each
 * stretch of contact by how far the point ends up from where it touched down. Played `warm` s first, then `span` s.
 */
export function measureContact(rig: Binding, toes: Record<"foot_L" | "foot_R", THREE.Vector3>, o: RetargetOptions, track: Track, warm = 2.5, span = 3) {
  const options = { id: o.id, settings: o.settings ?? {}, blocks: o.blocks };
  const p = createRetargetPipeline(rig, options, recordingOf(track));
  const player = new TrackPlayer(track, () => p);
  const samples: Record<string, number[][]> = { foot_L: [], foot_R: [] };
  for (let i = 1; i <= (warm + span) * FPS; i++) {
    const g = player.goal(i / FPS, 1 / FPS, false);
    if (!g) continue;
    const frame = p.pose(g, 1 / FPS);
    if (i / FPS < warm) continue;
    const { D, P } = fk(rig, frame);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), frame.rootYaw ?? 0);
    const off = frame.rootOffset ?? new THREE.Vector3();
    for (const k of ["foot_L", "foot_R"] as const) {
      const ankle = P.get(k)!.clone();
      const toe = ankle.clone().add(toes[k].clone().applyQuaternion(D.get(k)!));
      const [a, t] = [ankle, toe].map((v) => v.applyQuaternion(yaw).add(off));
      samples[k].push([i / FPS, a.x, a.y, a.z, t.x, t.y, t.z]);
    }
  }
  let dist = 0, time = 0;
  for (const s of Object.values(samples)) for (const c of [1, 4]) {
    const low = Math.min(...s.map((x) => x[c + 1]));
    const down = (i: number) => s[i][c + 1] <= low + 0.015;
    for (let i = 0; i < s.length; ) {
      if (!down(i)) { i++; continue; }
      let j = i;
      while (j + 1 < s.length && down(j + 1)) j++;
      if (j > i) (dist += Math.hypot(s[j][c] - s[i][c], s[j][c + 2] - s[i][c + 2])), (time += s[j][0] - s[i][0]);
      if (j > i && (globalThis as { __trace?: boolean }).__trace) console.log("stretch", c === 1 ? "heel" : "toe", s[i][0].toFixed(2), s[j][0].toFixed(2), (Math.hypot(s[j][c] - s[i][c], s[j][c + 2] - s[i][c + 2]) * 100).toFixed(1), "cm");
      i = j + 1;
    }
  }
  return { speed: time ? dist / time : 0, standing: time / 4 / span };
}
