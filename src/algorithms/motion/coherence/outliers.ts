/**
 * Outliers: frames where the detector got a joint wrong, found three ways and replaced by interpolating the joint
 * between the nearest good frames of its shot.
 *
 * - Left/right flips: the detector swaps the legs (or arms) of a person seen from behind or crossing over. Frame by
 *   frame, each limb group is compared, as labelled and swapped, with where the previous frames put it (constant
 *   velocity); a swap that fits much better is undone.
 * - Bone lengths: a person's bones do not stretch. A bone more than `boneTolerance` off its median length marks its
 *   outer joint.
 * - Spikes (a Hampel filter): a coordinate further from the median of its neighbours (±3 frames) than `spike` robust
 *   standard deviations (and a floor) marks the joint.
 */
import { N, PAIRS, present, shots, type Frame } from "./frames";

const ARMS = PAIRS.filter(([l]) => l >= 11 && l <= 22);
const LEGS = PAIRS.filter(([l]) => l >= 23);
const swapPairs = (f: Frame, pairs: readonly [number, number][]) => {
  for (const [l, r] of pairs)
    for (const k of ["world", "image"] as const) [f[k][l], f[k][r]] = [f[k][r], f[k][l]];
};

/** Undo left/right swaps of the legs and arms (in place). Returns how many group swaps were undone. */
export function fixFlips(frames: Frame[], cuts: number[], aspect: number): number {
  let fixed = 0;
  for (const [a, b] of shots(frames.length, cuts)) {
    for (let k = a + 1; k < b; k++) {
      const f = frames[k], p1 = frames[k - 1], p2 = k - 2 >= a ? frames[k - 2] : null;
      if (!present(f) || !present(p1)) continue;
      const predict = (kind: "world" | "image", i: number, c: number) => {
        const x1 = p1[kind][i][c];
        return p2 && present(p2) ? 2 * x1 - p2[kind][i][c] : x1;
      };
      for (const group of [LEGS, ARMS]) {
        const cost = (swapped: boolean) => {
          let s = 0;
          for (const [l, r] of group)
            for (const [i, j] of [[l, r], [r, l]]) {
              const src = swapped ? j : i;
              // Picture (isotropic, scaled to about metres) and world positions both count.
              const dx = (f.image[src][0] - predict("image", i, 0)) * aspect, dy = f.image[src][1] - predict("image", i, 1);
              s += (dx * dx + dy * dy) * 4;
              for (let c = 0; c < 3; c++) s += (f.world[src][c] - predict("world", i, c)) ** 2;
            }
          return s;
        };
        const keep = cost(false), swap = cost(true);
        // Only clear cases: the swap fits several times better and the labelled pose is far off.
        if (swap < 0.35 * keep && keep > 0.02 * group.length) {
          swapPairs(f, group);
          fixed++;
        }
      }
    }
  }
  return fixed;
}

const BONES: [number, number][] = [
  [11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [27, 31], [28, 32],
];
/** Landmarks that hang off a joint (a bad wrist takes its hand along, a bad ankle its foot). */
const HANGING: Record<number, number[]> = { 15: [17, 19, 21], 16: [18, 20, 22], 27: [29, 31], 28: [30, 32] };

/** Per frame, the landmarks judged wrong (bone lengths and spikes). */
export function findOutliers(frames: Frame[], cuts: number[], boneTolerance: number, spike: number): Set<number>[] {
  const bad = frames.map(() => new Set<number>());
  const mark = (k: number, i: number) => {
    bad[k].add(i);
    for (const j of HANGING[i] ?? []) bad[k].add(j);
  };
  // Bones.
  for (const [i, j] of BONES) {
    const len = frames.map((f) => (present(f) ? Math.hypot(f.world[i][0] - f.world[j][0], f.world[i][1] - f.world[j][1], f.world[i][2] - f.world[j][2]) : NaN));
    const ok = len.filter(Number.isFinite).sort((a, b) => a - b);
    if (!ok.length) continue;
    const med = ok[ok.length >> 1];
    len.forEach((l, k) => Number.isFinite(l) && Math.abs(l / med - 1) > boneTolerance && mark(k, j));
  }
  // Spikes, within each shot.
  const H = 3;
  for (const [a, b] of shots(frames.length, cuts)) {
    for (let i = 0; i < N; i++) {
      for (const [kind, c, floor] of [["world", 0, 0.06], ["world", 1, 0.06], ["world", 2, 0.12], ["image", 0, 0.03], ["image", 1, 0.03]] as const) {
        for (let k = a; k < b; k++) {
          if (!present(frames[k])) continue;
          const xs: number[] = [];
          for (let j = Math.max(a, k - H); j <= Math.min(b - 1, k + H); j++) if (j !== k && present(frames[j])) xs.push(frames[j][kind][i][c]);
          if (xs.length < 4) continue;
          xs.sort((p, q) => p - q);
          const m = xs.length % 2 ? xs[xs.length >> 1] : (xs[(xs.length >> 1) - 1] + xs[xs.length >> 1]) / 2;
          const mad = xs.map((x) => Math.abs(x - m)).sort((p, q) => p - q)[xs.length >> 1];
          if (Math.abs(frames[k][kind][i][c] - m) > Math.max(floor, spike * 1.4826 * mad)) mark(k, i);
        }
      }
    }
  }
  return bad;
}

/** Replace marked landmarks by interpolation between the nearest unmarked frames of the shot (in place). */
export function replaceOutliers(frames: Frame[], bad: Set<number>[], cuts: number[]): number {
  let count = 0;
  for (const [a, b] of shots(frames.length, cuts)) {
    for (let i = 0; i < N; i++) {
      for (let k = a; k < b; k++) {
        if (!present(frames[k]) || !bad[k].has(i)) continue;
        let lo = k - 1, hi = k + 1;
        while (lo >= a && (!present(frames[lo]) || bad[lo].has(i))) lo--;
        while (hi < b && (!present(frames[hi]) || bad[hi].has(i))) hi++;
        const L = lo >= a && k - lo <= 15 ? frames[lo] : null, R = hi < b && hi - k <= 15 ? frames[hi] : null;
        if (!L && !R) continue;
        const w = L && R ? (k - lo) / (hi - lo) : L ? 0 : 1;
        for (const kind of ["world", "image"] as const)
          for (let c = 0; c < 3; c++) {
            const x0 = (L ?? R)![kind][i][c], x1 = (R ?? L)![kind][i][c];
            frames[k][kind][i][c] = x0 + (x1 - x0) * w;
          }
        count++;
      }
    }
  }
  return count;
}
