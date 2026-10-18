/**
 * The pipeline against the code it replaced: fixtures/golden.json holds joint positions and faces of the test frog
 * recorded with the pre-pipeline retargeting (Retargeter + rig.solve, commit 7e92ed6) for every procedural dance,
 * every dance track (one also mirrored), a live run (One Euro on noisy landmarks) and an analysed video (zero-phase
 * smoothing of noisy landmarks). The same inputs through the default retargeter must give the same poses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PoseFrame } from "../contracts";
import type { Slot } from "./api";
import { DEFAULT_RETARGETER, registerBuiltins } from "./blocks";
import { createRetargetPipeline } from "./core";
import { PROCEDURAL_DANCES } from "./dances";
import { idlePose } from "./pose";
import { plantedRotations } from "./blocks/plantedRotations";
import { listRetargeters, registerRetargetBlock, registerRetargeter, resolve } from "./registry";
import { bindRig, jointPositions } from "./rig";
import { buildTestFrog } from "./testFrog";
import { recordingOf, TrackPlayer, type Track } from "./track";

registerBuiltins();
const b = bindRig(buildTestFrog().rig);
const options = { id: DEFAULT_RETARGETER, settings: {} };
const listBlocksOf = (id: string) => {
  const r = resolve({ id, settings: {} });
  return Object.fromEntries([...r].map(([slot, x]) => [slot, x.def.id])) as Record<Slot, string>;
};
type Golden = { j: Record<string, number[]>; e: Record<string, number> } | null;
const golden = JSON.parse(readFileSync("src/motion/fixtures/golden.json", "utf8")) as Record<string, Golden[]>;
const track = (id: string) => JSON.parse(readFileSync(`public/dances/${id}.json`, "utf8")) as Track;
const ids = (JSON.parse(readFileSync("public/dances/index.json", "utf8")) as { id: string }[]).map((e) => e.id);

/** The same noise the fixture was recorded with. */
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
const noisy = (t: Track) =>
  t.frames.map((f) => ({
    world: f.world.map((p) => [p[0] + rnd() * 0.02, p[1] + rnd() * 0.02, p[2] + rnd() * 0.02, p[3]]),
    image: f.image.map((p) => [p[0] + rnd() * 0.01, p[1] + rnd() * 0.01, p[2], p[3]]),
  }));

/** Largest joint distance (m) and face weight difference from the golden frames. */
function compare(frames: (PoseFrame | null)[], want: Golden[]) {
  expect(frames.length).toBe(want.length);
  let joint = 0, face = 0;
  frames.forEach((f, i) => {
    const g = want[i];
    expect(f === null).toBe(g === null);
    if (!f || !g) return;
    for (const [n, p] of jointPositions(b, f)) joint = Math.max(joint, Math.hypot(p.x - g.j[n][0], p.y - g.j[n][1], p.z - g.j[n][2]));
    for (const k of new Set([...Object.keys(g.e), ...Object.keys(f.expressions ?? {})])) {
      face = Math.max(face, Math.abs(((f.expressions as Record<string, number>)?.[k] ?? 0) - (g.e[k] ?? 0)));
    }
  });
  return { joint, face };
}
const TOLERANCE = { joint: 1e-3, face: 1e-3 };

describe("the default retargeter reproduces the pre-pipeline poses", () => {
  for (const d of PROCEDURAL_DANCES) {
    it(`procedural ${d.id}`, () => {
      const p = createRetargetPipeline(b, options);
      const r = compare(Array.from({ length: 12 }, (_, k) => p.pose(d.pose((k * d.duration) / 12), 1 / 30)), golden[`procedural:${d.id}`]);
      expect(r.joint).toBeLessThan(TOLERANCE.joint);
      expect(r.face).toBeLessThan(TOLERANCE.face);
    });
  }

  for (const id of ids) {
    for (const mirror of id === "gouxiong" ? [false, true] : [false]) {
      it(`track ${id}${mirror ? " mirrored" : ""}`, () => {
        const t = track(id);
        const p = createRetargetPipeline(b, options, recordingOf(t));
        const player = new TrackPlayer(t, () => p);
        const out: (PoseFrame | null)[] = [];
        for (let i = 0; i < Math.ceil((t.duration + 0.5) * 30); i++) {
          const g = player.goal(i / 30, 1 / 30, mirror);
          if (i % 5 === 0) out.push(g && p.pose(g, 1 / 30));
        }
        const r = compare(out, golden[`track:${id}${mirror ? ":mirror" : ""}`]);
        expect(r.joint).toBeLessThan(TOLERANCE.joint);
        expect(r.face).toBeLessThan(TOLERANCE.face);
      });
    }
  }

  it("live: One Euro on noisy landmarks", () => {
    seed = 1;
    const t = track("gouxiong");
    const frames = noisy(t);
    const p = createRetargetPipeline(b, options);
    const out: (PoseFrame | null)[] = [];
    frames.forEach((f, i) => {
      const g = p.live({ ...f, aspect: t.aspect ?? 1 }, i / 30, 1 / 30, false);
      if (i % 5 === 0) out.push(g && p.pose(g, 1 / 30));
    });
    const r = compare(out, golden["live:gouxiong"]);
    expect(r.joint).toBeLessThan(TOLERANCE.joint);
  });

  it("recorded: zero-phase smoothing of noisy landmarks", () => {
    seed = 2;
    const t = track("naenae");
    const filtered = createRetargetPipeline(b, options).recorded(noisy(t).map((f) => ({ ...f, aspect: 1 })), t.fps);
    const smoothed: Track = { ...t, frames: filtered };
    const p = createRetargetPipeline(b, options, recordingOf(smoothed));
    const player = new TrackPlayer(smoothed, () => p);
    const out: (PoseFrame | null)[] = [];
    for (let i = 0; i < t.frames.length; i++) {
      const g = player.goal(i / t.fps, 1 / t.fps, false);
      if (i % 5 === 0) out.push(g && p.pose(g, 1 / t.fps));
    }
    const r = compare(out, golden["recorded:naenae"]);
    expect(r.joint).toBeLessThan(TOLERANCE.joint);
  });
});

