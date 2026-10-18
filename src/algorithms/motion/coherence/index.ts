/**
 * Motion coherence: a dance track analysed from a video, made temporally coherent (DanceTrack → DanceTrack). Pure
 * numbers, runs in the browser and in Node (the Lab's motion-coherence job).
 *
 * MediaPipe sees each frame on its own and in the picture, so a moving camera reads as the person travelling,
 * turning or hopping, a cut as a jump, and detection errors as jitter and flipped legs. In order:
 *
 *   1. off-picture landmarks lose their visibility (the detector guesses them)
 *   2. camera: every frame of a moving shot put back into the picture of the shot's first frame (camera.ts)
 *   3. cuts: those of the camera estimate, and (detectCuts) jumps of the person no one could make; each new shot
 *      re-anchored onto the one before, position, size and heading (camera.ts)
 *   4. outliers: left/right flips undone, bones that stretch and spikes replaced by interpolation (outliers.ts)
 *   5. zero-phase smoothing: the library's RTS smoother (kalman-cv) or Savitzky–Golay
 *   6. feet: contacts found and pinned, the drift of standing feet taken off the whole person (contacts.ts)
 *   7. a seamless loop (loop.ts)
 *
 * AUTO is what an uploaded video gets as it is analysed (the steps that only remove what is certainly the camera's or
 * certainly wrong; the retargeter's own filter smooths after). DEFAULTS is everything, for the Lab's job.
 */
import type { PersonFrame, Settings } from "../../../motion/api";
import type { Track } from "../../../motion/track";
import { kalmanFilter } from "../kalmanFilter";
import { savitzkyGolay } from "../savitzkyGolay";
import { anchorCuts, compensateCamera, landmarkCuts, markOffPicture } from "./camera";
import { detectContacts, pinFeet, SIDES, type Side } from "./contacts";
import { aspectOf, copyFrames, hip, present, type Frame } from "./frames";
import { seamlessLoop } from "./loop";
import { measure, type CoherenceMetrics } from "./metrics";
import { findOutliers, fixFlips, replaceOutliers } from "./outliers";

export { measure, type CoherenceMetrics } from "./metrics";
export { detectContacts } from "./contacts";

/** A fix for a stretch of frames [from, to): its frames are bad (interpolated over), a cut the estimate missed at
 *  `from`, feet that must not be pinned there, or a person standing in place there (no travel). */
export interface Segment {
  from: number;
  to: number;
  fix: "outlier" | "cut" | "noPin" | "still";
}

export interface CoherenceParams {
  /** Undo the camera's motion (DanceTrack.camera). */
  camera: boolean;
  /** A shot whose camera moves less than this (picture fraction or log-zoom) is left as it is. */
  minCameraMotion: number;
  /** Field of view across the picture's width (degrees) for turning back a pan's heading change; 0: no pans assumed. */
  panFov: number;
  /** Re-anchor shots at cuts (position, size, heading). */
  cuts: boolean;
  /** Also find cuts from jumps of the person, for a track without a camera estimate (with one, the estimate has
   *  already looked at the pictures, which says more than the person's landmarks). */
  detectCuts: boolean;
  /** Mark landmarks outside the picture as barely visible. */
  offPicture: boolean;
  /** Undo left/right flips. */
  flips: boolean;
  /** Replace stretched bones and spikes. */
  outliers: boolean;
  /** Relative bone-length deviation that marks a joint. */
  boneTolerance: number;
  /** Robust standard deviations from its neighbours that mark a spike. */
  spike: number;
  smooth: "none" | "rts" | "savgol";
  /** RTS: acceleration noise (m/s²) and measurement noise (m). */
  accel: number;
  noise: number;
  /** Savitzky–Golay: window (s) and degree. */
  window: number;
  order: number;
  /** Foot contact: height above the floor line and speed, in torso lengths (per second). */
  contactHeight: number;
  contactSpeed: number;
  /** 0 … 1: how firmly standing feet are pinned. */
  pin: number;
  /** Seconds blended into a seamless loop (0: none). */
  loop: number;
  segments: Segment[];
}

