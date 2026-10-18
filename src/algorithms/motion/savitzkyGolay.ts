/**
 * Filter block: the Savitzky–Golay filter. Around each frame a polynomial of degree `order` is fitted by least squares
 * to the frames within `window`, and the frame takes the polynomial's value there. A low-pass that keeps peaks: a fast
 * move's top is a curve the polynomial follows, where an average would flatten it.
 *
 * The fit is linear in the samples, so it is a fixed set of weights per window shape (the convolution coefficients),
 * computed once and applied to all 198 coordinates. A recording uses a centred window (zero lag; at its ends the
 * window shifts inwards and the fit is evaluated off-centre). The camera has no future frames: there the polynomial
 * is fitted to the last `liveWindow` seconds and evaluated at the newest frame, which lags less than an average but
 * passes more noise, so it uses its own, lower order.
 */
import type { BlockDefinition, FilterBlock, PersonFrame, Settings } from "../../motion/api";
import { flatten, MAX_GAP, present, runs, SERIES, unflatten } from "./landmarkSeries";

/**
 * Weights w with Σ wⱼ yⱼ = the value at τ = 0 of the degree-`order` least-squares polynomial through (τⱼ, yⱼ):
 * the first row of (AᵀA)⁻¹Aᵀ, A the Vandermonde matrix of τ (scaled to ±1 for conditioning).
 */
export function polyWeights(tau: readonly number[], order: number): number[] {
  const n = tau.length, m = Math.min(order, n - 1) + 1;
  const scale = Math.max(1e-9, ...tau.map(Math.abs));
  const A = tau.map((t) => Array.from({ length: m }, (_, k) => (t / scale) ** k));
  // Normal equations AᵀA c = e₀, solved by Gauss–Jordan; then w = A c.
  const M = Array.from({ length: m }, (_, i) => [...Array.from({ length: m }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)), i === 0 ? 1 : 0]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= m; c++) M[r][c] -= f * M[col][c];
    }
  }
  const c = M.map((row, i) => row[m] / row[i]);
  return A.map((row) => row.reduce((s, x, k) => s + x * c[k], 0));
}

/** Linear interpolation over a run's missing frames (gaps up to MAX_GAP). */
function bridged(frames: PersonFrame[], from: number, to: number): Float64Array[] {
  const out: Float64Array[] = [];
  let last = from;
  for (let i = from; i <= to; i++) {
    if (!present(frames[i])) continue;
    const v = flatten(frames[i]);
    for (let j = last + 1; j < i; j++) {
      const w = (j - last) / (i - last);
      out.push(out[out.length - 1].map((a, k) => a + (v[k] - a) * w));
    }
    out.push(v);
    last = i;
  }
  return out;
}

class SavitzkyGolay implements FilterBlock {
  private times: number[] = [];
  private values: Float64Array[] = [];

  constructor(private s: Readonly<Settings>) {}

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  reset() {
    this.times = [];
    this.values = [];
  }

  live(frame: PersonFrame, t: number): PersonFrame {
    if (!present(frame)) return frame;
    if (this.times.length && (t - this.times[this.times.length - 1] > MAX_GAP || t <= this.times[this.times.length - 1])) this.reset();
    this.times.push(t);
    this.values.push(flatten(frame));
    while (t - this.times[0] > (this.s.liveWindow as number)) this.times.shift(), this.values.shift();
    const w = polyWeights(this.times.map((x) => x - t), this.s.liveOrder as number);
    const out = new Float64Array(SERIES);
    w.forEach((wj, j) => {
      const v = this.values[j];
      for (let k = 0; k < SERIES; k++) out[k] += wj * v[k];
    });
    return unflatten(out, frame);
  }

  recorded(frames: PersonFrame[], fps: number): PersonFrame[] {
    const out = frames.slice();
    const half = Math.max(1, Math.round(((this.s.window as number) * fps) / 2));
    const order = this.s.order as number;
    const cache = new Map<string, number[]>();
    for (const { from, to } of runs(frames, fps)) {
      const ys = bridged(frames, from, to);
      const n = ys.length;
      let like = frames[from];
      for (let i = 0; i < n; i++) {
        // The full window where it fits, shifted inwards at the run's ends.
        const lo = Math.max(0, Math.min(i - half, n - 1 - 2 * half)), hi = Math.min(n - 1, lo + 2 * half);
        const key = `${lo - i},${hi - i}`;
        let w = cache.get(key);
        if (!w) cache.set(key, (w = polyWeights(Array.from({ length: hi - lo + 1 }, (_, j) => (lo + j - i) / fps), order)));
        const v = new Float64Array(SERIES);
        for (let j = lo; j <= hi; j++) for (let k = 0; k < SERIES; k++) v[k] += w[j - lo] * ys[j][k];
        if (present(frames[from + i])) like = frames[from + i];
        out[from + i] = unflatten(v, { ...like, aspect: frames[from + i].aspect });
      }
    }
    return out;
  }
}

export const savitzkyGolay: BlockDefinition<"filter"> = {
  id: "savitzky-golay",
  slot: "filter",
  name: { zh: "Savitzky–Golay 滤波", en: "Savitzky–Golay filter" },
  summary: {
    zh: "在每帧前后的时间窗里用最小二乘拟合一个低次多项式，取它在这一帧的值：去掉抖动但保留动作的峰值。视频用居中窗口（无延迟）；摄像头只有过去的帧，用较短、较低次的窗口在最新一帧取值。",
    en: "Fits a low-degree polynomial by least squares to the frames in a window around each frame and takes its value there: jitter goes, the peaks of a move stay. Recordings use a centred window (no lag); the camera only has past frames, so it fits a shorter, lower-degree window ending at the newest one.",
  },
  parameters: [
    {
      key: "window", kind: "number", default: 0.3, min: 0.05, max: 1.5, step: 0.01, unit: "s",
      label: { zh: "视频 · 窗口长度", en: "Video · window" },
      help: { zh: "越长越平滑，太长会削平快动作（下次分析生效）", en: "Longer is smoother; too long flattens fast moves (applies to the next analysis)" },
    },
    {
      key: "order", kind: "number", default: 3, min: 0, max: 6, step: 1,
      label: { zh: "视频 · 多项式次数", en: "Video · polynomial degree" },
      help: { zh: "次数越高越能保留峰值，去噪越弱；0 就是滑动平均", en: "Higher keeps peaks better and removes less noise; 0 is a moving average" },
    },
    {
      key: "liveWindow", kind: "number", default: 0.15, min: 0.03, max: 0.6, step: 0.01, unit: "s",
      label: { zh: "摄像头 · 窗口长度", en: "Camera · window" },
    },
    {
      key: "liveOrder", kind: "number", default: 1, min: 0, max: 3, step: 1,
      label: { zh: "摄像头 · 多项式次数", en: "Camera · polynomial degree" },
      help: { zh: "在窗口末端取值时，高次多项式会放大噪声", en: "Evaluated at the window's end, a high degree amplifies noise" },
    },
  ],
  create: (_scene, settings) => new SavitzkyGolay(settings),
};
