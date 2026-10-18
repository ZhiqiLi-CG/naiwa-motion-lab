/**
 * The camera's motion from the background of a video, frame to frame: translation and zoom (no rotation), with the
 * people masked out, and shot cuts. Pure numbers (runs in Node for the tests); cameraFrames.ts feeds it the analysed
 * video's frames in the browser.
 *
 * Each frame comes in as a small grayscale picture (about 160 px on its long side). A three-level pyramid of
 * high-passed pictures (the local mean removed, so exposure changes do not count) is matched coarse to fine:
 * a grid of 8 × 8 blocks of the previous frame, skipping blocks on a person (their boxes, padded) and blocks without
 * texture in both directions, each searched for in the new frame around where the current model puts it (the
 * coarsest level around the previous frame's motion), with a parabola through the best cost for sub-pixel steps.
 * The block displacements d at block centres x (from the picture centre) are fitted with d = a·x + t (zoom 1 + a,
 * shift t): RANSAC over single blocks (pure shifts) and pairs, then iteratively reweighted least squares (Tukey), so
 * other moving things and mismatched blocks drop out.
 *
 * A cut: the brightness histogram changes a lot (Bhattacharyya distance), or changes somewhat while hardly any block
 * matches. A frame whose fit is unreliable (too few inliers) counts as a still camera.
 *
 * Convention (also of DanceTrack.camera): a background point at picture position p (fractions of width and height)
 * in the earlier frame is at p' = s·(p − ½) + ½ + t in the later one.
 */

/** A box in picture fractions. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The motion from the previous frame to this one. */
export interface CameraStep {
  /** Shift (picture fractions) and zoom; identity on the first frame, at a cut and when the fit is unreliable. */
  dx: number;
  dy: number;
  scale: number;
  /** A new shot starts at this frame. */
  cut: boolean;
  /** Whether the fit was trusted. */
  ok: boolean;
  /** Blocks matched and blocks that agree with the fit (finest level). */
  blocks: number;
  inliers: number;
  /** Histogram distance from the previous frame (0 same … 1 disjoint). */
  histogram: number;
  /** Median matching cost of the blocks (0 identical … about 0.5 and more for unrelated pictures). */
  residual: number;
}

export interface CameraOptions {
  /** Block side (px at every level). */
  block: number;
  /** Coarsest-level search radius (px) around the predicted motion. */
  search: number;
  /** Fewest inliers for a trusted fit. */
  minInliers: number;
  /** Histogram distance that alone is a cut, and the one that is a cut when few blocks match. */
  cutHistogram: number;
  cutHistogramWeak: number;
  /** Median matching cost that is a cut. */
  cutResidual: number;
}

export const CAMERA_DEFAULTS: CameraOptions = { block: 8, search: 5, minInliers: 6, cutHistogram: 0.45, cutHistogramWeak: 0.2, cutResidual: 0.45 };

/** The long side of the pictures to feed (px). */
export const CAMERA_SIZE = 160;

const LEVELS = 3;
const BINS = 16;

interface Level {
  w: number;
  h: number;
  /** High-passed picture. */
  img: Float32Array;
  /** Texture per pixel: |∂x| and |∂y| of the high-passed picture. */
  gx: Float32Array;
  gy: Float32Array;
}

interface Picture {
  levels: Level[];
  hist: Float64Array;
  masks: Box[];
}

/** Halve a picture (2 × 2 means). */
function halve(src: Float32Array, w: number, h: number): { img: Float32Array; w: number; h: number } {
  const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * W + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) / 4;
    }
  return { img: out, w: W, h: H };
}

