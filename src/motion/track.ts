/**
 * Dance tracks: a person's landmarks per frame (public/dances/*.json, analysed uploads, saved "我的舞蹈"), already
 * filtered, played back through the retargeting pipeline like a live person.
 */
import type { DanceTrack } from "../contracts";
import type { Goal, LandmarkFrame, Landmarks, Recording } from "./api";
import { FEET } from "./blocks/personDirections";
import type { RetargetPipeline } from "./core";

/** A track with the frame aspect (width / height) its image landmarks were measured in. */
export type Track = DanceTrack & { aspect?: number };

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

/** Where the hips usually are across the picture (image x × aspect): the dancer's home spot. */
export function trackHome(frames: LandmarkFrame[], aspect: number): number | undefined {
  const xs = frames.filter((f) => f.image.length >= 33).map((f) => ((f.image[23][0] + f.image[24][0]) / 2) * aspect);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

/** What the whole track tells the retargeting: its floor line and home spot. */
export const recordingOf = (t: Track): Recording => ({ floor: trackFloor(t.frames), home: trackHome(t.frames, t.aspect ?? 1) });

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

/** Plays a track at its own pace (or at a given time, for videos in sync) through a pipeline opened for it. */
export class TrackPlayer {
  constructor(
    readonly track: Track,
    private readonly retarget: () => RetargetPipeline | null,
  ) {}

  goal(t: number, dt: number, mirror: boolean): Goal | null {
    return this.retarget()?.goal({ ...frameAt(this.track, t), aspect: this.track.aspect ?? 1 }, dt, mirror) ?? null;
  }
}

/** Fetch public/dances/<file>. */
export async function fetchTrack(url: string): Promise<Track> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`motion: ${url}: HTTP ${res.status}`);
  return (await res.json()) as Track;
}
