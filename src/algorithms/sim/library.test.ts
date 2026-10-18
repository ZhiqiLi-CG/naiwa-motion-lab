import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import type { PhysicsParams } from "../../contracts";
import { createFrogSim, initPhysics, listSimulators, type ParticleView } from "../../sim";
import { createTestRigSpec } from "../../sim/testRig";
import { SIM_LIBRARY_SIMULATORS, registerSimLibrary } from ".";
import { bent } from "./testSupport";

const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };

beforeAll(async () => {
  await initPhysics();
  registerSimLibrary();
});

it("registers its simulators with their blocks' parameters, and removes them again", () => {
  const ids = SIM_LIBRARY_SIMULATORS.map((s) => s.id);
  const listed = listSimulators().filter((s) => ids.includes(s.id));
  expect(listed.length).toBe(ids.length);
  for (const s of listed) {
    expect(s.unavailable).toBeNull();
    const keys = s.parameters.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  }
  const remove = registerSimLibrary();
  remove();
  expect(listSimulators().some((s) => ids.includes(s.id))).toBe(false);
  registerSimLibrary();
});

describe.each(SIM_LIBRARY_SIMULATORS.map((s) => s.id))("%s on the test rig", (id) => {
  it("follows a bend, keeps a finite surface and its volume", async () => {
    const spec = createTestRigSpec();
    const sim = createFrogSim(spec, PARAMS, { id, settings: {} });
    await sim.ready;
    sim.setMode("driven");
    sim.setTargets(bent(spec, { spine: 20, chest: 20 }));
    for (let k = 0; k < 90; k++) sim.step(1 / 60);
    const body = sim.readBody();
    expect(body.length).toBe(spec.body.positions.length);
    expect(body.every(Number.isFinite)).toBe(true);
    const s = sim.stats();
    expect(Math.abs(s.volume!.body - 1)).toBeLessThan(0.2);
    expect(s.deviation!).toBeLessThan(0.08);
    sim.dispose();
  }, 30000);

  it("is two-way: a push on the belly moves the bones, and the frog gains the push's momentum", async () => {
    const spec = createTestRigSpec();
    // Twin frogs without gravity (the floor then exchanges little momentum with them); only one is pushed.
    const twins = [0, 1].map(() => createFrogSim(spec, { ...PARAMS, gravity: 0 }, { id, settings: {} }));
    await Promise.all(twins.map((t) => t.ready));
    for (const t of twins) {
      t.setMode("free");
      t.step(1 / 60);
    }
    const pushed = push(twins[1].scene.flesh.particles(twins[1].scene.parts[0]), new THREE.Vector3(0, 0.45, 0.15), new THREE.Vector3(0, 0, 2), 0.2);
    for (let k = 0; k < 30; k++) for (const t of twins) t.step(1 / 60);
    const gained = twins[1].stats().momentum![2] - twins[0].stats().momentum![2];
    const bones = twins[1].scene.skeleton.velocity().z - twins[0].scene.skeleton.velocity().z;
    expect(bones).toBeGreaterThan(0.01);
    expect(gained).toBeGreaterThan(0.7 * pushed);
    expect(gained).toBeLessThan(1.2 * pushed);
    for (const t of twins) t.dispose();
  }, 30000);
});

/** Push the free flesh as the page's poke does (the interaction block): dv faded over the radius. Returns the
 *  momentum given (kg·m/s). */
function push(view: ParticleView, point: THREE.Vector3, dv: THREE.Vector3, radius: number): number {
  const P = view.positions();
  let total = 0;
  for (let i = 0; i < view.count; i++) {
    if (view.attachedTo(i)) continue;
    const d = Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) / radius;
    if (d >= 1) continue;
    const m = view.mass(i) * (1 - d * d) ** 2;
    view.applyImpulse(i, dv.x * m, dv.y * m, dv.z * m);
    total += m * dv.length();
  }
  return total;
}