/** Box mean of radius r (separable, edges clamped). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s / (2 * r + 1);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s / (2 * r + 1);
    }
  return out;
}

function level(src: Float32Array, w: number, h: number): Level {
  // A light blur against noise, minus a wide one: band-pass, exposure-independent.
  const fine = boxBlur(src, w, h, 1), wide = boxBlur(src, w, h, 4);
  const img = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) img[i] = fine[i] - wide[i];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = Math.abs(img[i + 1] - img[i - 1]) / 2;
      gy[i] = Math.abs(img[i + w] - img[i - w]) / 2;
    }
  return { w, h, img, gx, gy };
}

function picture(gray: Float32Array | Uint8Array | Uint8ClampedArray, w: number, h: number, masks: Box[]): Picture {
  const hist = new Float64Array(BINS);
  const base = Float32Array.from(gray);
  for (let i = 0; i < w * h; i++) hist[Math.min(BINS - 1, Math.floor((base[i] / 256) * BINS))]++;
  for (let b = 0; b < BINS; b++) hist[b] /= w * h;
  const levels: Level[] = [];
  let cur = { img: base, w, h };
  for (let l = 0; l < LEVELS; l++) {
    levels.push(level(cur.img, cur.w, cur.h));
    if (l < LEVELS - 1) cur = halve(cur.img, cur.w, cur.h);
  }
  return { levels, hist, masks };
}

/** Bhattacharyya distance of two histograms. */
function histDistance(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return Math.sqrt(Math.max(0, 1 - s));
}

/** Model d = a·x + t (x from the picture centre, px of the level). */
interface Model {
  a: number;
  tx: number;
  ty: number;
}

interface Match {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** The best cost against the blocks' own texture (about 0.1–0.3 matched, near 1 for unrelated pictures). */
  cost: number;
}

/** Weighted least-squares fit of the model to matches. */
function fit(m: Match[], w: number[]): Model | null {
  let sw = 0, mx = 0, my = 0, mdx = 0, mdy = 0;
  m.forEach((p, i) => ((sw += w[i]), (mx += w[i] * p.x), (my += w[i] * p.y), (mdx += w[i] * p.dx), (mdy += w[i] * p.dy)));
  if (sw <= 0) return null;
  (mx /= sw), (my /= sw), (mdx /= sw), (mdy /= sw);
  let num = 0, den = 0;
  m.forEach((p, i) => {
    const x = p.x - mx, y = p.y - my;
    num += w[i] * (x * (p.dx - mdx) + y * (p.dy - mdy));
    den += w[i] * (x * x + y * y);
  });
  const a = den > 1e-6 ? Math.max(-0.2, Math.min(0.2, num / den)) : 0;
  return { a, tx: mdx - a * mx, ty: mdy - a * my };
}

const residual = (p: Match, f: Model) => Math.hypot(f.a * p.x + f.tx - p.dx, f.a * p.y + f.ty - p.dy);

/** RANSAC (single blocks as shifts, pairs as shift + zoom), then Tukey IRLS. Inlier threshold thr (px). */
function robustFit(m: Match[], thr: number): { model: Model; inliers: number } | null {
  if (m.length < 2) return null;
  const hyps: Model[] = m.map((p) => ({ a: 0, tx: p.dx, ty: p.dy }));
  // Deterministic pairs spread over the set.
  const pairs = Math.min(60, (m.length * (m.length - 1)) / 2);
  for (let k = 0; k < pairs; k++) {
    const i = (k * 7919) % m.length, j = (i + 1 + ((k * 104729) % (m.length - 1))) % m.length;
    const f = fit([m[i], m[j]], [1, 1]);
    if (f) hyps.push(f);
  }
  let best: Model | null = null, bestCount = -1, bestErr = Infinity;
  for (const h of hyps) {
    let count = 0, err = 0;
    for (const p of m) {
      const r = residual(p, h);
      if (r < thr) (count++, (err += r));
    }
    if (count > bestCount || (count === bestCount && err < bestErr)) (best = h), (bestCount = count), (bestErr = err);
  }
  if (!best) return null;
  let model = fit(m, m.map((p) => (residual(p, best!) < thr ? 1 : 0))) ?? best;
  const c = 2.5 * thr;
  for (let it = 0; it < 3; it++) {
    const w = m.map((p) => {
      const u = residual(p, model) / c;
      return u < 1 ? (1 - u * u) ** 2 : 0;
    });
    model = fit(m, w) ?? model;
  }
  return { model, inliers: m.filter((p) => residual(p, model) < thr).length };
}

/** Whether pixel (x, y) of a level lies in any box. */
function masked(boxes: Box[], x: number, y: number, w: number, h: number): boolean {
  const u = x / w, v = y / h;
  for (const b of boxes) if (u >= b.x0 && u <= b.x1 && v >= b.y0 && v <= b.y1) return true;
  return false;
}

