/**
 * The camera's motion from the background of a video, frame to frame: translation and zoom (no rotation), with the
 * people masked out, and shot cuts. Pure numbers (runs in Node for the tests); cameraFrames.ts feeds it the analysed
 * video's frames in the browser.
 *
 * Each frame comes in as a small grayscale picture (about 160 px on its long side) and becomes a three-level pyramid
 * of band-passed pictures (a light blur minus a wide one, so exposure changes do not count). The people's boxes
 * (padded) are left out. Two frames are aligned coarse to fine:
 *
 * - on the coarsest level (about 40 px), every whole-pixel shift around the previous frame's motion and around
 *   standing still is scored by the mean absolute difference of the background; the best, refined by a parabola;
 * - then on every level, Lucas–Kanade: Gauss–Newton on the model x' = (1 + a)·x + t (x from the picture's centre),
 *   over all background pixels, robustly reweighted (Tukey, scale from the median residual), so other moving things
 *   drop out. A direction the background has no texture along (stripes, a plain wall) is not trusted: the camera is
 *   taken as still along it.
 *
 * Pooling every background pixel is what makes stripes work: a block of horizontal slats says nothing about a pan,
 * but the slats' ends, the floor and the furniture together do.
 *
 * A cut: the brightness histogram changes a lot (Bhattacharyya distance), or the aligned frames still differ about
 * as much as unrelated pictures do (median residual against the median band-passed value). A frame whose fit is
 * unreliable (too little background, too little agreement) carries on the last trusted motion for a few frames,
 * fading (cameras move smoothly), then counts as a still camera.
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
  /** Shift (picture fractions) and zoom; identity on the first frame and at a cut; when the fit is unreliable, the
   *  last trusted motion fading out over a few frames. */
  dx: number;
  dy: number;
  scale: number;
  /** A new shot starts at this frame. */
  cut: boolean;
  /** Whether the fit was trusted. */
  ok: boolean;
  /** Background pixels used and those that agree with the fit (finest level, every other pixel). */
  blocks: number;
  inliers: number;
  /** Histogram distance from the previous frame (0 same … 1 disjoint). */
  histogram: number;
  /** Median aligned difference against the median band-passed value (well under 1 aligned, about 1 and more
   *  for unrelated pictures). */
  residual: number;
  /** Median band-passed value of the background (gray levels): its texture. */
  texture: number;
}

export interface CameraOptions {
  /** Coarsest-level search radius (px) around the predicted motion and around still. */
  search: number;
  /** Smallest share of the picture that must be usable background. */
  minBackground: number;
  /** Smallest share of the background that must agree with the fit. */
  minAgreement: number;
  /** Histogram distance that alone is a cut, and the one that is a cut when the fit fails. */
  cutHistogram: number;
  cutHistogramWeak: number;
  /** Aligned residual that is a cut, and the largest one a trusted fit may have. */
  cutResidual: number;
  maxResidual: number;
  /** Background texture (median band-passed value, gray levels) under which there is nothing to align: a plain wall.
   *  The residual then measures noise, so it says nothing about a cut, and the fit is not trusted. */
  minTexture: number;
  /** Largest uncertainty of the shift (px of the finest level, σ_residual / √information along the weakest
   *  direction) for that direction to be trusted. */
  maxUncertainty: number;
}

export const CAMERA_DEFAULTS: CameraOptions = {
  search: 4, minBackground: 0.06, minAgreement: 0.45, cutHistogram: 0.45, cutHistogramWeak: 0.2, cutResidual: 0.9, maxResidual: 0.7, minTexture: 1.5, maxUncertainty: 0.05,
};

/** The long side of the pictures to feed (px). */
export const CAMERA_SIZE = 160;

const LEVELS = 3;
const BINS = 16;

