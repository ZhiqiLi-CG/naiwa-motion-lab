/**
 * Camera compensation and shot cuts.
 *
 * Camera: DanceTrack.camera gives, per frame, the shift t and zoom s of the background against the first frame of its
 * shot (p' = s·(p − ½) + ½ + t, src/motion/cameraMotion.ts). Undoing it, p = (p' − ½ − t) / s + ½, puts every frame of
 * a shot into the picture of its first frame, so the person's own travel and hops are what is left. A shot whose camera
 * hardly moves is left alone (the estimate would only add its noise). A pan also turns the person's apparent heading;
 * with a field of view given (panFov, degrees across the picture width) that is undone too. A dolly (the camera moving
 * sideways) does not turn them, and which of the two a video has cannot be told from the picture alone, so it is off
 * unless asked for.
 *
 * Cuts: each new shot is re-anchored onto the one before. The hips where the earlier shot was heading at the cut and
 * where the new shot comes from (both extrapolated over a few frames), and the torso lengths on either side, give a
 * similarity of the picture (offset and scale) that makes the person continue; the heading change at the cut is
 * turned back the same way (a person cannot turn round in a frame, a camera angle can).
 */
import type { Track } from "../../../motion/track";
import { heading, hip, median, present, rotateWorld, shots, torso, wrap, type Frame } from "./frames";

/** Lower an image landmark's visibility where it is outside the picture (the detector's guess, not a sighting). */
export function markOffPicture(frames: Frame[]): number {
  let n = 0;
  for (const f of frames) {
    if (!present(f)) continue;
    for (const p of f.image)
      if ((p[0] < 0.005 || p[0] > 0.995 || p[1] < 0.005 || p[1] > 0.995) && p[3] > 0.3) (p[3] = 0.3), n++;
  }
  return n;
}

export interface CameraResult {
  moving: boolean[];
}

/**
 * Undo the camera per frame (in place). `minMotion`: the largest shift (picture fractions) or log-zoom a shot must
 * reach to count as moving. Returns which shots moved.
 */
export function compensateCamera(frames: Frame[], track: Track, cuts: number[], minMotion: number, panFov: number): CameraResult {
  const cam = track.camera;
  const moving: boolean[] = [];
  if (!cam || cam.length !== frames.length) return { moving: shots(frames.length, cuts).map(() => false) };
  const fov = (panFov * Math.PI) / 180;
  for (const [a, b] of shots(frames.length, cuts)) {
    // The camera is relative to the first frame of its own shot; a cut of ours that the estimator did not see
    // restarts it here.
    const base = cam[a];
    const inv = (k: number) => {
      const c = cam[k];
      const s = c.scale / base.scale;
      return { s, tx: c.shift[0] - s * base.shift[0], ty: c.shift[1] - s * base.shift[1] };
    };
    let peak = 0;
    for (let k = a; k < b; k++) {
      const c = inv(k);
      peak = Math.max(peak, Math.abs(c.tx), Math.abs(c.ty), Math.abs(Math.log(c.s)));
    }
    const moves = peak >= minMotion;
    moving.push(moves);
    if (!moves) continue;
    for (let k = a; k < b; k++) {
      const f = frames[k];
      if (!present(f)) continue;
      const { s, tx, ty } = inv(k);
      for (const p of f.image) {
        p[0] = (p[0] - 0.5 - tx) / s + 0.5;
        p[1] = (p[1] - 0.5 - ty) / s + 0.5;
        p[2] /= s;
      }
      // Panning right moves the background left (tx < 0) and turns everything seen by −tx · fov.
      if (fov) rotateWorld(f, tx * fov);
    }
  }
  return { moving };
}

/** Linear extrapolation of a few samples (index, value) to index at; median slopes, robust to one bad frame. */
function extrapolate(samples: [number, number][], at: number): number {
  if (!samples.length) return NaN;
  if (samples.length === 1) return samples[0][1];
  const slopes: number[] = [];
  for (let i = 1; i < samples.length; i++) slopes.push((samples[i][1] - samples[i - 1][1]) / (samples[i][0] - samples[i - 1][0]));
  const v = median(slopes);
  const ref = samples.reduce((best, s) => (Math.abs(s[0] - at) < Math.abs(best[0] - at) ? s : best));
  return ref[1] + v * (at - ref[0]);
}

