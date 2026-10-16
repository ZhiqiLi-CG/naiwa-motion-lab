/**
 * Dance tracks: a person's landmarks per frame (public/dances/*.json, analysed uploads, saved "我的舞蹈"), played back
 * through the Retargeter like a live person.
 */
import type { DanceTrack } from "../contracts";
import { OneEuro } from "./oneEuro";
import type { BodyPose } from "./pose";
import { Retargeter, type LandmarkFrame, type Landmarks } from "./retarget";

/** A track with the frame aspect (width / height) its image landmarks were measured in. */
export type Track = DanceTrack & { aspect?: number };

const FEET = [27, 28, 29, 30, 31, 32];

/** The feet's floor line: where the lowest visible foot usually is (a high percentile, so hops do not count). */
export function trackFloor(frames: LandmarkFrame[]): number | undefined {
  const lows: number[] = [];
  for (const f of frames) {
    if (f.image.length < 33) continue;
    const ys = FEET.filter((i) => f.image[i][3] > 0.5 && f.image[i][1] < 0.99).map((i) => f.image[i][1]);
    if (ys.length >= 2) lows.push(Math.max(...ys));
  }
  if (lows.length < frames.length * 0.3) return undefined;
  lows.sort((a, b) => a - b);
  return lows[Math.floor(lows.length * 0.9)];
}

function lerpLandmarks(a: Landmarks, b: Landmarks, w: number): Landmarks {
  return a.map((p, i) => p.map((x, k) => x + (b[i][k] - x) * w));
}

/** The frame at time t (seconds, looping), interpolated between neighbours; empty when nobody is there. */
export function frameAt(track: DanceTrack, t: number): LandmarkFrame {
  const n = track.frames.length;
  const f = ((((t * track.fps) % n) + n) % n);
  const i = Math.floor(f), j = (i + 1) % n, w = f - i;
  const A = track.frames[i], B = track.frames[j];
  if (A.world.length < 33) return w > 0.5 && B.world.length >= 33 ? B : A;
  if (B.world.length < 33) return A;
  return { world: lerpLandmarks(A.world, B.world, w), image: lerpLandmarks(A.image, B.image, w) };
}

/** Plays a track at its own pace (or at a given time, for videos in sync). */
export class TrackPlayer {
  private readonly retarget: Retargeter;
  constructor(readonly track: Track) {
    this.retarget = new Retargeter({ floor: trackFloor(track.frames) });
  }
  pose(t: number, dt: number, mirror: boolean): BodyPose | null {
    return this.retarget.pose(frameAt(this.track, t), this.track.aspect ?? 1, dt, mirror);
  }
}

/**
 * Zero-phase smoothing of a recorded sequence: a One Euro filter run forwards and backwards, averaged, so fast moves
 * keep their timing (no lag) and still poses lose their jitter. Gaps (nobody seen) shorter than maxGap seconds are
 * bridged by interpolation; longer ones stay empty.
 */
export function smoothFrames(frames: LandmarkFrame[], fps: number, maxGap = 0.5): LandmarkFrame[] {
  const out = frames.map((f) => ({ world: f.world.map((p) => [...p]), image: f.image.map((p) => [...p]) }));
  const present = out.map((f) => f.world.length >= 33);
  // Bridge short gaps.
  for (let i = 0; i < out.length; i++) {
    if (present[i]) continue;
    let j = i;
    while (j < out.length && !present[j]) j++;
    if (i > 0 && j < out.length && (j - i) / fps <= maxGap) {
      for (let k = i; k < j; k++) {
        const w = (k - i + 1) / (j - i + 1);
        out[k] = { world: lerpLandmarks(out[i - 1].world, out[j].world, w), image: lerpLandmarks(out[i - 1].image, out[j].image, w) };
        present[k] = true;
      }
    }
    i = j;
  }
  const run = (order: number[], key: "world" | "image", minCutoff: number, beta: number) => {
    const f = new OneEuro(minCutoff, beta);
    const res = new Map<number, Float64Array>();
    let last = -2;
    for (const i of order) {
      if (!present[i]) continue;
      if (Math.abs(i - last) > 1) f.reset();
      last = i;
      const v = Float64Array.from(out[i][key].flatMap((p) => p.slice(0, 3)));
      f.filter(v, i / fps);
      res.set(i, v);
    }
    return res;
  };
  const idx = out.map((_, i) => i);
  for (const [key, minCutoff, beta] of [["world", 1.2, 4], ["image", 1.2, 6]] as const) {
    const fw = run(idx, key, minCutoff, beta);
    const bw = run([...idx].reverse(), key, minCutoff, beta);
    for (const [i, a] of fw) {
      const b = bw.get(i)!;
      out[i][key] = out[i][key].map((p, k) => [(a[k * 3] + b[k * 3]) / 2, (a[k * 3 + 1] + b[k * 3 + 1]) / 2, (a[k * 3 + 2] + b[k * 3 + 2]) / 2, p[3]]);
    }
  }
  return out;
}

/** Fetch public/dances/<file>. */
export async function fetchTrack(url: string): Promise<Track> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`motion: ${url}: HTTP ${res.status}`);
  return (await res.json()) as Track;
}
