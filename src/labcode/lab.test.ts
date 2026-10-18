import { beforeAll, describe, expect, it } from "vitest";
import type { PhysicsParams, SimulatorOptions } from "../contracts";
import { registerBuiltins as registerRetargetBuiltins, DEFAULT_RETARGETER } from "../motion/blocks";
import { createRetargetPipeline } from "../motion/core";
import { PROCEDURAL_DANCES } from "../motion/dances";
import { listRetargeters } from "../motion/registry";
import { bindRig } from "../motion/rig";
import { buildTestFrog } from "../motion/testFrog";
import { createFrogSim, initPhysics, listSimulators } from "../sim";
import { createTestRigSpec } from "../sim/testRig";
import { blockSources, learnPage } from "./catalog";
import type { CoreKind } from "./catalog";
import { createLab, LAB_ASSEMBLY, labBlockId, type LabHost } from "./lab";
import { pageSource } from "./loader";
import { memoryStorage } from "./storage";

const PARAMS: PhysicsParams = { softness: 0.5, bounciness: 0.5, gravity: 1, bellySize: 1, stubbornness: 0.8 };
const spec = createTestRigSpec();
const rig = bindRig(buildTestFrog().rig);

function fakeHost() {
  const chosen: Record<CoreKind, SimulatorOptions> = {
    simulator: { id: "cpu-constraints", settings: {} },
    retargeter: { id: DEFAULT_RETARGETER, settings: {} },
  };
  const log: SimulatorOptions[] = [];
  const host: LabHost = {
    current: (k) => chosen[k],
    choose: (k, o) => {
      chosen[k] = o;
      log.push(o);
    },
    spec: () => spec,
    params: () => PARAMS,
    binding: () => rig,
    track: async () => null,
  };
  return { host, chosen, log };
}

async function smoothSource() {
  const all = await blockSources();
  const src = all.find((s) => s.id === "smooth-surface")!;
  return { src, code: await pageSource(src.path) };
}

beforeAll(async () => {
  await initPhysics();
  registerRetargetBuiltins();
});