interface Level {
  w: number;
  h: number;
  /** Band-passed picture and its gradient (central differences). */
  img: Float32Array;
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

/** Box mean of radius r (separable running sums, edges clamped). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function level(src: Float32Array, w: number, h: number): Level {
  const fine = boxBlur(src, w, h, 1), wide = boxBlur(src, w, h, 4);
  const img = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) img[i] = fine[i] - wide[i];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (img[i + 1] - img[i - 1]) / 2;
      gy[i] = (img[i + w] - img[i - w]) / 2;
    }
  return { w, h, img, gx, gy };
}

function picture(gray: Float32Array | Uint8Array | Uint8ClampedArray, w: number, h: number, masks: Box[]): Picture {
  const hist = new Float64Array(BINS);
  const base = Float32Array.from(gray);
  for (let i = 0; i < w * h; i++) hist[Math.min(BINS - 1, Math.max(0, Math.floor((base[i] / 256) * BINS)))]++;
  for (let b = 0; b < BINS; b++) hist[b] /= w * h;
  const levels: Level[] = [];
  let cur: { img: Float32Array; w: number; h: number } = { img: base, w, h };
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

/** Model x' = (1 + a)·x + t, x from the picture centre, px of a level. */
interface Model {
  a: number;
  tx: number;
  ty: number;
}

/** Usable background pixels of a level: outside every box, two pixels in from the border. */
function background(L: Level, boxes: Box[]): Uint8Array {
  const { w, h } = L, out = new Uint8Array(w * h);
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const u = (x + 0.5) / w, v = (y + 0.5) / h;
      let inside = false;
      for (const b of boxes) if (u >= b.x0 && u <= b.x1 && v >= b.y0 && v <= b.y1) inside = true;
      out[y * w + x] = inside ? 0 : 1;
    }
  return out;
}

function bilinear(a: Float32Array, w: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

/** Whole-pixel shifts around the given points scored on the background; the best with a sub-pixel parabola. */
function coarseShift(P: Level, C: Level, bg: Uint8Array, around: [number, number][], R: number): [number, number] {
  const { w, h } = P;
  const score = new Map<string, number>();
  const at = (dx: number, dy: number) => {
    const key = `${dx},${dy}`;
    let s = score.get(key);
    if (s !== undefined) return s;
    let sum = 0, n = 0;
    for (let y = 2; y < h - 2; y++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let x = 2; x < w - 2; x++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || !bg[y * w + x]) continue;
        sum += Math.abs(P.img[y * w + x] - C.img[yy * w + xx]);
        n++;
      }
    }
    s = n > 20 ? sum / n : Infinity;
    score.set(key, s);
    return s;
  };
  let best: [number, number] = [0, 0], bestS = Infinity;
  for (const [cx, cy] of around)
    for (let dy = Math.round(cy) - R; dy <= Math.round(cy) + R; dy++)
      for (let dx = Math.round(cx) - R; dx <= Math.round(cx) + R; dx++) {
        const s = at(dx, dy);
        if (s < bestS) (bestS = s), (best = [dx, dy]);
      }
  const sub = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return Number.isFinite(d) && d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
  };
  const [bx, by] = best;
  return [bx + sub(at(bx - 1, by), bestS, at(bx + 1, by)), by + sub(at(bx, by - 1), bestS, at(bx, by + 1))];
}

interface Refined {
  model: Model;
  /** Background pixels used, and those agreeing (Tukey weight over ½). */
  used: number;
  agree: number;
  /** Median |residual| over median |band-passed value|, and that median value. */
  residual: number;
  texture: number;
  /** The shift's uncertainty along its weakest direction (px), and that direction (unit). */
  weak: number;
  weakDir: [number, number];
}

/** Solve a 3 × 3 system (Cramer's rule); zeros if singular. */
function solve3(A: number[][], b: number[]): number[] {
  const det = (M: number[][]) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return [0, 0, 0];
  return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
}

