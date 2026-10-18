/**
 * The comparison table of docs/learn/sim-index.md: every simulator of the library and the built-in CPU example through
 * the same harness (bench.ts) on naiwa.glb, at their default settings, plus the FEM materials and the explicit and
 * semi-implicit mass–spring. Prints the table as Markdown. Checks only what every one of them must do; the numbers
 * are for the pages.
 */
import fs from "node:fs";
import { beforeAll, expect, it } from "vitest";
import { initPhysics } from "../../sim";
import { registerSimLibrary } from ".";
import { measureSimulator, tableRow, TABLE_HEAD, type BenchOptions, type SimRun } from "./bench";
import { GLB, loadFrog } from "./testSupport";

beforeAll(async () => {
  await initPhysics();
  registerSimLibrary();
});

const ROWS: [string, BenchOptions][] = [
  ["cpu-constraints (built-in)", { id: "cpu-constraints", settings: {} }],
  ["mass-spring, explicit", { id: "mass-spring", settings: {} }],
  ["mass-spring, semi-implicit", { id: "mass-spring", settings: { integrator: "semi-implicit" } }],
  ["pbd", { id: "pbd", settings: {} }],
  ["xpbd", { id: "xpbd", settings: {} }],
  ["shape-matching", { id: "shape-matching", settings: {} }],
  ["projective-dynamics", { id: "projective-dynamics", settings: {} }],
  ["implicit-fem, linear", { id: "implicit-fem", settings: { femMaterial: "linear" } }],
  ["implicit-fem, corotational", { id: "implicit-fem", settings: {} }],
  ["implicit-fem, neo-Hookean", { id: "implicit-fem", settings: { femMaterial: "neohookean" } }],
  ["fem-tethers", { id: "fem-tethers", settings: {} }],
];

it.skipIf(!fs.existsSync(GLB))("compares the simulators on the real frog", async () => {
  const spec = (await loadFrog())!;
  const lines = [...TABLE_HEAD], runs: [string, SimRun][] = [];
  for (const [name, o] of ROWS) {
    const r = await measureSimulator(spec, o);
    lines.push(tableRow(name, r));
    runs.push([name, r]);
  }
  console.log(lines.join("\n"));
  for (const [name, r] of runs) {
    // Every simulator stands and stays put, and follows the bend.
    expect(r.head, name).toBeGreaterThan(0.95);
    expect(r.lean, name).toBeLessThan(8);
    expect(r.drift, name).toBeLessThan(0.2);
    expect(r.jitter, name).toBeLessThan(0.02);
    expect(r.deviation, name).toBeLessThan(0.06);
    expect(Math.abs(r.volume - 1), name).toBeLessThan(0.2);
  }
}, 900000);
