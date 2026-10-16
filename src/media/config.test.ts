import { describe, expect, it } from "vitest";
import { decodeConfig, encodeConfig, type ConfigState } from "./config";
import { MATERIAL_PRESETS, initialState } from "../store";

const state = (patch: Partial<ConfigState> = {}): ConfigState => ({ ...initialState(), ...patch });

describe("encodeConfig / decodeConfig", () => {
  it("round-trips every field", () => {
    const s = state({
      mode: "dance",
      tool: "pump",
      preset: "balloon",
      params: { softness: 0.6, bounciness: 0.85, gravity: 0.35, bellySize: 1.35, stubbornness: 0.8 },
      dance: "belly-laugh",
      mirror: false,
    });
    const hash = encodeConfig(s);
    expect(hash).toBe("#v=1&m=dance&t=pump&p=balloon&k=60.85.35.135.80&d=belly-laugh&r=0");
    expect(decodeConfig(hash)).toEqual({
      mode: s.mode,
      tool: s.tool,
      preset: s.preset,
      params: s.params,
      dance: s.dance,
      mirror: s.mirror,
    });
  });

  it("is short", () => {
    expect(encodeConfig(state()).length).toBeLessThan(80);
  });

  it("round-trips params to 0.01", () => {
    const params = { softness: 0.333, bounciness: 0.006, gravity: 2.718, bellySize: 0.5, stubbornness: 1 };
    const back = decodeConfig(encodeConfig(state({ params }))).params!;
    for (const k of Object.keys(params) as (keyof typeof params)[]) expect(back[k]).toBeCloseTo(params[k], 2);
  });

  it("reads hashes with or without # and whole URLs", () => {
    const hash = encodeConfig(state({ tool: "ball" }));
    expect(decodeConfig(hash.slice(1)).tool).toBe("ball");
    expect(decodeConfig(`https://example.com/naiwa/?x=1${hash}`).tool).toBe("ball");
    expect(decodeConfig("%23v%3D1").tool).toBeUndefined();
  });

  it("opens video links in play mode (the video is not in the link)", () => {
    expect(decodeConfig(encodeConfig(state({ mode: "video" }))).mode).toBe("play");
    expect(decodeConfig("#m=video").mode).toBe("play");
  });

  it("returns nothing for garbage", () => {
    for (const g of ["", "#", "#about", "#%E0%A4%A", "#m=fly&t=laser&p=steel&d=<script>&r=yes", "#&&&==&", "#k=", "#k=a.b.c"]) {
      expect(decodeConfig(g)).toEqual({});
    }
    expect(decodeConfig("#" + "x".repeat(100_000))).toEqual({});
  });

  it("keeps the valid parts of a damaged link", () => {
    const d = decodeConfig("#v=1&m=camera&t=nope&p=mochi&k=50.zz.&d=wave&r=1");
    expect(d.mode).toBe("camera");
    expect(d.tool).toBeUndefined();
    expect(d.preset).toBe("mochi");
    expect(d.dance).toBe("wave");
    expect(d.mirror).toBe(true);
    // Unreadable params come from the link's preset.
    const mochi = MATERIAL_PRESETS.find((p) => p.id === "mochi")!.params;
    expect(d.params).toEqual({ ...mochi, softness: 0.5 });
  });

  it("clamps out-of-range params", () => {
    const p = decodeConfig("#k=9999.-50.900.1.100").params!;
    expect(p.softness).toBe(1);
    expect(p.bounciness).toBe(0);
    expect(p.gravity).toBe(4);
    expect(p.bellySize).toBe(0.5);
    expect(p.stubbornness).toBe(1);
  });

  it("reads old links (no version, fewer params) and future ones (more params, unknown keys)", () => {
    const old = decodeConfig("#m=dance&k=40.30&d=belly-laugh");
    expect(old.mode).toBe("dance");
    expect(old.params).toEqual({ ...initialState().params, softness: 0.4, bounciness: 0.3 });
    const future = decodeConfig("#v=7&m=play&k=10.20.100.100.50.77.88&zz=3&t=feather");
    expect(future.tool).toBe("feather");
    expect(future.params?.softness).toBe(0.1);
    expect(Object.keys(future.params!)).toHaveLength(5);
  });

  it("takes a preset's params when the link has a preset but no k", () => {
    const d = decodeConfig("#p=rubber");
    expect(d.params).toEqual(MATERIAL_PRESETS.find((p) => p.id === "rubber")!.params);
  });
});
