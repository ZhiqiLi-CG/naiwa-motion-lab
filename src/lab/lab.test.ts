import { describe, expect, it } from "vitest";
import { initialState } from "../store";
import { availability, availabilityNote, serverUrl, type ServerStatus } from "./client";
import { applyChat, applyJob, emptyFeed, metricRows } from "./feed";
import { settleTime, summariseProbe, surfaceDisplacement, type ProbeSample } from "./probe";
import { paramsPatch, readState } from "./tools";

const status = (installed: boolean, loggedIn: boolean): ServerStatus => ({ codex: { installed, version: installed ? "0.155.1" : null, loggedIn, how: loggedIn ? "ChatGPT" : null }, page: false, job: null });

describe("availability", () => {
  it("is ready only with the server up and Codex logged in", () => {
    expect(availability(null).state).toBe("no-server");
    expect(availability(status(false, false)).state).toBe("not-installed");
    expect(availability(status(true, false)).state).toBe("logged-out");
    expect(availability(status(true, true)).state).toBe("ready");
  });
  it("says nothing on the public site without a server, how to start it in development, how to log in", () => {
    expect(availabilityNote({ state: "no-server" }, false)).toBeNull();
    expect(availabilityNote({ state: "no-server" }, true)?.en).toMatch(/node lab\/server\.mjs/);
    expect(availabilityNote(availability(status(true, false)), false)?.zh).toMatch(/codex login/);
    expect(availabilityNote(availability(status(true, true)), false)).toBeNull();
  });
  it("finds the server from ?lab=", () => {
    expect(serverUrl("")).toBe("http://127.0.0.1:5170");
    expect(serverUrl("?lab=5999")).toBe("http://127.0.0.1:5999");
    expect(serverUrl("?lab=http://localhost:6000/")).toBe("http://localhost:6000");
  });
});

describe("feed", () => {
  it("builds a conversation, updating tool lines in place and keeping turns apart", () => {
    let f = emptyFeed();
    f = applyChat(f, { type: "user", text: "poke it" });
    expect(f.busy).toBe(true);
    f = applyChat(f, { type: "tool", id: "item_1", tool: "page", title: "poke region=belly", status: "running", exitCode: null, output: "" });
    f = applyChat(f, { type: "tool", id: "item_1", tool: "page", title: "poke region=belly", status: "done", exitCode: 0, output: "{}" });
    f = applyChat(f, { type: "message", id: "item_2", role: "assistant", text: "Done." });
    f = applyChat(f, { type: "end", ok: true, stopped: false, error: null });
    expect(f.items.map((x) => x.kind)).toEqual(["user", "tool", "assistant"]);
    expect(f.busy).toBe(false);
    // the next turn reuses Codex's item ids
    f = applyChat(f, { type: "user", text: "again" });
    f = applyChat(f, { type: "tool", id: "item_1", tool: "shell", title: "ls", status: "running", exitCode: null, output: "" });
    f = applyChat(f, { type: "end", ok: false, stopped: true, error: null });
    expect(f.items).toHaveLength(5);
    expect(f.items[4]).toMatchObject({ kind: "tool", status: "failed" });
  });
  it("shows a failed turn's error", () => {
    let f = applyChat(emptyFeed(), { type: "user", text: "x" });
    f = applyChat(f, { type: "end", ok: false, stopped: false, error: "quota" });
    expect(f.items.at(-1)).toMatchObject({ kind: "error", text: "quota" });
  });
  it("follows a job to its result", () => {
    let f = applyJob(emptyFeed(), "r1", { type: "start", job: "tune-feel", name: { zh: "优化手感", en: "Tune the feel" }, workdir: ".cache/lab/jobs/r1" });
    f = applyJob(f, "r1", { type: "progress", value: 0.4 });
    f = applyJob(f, "r1", { type: "log", text: "measuring" });
    f = applyJob(f, "r1", { type: "codex", ev: { type: "tool", id: "i", tool: "page", title: "probe", status: "running", exitCode: null, output: "" } });
    f = applyJob(f, "r1", { type: "done", result: { summary: { zh: "好", en: "Good" }, artifacts: [{ kind: "preset", data: { params: { softness: 0.9 } } }] } });
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ kind: "job", status: "done", progress: 1, log: ["measuring"] });
    const job = f.items[0] as Extract<(typeof f.items)[number], { kind: "job" }>;
    expect(job.steps[0]).toMatchObject({ kind: "tool", status: "failed" });
  });
  it("compares metrics, lower is better, peaks neutral", () => {
    const rows = metricRows({ before: { "poke.settle_s": 1.2, "poke.peak_mm": 30, jitter: 1 }, after: { "poke.settle_s": 0.8, "poke.peak_mm": 40, jitter: 1.5, extra: 2 } });
    expect(rows.find((r) => r.key === "poke.settle_s")?.verdict).toBe("better");
    expect(rows.find((r) => r.key === "poke.peak_mm")?.verdict).toBeNull();
    expect(rows.find((r) => r.key === "jitter")?.verdict).toBe("worse");
    expect(rows.find((r) => r.key === "extra")).toMatchObject({ before: null, after: 2, verdict: null });
  });
});

