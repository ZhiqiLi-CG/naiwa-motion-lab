import { describe, expect, it } from "vitest";
import { MATERIAL_PRESETS, createStore, initialState } from "../store";
import { KNOBS } from "./copy";
import { BELLY_RANGE, FEEL_SLIDERS, MOON_GRAVITY, atDefaults, defaultsPatch, feelWord, isMoon, isSlow, moonGravity } from "./feel";
import { matchingPreset } from "./format";

const slider = (id: string) => FEEL_SLIDERS.find((d) => d.id === id)!;
const knob = (id: string) => KNOBS.find((k) => k.id === id)!;

describe("feel panel", () => {
  it("sliders map onto their parameters in the right direction", () => {
    // soft ↔ firm: left is the softest
    expect(slider("firm").fromView(0)).toBe(1);
    expect(slider("firm").fromView(1)).toBe(0);
    // wobbles long ↔ settles fast: left keeps bouncing
    expect(slider("settle").fromView(0)).toBe(1);
    expect(slider("settle").fromView(1)).toBe(0);
    // small ↔ big belly, within a range that still looks like 奶蛙
    expect(slider("belly").fromView(0)).toBe(BELLY_RANGE[0]);
    expect(slider("belly").fromView(1)).toBe(BELLY_RANGE[1]);
    expect(slider("belly").toView(1.8)).toBe(1);
    for (const d of FEEL_SLIDERS)
      for (const x of [0, 0.25, 0.5, 0.73, 1]) {
        expect(d.toView(d.fromView(x))).toBeCloseTo(x, 2);
        // tidy values for the Lab's exact fields
        expect(Math.round(d.fromView(x) * 1000)).toBe(d.fromView(x) * 1000);
      }
  });

  it("stays in step with the Lab's knobs both ways through the store", () => {
    const store = createStore(initialState());
    // a feel slider moves: the Lab's softness knob shows the new value, the preset reads as modified
    const firm = slider("firm");
    store.set({ params: { softness: firm.fromView(0.7) } });
    expect(knob("softness").toView(store.get().params.softness)).toBeCloseTo(0.3, 9);
    expect(matchingPreset(store.get().params, MATERIAL_PRESETS)).toBeNull();
    // the Lab's damping knob moves: the feel slider (wobbles long ↔ settles fast) reads the same number
    store.set({ params: { bounciness: knob("damping").fromView(0.8) } });
    expect(slider("settle").toView(store.get().params.bounciness)).toBeCloseTo(0.8, 9);
    // a chip brings the preset back for both
    const mochi = MATERIAL_PRESETS[1]!;
    store.set({ preset: mochi.id, params: { ...mochi.params } });
    expect(matchingPreset(store.get().params, MATERIAL_PRESETS)).toBe(mochi.id);
    expect(slider("firm").toView(store.get().params.softness)).toBeCloseTo(1 - mochi.params.softness, 9);
  });

  it("moon gravity and slow motion", () => {
    expect(isMoon(MOON_GRAVITY)).toBe(true);
    expect(isMoon(1)).toBe(false);
    // the Lab shows it in m/s², inside its knob's range
    const g = knob("gravity");
    expect(g.toView(MOON_GRAVITY)).toBeGreaterThanOrEqual(g.min);
    expect(moonGravity(true, { preset: "jelly" }, MATERIAL_PRESETS)).toBe(MOON_GRAVITY);
    // off: back to the picked preset's own gravity (the balloon floats a little)
    expect(moonGravity(false, { preset: "jelly" }, MATERIAL_PRESETS)).toBe(1);
    expect(moonGravity(false, { preset: "balloon" }, MATERIAL_PRESETS)).toBe(0.35);
    expect(isSlow({ paused: false, timeScale: 0.25 })).toBe(true);
    expect(isSlow({ paused: false, timeScale: 0.5 })).toBe(true);
    expect(isSlow({ paused: false, timeScale: 1 })).toBe(false);
  });

  it("back to default", () => {
    const store = createStore(initialState());
    expect(atDefaults(store.get(), MATERIAL_PRESETS)).toBe(true);
    store.set({ params: { gravity: MOON_GRAVITY, regionSoftness: { head: 0.2 } }, playback: { paused: true, timeScale: 0.25 } });
    expect(atDefaults(store.get(), MATERIAL_PRESETS)).toBe(false);
    store.set(defaultsPatch(MATERIAL_PRESETS));
    expect(atDefaults(store.get(), MATERIAL_PRESETS)).toBe(true);
    expect(store.get().params.regionSoftness).toBeUndefined();
  });

  it("describes a slider's position in words", () => {
    const w = { low: "软", mid: "适中", high: "硬" };
    expect(feelWord(0.1, w)).toBe("软");
    expect(feelWord(0.5, w)).toBe("适中");
    expect(feelWord(0.9, w)).toBe("硬");
  });
});
