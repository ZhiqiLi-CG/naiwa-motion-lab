/**
 * The feel in numbers: a standard perturbation (poke or slap a region, or drop the frog) sampled a few times a
 * second, summarised into a few comparable numbers. Lower is better for all but peak_mm, which says how much the
 * flesh gives at all. The surface numbers work with any simulator; the others need its metrics block.
 */

export interface ProbeSample {
  /** Seconds since the perturbation (negative: before it). */
  t: number;
  /** Surface displacement against the surface just before the perturbation, with the mean (rigid) shift removed:
   *  mean and max over the vertices (m). */
  surfaceMean: number;
  surfaceMax: number;
  /** The simulator's metrics when it has them (src/sim/api.ts Metrics). */
  deviation?: number;
  deviationMax?: number;
  jitter?: number;
  penetration?: number;
  invertedCells?: number;
  volume?: Record<string, number>;
  stepMs?: number;
}

/** Displacement of a surface against a reference, with the mean shift removed. */
export function surfaceDisplacement(ref: Float32Array, now: Float32Array): { mean: number; max: number } {
  const n = Math.min(ref.length, now.length) / 3;
  if (!n) return { mean: 0, max: 0 };
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    sx += now[3 * i] - ref[3 * i];
    sy += now[3 * i + 1] - ref[3 * i + 1];
    sz += now[3 * i + 2] - ref[3 * i + 2];
  }
  sx /= n;
  sy /= n;
  sz /= n;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(now[3 * i] - ref[3 * i] - sx, now[3 * i + 1] - ref[3 * i + 1] - sy, now[3 * i + 2] - ref[3 * i + 2] - sz);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / n, max };
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** When a signal last stood above rest + 10 % of its excursion (s after the perturbation; 0 if it never rose). */
export function settleTime(samples: ProbeSample[], pick: (s: ProbeSample) => number | undefined): number | null {
  const before = samples.filter((s) => s.t < 0).map(pick).filter((v): v is number => v !== undefined);
  const after = samples.filter((s) => s.t >= 0);
  const values = after.map(pick);
  if (!after.length || values.some((v) => v === undefined)) return null;
  const rest = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
  const peak = Math.max(...(values as number[]));
  if (peak <= rest) return 0;
  const threshold = rest + 0.1 * (peak - rest);
  let last = 0;
  after.forEach((s, i) => {
    if ((values[i] as number) > threshold) last = s.t;
  });
  return last;
}

/** The summary numbers of a probe (keys with units; only those the samples can tell). */
export function summariseProbe(samples: ProbeSample[]): Record<string, number> {
  const after = samples.filter((s) => s.t >= 0);
  if (!after.length) return {};
  const out: Record<string, number> = {};
  const tail = after.slice(Math.floor(after.length * 0.7));
  out.surface_peak_mm = round(Math.max(...after.map((s) => s.surfaceMax)) * 1000, 1);
  out.surface_settle_s = round(settleTime(samples, (s) => s.surfaceMean) ?? 0, 2);
  out.surface_rest_mm = round((tail.reduce((a, s) => a + s.surfaceMean, 0) / tail.length) * 1000, 2);
  const has = <K extends keyof ProbeSample>(k: K) => after.every((s) => typeof s[k] === "number");
  if (has("deviationMax")) out.peak_mm = round(Math.max(...after.map((s) => s.deviationMax!)) * 1000, 1);
  if (has("jitter")) out.jitter_rest_mm_s = round((tail.reduce((a, s) => a + s.jitter!, 0) / tail.length) * 1000, 2);
  if (has("penetration")) out.penetration_mm = round(Math.max(...after.map((s) => s.penetration!)) * 1000, 1);
  if (has("invertedCells")) out.inverted_cells = Math.max(...after.map((s) => s.invertedCells!));
  if (after.every((s) => s.volume)) {
    out.volume_err_pct = round(Math.max(...after.flatMap((s) => Object.values(s.volume!).map((v) => Math.abs(v - 1)))) * 100, 2);
  }
  if (has("stepMs")) out.step_ms = round(after.reduce((a, s) => a + s.stepMs!, 0) / after.length, 2);
  return out;
}