describe("probe", () => {
  it("removes the rigid shift from the surface displacement", () => {
    const ref = new Float32Array([0, 0, 0, 1, 0, 0]);
    expect(surfaceDisplacement(ref, new Float32Array([1, 1, 1, 2, 1, 1]))).toEqual({ mean: 0, max: 0 });
    const d = surfaceDisplacement(ref, new Float32Array([0, 0.2, 0, 1, 0, 0]));
    expect(d.max).toBeCloseTo(0.1);
  });
  it("finds when a signal settles and summarises", () => {
    const s = (t: number, v: number, extra: Partial<ProbeSample> = {}): ProbeSample => ({ t, surfaceMean: v, surfaceMax: 2 * v, ...extra });
    const samples = [s(-0.2, 0), s(-0.1, 0), s(0, 0.01), s(0.1, 0.02), s(0.2, 0.01), s(0.3, 0.004), s(0.4, 0.001), s(0.5, 0.001)];
    expect(settleTime(samples, (x) => x.surfaceMean)).toBeCloseTo(0.3);
    const out = summariseProbe(samples.map((x) => ({ ...x, jitter: 0.001, penetration: 0.002, volume: { body: 0.98 } })));
    expect(out).toMatchObject({ surface_peak_mm: 40, surface_settle_s: 0.3, jitter_rest_mm_s: 1, penetration_mm: 2, volume_err_pct: 2 });
    expect(out.settle_s).toBeUndefined();
  });
});

describe("tools", () => {
  it("patches the physics params, refusing unknown keys", () => {
    const p = initialState().params;
    expect(paramsPatch({ softness: 0.5, regionSoftness: { belly: 1 } }, p)).toMatchObject({ softness: 0.5, regionSoftness: { belly: 1 } });
    const merged = paramsPatch({ regionSoftness: { head: 0.2 } }, { ...p, regionSoftness: { belly: 1 } });
    expect(merged.regionSoftness).toEqual({ belly: 1, head: 0.2 });
    expect(paramsPatch({ replace: true, regionSoftness: { head: 0.2 } }, { ...p, regionSoftness: { belly: 1 } }).regionSoftness).toEqual({ head: 0.2 });
    expect(paramsPatch({ softness: "0.3" }, p).softness).toBe(0.3);
    expect(() => paramsPatch({ wobble: 1 }, p)).toThrow(/unknown parameter/);
    expect(() => paramsPatch({ regionSoftness: { tail: 1 } }, p)).toThrow(/unknown region/);
  });
  it("reads a compact state", () => {
    const s = readState(initialState(), false);
    expect(s).toMatchObject({ mode: "play", simulator: { id: "cpu-constraints" }, simulatorIds: [] });
    expect("simulators" in s).toBe(false);
  });
});