describe("registry and settings", () => {
  it("lists the default retargeter with every block's parameters, units and both languages", () => {
    const info = listRetargeters().find((r) => r.id === DEFAULT_RETARGETER)!;
    expect(info.unavailable).toBeNull();
    const keys = info.parameters.map((p) => p.key);
    for (const k of ["cutoff", "beta", "margin", "elbowLimit", "iterations"]) expect(keys).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of info.parameters) expect(p.label.zh && p.label.en).toBeTruthy();
  });

  it("applies settings live, and a block swapped by slot changes the result", () => {
    const p = createRetargetPipeline(b, options);
    expect(p.setSettings({ margin: 0.03 })).toBe(true);
    // Arms hanging at rest lie against the belly: a wider margin moves them out.
    const goal = idlePose();
    const tight = jointPositions(b, p.pose(goal, 0));
    const loose = jointPositions(b, createRetargetPipeline(b, options).pose(goal, 0));
    expect(Math.max(...[...tight].map(([n, q]) => q.distanceTo(loose.get(n)!)))).toBeGreaterThan(1e-3);

  });

  it("swaps a user's block in by slot, and lists a user's retargeter", () => {
    // A user's output block: the built-in one, lifted by 10 cm.
    const removeBlock = registerRetargetBlock({
      id: "test-lift", slot: "output", name: { zh: "抬高", en: "Lift" }, summary: { zh: "", en: "" }, parameters: [],
      create: (scene, settings) => {
        const inner = plantedRotations.create(scene, settings);
        return { pose: (frog, dt) => ((f) => (f.rootOffset!.y += 0.1, f))(inner.pose(frog, dt)) };
      },
    });
    const removeAssembly = registerRetargeter({ id: "test", name: { zh: "测试", en: "Test" }, summary: { zh: "", en: "" }, blocks: { ...listBlocksOf(DEFAULT_RETARGETER), output: "test-lift" } });
    const goal = PROCEDURAL_DANCES[0].pose(0.2);
    const base = createRetargetPipeline(b, options).pose(goal, 0);
    const swapped = createRetargetPipeline(b, { ...options, blocks: { output: "test-lift" } }).pose(goal, 0);
    const user = createRetargetPipeline(b, { id: "test", settings: {} }).pose(goal, 0);
    expect(swapped.rootOffset!.y - base.rootOffset!.y).toBeCloseTo(0.1, 6);
    expect(user.rootOffset!.y - base.rootOffset!.y).toBeCloseTo(0.1, 6);
    expect(listRetargeters().map((r) => r.id)).toContain("test");
    removeAssembly();
    removeBlock();
    expect(listRetargeters().map((r) => r.id)).not.toContain("test");
  });

  it("measures smoothness, penetration and foot sliding", () => {
    const p = createRetargetPipeline(b, options);
    const d = PROCEDURAL_DANCES.find((x) => x.id === "wiggle")!;
    for (let t = 0; t < 2; t += 1 / 60) p.pose(d.pose(t % d.duration), 1 / 60);
    const m = p.metrics()!;
    expect(m.penetration).toBeLessThan(0.01);
    expect(m.jerk).toBeGreaterThan(0);
    expect(Number.isFinite(m.fidelity) && Number.isFinite(m.footSlide)).toBe(true);
    // A still pose: nothing moves.
    const still = createRetargetPipeline(b, options);
    for (let i = 0; i < 30; i++) still.pose(idlePose(), 1 / 60);
    expect(still.metrics()!.jerk).toBeLessThan(1e-6);
    expect(still.metrics()!.footSlide).toBeLessThan(1e-6);
  });
});