export interface AnchorResult {
  /** Per cut: picture offset (picture heights) and scale applied to the new shot, heading turned (rad). */
  anchors: { cut: number; shift: [number, number]; scale: number; turn: number }[];
}

/** Re-anchor each shot after a cut onto the one before (in place). K frames each side are looked at. */
export function anchorCuts(frames: Frame[], cuts: number[], aspect: number, K = 4, turnBack = true): AnchorResult {
  const anchors: AnchorResult["anchors"] = [];
  const ranges = shots(frames.length, cuts);
  for (let r = 1; r < ranges.length; r++) {
    const [a, b] = ranges[r];
    const before: number[] = [], after: number[] = [];
    for (let k = a - 1; k >= ranges[r - 1][0] && before.length < K && a - k <= 15; k--) if (present(frames[k])) before.unshift(k);
    for (let k = a; k < b && after.length < K && k - a <= 15; k++) if (present(frames[k])) after.push(k);
    if (!before.length || !after.length) continue;
    // Where the cut falls: halfway between the last frame of the old shot and the first of the new.
    const at = (before[before.length - 1] + after[0]) / 2;
    const hb = before.map((k) => hip(frames[k], aspect)), ha = after.map((k) => hip(frames[k], aspect));
    const pb = [0, 1].map((c) => extrapolate(before.map((k, i) => [k, hb[i][c]]), at));
    const pa = [0, 1].map((c) => extrapolate(after.map((k, i) => [k, ha[i][c]]), at));
    const tb = median(before.map((k) => torso(frames[k], aspect))), ta = median(after.map((k) => torso(frames[k], aspect)));
    const scale = Math.min(4, Math.max(0.25, tb / Math.max(1e-4, ta)));
    // Heading, unwrapped within each side.
    const unwrap = (ks: number[]) => {
      const out: [number, number][] = [];
      for (const k of ks) {
        const h = heading(frames[k]);
        out.push([k, out.length ? out[out.length - 1][1] + wrap(h - out[out.length - 1][1]) : h]);
      }
      return out;
    };
    const turn = turnBack ? wrap(extrapolate(unwrap(before), at) - extrapolate(unwrap(after), at)) : 0;
    // p ↦ pb + scale · (p − pa), in isotropic picture units (x · aspect, y).
    // Later shots are anchored onto this one in their turn.
    for (let k = a; k < b; k++) {
      const f = frames[k];
      if (!present(f)) continue;
      for (const p of f.image) {
        p[0] = (pb[0] + scale * (p[0] * aspect - pa[0])) / aspect;
        p[1] = pb[1] + scale * (p[1] - pa[1]);
        p[2] *= scale;
      }
      rotateWorld(f, turn);
    }
    anchors.push({ cut: a, shift: [pb[0] - pa[0], pb[1] - pa[1]], scale, turn });
  }
  return { anchors };
}

/**
 * Cuts read from the landmarks alone (a track without camera information): the hips jump further in one frame than
 * a person moves (`jump` torso lengths) while moving little just before and after, or the torso's size in the
 * picture changes by more than a third at once.
 */
export function landmarkCuts(frames: Frame[], aspect: number, jump = 0.6): number[] {
  const out: number[] = [];
  const ok = (k: number) => k >= 0 && k < frames.length && present(frames[k]);
  for (let k = 2; k < frames.length - 1; k++) {
    if (!ok(k) || !ok(k - 1) || !ok(k - 2) || !ok(k + 1)) continue;
    const t = torso(frames[k - 1], aspect);
    const d = (i: number, j: number) => {
      const p = hip(frames[i], aspect), q = hip(frames[j], aspect);
      return Math.hypot(p[0] - q[0], p[1] - q[1]) / Math.max(1e-3, t);
    };
    const step = d(k - 1, k), around = Math.max(d(k - 2, k - 1), d(k, k + 1));
    const size = torso(frames[k], aspect) / Math.max(1e-3, t);
    const sizeAround = torso(frames[k + 1], aspect) / Math.max(1e-3, torso(frames[k], aspect));
    if ((step > jump && step > 3 * around) || ((size > 1.35 || size < 1 / 1.35) && Math.abs(Math.log(sizeAround)) < 0.1)) out.push(k);
  }
  return out;
}
