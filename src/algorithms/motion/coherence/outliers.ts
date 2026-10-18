/**
 * Outliers: frames where the detector got a joint wrong, found three ways and replaced by interpolating the joint
 * between the nearest good frames of its shot.
 *
 * - Left/right flips: the detector swaps the legs (or arms) of a person seen from behind or crossing over. Frame by
 *   frame, each limb group is compared, as labelled and swapped, with where the previous frames put it (constant
 *   velocity); a swap that fits much better is undone.
 * - Bone lengths: a person's bones do not stretch. A bone more than `boneTolerance` off its median length for a
 *   short while (up to `maxRun` frames) marks its outer joint; a longer stretch is a limb out of the picture or hidden,
 *   which interpolating over would invent.
 * - Spikes (a Hampel filter): a coordinate further from the median of its neighbours (±3 frames) than `spike` robust
 *   standard deviations (and a floor) marks the joint.
 */
import { N, PAIRS, present, shots, type Frame } from "./frames";

/** Elbows down and knees down: the shoulders and hips stay, so the heading never flips with them. */
const ARMS = PAIRS.filter(([l]) => l >= 13 && l <= 22);
const LEGS = PAIRS.filter(([l]) => l >= 25);
const swapPairs = (f: Frame, pairs: readonly [number, number][]) => {
  for (const [l, r] of pairs)
    for (const k of ["world", "image"] as const) [f[k][l], f[k][r]] = [f[k][r], f[k][l]];
};

/**
 * Undo left/right swaps of the legs and arms (in place). Per limb group and shot, each frame is labelled as detected
 * or swapped so that the whole sequence jumps least (Viterbi over the two states): the cost of a frame following the
 * one before is the distance between them (picture and world), and a swapped frame costs `prior` on its own, so only
 * a swap that removes a jump on either side is undone, and a long stretch of consistently swapped labels (a person
 * seen from behind) is left as it is. Returns the number of swapped stretches undone.
 */
export function fixFlips(frames: Frame[], cuts: number[], aspect: number, prior = 0.01): number {
  let fixed = 0;
  for (const group of [LEGS, ARMS]) {
    const ids = group.flatMap(([l, r]) => [l, r]);
    const partner = new Map(group.flatMap(([l, r]) => [[l, r], [r, l]] as [number, number][]));
    /** Distance of frame k (state sk) from frame j (state sj). */
    const dist = (k: number, sk: number, j: number, sj: number) => {
      const f = frames[k], g = frames[j];
      let s = 0;
      for (const i of ids) {
        const a = sk ? partner.get(i)! : i, b = sj ? partner.get(i)! : i;
        const dx = (f.image[a][0] - g.image[b][0]) * aspect, dy = f.image[a][1] - g.image[b][1];
        s += (dx * dx + dy * dy) * 4;
        for (let c = 0; c < 3; c++) s += (f.world[a][c] - g.world[b][c]) ** 2;
      }
      return s;
    };
    const unary = prior * group.length;
    for (const [a, b] of shots(frames.length, cuts)) {
      // Chains of consecutive frames with a person.
      for (let k0 = a; k0 < b; ) {
        if (!present(frames[k0])) {
          k0++;
          continue;
        }
        let k1 = k0;
        while (k1 + 1 < b && present(frames[k1 + 1])) k1++;
        const len = k1 - k0 + 1;
        const cost = [new Float64Array(len), new Float64Array(len)], from = [new Uint8Array(len), new Uint8Array(len)];
        cost[0][0] = 0;
        cost[1][0] = unary;
        for (let i = 1; i < len; i++) {
          const k = k0 + i;
          for (const s of [0, 1]) {
            const c0 = cost[0][i - 1] + dist(k, s, k - 1, 0), c1 = cost[1][i - 1] + dist(k, s, k - 1, 1);
            cost[s][i] = Math.min(c0, c1) + (s ? unary : 0);
            from[s][i] = c1 < c0 ? 1 : 0;
          }
        }
        let s = cost[1][len - 1] < cost[0][len - 1] ? 1 : 0;
        const state = new Uint8Array(len);
        for (let i = len - 1; i >= 0; i--) {
          state[i] = s;
          s = from[s][i];
        }
        for (let i = 0; i < len; i++) {
          if (state[i]) swapPairs(frames[k0 + i], group);
          if (state[i] && (i === 0 || !state[i - 1])) fixed++;
        }
        k0 = k1 + 1;
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
export function findOutliers(frames: Frame[], cuts: number[], boneTolerance: number, spike: number, maxRun = 9): Set<number>[] {
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
    const off = len.map((l) => Number.isFinite(l) && Math.abs(l / med - 1) > boneTolerance);
    for (let k = 0; k < off.length; ) {
      if (!off[k]) {
        k++;
        continue;
      }
      let e = k;
      while (e < off.length && off[e]) e++;
      if (e - k <= maxRun) for (let q = k; q < e; q++) mark(q, j);
      k = e;
    }
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