/** Lucas–Kanade (Gauss–Newton, Tukey-reweighted) from `m` on one level, every `step`-th pixel. */
function refine(P: Level, C: Level, bg: Uint8Array, m: Model, iterations: number, step: number): Refined {
  const { w, h } = P, cx = w / 2, cy = h / 2;
  const cap = Math.ceil(w / step) * Math.ceil(h / step);
  const R = new Float32Array(cap), J0 = new Float32Array(cap), J1 = new Float32Array(cap), J2 = new Float32Array(cap), V = new Float32Array(cap);
  let model = { ...m };
  let out: Refined = { model, used: 0, agree: 0, residual: Infinity, texture: 0, weak: 0, weakDir: [1, 0] };
  for (let it = 0; it < iterations; it++) {
    let n = 0;
    for (let y = 2; y < h - 2; y += step)
      for (let x = 2; x < w - 2; x += step) {
        if (!bg[y * w + x]) continue;
        const xr = x - cx, yr = y - cy;
        const u = (1 + model.a) * xr + cx + model.tx, v = (1 + model.a) * yr + cy + model.ty;
        if (u < 1 || v < 1 || u > w - 2 || v > h - 2) continue;
        const gxv = bilinear(C.gx, w, u, v), gyv = bilinear(C.gy, w, u, v);
        R[n] = bilinear(C.img, w, u, v) - P.img[y * w + x];
        J0[n] = gxv * xr + gyv * yr;
        J1[n] = gxv;
        J2[n] = gyv;
        V[n] = Math.abs(P.img[y * w + x]);
        n++;
      }
    if (n < 30) return { ...out, used: n };
    // Robust scale from the median residual (a subsample is enough).
    const stride = Math.max(1, Math.floor(n / 400));
    const abs: number[] = [], val: number[] = [];
    for (let i = 0; i < n; i += stride) abs.push(Math.abs(R[i])), val.push(V[i]);
    abs.sort((p, q) => p - q);
    val.sort((p, q) => p - q);
    const med = abs[abs.length >> 1];
    const sigma = Math.max(0.5, 1.4826 * med), c = 4.685 * sigma;
    let h00 = 0, h01 = 0, h02 = 0, h11 = 0, h12 = 0, h22 = 0, g0 = 0, g1 = 0, g2 = 0, agree = 0;
    for (let i = 0; i < n; i++) {
      const u = R[i] / c;
      if (u >= 1 || u <= -1) continue;
      const wt = (1 - u * u) ** 2;
      if (wt > 0.5) agree++;
      const a = J0[i], b = J1[i], d = J2[i], r = R[i];
      (h00 += wt * a * a), (h01 += wt * a * b), (h02 += wt * a * d), (h11 += wt * b * b), (h12 += wt * b * d), (h22 += wt * d * d);
      (g0 += wt * a * r), (g1 += wt * b * r), (g2 += wt * d * r);
    }
    // The weakest translation direction: the smallest eigenvalue of [[h11, h12], [h12, h22]] and its vector.
    const tr = h11 + h22, det = h11 * h22 - h12 * h12, disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const lmin = tr / 2 - disc;
    let wd: [number, number] = Math.abs(h12) > 1e-9 ? [lmin - h22, h12] : h11 < h22 ? [1, 0] : [0, 1];
    const wl = Math.hypot(wd[0], wd[1]) || 1;
    wd = [wd[0] / wl, wd[1] / wl];
    // A little Levenberg damping: a direction without any texture stays where it was.
    const lam = 1e-6 * (h00 / Math.max(1, cx * cx) + h11 + h22) + 1e-6;
    const d = solve3([[h00 + lam * cx * cx, h01, h02], [h01, h11 + lam, h12], [h02, h12, h22 + lam]], [g0, g1, g2]);
    model = { a: Math.max(-0.2, Math.min(0.2, model.a - d[0])), tx: model.tx - d[1], ty: model.ty - d[2] };
    out = { model, used: n, agree, residual: med / Math.max(1e-6, val[val.length >> 1]), texture: val[val.length >> 1], weak: sigma / Math.sqrt(Math.max(1e-9, lmin)), weakDir: wd };
    if (Math.abs(d[1]) + Math.abs(d[2]) < 0.01 && Math.abs(d[0]) < 1e-4) break;
  }
  return out;
}

