/**
 * The one harness every simulator of the library is measured with (bench.test.ts prints the table in
 * docs/learn/sim-index.md), on the real frog with the app's default material:
 *
 *   free 10 s   standing on its own: head height against rest, lean of the hips, drift on the floor, jitter at the end
 *   bend 50°    driven: spine and chest 25° forward each, head 17° more, held 3 s: deviation of the flesh from its
 *               target, inverted cells, Body volume, head shape (error against the head bone carrying it rigidly)
 *   ms/step     the whole step (skeleton, flesh, collision, coupling…) during the bend, and the flesh block alone
 */
import * as THREE from "three";
import type { BoneName, RigSpec, SimulatorOptions } from "../../contracts";
import { createFrogSim, type LabFrogSim, type Slot } from "../../sim";
import { PARAMS, bent, headShape, position, tilt } from "./testSupport";

export interface SimRun {
  head: number;
  lean: number;
  drift: number;
  jitter: number;
  momentum: number;
  deviation: number;
  inverted: number;
  volume: number;
  headError: number;
  headSize: number;
  /** Mean ms per step: the whole step during the bend, and the flesh block's share; the free run's whole step. */
  msStep: number;
  msFlesh: number;
  msFree: number;
  particles: number;
  cells: number;
}

export type BenchOptions = SimulatorOptions & { blocks?: Partial<Record<Slot, string>> };

async function make(spec: RigSpec, o: BenchOptions, mode: "free" | "driven"): Promise<LabFrogSim> {
  const sim = createFrogSim(spec, PARAMS, o);
  await sim.ready;
  sim.setMode(mode);
  return sim;
}

/** Wrap the flesh block's afterStep to time it. */
function timeFlesh(sim: LabFrogSim): { ms: () => number } {
  const flesh = sim.scene.flesh;
  const inner = flesh.afterStep?.bind(flesh);
  let total = 0, n = 0;
  if (inner) {
    flesh.afterStep = (scene) => {
      const t0 = performance.now();
      inner(scene);
      total += performance.now() - t0;
      n++;
    };
  }
  return { ms: () => total / Math.max(1, n) };
}

export async function measureSimulator(spec: RigSpec, o: BenchOptions): Promise<SimRun> {
  const rest = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
  const bones = new Map<BoneName, THREE.Matrix4>();

  const free = await make(spec, o, "free");
  const head0 = position(rest.get("head")!).y, hips0 = position(rest.get("hips")!);
  let t0 = performance.now();
  for (let k = 0; k < 600; k++) free.step(1 / 60);
  const msFree = (performance.now() - t0) / 600;
  free.readBones(bones);
  const fs = free.stats();
  const run = {
    head: position(bones.get("head")!).y / head0,
    lean: tilt(bones.get("hips")!, rest.get("hips")!),
    drift: position(bones.get("hips")!).setY(0).distanceTo(hips0.clone().setY(0)),
    jitter: fs.jitter ?? NaN,
    momentum: Math.hypot(...(fs.momentum ?? [NaN, 0, 0])),
    particles: fs.particles,
    cells: fs.cells,
  };
  free.dispose();

  const driven = await make(spec, o, "driven");
  const timer = timeFlesh(driven);
  driven.setTargets(bent(spec, { spine: 25, chest: 25, head: 17 }));
  t0 = performance.now();
  for (let k = 0; k < 180; k++) driven.step(1 / 60);
  const msStep = (performance.now() - t0) / 180;
  const s = driven.stats(), head = headShape(driven, spec);
  driven.dispose();
  return {
    ...run,
    deviation: s.deviation ?? NaN,
    inverted: s.invertedCells ?? NaN,
    volume: s.volume?.body ?? NaN,
    headError: head.error,
    headSize: head.size,
    msStep,
    msFlesh: timer.ms(),
    msFree,
  };
}

const f = (x: number, d: number) => (Number.isFinite(x) ? x.toFixed(d) : "—");

export const TABLE_HEAD = [
  "| simulator | particles / cells | head height | lean ° | drift cm | jitter mm/s | bend: deviation cm | inverted | volume | head error mm | ms/step (flesh) |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];

export function tableRow(name: string, r: SimRun): string {
  return `| ${name} | ${r.particles} / ${r.cells} | ${f(r.head, 3)} | ${f(r.lean, 1)} | ${f(r.drift * 100, 1)} | ${f(r.jitter * 1000, 1)} | ${f(r.deviation * 100, 2)} | ${r.inverted} | ${f(r.volume, 3)} | ${f(r.headError * 1000, 1)} | ${f(r.msStep, 2)} (${f(r.msFlesh, 2)}) |`;
}
