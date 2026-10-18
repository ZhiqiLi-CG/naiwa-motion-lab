/**
 * Filter block: a constant-velocity Kalman filter on every landmark coordinate, and for a recording the
 * Rauch–Tung–Striebel smoother (the Kalman filter run forwards, then corrected backwards: zero lag).
 *
 * Each coordinate is a state [position, velocity] that moves on at its velocity while an unknown acceleration
 * (white, σ = `accel`) nudges it; the detector measures the position with noise σ = `noise`, larger for landmarks it
 * is unsure of (noise / visibility). The gain K weighs the prediction against the measurement by their variances.
 * A recording's short gaps are bridged by the model's prediction, and the smoother joins them up with the far side.
 */
import type { BlockDefinition, FilterBlock, PersonFrame, Settings } from "../../motion/api";
import { flatten, IMAGE_PER_METRE, isImage, MAX_GAP, present, runs, SERIES, unflatten, visibility } from "./landmarkSeries";

/** Kalman state of every series: position, velocity and the covariance [[p00, p01], [p01, p11]]. */
class Bank {
  x = new Float64Array(SERIES);
  v = new Float64Array(SERIES);
  p00 = new Float64Array(SERIES);
  p01 = new Float64Array(SERIES);
  p11 = new Float64Array(SERIES);

  /** Start at z with an unknown velocity. */
  init(z: Float64Array, noise: number) {
    this.x.set(z);
    this.v.fill(0);
    for (let k = 0; k < SERIES; k++) {
      const r = isImage(k) ? noise * IMAGE_PER_METRE : noise;
      this.p00[k] = r * r;
      this.p11[k] = 1;
    }
    this.p01.fill(0);
  }

  /** x ← x + v·dt, P ← F P Fᵀ + Q (piecewise-constant white acceleration of σ = accel). */
  predict(dt: number, accel: number) {
    const dt2 = dt * dt;
    for (let k = 0; k < SERIES; k++) {
      const a = isImage(k) ? accel * IMAGE_PER_METRE : accel, q = a * a;
      this.x[k] += this.v[k] * dt;
      const p00 = this.p00[k] + 2 * dt * this.p01[k] + dt2 * this.p11[k];
      const p01 = this.p01[k] + dt * this.p11[k];
      this.p00[k] = p00 + (q * dt2 * dt2) / 4;
      this.p01[k] = p01 + (q * dt2 * dt) / 2;
      this.p11[k] += q * dt2;
    }
  }

  /** Measurement z of position, variance r: K = P Hᵀ / (H P Hᵀ + r), x ← x + K (z − x), P ← (I − K H) P. */
  update(k: number, z: number, r: number) {
    const s = this.p00[k] + r;
    const k0 = this.p00[k] / s, k1 = this.p01[k] / s;
    const e = z - this.x[k];
    this.x[k] += k0 * e;
    this.v[k] += k1 * e;
    const p00 = this.p00[k], p01 = this.p01[k];
    this.p00[k] = (1 - k0) * p00;
    this.p01[k] = (1 - k0) * p01;
    this.p11[k] -= k1 * p01;
  }

  measure(f: PersonFrame, z: Float64Array, noise: number) {
    for (let k = 0; k < SERIES; k++) {
      const r = isImage(k) ? noise * IMAGE_PER_METRE : noise;
      this.update(k, z[k], (r * r) / Math.max(0.1, visibility(f, k)));
    }
  }

  snapshot() {
    return { x: this.x.slice(), v: this.v.slice(), p00: this.p00.slice(), p01: this.p01.slice(), p11: this.p11.slice() };
  }
}

class KalmanFilter implements FilterBlock {
  private bank = new Bank();
  private last: number | null = null;
  private readonly z = new Float64Array(SERIES);

  constructor(private s: Readonly<Settings>) {}

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  reset() {
    this.last = null;
  }

  live(frame: PersonFrame, t: number): PersonFrame {
    if (!present(frame)) return frame;
    const accel = this.s.accel as number, noise = this.s.noise as number;
    flatten(frame, this.z);
    if (this.last === null || t - this.last > MAX_GAP || t <= this.last) this.bank.init(this.z, noise);
    else {
      this.bank.predict(t - this.last, accel);
      this.bank.measure(frame, this.z, noise);
    }
    this.last = t;
    return unflatten(this.bank.x, frame);
  }