/** Estimates the camera's motion frame to frame. */
export class CameraEstimator {
  private prev: Picture | null = null;
  /** The previous step in px of the finest level (prediction for the next one). */
  private velocity: Model = { a: 0, tx: 0, ty: 0 };
  /** Untrusted steps in a row (each carries on the last trusted motion, fading). */
  private coast = 0;
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
    const still = (cut: boolean, histogram: number, used = 0, agree = 0, residual = 0, texture = 0): CameraStep =>
      ({ dx: 0, dy: 0, scale: 1, cut, ok: false, blocks: used, inliers: agree, histogram, residual, texture });
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
    const top = LEVELS - 1, f = 2 ** top;
    const Pt = prev.levels[top], Ct = cur.levels[top];
    const bgTop = background(Pt, boxes);
    const v = this.velocity;
    const [sx, sy] = coarseShift(Pt, Ct, bgTop, [[v.tx / f, v.ty / f], [0, 0]], this.o.search);
    let model: Model = { a: v.a, tx: sx, ty: sy };
    let fine: Refined | null = null;
    for (let l = top; l >= 0; l--) {
      const P = prev.levels[l], C = cur.levels[l];
      fine = refine(P, C, l === top ? bgTop : background(P, boxes), model, l === 0 ? 6 : 5, l === 0 ? 2 : 1);
      model = fine.model;
      if (l > 0) model = { a: model.a, tx: model.tx * 2, ty: model.ty * 2 };
    }
    const r = fine!;
    const total = Math.ceil((w - 4) / 2) * Math.ceil((h - 4) / 2);
    const enough = r.used >= this.o.minBackground * total && r.texture >= this.o.minTexture;
    const agreement = r.used ? r.agree / r.used : 0;
    const trusted = enough && agreement >= this.o.minAgreement && r.residual <= this.o.maxResidual;
    // Without texture (a plain wall) only a large change of the brightness histogram says cut.
    const textured = r.texture >= this.o.minTexture;
    // The residual only speaks for a cut over a good part of the picture (beside a dancer, their arms and clothes leak in).
    const wide = r.used >= 0.15 * total;
    if ((enough && wide && r.residual > this.o.cutResidual) || (textured && histogram > this.o.cutHistogramWeak && !trusted)) {
      this.velocity = { a: 0, tx: 0, ty: 0 };
      return still(true, histogram, r.used, r.agree, r.residual, r.texture);
    }
    if (!trusted) {
      // Too little background (a dancer filling the picture): cameras move smoothly, so carry on the last trusted
      // motion for a few frames, fading, then stand still.
      const k = ++this.coast <= 6 ? 0.75 : 0;
      const p = (this.velocity = { a: this.velocity.a * k, tx: this.velocity.tx * k, ty: this.velocity.ty * k });
      return { ...still(false, histogram, r.used, r.agree, r.residual, r.texture), dx: p.tx / w, dy: p.ty / h, scale: 1 + p.a };
    }
    this.coast = 0;
    // Along a direction without texture the camera is taken as still.
    if (r.weak > this.o.maxUncertainty) {
      const [ex, ey] = r.weakDir, along = model.tx * ex + model.ty * ey;
      model = { ...model, tx: model.tx - along * ex, ty: model.ty - along * ey };
    }
    this.velocity = model;
    // x' = (1 + a)·x + t about the centre ⇒ p' − ½ = (1 + a)(p − ½) + t / size.
    return { dx: model.tx / w, dy: model.ty / h, scale: 1 + model.a, cut: false, ok: true, blocks: r.used, inliers: r.agree, histogram, residual: r.residual, texture: r.texture };
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
