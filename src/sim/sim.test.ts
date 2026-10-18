import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { BoneName, PhysicsParams } from "../contracts";
import { createFrogSim, initPhysics, listSimulators } from ".";
import { createTestRigSpec } from "./testRig";

const PARAMS: PhysicsParams = { softness: 0.5, bounciness: 0.5, gravity: 1, bellySize: 1, stubbornness: 0.8 };

beforeAll(() => initPhysics());

async function frog(mode: "free" | "driven") {
  const sim = createFrogSim(createTestRigSpec(), PARAMS, { id: "cpu-constraints", settings: {} });
  await sim.ready;
  sim.setMode(mode);
  return sim;
}

const headHeight = (bones: Map<BoneName, THREE.Matrix4>) => new THREE.Vector3().setFromMatrixPosition(bones.get("head")!).y;

describe("cpu-constraints", () => {
  it("is registered with its blocks' parameters", () => {
    const info = listSimulators().find((s) => s.id === "cpu-constraints");
    expect(info?.unavailable).toBeNull();
    expect(info?.parameters.map((p) => p.key)).toContain("cellModel");
  });

  it("stands upright in free mode and keeps its volume", async () => {
    const sim = await frog("free");
    const bones = new Map<BoneName, THREE.Matrix4>();
    sim.readBones(bones);
    const start = headHeight(bones);
    for (let k = 0; k < 180; k++) sim.step(1 / 60);
    sim.readBones(bones);
    const s = sim.stats();
    console.log("free 3 s:", { head: [start, headHeight(bones)], ...s, volume: s.volume });
    expect(sim.readBody().every(Number.isFinite)).toBe(true);
    expect(headHeight(bones)).toBeGreaterThan(0.8 * start);
    expect(s.volumeRatio).toBeGreaterThan(0.9);
    expect(s.volumeRatio).toBeLessThan(1.1);
    sim.dispose();
  });

  it("follows pose targets in driven mode", async () => {
    const sim = await frog("driven");
    const spec = createTestRigSpec();
    const targets = new Map<BoneName, THREE.Matrix4>(spec.bones.map((b) => [b.name, b.restWorld.clone()]));
    sim.setTargets(targets);
    for (let k = 0; k < 120; k++) sim.step(1 / 60);
    const bones = new Map<BoneName, THREE.Matrix4>();
    sim.readBones(bones);
    const want = new THREE.Vector3().setFromMatrixPosition(targets.get("chest")!);
    const got = new THREE.Vector3().setFromMatrixPosition(bones.get("chest")!);
    expect(got.distanceTo(want)).toBeLessThan(0.01);
    expect(sim.stats().invertedCells).toBe(0);
    sim.dispose();
  });
});
