import { describe, expect, it } from "vitest";
import { MATERIAL_PRESETS } from "../store";
import { KNOBS, REGION_GROUPS, SHORTCUT_KEYS, STRINGS, copy, formatDuration, isText } from "./copy";
import { formatClock, formatCount, formatMs, formatValue, matchingPreset, resolveTheme } from "./format";
import { danceNameFrom } from "./motion";
import { groupValue, withGroup } from "./simulation";

describe("format", () => {
  it("clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7400)).toBe("0:07");
    expect(formatClock(754_000)).toBe("12:34");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-50)).toBe("0:00");
  });
  it("duration in both languages", () => {
    expect(formatDuration(300, "zh")).toBe("1 秒");
    expect(formatDuration(12_400, "zh")).toBe("12 秒");
    expect(formatDuration(65_000, "zh")).toBe("1 分 05 秒");
    expect(formatDuration(12_400, "en")).toBe("12 s");
    expect(formatDuration(65_000, "en")).toBe("1 min 05 s");
  });
  it("values with units and readouts", () => {
    expect(formatValue(0.854, 2, "")).toBe("0.85");
    expect(formatValue(9.81, 2, "m/s²")).toBe("9.81 m/s²");
    expect(formatValue(1.35, 2, "×")).toBe("1.35×");
    expect(formatCount(12345.4)).toBe("12,345");
    expect(formatMs(2.14)).toBe("2.1");
    expect(formatMs(16.6)).toBe("17");
  });
  it("knobs round-trip between stored and shown values", () => {
    for (const k of KNOBS) for (const v of [0.2, 0.5, 1]) expect(k.fromView(k.toView(v))).toBeCloseTo(v, 9);
    expect(KNOBS.find((k) => k.id === "gravity")!.toView(1)).toBeCloseTo(9.81);
    expect(KNOBS.find((k) => k.id === "damping")!.toView(0.65)).toBeCloseTo(0.35);
  });
  it("preset match ignores per-region softness", () => {
    const jelly = MATERIAL_PRESETS[0]!;
    expect(matchingPreset({ ...jelly.params }, MATERIAL_PRESETS)).toBe(jelly.id);
    expect(matchingPreset({ ...jelly.params, regionSoftness: { head: 0.2 } }, MATERIAL_PRESETS)).toBe(jelly.id);
    expect(matchingPreset({ ...jelly.params, softness: 0.5 }, MATERIAL_PRESETS)).toBeNull();
  });
  it("theme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("regions", () => {
  const belly = REGION_GROUPS.find((g) => g.id === "belly")!;
  it("a group writes all its regions and keeps the others", () => {
    expect(withGroup(belly, 0.3, { head: 0.2 })).toEqual({ head: 0.2, belly: 0.3, body: 0.3 });
    expect(withGroup(belly, 0.3, undefined)).toEqual({ belly: 0.3, body: 0.3 });
  });
  it("a group untouched reads as default", () => {
    expect(groupValue(belly, undefined)).toBeNull();
    expect(groupValue(belly, { belly: 0.4, body: 0.4 })).toBe(0.4);
  });
});

describe("copy", () => {
  // every string the UI shows exists in both languages
  const leaves = (v: unknown, path: string): [string, unknown][] =>
    isText(v)
      ? [[path, v]]
      : typeof v === "function"
        ? [[`${path}()`, (v as (...a: unknown[]) => unknown)(1)]]
        : v && typeof v === "object"
          ? Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}.${k}`))
          : [[path, null]];
  it("every string has 中文 and English", () => {
    for (const [path, text] of leaves(STRINGS, "")) {
      expect(isText(text), path).toBe(true);
      expect((text as { zh: string }).zh.length, path).toBeGreaterThan(0);
      expect((text as { en: string }).en.length, path).toBeGreaterThan(0);
    }
  });
  it("copy() resolves to one language", () => {
    expect(copy("zh").lab).toBe("实验室");
    expect(copy("en").lab).toBe("Lab");
    expect(copy("en").dance.loop(1.5)).toBe("1.5 s loop");
  });
  it("every shortcut is described", () => {
    expect(copy("zh").shortcuts.length).toBe(SHORTCUT_KEYS.length);
  });
  it("a dance name from a file name", () => {
    expect(danceNameFrom("my dance.final.mp4")).toBe("my dance.final");
    expect(danceNameFrom("一二三四五六七八九十一二三四五六七八.mov")).toHaveLength(16);
  });
});