export const DEFAULTS: CoherenceParams = {
  camera: true, minCameraMotion: 0.02, panFov: 0, cuts: true, detectCuts: true, offPicture: true,
  flips: true, outliers: true, boneTolerance: 0.3, spike: 4,
  smooth: "rts", accel: 30, noise: 0.015, window: 0.3, order: 3,
  contactHeight: 0.15, contactSpeed: 0.4, pin: 0.5, loop: 0.5, segments: [],
};

/** For uploads as they are analysed: camera, cuts, off-picture landmarks and clear left/right flips. */
export const AUTO: CoherenceParams = {
  ...DEFAULTS, minCameraMotion: 0.03, detectCuts: false, outliers: false, smooth: "none", pin: 0, loop: 0,
};

export interface CoherenceReport {
  shots: number;
  movingShots: number;
  cuts: number[];
  /** Cuts found from the person's jumps (not in the camera estimate). */
  foundCuts: number[];
  anchors: { cut: number; shift: [number, number]; scale: number; turn: number }[];
  offPicture: number;
  flips: number;
  outliers: number;
  /** Share of frames each foot stands. */
  contacts: Record<Side, number>;
  /** Largest shift pinning applied (torso lengths). */
  pinned: number;
  looped: boolean;
  ms: number;
}

/** The track's frames as the library's filters take them. */
const asPerson = (frames: Frame[], aspect: number): PersonFrame[] => frames.map((f) => ({ ...f, aspect }));

function smooth(frames: Frame[], fps: number, aspect: number, p: CoherenceParams): Frame[] {
  if (p.smooth === "none") return frames;
  const def = p.smooth === "rts" ? kalmanFilter : savitzkyGolay;
  const settings: Settings = Object.fromEntries(def.parameters.map((x) => [x.key, x.default]));
  Object.assign(settings, p.smooth === "rts" ? { accel: p.accel, noise: p.noise } : { window: p.window, order: p.order });
  // Neither filter reads the scene.
  const filter = (def.create as (scene: unknown, s: Settings) => { recorded(f: PersonFrame[], fps: number): PersonFrame[] })(null, settings);
  return filter.recorded(asPerson(frames, aspect), fps).map(({ world, image }) => ({ world, image }));
}

/** Hold the hips in place over a stretch (eased over 0.2 s at its ends). */
function holdStill(frames: Frame[], seg: Segment, fps: number, aspect: number): void {
  const ks = [];
  for (let k = Math.max(0, seg.from); k < Math.min(frames.length, seg.to); k++) if (present(frames[k])) ks.push(k);
  if (!ks.length) return;
  const hs = ks.map((k) => hip(frames[k], aspect));
  const mx = hs.reduce((a, h) => a + h[0], 0) / hs.length, my = hs.reduce((a, h) => a + h[1], 0) / hs.length;
  const ramp = Math.max(1, Math.round(0.2 * fps));
  ks.forEach((k, i) => {
    const w = Math.min(1, (k - seg.from + 1) / ramp, (seg.to - k) / ramp);
    const ox = ((mx - hs[i][0]) * w) / aspect, oy = (my - hs[i][1]) * w;
    for (const p of frames[k].image) (p[0] += ox), (p[1] += oy);
  });
}

/** Make a track coherent. Returns the new track (its camera, if any, undone and marked so: Track.cameraUndone), what
 *  was done, and the reference for fidelity (the person with the camera undone and the cuts anchored). */