describe("catalog", () => {
  it("finds the blocks of both cores in the page's sources, and their learning pages", async () => {
    const all = await blockSources();
    expect(all.find((s) => s.id === "flesh-surface")).toMatchObject({ kind: "simulator", slot: "output", path: "sim/blocks/fleshSurface.ts" });
    expect(all.find((s) => s.id === "ccd-ik")).toMatchObject({ kind: "retargeter", slot: "solver", path: "algorithms/motion/ccdSolver.ts" });
    expect(all.find((s) => s.id === "ema-filter")).toMatchObject({ kind: "retargeter", slot: "filter" });
    expect(await learnPage("retargeter", "ccd-ik", "en")).toMatch(/^# CCD/);
    expect(await learnPage("simulator", "flesh-surface", "en")).toBeNull();
  });
});

describe("lab", () => {
  it("loads a forked block, tries it and swaps it into its slot of the running simulator", async () => {
    const { host, chosen } = fakeHost();
    const lab = createLab(host, memoryStorage());
    await lab.ready;
    const { src, code } = await smoothSource();
    const b = lab.fork(src, code.replace("default: 2, min: 0, max: 6", "default: 4, min: 0, max: 6"));
    const r = await lab.apply(b.key);
    expect(r).toEqual({ ok: true });
    expect(chosen.simulator.id).toBe(LAB_ASSEMBLY.simulator);
    const info = listSimulators().find((s) => s.id === LAB_ASSEMBLY.simulator)!;
    expect(info.origin).toBe("user");
    expect(info.parameters.find((p) => p.key === "rounds")?.default).toBe(4);
    // The page builds it as it would any simulator.
    const sim = createFrogSim(spec, PARAMS, chosen.simulator);
    await sim.ready;
    for (let i = 0; i < 10; i++) sim.step(1 / 60);
    expect(sim.readBody().every(Number.isFinite)).toBe(true);
    sim.dispose();
    lab.restore("simulator", "output");
    expect(chosen.simulator.id).toBe("cpu-constraints");
    expect(listSimulators().some((s) => s.id === LAB_ASSEMBLY.simulator)).toBe(false);
  }, 30000);

  it("reports what does not compile, at its place, and changes nothing", async () => {
    const { host, log } = fakeHost();
    const lab = createLab(host, memoryStorage());
    const { src, code } = await smoothSource();
    const bad = code.replace("class SmoothSurface", "enum E { A }\nclass SmoothSurface");
    const b = lab.fork(src, bad);
    const r = await lab.apply(b.key);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.phase).toBe("compile");
    expect(bad.slice(r.error.problems[0].from, r.error.problems[0].to)).toBe("enum E { A }");
    expect(log).toEqual([]);
  });

  it("a block that throws while it is built fails its trial and never reaches the page", async () => {
    const { host, log } = fakeHost();
    const lab = createLab(host, memoryStorage());
    const { src, code } = await smoothSource();
    const bad = code.replace("for (const part of scene.parts) {", "for (const part of scene.parts) {\n      throw new Error(\"broken on purpose\");");
    const b = lab.fork(src, bad);
    const r = await lab.apply(b.key);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.phase).toBe("trial");
    expect(r.error.message).toContain("broken on purpose");
    expect(log).toEqual([]);
    expect(listSimulators().some((s) => s.id === LAB_ASSEMBLY.simulator)).toBe(false);
  }, 30000);

  it("an error while the page runs it falls back to the previous version, then to the built-in block", async () => {
    const { host, chosen } = fakeHost();
    const lab = createLab(host, memoryStorage());
    const { src, code } = await smoothSource();
    const b = lab.fork(src, code);
    expect((await lab.apply(b.key)).ok).toBe(true);
    // Version 2 throws once the page sets a flag (after its trial).
    const flaky = code.replace("read(part: SimPart): Float32Array {", "read(part: SimPart): Float32Array {\n    if ((globalThis as any).__labFail) throw new Error(\"flaky\");");
    lab.save(b.key, flaky);
    expect((await lab.apply(b.key)).ok).toBe(true);
    const events: string[] = [];
    lab.onEvent((e) => e.type === "fallback" && events.push(`fallback:${e.restored}:${e.error.message}`));

    const run = async () => {
      const sim = createFrogSim(spec, PARAMS, chosen.simulator);
      await sim.ready;
      let threw = false;
      try {
        for (let i = 0; i < 3; i++) sim.readBody();
      } catch {
        threw = true;
      }
      sim.dispose();
      await Promise.resolve();
      return threw;
    };
    (globalThis as Record<string, unknown>).__labFail = true;
    try {
      expect(await run()).toBe(true);
      expect(events).toEqual(["fallback:previous-version:Error: flaky"]);
      expect(chosen.simulator.id).toBe(LAB_ASSEMBLY.simulator);
      // Version 1 is back in the slot: it does not read the flag.
      expect(await run()).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).__labFail;
    }

    // A block that fails with no earlier version: the built-in block comes back.
    const c = lab.fork(src, flaky);
    lab.restore("simulator", "output");
    expect((await lab.apply(c.key)).ok).toBe(true);
    (globalThis as Record<string, unknown>).__labFail = true;
    try {
      expect(await run()).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__labFail;
    }
    expect(events[1]).toBe("fallback:previous-block:Error: flaky");
    expect(chosen.simulator.id).toBe("cpu-constraints");
    expect(lab.experiment("simulator")).toBeUndefined();
  }, 60000);

  it("swaps a retargeting block, compares it with the built-in one and restores it after a reload", async () => {
    const { host, chosen } = fakeHost();
    const storage = memoryStorage();
    const lab = createLab(host, storage);
    const src = (await blockSources()).find((s) => s.id === "ema-filter")!;
    const b = lab.fork(src, await pageSource(src.path));
    expect(await lab.apply(b.key)).toEqual({ ok: true });
    expect(chosen.retargeter.id).toBe(LAB_ASSEMBLY.retargeter);
    const info = listRetargeters().find((r) => r.id === LAB_ASSEMBLY.retargeter)!;
    expect(info.parameters.map((p) => p.key)).toContain("alpha");
    const p = createRetargetPipeline(rig, chosen.retargeter);
    const frame = p.pose(PROCEDURAL_DANCES[0].pose(0.5), 1 / 60);
    expect(frame.bones.size ?? Object.keys(frame.bones).length).toBeGreaterThan(0);

    const cmp = await lab.compare(b.key);
    expect(cmp.builtin.id).toBe("one-euro");
    expect(cmp.mine.id).toBe(labBlockId(b.key));
    expect(cmp.mine.rows.map((r) => r.key)).toEqual(["fidelity", "jerk", "penetration", "footSlide"]);
    for (const r of [...cmp.builtin.rows, ...cmp.mine.rows]) expect(Number.isFinite(r.value)).toBe(true);

    // A new page: the saved experiment registers again.
    const again = createLab(fakeHost().host, storage);
    await again.ready;
    expect(listRetargeters().find((r) => r.id === LAB_ASSEMBLY.retargeter)?.origin).toBe("user");
    again.remove(b.key);
    expect(again.blocks()).toEqual([]);
  }, 30000);

  it("compares a simulator block with the built-in one on the same scene", async () => {
    const { host } = fakeHost();
    const lab = createLab(host, memoryStorage());
    const { src, code } = await smoothSource();
    const b = lab.fork(src, code);
    const cmp = await lab.compare(b.key);
    expect(cmp.builtin.id).toBe("flesh-surface");
    expect(cmp.mine.rows.map((r) => r.key)).toContain("deviation");
    for (const r of [...cmp.builtin.rows, ...cmp.mine.rows]) expect(Number.isFinite(r.value), r.key).toBe(true);
    // Not applied: nothing of it stays registered.
    expect(listSimulators().some((s) => s.id === LAB_ASSEMBLY.simulator)).toBe(false);
  }, 60000);
});
