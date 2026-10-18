/** 手感 Feel: the material in everyday words, for the first view (the Lab closed). Material chips, three sliders
 *  (soft ↔ firm, wobbles long ↔ settles fast, small ↔ big belly), slow motion, moon gravity and a way back to the
 *  defaults. No numbers or units: they write the same store state as the Lab's exact knobs, so the two stay in step
 *  (a moved slider leaves the preset, which both panels then show as modified). */
import type { AppState, MaterialPreset, PhysicsParams } from "../contracts";
import { FEEL_KEY, copy, presetName, type FeelSliderId } from "./copy";
import { codexButton } from "./codex";
import { changed, type Ctx, type Part } from "./ctx";
import { append, h, icon } from "./dom";
import { matchingPreset } from "./format";
import { panel, switchRow } from "./panel";

type FeelParam = "softness" | "bounciness" | "bellySize";

/** A slider shown from 0 (left word) to 1 (right word), mapped onto one physics parameter. */
export interface FeelSliderDef {
  id: FeelSliderId;
  param: FeelParam;
  toView(v: number): number;
  fromView(x: number): number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
// the store keeps tidy values, so the Lab's exact fields show 0.42 rather than 0.41999999
const tidy = (v: number) => Math.round(v * 1000) / 1000;

/** The belly slider spans a range that always looks like 奶蛙 (the Lab's volume knob reaches further). */
export const BELLY_RANGE = [0.8, 1.5] as const;

export const FEEL_SLIDERS: FeelSliderDef[] = [
  { id: "firm", param: "softness", toView: (s) => clamp01(1 - s), fromView: (x) => tidy(1 - clamp01(x)) },
  { id: "settle", param: "bounciness", toView: (b) => clamp01(1 - b), fromView: (x) => tidy(1 - clamp01(x)) },
  {
    id: "belly",
    param: "bellySize",
    toView: (v) => clamp01((v - BELLY_RANGE[0]) / (BELLY_RANGE[1] - BELLY_RANGE[0])),
    fromView: (x) => tidy(BELLY_RANGE[0] + clamp01(x) * (BELLY_RANGE[1] - BELLY_RANGE[0])),
  },
];

/** The Moon's surface gravity as a multiple of Earth's. */
export const MOON_GRAVITY = 1 / 6;
export const SLOW_SPEED = 0.25;

export const isMoon = (gravity: number) => Math.abs(gravity - MOON_GRAVITY) < 1e-3;
export const isSlow = (playback: AppState["playback"]) => playback.timeScale < 1;

/** Moon gravity on, or off: back to the gravity of the preset last picked (a balloon floats a little), else Earth's. */
export function moonGravity(on: boolean, s: Pick<AppState, "preset">, presets: MaterialPreset[]): number {
  if (on) return MOON_GRAVITY;
  const g = presets.find((p) => p.id === s.preset)?.params.gravity ?? 1;
  return isMoon(g) ? 1 : g;
}

/** The store patch of 恢复默认: the default preset (first in the list), all regions at their defaults, real time. */
export function defaultsPatch(presets: MaterialPreset[]) {
  const p = presets[0]!;
  return {
    preset: p.id,
    params: { ...p.params, regionSoftness: undefined } as Partial<PhysicsParams>,
    playback: { paused: false, timeScale: 1 },
  };
}

export function atDefaults(s: AppState, presets: MaterialPreset[]): boolean {
  return matchingPreset(s.params, presets) === presets[0]?.id && s.params.regionSoftness === undefined && !s.playback.paused && s.playback.timeScale === 1;
}

/** Where a 0…1 slider sits, in words: the left word, the middle one, or the right word. */
export function feelWord(x: number, words: { low: string; mid: string; high: string }): string {
  return x < 0.34 ? words.low : x > 0.66 ? words.high : words.mid;
}

export function createFeelPanel(ctx: Ctx, host: HTMLElement): Part {
  const { store, presets } = ctx;
  const T = copy();
  const { el, body } = panel(ctx, "feel", "feel", T.feel.title, T.feel.sub, FEEL_KEY);

  const reset = h(
    "button",
    { class: "nw-btn nw-btn--ghost nw-btn--sm", title: T.feel.resetHint, onclick: () => store.set(defaultsPatch(presets)) },
    icon("reset"),
    T.feel.reset,
  );
  const chips = presets.map((p) =>
    h("button", { class: "nw-chip", "aria-pressed": "false", onclick: () => store.set({ preset: p.id, params: { ...p.params } }) }, presetName(p)),
  );

  const sliders = FEEL_SLIDERS.map((d) => {
    const words = T.feel.sliders[d.id];
    const id = `nw-feel-${d.id}`;
    const input = h("input", {
      id,
      class: "nw-slider",
      type: "range",
      min: 0,
      max: 1,
      step: 0.01,
      "aria-label": words.label,
      oninput: (e: Event) => store.set({ params: { [d.param]: d.fromView(Number((e.target as HTMLInputElement).value)) } }),
    });
    const row = h(
      "div",
      { class: "nw-feel-slider" },
      h("label", { for: id, class: "nw-feel-ends" }, h("span", {}, words.low), h("span", {}, words.high)),
      input,
    );
    return { d, input, row, words };
  });

  const slow = switchRow(null, T.feel.slow, T.feel.slowHint, () => {
    const pb = store.get().playback;
    store.set({ playback: { ...pb, paused: false, timeScale: isSlow(pb) ? 1 : SLOW_SPEED } });
  });
  const moon = switchRow(null, T.feel.moon, T.feel.moonHint, () => {
    const s = store.get();
    store.set({ params: { gravity: moonGravity(!isMoon(s.params.gravity), s, presets) } });
  });
  for (const [r, hint] of [
    [slow.row, T.feel.slowHint],
    [moon.row, T.feel.moonHint],
  ] as const)
    r.title = hint;

  append(body, [
    h(
      "div",
      { class: "nw-section" },
      h("div", { class: "nw-section-head" }, h("h3", { class: "nw-section-title" }, T.feel.material), h("span", { class: "nw-section-actions" }, codexButton({ kind: "feel" }, { zh: "优化手感", en: "Tune the feel" }), reset)),
      h("div", { class: "nw-chips", role: "group", "aria-label": T.feel.material }, ...chips),
    ),
    h("div", { class: "nw-feel-sliders" }, ...sliders.map((x) => x.row)),
    h("div", { class: "nw-feel-toggles", role: "group", "aria-label": T.transport.playback }, slow.row, moon.row),
  ]);
  host.append(el);

  return {
    update(s: AppState, prev) {
      if (changed(s, prev, (x) => x.params)) {
        for (const { d, input, words } of sliders) {
          const x = d.toView(s.params[d.param]);
          if (document.activeElement !== input && input.value !== String(x)) input.value = String(x);
          input.style.setProperty("--fill", `${x * 100}%`);
          input.setAttribute("aria-valuetext", feelWord(x, words));
        }
        const match = matchingPreset(s.params, presets);
        chips.forEach((c, i) => c.setAttribute("aria-pressed", String(presets[i]!.id === match)));
        moon.set(isMoon(s.params.gravity));
      }
      if (changed(s, prev, (x) => x.playback)) slow.set(isSlow(s.playback));
      reset.disabled = atDefaults(s, presets);
    },
  };
}
