/**
 * Foot contacts and pinning, in the picture after the camera is undone.
 *
 * A foot (ankle, heel and toe) stands when it is near the floor line (the 90th percentile of the lower foot over the
 * surrounding 3 s, so a slow tilt or a residual camera drift is followed) and nearly still. Runs shorter than four
 * frames are dropped and gaps of up to two frames filled.
 *
 * Pinning has two parts. The whole person is shifted so a foot that stands stays where it is: frame by frame, the
 * drift of the standing feet is taken off everyone (the accumulated shift smoothed with zero phase). That removes what
 * is left of the camera's motion and sliding in the detection, and keeps the person's own steps, which happen while
 * the other foot stands. Then each standing foot's landmarks are held at their mean spot for the run, eased in and out
 * over two frames.
 */
import { FOOT, median, present, quantile, typicalTorso, type Frame } from "./frames";

export type Side = "L" | "R";
export const SIDES: Side[] = ["L", "R"];

/** A foot's position in the picture (x scaled by the aspect), or null when it is not seen well. */
export function footAt(f: Frame, side: Side, aspect: number): [number, number] | null {
  if (!present(f)) return null;
  const ids = FOOT[side];
  if (f.image[ids[0]][3] < 0.4) return null;
  let x = 0, y = 0;
  for (const i of ids) (x += f.image[i][0] * aspect), (y += f.image[i][1]);
  return [x / ids.length, y / ids.length];
}

export interface ContactOptions {
  /** Height above the floor line (torso lengths) within which a foot may stand. */
  height: number;
  /** Speed (torso lengths per second) under which it may stand. */
  speed: number;
}

/** Per side, per frame: whether the foot stands. */
export function detectContacts(frames: Frame[], fps: number, aspect: number, o: ContactOptions): Record<Side, boolean[]> {
  const n = frames.length;
  const T = typicalTorso(frames, aspect);
  const feet = { L: frames.map((f) => footAt(f, "L", aspect)), R: frames.map((f) => footAt(f, "R", aspect)) };
  const lows = frames.map((_, k) => {
    const ys = SIDES.map((s) => feet[s][k]?.[1]).filter((y): y is number => y !== undefined);
    return ys.length ? Math.max(...ys) : NaN;
  });
  const half = Math.round(1.5 * fps);
  const floor = frames.map((_, k) => quantile(lows.slice(Math.max(0, k - half), Math.min(n, k + half + 1)).filter(Number.isFinite), 0.9));
  const out = { L: new Array<boolean>(n).fill(false), R: new Array<boolean>(n).fill(false) };
  for (const s of SIDES) {
    const p = feet[s];
    for (let k = 0; k < n; k++) {
      const q = p[k];
      if (!q || !Number.isFinite(floor[k])) continue;
      const a = p[k - 1] ?? q, b = p[k + 1] ?? q;
      const span = (p[k - 1] ? 1 : 0) + (p[k + 1] ? 1 : 0);
      const v = span ? (Math.hypot(b[0] - a[0], b[1] - a[1]) * fps) / span / T : 0;
      out[s][k] = floor[k] - q[1] < o.height * T && v < o.speed;
    }
    clean(out[s]);
  }
  return out;
}

/** Fill gaps of up to two frames, then drop runs shorter than four (in place). */
function clean(c: boolean[]): void {
  const runs = (v: boolean) => {
    const r: [number, number][] = [];
    for (let k = 0; k < c.length; ) {
      if (c[k] !== v) {
        k++;
        continue;
      }
      let e = k;
      while (e < c.length && c[e] === v) e++;
      r.push([k, e]);
      k = e;
    }
    return r;
  };
  for (const [a, b] of runs(false)) if (a > 0 && b < c.length && b - a <= 2) for (let k = a; k < b; k++) c[k] = true;
  for (const [a, b] of runs(true)) if (b - a < 4) for (let k = a; k < b; k++) c[k] = false;
}

/** Zero-phase moving average (radius r, applied twice: triangular). */
function smoothSeries(x: number[], r: number): number[] {
  let cur = x;
  for (let pass = 0; pass < 2; pass++) {
    const out = cur.slice();
    for (let k = 0; k < cur.length; k++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, k - r); j <= Math.min(cur.length - 1, k + r); j++) (s += cur[j]), n++;
      out[k] = s / n;
    }
    cur = out;
  }
  return cur;
}

/**
 * Pin the standing feet (in place): `strength` 0 … 1 of the drift of standing feet taken off the whole person, and
 * of each standing foot held still. Returns the largest shift applied (torso lengths).
 */
export function pinFeet(frames: Frame[], contacts: Record<Side, boolean[]>, fps: number, aspect: number, strength: number): number {
  if (strength <= 0) return 0;
  const n = frames.length;
  const T = typicalTorso(frames, aspect);
  const feet = { L: frames.map((f) => footAt(f, "L", aspect)), R: frames.map((f) => footAt(f, "R", aspect)) };
  // 1. The whole person: δ(k) = δ(k−1) − strength · mean drift of the feet standing in both frames.
  const dx = new Array<number>(n).fill(0), dy = new Array<number>(n).fill(0);
  for (let k = 1; k < n; k++) {
    let sx = 0, sy = 0, m = 0;
    for (const s of SIDES) {
      const a = feet[s][k - 1], b = feet[s][k];
      if (contacts[s][k] && contacts[s][k - 1] && a && b) (sx += b[0] - a[0]), (sy += b[1] - a[1]), m++;
    }
    dx[k] = dx[k - 1] - (m ? (strength * sx) / m : 0);
    dy[k] = dy[k - 1] - (m ? (strength * sy) / m : 0);
  }
  const r = Math.max(1, Math.round(0.08 * fps));
  const sx = smoothSeries(dx, r), sy = smoothSeries(dy, r);
  // Keep the mean where it was (the person's home spot does not move).
  const mx = median(sx), my = median(sy);
  let peak = 0;
  frames.forEach((f, k) => {
    if (!present(f)) return;
    const ox = (sx[k] - mx) / aspect, oy = sy[k] - my;
    peak = Math.max(peak, Math.hypot(sx[k] - mx, oy) / T);
    for (const p of f.image) (p[0] += ox), (p[1] += oy);
  });
  // 2. Each standing foot held at its run's mean spot.
  for (const s of SIDES) {
    const c = contacts[s];
    for (let k = 0; k < n; ) {
      if (!c[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < n && c[e]) e++;
      const pts = [];
      for (let j = k; j < e; j++) {
        const q = footAt(frames[j], s, aspect);
        if (q) pts.push(q);
      }
      if (pts.length) {
        const cx = median(pts.map((q) => q[0])), cy = median(pts.map((q) => q[1]));
        for (let j = k; j < e; j++) {
          const q = footAt(frames[j], s, aspect);
          if (!q) continue;
          const ease = Math.min(1, (j - k + 1) / 3, (e - j) / 3) * strength;
          const ox = ((cx - q[0]) * ease) / aspect, oy = (cy - q[1]) * ease;
          for (const i of FOOT[s]) (frames[j].image[i][0] += ox), (frames[j].image[i][1] += oy);
        }
      }
      k = e;
    }
  }
  return peak;
}
