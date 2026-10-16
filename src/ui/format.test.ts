import { describe, expect, it } from "vitest";
import { MATERIAL_PRESETS } from "../store";
import { formatClock, formatDuration, formatParam, matchingPreset, resolveTheme } from "./format";

describe("format", () => {
  it("clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7400)).toBe("0:07");
    expect(formatClock(754_000)).toBe("12:34");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-50)).toBe("0:00");
  });
  it("duration", () => {
    expect(formatDuration(300)).toBe("1 秒");
    expect(formatDuration(12_400)).toBe("12 秒");
    expect(formatDuration(65_000)).toBe("1 分 05 秒");
  });
  it("param values", () => {
    expect(formatParam("softness", 0.854)).toBe("85%");
    expect(formatParam("gravity", 1)).toBe("1.0 g");
    expect(formatParam("gravity", 0.35)).toBe("0.35 g");
    expect(formatParam("bellySize", 1.35)).toBe("×1.35");
  });
  it("preset match", () => {
    const jelly = MATERIAL_PRESETS[0]!;
    expect(matchingPreset({ ...jelly.params }, MATERIAL_PRESETS)).toBe(jelly.id);
    expect(matchingPreset({ ...jelly.params, softness: 0.5 }, MATERIAL_PRESETS)).toBeNull();
  });
  it("theme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
