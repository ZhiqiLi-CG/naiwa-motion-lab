/**
 * Running a block off screen: the short trial a block must pass before it goes into the page's simulation or
 * retargeter, and the comparison of two blocks in the same slot on the same scene or motion.
 *
 * Simulator scene: the frog in free mode, let fall from rest; a poke on the belly at 1 s, a ball thrown at it at 2 s,
 * then it settles. The metrics block's numbers are read ten times a second. Retargeter motion: a dance track played
 * through the pipeline (the library's bench), or a procedural dance when no track is at hand.
 */
import * as THREE from "three";
import { measureFilter, measureRetargeter } from "../algorithms/motion/bench";
import type { PhysicsParams, RigSpec, SimulatorOptions } from "../contracts";
import type { Text } from "../i18n";
import { createRetargetPipeline } from "../motion/core";
import { PROCEDURAL_DANCES } from "../motion/dances";
import type { Binding } from "../motion/rig";
import type { Track } from "../motion/track";
import { createFrogSim, type LabFrogSim } from "../sim/core";

export type Blocks = Record<string, string>;

/** One number of a comparison; lower is better for all of them. */
export interface MetricRow {
  key: string;
  label: Text;
  unit: string;
  digits: number;
  value: number;
}

const DT = 1 / 60;
/** Lets the page draw between chunks of a long run. */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

