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

/** "3 秒", "1 分 05 秒". */
export function formatDuration(ms: number): string {
  const t = Math.max(1, Math.round(ms / 1000));
  return t < 60 ? `${t} 秒` : `${Math.floor(t / 60)} 分 ${String(t % 60).padStart(2, "0")} 秒`;
}

/** The live value next to a slider: 0..1 knobs as percent, multipliers as ×. */
export function formatParam(key: keyof PhysicsParams, v: number): string {
  if (key === "gravity") return `${v.toFixed(2).replace(/0$/, "")} g`;
  if (key === "bellySize") return `×${v.toFixed(2)}`;
  return `${Math.round(v * 100)}%`;
}

/** The preset whose params the current ones still equal (null once the player changed something). */
export function matchingPreset(params: PhysicsParams, presets: MaterialPreset[]): string | null {
  const same = (a: PhysicsParams, b: PhysicsParams) =>
    (Object.keys(a) as (keyof PhysicsParams)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-6);
  return presets.find((p) => same(p.params, params))?.id ?? null;
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): "light" | "dark" {
  return choice === "system" ? (prefersDark ? "dark" : "light") : choice;
}