  /** Forwards (filter), then backwards (RTS): x̂ₖ = xₖ + Cₖ (x̂ₖ₊₁ − x⁻ₖ₊₁), Cₖ = Pₖ Fᵀ (P⁻ₖ₊₁)⁻¹. */
  recorded(frames: PersonFrame[], fps: number): PersonFrame[] {
    const out = frames.slice();
    const accel = this.s.accel as number, noise = this.s.noise as number, dt = 1 / fps;
    for (const { from, to } of runs(frames, fps)) {
      const filtered: ReturnType<Bank["snapshot"]>[] = [];
      const predicted: ReturnType<Bank["snapshot"]>[] = [];
      const bank = new Bank();
      let like = frames[from];
      for (let i = from; i <= to; i++) {
        if (i === from) bank.init(flatten(frames[i]), noise);
        else bank.predict(dt, accel);
        predicted.push(bank.snapshot());
        if (i > from && present(frames[i])) bank.measure(frames[i], flatten(frames[i]), noise);
        filtered.push(bank.snapshot());
      }
      const n = filtered.length;
      const xs = filtered[n - 1].x.slice(), vs = filtered[n - 1].v.slice();
      const result = [xs.slice()];
      for (let j = n - 2; j >= 0; j--) {
        const f = filtered[j], p = predicted[j + 1];
        for (let k = 0; k < SERIES; k++) {
          // P Fᵀ (F = [[1, dt], [0, 1]]): the cross-covariance of this state and the next prediction.
          const a00 = f.p00[k] + dt * f.p01[k], a01 = f.p01[k], a10 = f.p01[k] + dt * f.p11[k], a11 = f.p11[k];
          const det = p.p00[k] * p.p11[k] - p.p01[k] * p.p01[k];
          // C = P Fᵀ (P⁻)⁻¹, written out for 2 × 2 (the inverse is symmetric).
          const i00 = p.p11[k] / det, i01 = -p.p01[k] / det, i11 = p.p00[k] / det;
          const c00 = a00 * i00 + a01 * i01, c01 = a00 * i01 + a01 * i11;
          const c10 = a10 * i00 + a11 * i01, c11 = a10 * i01 + a11 * i11;
          const dx = xs[k] - p.x[k], dv = vs[k] - p.v[k];
          xs[k] = f.x[k] + c00 * dx + c01 * dv;
          vs[k] = f.v[k] + c10 * dx + c11 * dv;
        }
        result.push(xs.slice());
      }
      result.reverse();
      for (let i = from; i <= to; i++) {
        if (present(frames[i])) like = frames[i];
        out[i] = unflatten(result[i - from], { ...like, aspect: frames[i].aspect });
      }
    }
    return out;
  }
}

export const kalmanFilter: BlockDefinition<"filter"> = {
  id: "kalman-cv",
  slot: "filter",
  name: { zh: "卡尔曼滤波（匀速模型）", en: "Kalman filter (constant velocity)" },
  summary: {
    zh: "每个关键点坐标是 [位置, 速度] 的状态，按匀速预测、用检测值校正，增益由两者的方差决定；看不清的点更信预测。上传的视频再用 RTS 平滑器反向修正，没有延迟，并补上半秒以内的空缺。",
    en: "Each landmark coordinate is a [position, velocity] state, predicted at constant velocity and corrected by the detection, weighted by their variances; unsure landmarks trust the prediction more. Recorded videos are corrected backwards by the RTS smoother (no lag), gaps under half a second bridged.",
  },
  parameters: [
    {
      key: "accel", kind: "number", default: 30, min: 1, max: 300, step: 1, unit: "m/s²",
      label: { zh: "加速度噪声 σa", en: "Acceleration noise σa" },
      help: { zh: "模型允许的意外加速度：越大越跟手，越小越平滑", en: "Unexpected acceleration the model allows: higher follows faster moves, lower is smoother" },
    },
    {
      key: "noise", kind: "number", default: 0.015, min: 0.001, max: 0.1, step: 0.001, unit: "m",
      label: { zh: "测量噪声 σm", en: "Measurement noise σm" },
      help: { zh: "检测器的抖动大小（可见度低时自动放大）", en: "How much the detector jitters (scaled up for poorly visible landmarks)" },
    },
  ],
  create: (_scene, settings) => new KalmanFilter(settings),
};