/** Matches of the previous frame's blocks in the current one around the model's prediction. */
function matchLevel(P: Level, C: Level, boxes: Box[], pred: Model, radius: number, B: number, step: number): Match[] {
  const { w, h } = P, cx = w / 2, cy = h / 2;
  const out: Match[] = [];
  const minTex = 1.2;
  for (let by = 1; by + B < h - 1; by += step)
    for (let bx = 1; bx + B < w - 1; bx += step) {
      const mx = bx + B / 2, my = by + B / 2;
      // Skip blocks touching a person (corners and centre).
      if (masked(boxes, bx, by, w, h) || masked(boxes, bx + B, by, w, h) || masked(boxes, bx, by + B, w, h) || masked(boxes, bx + B, by + B, w, h) || masked(boxes, mx, my, w, h)) continue;
      let tx = 0, ty = 0, energy = 0;
      for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) (tx += P.gx[y * w + x]), (ty += P.gy[y * w + x]), (energy += Math.abs(P.img[y * w + x]));
      if (Math.min(tx, ty) / (B * B) < minTex) continue;
      const px = pred.a * (mx - cx) + pred.tx, py = pred.a * (my - cy) + pred.ty;
      const ix = Math.round(px), iy = Math.round(py);
      const R = radius, side = 2 * R + 1;
      const cost = new Float64Array(side * side).fill(Infinity);
      let best = Infinity, bi = -1;
      for (let sy = -R; sy <= R; sy++)
        for (let sx = -R; sx <= R; sx++) {
          const ox = bx + ix + sx, oy = by + iy + sy;
          if (ox < 0 || oy < 0 || ox + B > w || oy + B > h) continue;
          let s = 0;
          for (let y = 0; y < B; y++) {
            const pr = (by + y) * w + bx, cr = (oy + y) * w + ox;
            for (let x = 0; x < B; x++) s += Math.abs(P.img[pr + x] - C.img[cr + x]);
          }
          const k = (sy + R) * side + (sx + R);
          cost[k] = s;
          if (s < best) (best = s), (bi = k);
        }
      if (bi < 0) continue;
      const kx = bi % side, ky = Math.floor(bi / side);
      // Sub-pixel: a parabola through the best cost and its neighbours, per axis.
      const sub = (a: number, b: number, c: number) => {
        if (!Number.isFinite(a) || !Number.isFinite(c)) return 0;
        const d = a - 2 * b + c;
        return d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      };
      const fx = kx > 0 && kx < side - 1 ? sub(cost[bi - 1], best, cost[bi + 1]) : 0;
      const fy = ky > 0 && ky < side - 1 ? sub(cost[bi - side], best, cost[bi + side]) : 0;
      // A best match on the search border is likely beyond it: drop.
      if (kx === 0 || ky === 0 || kx === side - 1 || ky === side - 1) continue;
      out.push({ x: mx - cx, y: my - cy, dx: ix + kx - R + fx, dy: iy + ky - R + fy, cost: best / Math.max(1e-6, 2 * energy) });
    }
  return out;
}

/** Estimates the camera's motion frame to frame. */
export class CameraEstimator {
  private prev: Picture | null = null;
  /** The previous step in px of the finest level (prediction for the next search). */
  private velocity: Model = { a: 0, tx: 0, ty: 0 };
  private readonly o: CameraOptions;

  constructor(options: Partial<CameraOptions> = {}) {
    this.o = { ...CAMERA_DEFAULTS, ...options };
  }

  reset(): void {
    this.prev = null;
    this.velocity = { a: 0, tx: 0, ty: 0 };
  }

