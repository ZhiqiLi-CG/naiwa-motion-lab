import { beforeAll, expect, it } from "vitest";
import type { PhysicsParams } from "../../contracts";
import { createFrogSim, initPhysics, listSimulators } from "..";
import { createTestRigSpec } from "../testRig";
import { registerSmoothExample } from "./smoothSurface";

const PARAMS: PhysicsParams = { softness: 0.5, bounciness: 0.5, gravity: 1, bellySize: 1, stubbornness: 0.8 };

beforeAll(() => initPhysics());

it("the docs' example block runs, swapped in by slot and as its own simulator", async () => {
  const remove = registerSmoothExample();
  expect(listSimulators().map((s) => s.id)).toContain("cpu-constraints-smooth");
  const spec = createTestRigSpec();
  const swapped = createFrogSim(spec, PARAMS, { id: "cpu-constraints", settings: { rounds: 3 }, blocks: { output: "smooth-surface" } });
  const own = createFrogSim(spec, PARAMS, { id: "cpu-constraints-smooth", settings: {} });
  await Promise.all([swapped.ready, own.ready]);
  for (let k = 0; k < 30; k++) {
    swapped.step(1 / 60);
    own.step(1 / 60);
  }
  for (const sim of [swapped, own]) {
    const body = sim.readBody();
    expect(body.length).toBe(spec.body.positions.length);
    expect(body.every(Number.isFinite)).toBe(true);
    sim.dispose();
  }
  remove();
  expect(listSimulators().map((s) => s.id)).not.toContain("cpu-constraints-smooth");
});