async function ready(sim: LabFrogSim, ms = 15000): Promise<void> {
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the simulator was not built within ${ms / 1000} s`)), ms) as unknown as number;
  });
  try {
    await Promise.race([sim.ready, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Build the simulator with these blocks and run a few steps, reading everything the page reads. Throws what the
 *  blocks throw. */
export async function trialSim(spec: RigSpec, params: PhysicsParams, options: SimulatorOptions, blocks: Blocks): Promise<void> {
  const sim = createFrogSim(spec, params, { ...options, blocks });
  // A simulator whose blocks failed to build is not disposed: its dispose waits for the build, which never ends.
  await ready(sim);
  try {
    const bones = new Map();
    const limbs = new Map<string, Float32Array>();
    for (let i = 0; i < 12; i++) {
      sim.step(DT);
      sim.readBones(bones);
      sim.readLimbs(limbs);
      const body = sim.readBody();
      if (body.length !== spec.body.positions.length) throw new Error(`output: read() returned ${body.length / 3} vertices for the Body, it has ${spec.body.positions.length / 3}`);
    }
    sim.stats();
  } finally {
    sim.dispose();
  }
}

/** The scene every simulator block is compared on (see the top of the file). */
export async function measureSim(
  spec: RigSpec,
  params: PhysicsParams,
  options: SimulatorOptions,
  blocks: Blocks,
  progress?: (f: number) => void,
): Promise<MetricRow[]> {
  const sim = createFrogSim(spec, params, { ...options, blocks });
  await ready(sim);
  try {
    sim.setMode("free");
    const seconds = 4;
    const steps = Math.round(seconds / DT);
    const samples: { t: number; s: ReturnType<LabFrogSim["stats"]> }[] = [];
    let stepMs = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i * DT;
      if (i === Math.round(1 / DT)) {
        const ray = new THREE.Ray(new THREE.Vector3(0, 0.42, 2), new THREE.Vector3(0, 0, -1));
        const hit = sim.raycast(ray);
        if (hit) sim.poke(hit, 0.7, ray.direction);
      }
      if (i === Math.round(2 / DT)) {
        const origin = new THREE.Vector3(0.6, 0.9, 1.6);
        sim.throwBall(origin, new THREE.Vector3(0, 0.45, 0).sub(origin).multiplyScalar(2.2).add(new THREE.Vector3(0, 2, 0)), 0.1);
      }
      const t0 = performance.now();
      sim.step(DT);
      stepMs += performance.now() - t0;
      if (i % 6 === 0) samples.push({ t, s: sim.stats() });
      if (i % 20 === 0) {
        progress?.(i / steps);
        await breathe();
      }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const of = (k: "deviation" | "deviationMax" | "invertedCells" | "penetration" | "jitter", from = 0) =>
      samples.filter((x) => x.t >= from).map((x) => x.s[k] ?? 0);
    const volume = samples.map((x) => Math.abs((x.s.volume?.body ?? x.s.volumeRatio) - 1));
    const energy = samples.map((x) => x.s.energy ?? 0);
    return [
      { key: "deviation", label: { zh: "偏离目标（平均）", en: "Deviation (mean)" }, unit: "mm", digits: 1, value: mean(of("deviation")) * 1000 },
      { key: "deviationMax", label: { zh: "偏离目标（最大）", en: "Deviation (max)" }, unit: "mm", digits: 1, value: Math.max(0, ...of("deviationMax")) * 1000 },
      { key: "invertedCells", label: { zh: "翻转单元", en: "Inverted cells" }, unit: "", digits: 0, value: Math.max(0, ...of("invertedCells")) },
      { key: "volume", label: { zh: "体积误差", en: "Volume error" }, unit: "%", digits: 2, value: mean(volume) * 100 },
      { key: "penetration", label: { zh: "四肢入体", en: "Limb penetration" }, unit: "mm", digits: 1, value: Math.max(0, ...of("penetration")) * 1000 },
      { key: "jitter", label: { zh: "静止抖动（最后 1 秒）", en: "Jitter at rest (last 1 s)" }, unit: "mm/s", digits: 2, value: mean(of("jitter", seconds - 1)) * 1000 },
      { key: "energy", label: { zh: "静止能量漂移", en: "Energy drift at rest" }, unit: "J", digits: 3, value: energy.length > 10 ? Math.abs(energy[energy.length - 1] - energy[energy.length - 10]) : 0 },
      { key: "stepMs", label: { zh: "每步耗时", en: "Time per step" }, unit: "ms", digits: 2, value: stepMs / steps },
    ];
  } finally {
    sim.dispose();
  }
}

/** Build the retargeter with these blocks and run a second of motion through every slot. */
export function trialRetarget(rig: Binding, options: SimulatorOptions, blocks: Blocks, track: Track | null): void {
  const p = createRetargetPipeline(rig, { ...options, blocks });
  const dance = PROCEDURAL_DANCES[0];
  for (let i = 1; i <= 30; i++) p.pose(dance.pose(i * DT), DT);
  if (!track) return;
  const live = createRetargetPipeline(rig, { ...options, blocks });
  for (let i = 0; i < Math.min(30, track.frames.length); i++) {
    const goal = live.live({ ...track.frames[i], aspect: track.aspect ?? 1 }, i / track.fps, 1 / track.fps, false);
    if (goal) live.pose(goal, 1 / track.fps);
  }
  live.recorded(track.frames.slice(0, 30).map((f) => ({ ...f, aspect: track.aspect ?? 1 })), track.fps);
}

/** The retargeter's metrics on a dance track (the library's bench), or on a procedural dance without one. For a
 *  filter, how close the filtered landmarks stay to the clean ones under detector noise too. */
export function measureRetarget(rig: Binding, options: SimulatorOptions, blocks: Blocks, slot: string, track: Track | null): MetricRow[] {
  const rows: MetricRow[] = [];
  let m: { fidelity: number; jerk: number; penetration: number; footSlide: number; solveMs?: number; outputMs?: number };
  if (track) m = measureRetargeter(rig, { id: options.id, settings: options.settings, blocks }, track);
  else {
    const p = createRetargetPipeline(rig, { ...options, blocks });
    const dance = PROCEDURAL_DANCES[0];
    const windows: NonNullable<ReturnType<typeof p.metrics>>[] = [];
    for (let i = 1; i <= 6 * 60; i++) {
      p.pose(dance.pose(i * DT), DT);
      if (i % 120 === 0) windows.push(p.metrics()!);
    }
    const mean = (k: "fidelity" | "jerk" | "footSlide") => windows.reduce((a, w) => a + w[k], 0) / windows.length;
    m = { fidelity: mean("fidelity"), jerk: mean("jerk"), footSlide: mean("footSlide"), penetration: Math.max(...windows.map((w) => w.penetration)) };
  }
  rows.push(
    { key: "fidelity", label: { zh: "方向偏差", en: "Direction error" }, unit: "°", digits: 1, value: m.fidelity },
    { key: "jerk", label: { zh: "加加速度", en: "Jerk" }, unit: "m/s³", digits: 0, value: m.jerk },
    { key: "penetration", label: { zh: "四肢入体", en: "Limb penetration" }, unit: "mm", digits: 1, value: m.penetration * 1000 },
    { key: "footSlide", label: { zh: "脚滑", en: "Foot slide" }, unit: "cm/s", digits: 1, value: m.footSlide * 100 },
  );
  if (m.solveMs !== undefined) {
    rows.push({ key: "solveMs", label: { zh: "求解耗时", en: "Solver time" }, unit: "ms", digits: 3, value: m.solveMs });
    rows.push({ key: "outputMs", label: { zh: "输出耗时", en: "Output time" }, unit: "ms", digits: 3, value: m.outputMs ?? 0 });
  }
  if (slot === "filter" && track) {
    const f = measureFilter(rig, { id: options.id, settings: options.settings, blocks }, track);
    rows.push(
      { key: "rmseLive", label: { zh: "滤波误差（实时）", en: "Filter error (live)" }, unit: "mm", digits: 1, value: f.rmseLive },
      { key: "rmseRecorded", label: { zh: "滤波误差（整段视频）", en: "Filter error (recording)" }, unit: "mm", digits: 1, value: f.rmseRecorded },
      { key: "jerkLive", label: { zh: "加加速度（实时）", en: "Jerk (live)" }, unit: "m/s³", digits: 0, value: f.jerkLive },
      { key: "liveMs", label: { zh: "滤波耗时", en: "Filter time" }, unit: "ms", digits: 3, value: f.liveMs },
    );
  }
  return rows;
}