  /**
   * The next frame: grayscale w × h (0..255) and the boxes of the people in it (picture fractions, padded by the
   * caller). Returns the motion from the previous frame.
   */
  push(gray: Float32Array | Uint8Array | Uint8ClampedArray, w: number, h: number, masks: Box[]): CameraStep {
    const cur = picture(gray, w, h, masks);
    const prev = this.prev;
    this.prev = cur;
    const still = (cut: boolean, histogram: number, blocks = 0, inliers = 0, residual = 0): CameraStep => ({ dx: 0, dy: 0, scale: 1, cut, ok: false, blocks, inliers, histogram, residual });
    if (!prev || prev.levels[0].w !== w || prev.levels[0].h !== h) {
      this.velocity = { a: 0, tx: 0, ty: 0 };
      return { ...still(false, 0), ok: true };
    }
    const histogram = histDistance(prev.hist, cur.hist);
    if (histogram > this.o.cutHistogram) {
      this.velocity = { a: 0, tx: 0, ty: 0 };
      return still(true, histogram);
    }
    const boxes = [...prev.masks, ...cur.masks];
    const B = this.o.block;
    // Coarse to fine; the model in px of the current level.
    const top = LEVELS - 1;
    const f = 2 ** top;
    let model: Model = { a: this.velocity.a, tx: this.velocity.tx / f, ty: this.velocity.ty / f };
    let matches: Match[] = [];
    let inliers = 0;
    let trusted = true;
    for (let l = top; l >= 0; l--) {
      const P = prev.levels[l], C = cur.levels[l];
      const step = l === 0 ? 10 : l === 1 ? 7 : 5;
      matches = matchLevel(P, C, boxes, model, l === top ? this.o.search : 2, B, step);
      let r = robustFit(matches, l === 0 ? 0.75 : 0.6);
      if (l === top && (!r || r.inliers < 3)) {
        // The prediction may be off (a sudden stop or start): search again around still.
        matches = matchLevel(P, C, boxes, { a: 0, tx: 0, ty: 0 }, this.o.search, B, step);
        r = robustFit(matches, 0.6);
        if (!r || r.inliers < 3) {
          trusted = false;
          break;
        }
      }
      // A finer level that finds too little keeps the coarser fit.
      if (r && r.inliers >= 3) (model = r.model), (inliers = r.inliers);
      else if (l === 0) inliers = 0;
      if (l > 0) model = { a: model.a, tx: model.tx * 2, ty: model.ty * 2 };
    }
    if (inliers < this.o.minInliers) trusted = false;
    const lowAgreement = matches.length > 0 ? inliers / matches.length : 0;
    const costs = matches.map((m) => m.cost).sort((a, b) => a - b);
    const residual = costs.length ? costs[costs.length >> 1] : 0;
    if ((costs.length >= 4 && residual > this.o.cutResidual) || (histogram > this.o.cutHistogramWeak && (!trusted || lowAgreement < 0.35))) {
      this.velocity = { a: 0, tx: 0, ty: 0 };
      return still(true, histogram, matches.length, inliers, residual);
    }
    if (!trusted) {
      this.velocity = { a: 0, tx: 0, ty: 0 };
      return still(false, histogram, matches.length, inliers, residual);
    }
    this.velocity = model;
    // d = a·x + t about the centre ⇒ p' − ½ = (1 + a)(p − ½) + t / size.
    return { dx: model.tx / w, dy: model.ty / h, scale: 1 + model.a, cut: false, ok: true, blocks: matches.length, inliers, histogram, residual };
  }
}

/** Shot-relative camera per frame from frame-to-frame steps: s and t against the first frame of each shot. */
export function accumulate(steps: CameraStep[]): { camera: { shift: [number, number]; scale: number }[]; cuts: number[] } {
  const camera: { shift: [number, number]; scale: number }[] = [];
  const cuts: number[] = [];
  let s = 1, tx = 0, ty = 0;
  steps.forEach((st, i) => {
    if (st.cut || i === 0) {
      if (st.cut && i > 0) cuts.push(i);
      (s = 1), (tx = 0), (ty = 0);
    } else {
      // p_k − ½ = s_k (p_{k−1} − ½) + t_k, p_{k−1} − ½ = S (p_0 − ½) + T ⇒ S' = s_k S, T' = s_k T + t_k.
      tx = st.scale * tx + st.dx;
      ty = st.scale * ty + st.dy;
      s *= st.scale;
    }
    camera.push({ shift: [tx, ty], scale: s });
  });
  return { camera, cuts };
}

/** The people's boxes from image landmarks (each 33 × [x, y, z, vis]), padded for hair, clothes, motion blur and the
 *  shadow at the feet. */
export function personBoxes(people: number[][][]): Box[] {
  const out: Box[] = [];
  for (const lm of people) {
    if (lm.length < 33) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of lm) (x0 = Math.min(x0, p[0])), (x1 = Math.max(x1, p[0])), (y0 = Math.min(y0, p[1])), (y1 = Math.max(y1, p[1]));
    const h = y1 - y0, pad = Math.max(0.04, 0.18 * h);
    out.push({ x0: x0 - pad, x1: x1 + pad, y0: y0 - pad - 0.1 * h, y1: y1 + pad });
  }
  return out;
}
