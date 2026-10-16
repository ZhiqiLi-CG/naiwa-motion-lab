/** Pure helpers of the UI (unit-tested). */
import type { MaterialPreset, PhysicsParams, ThemeChoice } from "../contracts";

/** "0:07", "12:34", "1:02:03". */
export function formatClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const hr = Math.floor(t / 3600);
  const ss = String(s).padStart(2, "0");
  return hr > 0 ? `${hr}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A value with its unit: "0.85", "9.81 m/s²", "1.35×". */
export function formatValue(v: number, digits: number, unit: string): string {
  const n = v.toFixed(digits);
  return unit === "" ? n : unit === "×" ? `${n}×` : `${n} ${unit}`;
}

/** Readouts: "1,234" (grouped), "2.1" (ms, one decimal under 10, none above). */
export const formatCount = (n: number) => Math.round(n).toLocaleString("en-US");
export const formatMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));

/** The five global knobs (regionSoftness is a map). */
export type ScalarParam = Exclude<keyof PhysicsParams, "regionSoftness">;
export const SCALAR_PARAMS: ScalarParam[] = ["softness", "bounciness", "gravity", "bellySize", "stubbornness"];

/** The preset whose knobs the current ones still equal (null once one changed; material by region is tuned on top of
 *  any preset and does not count). */
export function matchingPreset(params: PhysicsParams, presets: MaterialPreset[]): string | null {
  const same = (a: PhysicsParams, b: PhysicsParams) => SCALAR_PARAMS.every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  return presets.find((p) => same(p.params, params))?.id ?? null;
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  return choice === "system" ? (prefersDark ? "dark" : "light") : choice;
}
