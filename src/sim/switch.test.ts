/**
 * Switching motions on the real frog: every dance from a fresh start, then all of them one after another with the
 * switches the page makes (a gap of idle stance, a transition), quick back-and-forth switches and play <-> dance.
 * The flesh must come through without inverted cells, tangles or lost volume.
 */
import fs from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { BoneName, MotionSource, PhysicsParams } from "../contracts";
import { parseModel } from "../character/asset";
import { createCharacter } from "../character/character";
import { DEFAULT_RETARGETER, registerBuiltins as registerMotion } from "../motion/blocks";
import { createRetargetPipeline } from "../motion/core";
import { PROCEDURAL_DANCES } from "../motion/dances";
import { bindRig } from "../motion/rig";
import { proceduralSource, trackSource } from "../motion/sources";
import type { Track } from "../motion/track";
import { createFrogSim, initPhysics, type LabFrogSim } from ".";
import { untextured } from "./testModel";
import { interpenetration, restInside } from "./testMetrics";

const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
const GLB = new URL("../../public/models/naiwa.glb", import.meta.url);
const TRACKS = (JSON.parse(fs.readFileSync("public/dances/index.json", "utf8")) as { id: string; duration: number }[]);
const DANCES = [...TRACKS.map((t) => t.id), ...PROCEDURAL_DANCES.map((d) => d.id)];

let character: ReturnType<typeof createCharacter> | null = null;
beforeAll(async () => {
  await initPhysics();
  registerMotion();
  if (fs.existsSync(GLB)) character = createCharacter(await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb"), "glb", "models/naiwa.glb");
}, 60000);

/** The page's frame loop around one sim: a motion source (or the idle stance), targets, a step. */
class Page {
  readonly sim: LabFrogSim;
  private source: MotionSource | null = null;
  private targets = new Map<BoneName, THREE.Matrix4>();
  private binding = bindRig(character!.rig);
  /** Worst numbers since the last take(). */
  worst = { inverted: 0, limbs: 0, volume: 0, deviationMax: 0, at: "", inside: 0, legDepth: 0, armDepth: 0 };
  private restInside: Uint8Array[] | null = null;
  label = "";
  steps = 0;

  constructor() {
    this.sim = createFrogSim(character!.spec, PARAMS, { id: "cpu-constraints", settings: {} });
  }

  dance(id: string) {
    const open = () => {
      const p = createRetargetPipeline(this.binding, { id: DEFAULT_RETARGETER, settings: {} });
      return () => p;
    };
    const proc = PROCEDURAL_DANCES.find((d) => d.id === id);
    if (proc) return proceduralSource(proc, open);
    const info = TRACKS.find((t) => t.id === id)!;
    const track = JSON.parse(fs.readFileSync(`public/dances/${id}.json`, "utf8")) as Track;
    const openRec = (rec?: Parameters<typeof createRetargetPipeline>[2]) => {
      const p = createRetargetPipeline(this.binding, { id: DEFAULT_RETARGETER, settings: {} }, rec);
      return () => p;
    };
    return trackSource(Promise.resolve(track), info.duration, openRec, () => {});
  }

  /** What main.switchMotion does: mode first, then the new source and a transition. */
  async switchTo(mode: "dance" | "play", id?: string) {
    this.source = null;
    this.sim.setMode(mode === "play" ? "free" : "driven");
    if (mode === "dance") {
      this.source = this.dance(id!);
      await Promise.resolve(); // a track resolves its promise
      this.sim.transition();
    }
    this.label = mode === "dance" ? id! : "play";
  }

  run(seconds: number) {
    const dt = 1 / 60;
    for (let k = 0; k < Math.round(seconds / dt); k++) {
      const pose = this.source ? this.source.update(0, dt) : null;
      character!.targetsFromPose(pose, this.targets);
      this.sim.setTargets(this.targets, pose?.contacts);
      this.sim.step(dt);
      this.steps++;
      if (this.steps % 3 === 0) {
        const s = this.sim.stats();
        const vol = Math.abs(s.volume!.body - 1);
        const body = invertedIn(this.sim, this.sim.scene.parts[0]);
        if (body > this.worst.inverted) this.worst.at = `${this.label} @${(k * dt).toFixed(2)}s`;
        this.worst.inverted = Math.max(this.worst.inverted, body);
        this.worst.limbs = Math.max(this.worst.limbs, s.invertedCells! - body);
        this.worst.volume = Math.max(this.worst.volume, vol);
        this.worst.deviationMax = Math.max(this.worst.deviationMax, s.deviationMax!);
        this.worst.inside = Math.max(this.worst.inside, limbsInside(this.sim));
      }
      if (this.steps % 120 === 0) {
        // The e2e's measure: limb flesh outside the Body at rest that is now inside it (deepest, m).
        const r = interpenetration(this.sim, (this.restInside ??= restInside(this.sim)));
        this.worst.legDepth = Math.max(this.worst.legDepth, r.per.leg?.maxDepth ?? 0, r.per.foot?.maxDepth ?? 0);
        this.worst.armDepth = Math.max(this.worst.armDepth, r.per.arm?.maxDepth ?? 0, r.per.hand?.maxDepth ?? 0);
      }
    }
  }

  take() {
    const w = this.worst;
    this.worst = { inverted: 0, limbs: 0, volume: 0, deviationMax: 0, at: "", inside: 0, legDepth: 0, armDepth: 0 };
    return { legDepth: Number(w.legDepth.toFixed(3)), armDepth: Number(w.armDepth.toFixed(3)), inverted: w.inverted, limbs: w.limbs, volume: Number(w.volume.toFixed(3)), deviationMax: Number(w.deviationMax.toFixed(3)), inside: w.inside, at: w.at };
  }
}

type Worst = ReturnType<Page["take"]>;

/** Through every stretch: the Body's cells stay right side out (a stray one or two at most), its volume within 4%,
 *  no hand or foot ends up inside it, and the legs' flesh stays out of it (the e2e's measure, within 3 cm). (A limb's carried lattice folds at a sharply bent joint, as it did solved.) */
function expectSound(takes: Worst[]) {
  expect(Math.max(...takes.map((w) => w.inverted))).toBeLessThanOrEqual(3);
  expect(Math.max(...takes.map((w) => w.volume))).toBeLessThan(0.03);
  expect(Math.max(...takes.map((w) => w.inside))).toBe(0);
  // Legs: the belly rests on the thighs (up to 6-11 cm inside them before the legs had contact shapes).
  expect(Math.max(...takes.map((w) => w.legDepth))).toBeLessThan(0.03);
}

/** Cells of a part turned inside out. */
function invertedIn(sim: LabFrogSim, part: LabFrogSim["scene"]["parts"][number]): number {
  const cells = sim.scene.flesh.cells!(part), view = sim.scene.flesh.particles(part), P = view.positions(), R = view.rest;
  const vol = (X: Float32Array, c: number) => {
    const a = cells[c] * 3, b = cells[c + 1] * 3, d = cells[c + 2] * 3, e = cells[c + 3] * 3;
    const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2];
    const vx = X[d] - X[a], vy = X[d + 1] - X[a + 1], vz = X[d + 2] - X[a + 2];
    const wx = X[e] - X[a], wy = X[e + 1] - X[a + 1], wz = X[e + 2] - X[a + 2];
    return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
  };
  let n = 0;
  for (let c = 0; c < cells.length; c += 4) if (vol(R, c) * vol(P, c) < 0) n++;
  return n;
}