export function coherence(track: Track, params: Partial<CoherenceParams> = {}): { track: Track; report: CoherenceReport; reference: Frame[] } {
  const t0 = performance.now();
  const p: CoherenceParams = { ...DEFAULTS, ...params };
  const aspect = aspectOf(track), fps = track.fps;
  let frames = copyFrames(track.frames);
  const n = frames.length;
  const segs = p.segments.filter((s) => s.to > s.from);

  const offPicture = p.offPicture ? markOffPicture(frames) : 0;
  let cuts = [...(track.cuts ?? []), ...segs.filter((s) => s.fix === "cut").map((s) => s.from)].filter((c) => c > 0 && c < n);
  cuts = [...new Set(cuts)].sort((a, b) => a - b);
  const { moving } = p.camera && !track.cameraUndone ? compensateCamera(frames, track, cuts, p.minCameraMotion, p.panFov) : { moving: [] as boolean[] };
  let foundCuts: number[] = [];
  if (p.detectCuts && !track.camera) {
    // A cut within two frames of a known one is the same cut.
    foundCuts = landmarkCuts(frames, aspect).filter((c) => !cuts.some((k) => Math.abs(k - c) <= 2));
    cuts = [...cuts, ...foundCuts].sort((a, b) => a - b);
  }
  const anchors = p.cuts ? anchorCuts(frames, cuts, aspect).anchors : [];
  const reference = copyFrames(frames);

  const flips = p.flips ? fixFlips(frames, cuts, aspect) : 0;
  let outliers = 0;
  const bad = p.outliers ? findOutliers(frames, cuts, p.boneTolerance, p.spike, Math.max(3, Math.round(0.3 * fps))) : frames.map(() => new Set<number>());
  for (const s of segs.filter((x) => x.fix === "outlier"))
    for (let k = Math.max(0, s.from); k < Math.min(n, s.to); k++) for (let i = 0; i < 33; i++) bad[k].add(i);
  if (bad.some((b) => b.size)) outliers = replaceOutliers(frames, bad, cuts);

  frames = smooth(frames, fps, aspect, p);

  const contacts = detectContacts(frames, fps, aspect, { height: p.contactHeight, speed: p.contactSpeed });
  for (const s of segs.filter((x) => x.fix === "noPin")) for (const side of SIDES) for (let k = Math.max(0, s.from); k < Math.min(n, s.to); k++) contacts[side][k] = false;
  const pinned = pinFeet(frames, contacts, fps, aspect, p.pin);
  for (const s of segs.filter((x) => x.fix === "still")) holdStill(frames, s, fps, aspect);
  const looped = p.loop > 0 ? seamlessLoop(frames, fps, p.loop) : false;

  const seen = Math.max(1, frames.filter(present).length);
  const out: Track = { ...track, frames, cuts: cuts.length ? cuts : undefined };
  if (!cuts.length) delete out.cuts;
  if (track.camera && p.camera) out.cameraUndone = true;
  return {
    track: out,
    reference,
    report: {
      shots: cuts.length + 1, movingShots: moving.filter(Boolean).length, cuts, foundCuts, anchors, offPicture, flips, outliers,
      contacts: { L: contacts.L.filter(Boolean).length / seen, R: contacts.R.filter(Boolean).length / seen },
      pinned, looped, ms: performance.now() - t0,
    },
  };
}

/** Before and after numbers for a track made coherent: the input as the old pipeline used it, the output, both
 *  measured on the output's foot contacts and cuts; fidelity against the camera-compensated person. */
export function compare(input: Track, result: { track: Track; reference: Frame[] }, params: Partial<CoherenceParams> = {}): { before: CoherenceMetrics; after: CoherenceMetrics } {
  const p = { ...DEFAULTS, ...params };
  const aspect = aspectOf(input), fps = input.fps;
  const contacts = detectContacts(result.track.frames, fps, aspect, { height: p.contactHeight, speed: p.contactSpeed });
  const cuts = result.track.cuts ?? [];
  const n = result.track.frames.length;
  const fidelityUntil = p.loop > 0 ? n - Math.min(Math.round(p.loop * fps), Math.floor(n / 3)) : n;
  return {
    before: measure(input.frames, fps, aspect, { cuts, contacts, reference: result.reference, fidelityUntil }),
    after: measure(result.track.frames, fps, aspect, { cuts, contacts, reference: result.reference, fidelityUntil }),
  };
}

