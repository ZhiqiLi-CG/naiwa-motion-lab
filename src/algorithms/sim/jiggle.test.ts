/**
 * The jiggle table of docs/learn/sim-index.md (jiggle.ts): every simulator poked and shaken on the real frog, at the
 * app's default material and at the softest, bounciest the feel panel allows. JIGGLE=id,id… limits the rows;
 * EXTRA=id:key=value:… adds a row with those settings;
 * MPM=1 adds gpu-mpm on its CPU backend.
 */
import fs from "node:fs";
import { beforeAll, expect, it } from "vitest";
import type { PhysicsParams } from "../../contracts";
import { initPhysics } from "../../sim";
import { registerSimLibrary } from ".";
import type { BenchOptions } from "./bench";
import { measurePoke, measureShake, type Jiggle } from "./jiggle";
import { GLB, PARAMS, loadFrog } from "./testSupport";

const SOFTEST: PhysicsParams = { ...PARAMS, softness: 1, bounciness: 1 };

const ROWS: [string, BenchOptions][] = [
  ["cpu-constraints (built-in)", { id: "cpu-constraints", settings: {} }],
  ["mass-spring", { id: "mass-spring", settings: {} }],
  ["pbd", { id: "pbd", settings: {} }],
  ["xpbd", { id: "xpbd", settings: {} }],
  ["shape-matching", { id: "shape-matching", settings: {} }],
  ["projective-dynamics", { id: "projective-dynamics", settings: {} }],
  ["implicit-fem", { id: "implicit-fem", settings: {} }],
  ["implicit-fem, neo-Hookean", { id: "implicit-fem", settings: { femMaterial: "neohookean" } }],
  ["fem-tethers", { id: "fem-tethers", settings: {} }],
  ...(process.env.EXTRA ? [["extra", { id: process.env.EXTRA.split(":")[0], settings: Object.fromEntries(process.env.EXTRA.split(":").slice(1).map((kv) => kv.split("=")).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)])) }] as [string, BenchOptions]] : []),
];

beforeAll(async () => {
  await initPhysics();
  registerSimLibrary();
  if (process.env.MPM) {
    const gpu = await import("../../sim/gpu");
    gpu.forceBackend("cpu-inline");
    await gpu.probeDevices();
    gpu.registerGpuSimulators();
    ROWS.push(["gpu-mpm (CPU backend)", { id: "gpu-mpm", settings: {} }]);
  }
});

const cell = (j: Jiggle) => `${(j.peak * 1000).toFixed(0)} / ${j.oscillations.toFixed(1)} / ${j.decay.toFixed(2)} / ${j.frequency.toFixed(1)}`;

it.skipIf(!fs.existsSync(GLB))("measures the jiggle of every simulator", async () => {
  const spec = (await loadFrog())!;
  const only = process.env.JIGGLE?.split(",");
  const lines = [
    "| peak mm / oscillations / decay s / Hz | poke, default | poke, softest | shake, default | shake, softest |",
    "|---|---|---|---|---|",
  ];
  const results: [string, Jiggle][] = [];
  for (const [name, o] of ROWS) {
    if (only && !only.includes(o.id) && name !== "extra") continue;
    const r = [
      await measurePoke(spec, o, PARAMS), await measurePoke(spec, o, SOFTEST),
      await measureShake(spec, o, PARAMS), await measureShake(spec, o, SOFTEST),
    ];
    lines.push(`| ${name} | ${r.map(cell).join(" | ")} |`);
    results.push([name, r[1]]);
  }
  console.log(lines.join("\n"));
  for (const [name, soft] of results) expect(Number.isFinite(soft.peak), name).toBe(true);
}, 1800000);