/** Hands, wrists and feet (bone ends) that are inside the Body's surface: a limb pushed through the belly. */
function limbsInside(sim: LabFrogSim): number {
  const part = sim.scene.parts[0], S = sim.readBody(), I = part.indices;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3(), m = new THREE.Matrix4();
  let inside = 0;
  for (const bone of sim.scene.skeleton.bones.values()) {
    if (!/hand|forearm|foot|shin/.test(bone.name)) continue;
    const p = bone.tail.clone().applyMatrix4(bone.restInverse).applyMatrix4(bone.pose(m));
    const ray = new THREE.Ray(p, new THREE.Vector3(0.3, 1, 0.2).normalize());
    let n = 0;
    for (let t = 0; t < I.length; t += 3) {
      if (ray.intersectTriangle(a.fromArray(S, I[t] * 3), b.fromArray(S, I[t + 1] * 3), c.fromArray(S, I[t + 2] * 3), false, hit)) n++;
    }
    if (n % 2) inside++;
  }
  return inside;
}

describe.skipIf(!fs.existsSync(GLB))("switching motions, the real frog", () => {
  it("each dance from a fresh start", async () => {
    const out: Record<string, unknown> = {};
    for (const id of DANCES) {
      const page = new Page();
      await page.sim.ready;
      await page.switchTo("dance", id);
      page.run(3);
      out[id] = page.take();
      page.sim.dispose();
    }
    console.log("fresh:", out);
    expectSound(Object.values(out) as Worst[]);
  }, 300000);

  it("all dances in a row with switches, back-and-forth, play <-> dance", async () => {
    const page = new Page();
    await page.sim.ready;
    const log: string[] = [], takes: Worst[] = [];
    const seg = (s: number) => {
      page.run(s);
      const w = page.take();
      takes.push(w);
      log.push(`${page.label.padEnd(12)} ${JSON.stringify(w)}`);
      return w;
    };
    await page.switchTo("dance", "naenae");
    seg(3);
    for (const id of DANCES) {
      await page.switchTo("dance", id);
      seg(3);
    }
    for (const id of ["frog-hop", "gouxiong", "frog-hop", "peace", "kemusan"]) {
      await page.switchTo("dance", id);
      seg(0.3);
    }
    await page.switchTo("play");
    seg(0.3);
    await page.switchTo("dance", "peace");
    seg(0.15);
    await page.switchTo("play");
    seg(3);
    await page.switchTo("dance", "naenae");
    seg(3);
    console.log(log.join("\n"));
    expectSound(takes);
    page.sim.dispose();
  }, 300000);

  it("the page's sequence: frog-hop mid-air -> play -> peace", async () => {
    const page = new Page();
    await page.sim.ready;
    const log: string[] = [], takes: Worst[] = [];
    const seg = (s: number) => {
      page.run(s);
      const w = page.take();
      takes.push(w);
      log.push(`${page.label.padEnd(12)} ${s}s ${JSON.stringify(w)}`);
      return w;
    };
    await page.switchTo("dance", "naenae");
    seg(3);
    for (const id of ["gouxiong", "belly-laugh", "kemusan", "frog-hop"]) {
      await page.switchTo("dance", id);
      seg(id === "frog-hop" ? 0.85 : 2.3);
    }
    await page.switchTo("play");
    seg(0.3);
    await page.switchTo("dance", "peace");
    seg(0.15);
    seg(1);
    seg(3);
    seg(3);
    console.log(log.join("\n"));
    expectSound(takes);
    page.sim.dispose();
  }, 300000);
});
