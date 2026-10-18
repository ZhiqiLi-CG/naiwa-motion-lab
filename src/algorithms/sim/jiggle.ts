/**
 * How much the flesh jiggles: one harness for every simulator (jiggle.test.ts prints the table in
 * docs/learn/sim-index.md). The real frog stands for 2 s, then
 *
 *   poke    the page's strongest poke into the belly (core.poke: 5 m/s inwards, fading over 14 cm), free mode;
 *   shake   driven: the torso swings sideways (chest ±20°, 3 Hz) for 0.5 s and stops dead.
 *
 * The signal is the belly's rendered surface around the poke point against where its bones would carry it rigidly
 * (so the frog rocking as a whole does not count), along the poke (or the shake), minus where it rested. From 3 s of it:
 * The slow drift of where the flesh settles (the frog leans a little after a poke) is taken out: the signal is
 * measured against its mean over the last half second.
 *   peak           the largest displacement (mm)
 *   oscillations   full swings that reach a tenth of the peak (counted by sign changes with that hysteresis)
 *   decay          time from the peak until the displacement stays below peak/e (s)
 */
import * as THREE from "three";
import type { BoneName, PhysicsParams, RigSpec } from "../../contracts";
import { createFrogSim, type LabFrogSim, type SimBone } from "../../sim";
import { nearestBone } from "../../sim/parts";
import type { BenchOptions } from "./bench";
import { bent } from "./testSupport";

const DT = 1 / 60;

export interface Jiggle {
  peak: number;
  oscillations: number;
  decay: number;
  /** Frequency of the swings (Hz), from the time between the first and last counted swing. */
  frequency: number;
}

/** Surface vertices of the Body within `radius` of a point, each with the bone that carries it at rest. */
function probe(sim: LabFrogSim, point: THREE.Vector3, radius: number) {
  const part = sim.scene.parts[0], R = part.positions, p = new THREE.Vector3();
  const verts: { v: number; bone: SimBone }[] = [];
  for (let v = 0; v < R.length / 3; v++) {
    p.fromArray(R, v * 3);
    if (p.distanceTo(point) < radius) verts.push({ v, bone: nearestBone(part, p).bone });
  }
  return () => {
    const S = sim.readBody(), m = new THREE.Matrix4(), out = new THREE.Vector3(), q = new THREE.Vector3();
    const poses = new Map<SimBone, THREE.Matrix4>();
    for (const { v, bone } of verts) {
      let pose = poses.get(bone);
      if (!pose) poses.set(bone, (pose = bone.pose(m.clone()).multiply(bone.restInverse)));
      q.fromArray(R, v * 3).applyMatrix4(pose);
      out.add(p.fromArray(S, v * 3).sub(q));
    }
    return out.multiplyScalar(1 / Math.max(1, verts.length));
  };
}

/** Peak, swings and decay of a displacement signal (m, one sample per step), about where it ends up. */
export function analyse(raw: number[]): Jiggle {
  const tail = raw.slice(-30), end = tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length);
  const d = raw.map((x) => x - end);
  let peak = 0, at = 0;
  d.forEach((x, i) => {
    if (Math.abs(x) > peak) {
      peak = Math.abs(x);
      at = i;
    }
  });
  if (peak < 1e-5) return { peak: 0, oscillations: 0, decay: 0, frequency: 0 };
  const band = 0.1 * peak;
  let sign = 0, flips = 0, first = -1, lastFlip = -1;
  d.forEach((x, i) => {
    const s = x > band ? 1 : x < -band ? -1 : 0;
    if (s === 0 || s === sign) return;
    if (sign !== 0) {
      flips++;
      if (first < 0) first = i;
      lastFlip = i;
    }
    sign = s;
  });
  let last = at;
  for (let i = at; i < d.length; i++) if (Math.abs(d[i]) > peak / Math.E) last = i;
  const frequency = flips > 1 ? (flips - 1) / 2 / ((lastFlip - first) * DT) : 0;
  return { peak, oscillations: flips / 2, decay: (last - at + 1) * DT, frequency };
}

async function make(spec: RigSpec, o: BenchOptions, params: PhysicsParams, mode: "free" | "driven") {
  const sim = createFrogSim(spec, params, o);
  await sim.ready;
  sim.setMode(mode);
  return sim;
}

/** The belly poked in free mode. */
export async function measurePoke(spec: RigSpec, o: BenchOptions, params: PhysicsParams): Promise<Jiggle> {
  const sim = await make(spec, o, params, "free");
  for (let k = 0; k < 120; k++) sim.step(DT);
  const hit = sim.raycast(new THREE.Ray(new THREE.Vector3(0, 0.45, 2), new THREE.Vector3(0, 0, -1)));
  if (!hit) throw new Error("jiggle: the ray misses the belly");
  const read = probe(sim, hit.point, 0.08), dir = new THREE.Vector3(0, 0, -1);
  const rest = read().dot(dir);
  sim.poke(hit, 1, dir);
  const d: number[] = [];
  for (let k = 0; k < 180; k++) {
    sim.step(DT);
    d.push(read().dot(dir) - rest);
  }
  sim.dispose();
  return analyse(d);
}

/** Driven: the torso swings sideways for half a second and stops; the belly's swing after the stop. */
export async function measureShake(spec: RigSpec, o: BenchOptions, params: PhysicsParams): Promise<Jiggle> {
  const sim = await make(spec, o, params, "driven");
  const restTargets = bent(spec, {});
  sim.setTargets(restTargets);
  for (let k = 0; k < 120; k++) sim.step(DT);
  const front = new THREE.Vector3(0, 0.45, 0.25);
  const read = probe(sim, front, 0.1), dir = new THREE.Vector3(1, 0, 0);
  const rest = read().dot(dir);
  const sway = (deg: number) => {
    const out = new Map<BoneName, THREE.Matrix4>();
    // Turn spine and chest about the forward axis (sideways), down the chain.
    const turn = new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(deg));
    for (const [name, m] of restTargets) {
      if (name === "hips" || name === "root" || /thigh|shin|foot/.test(name)) out.set(name, m.clone());
      else {
        const pivot = new THREE.Vector3().setFromMatrixPosition(restTargets.get("spine")!);
        const about = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(turn).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
        out.set(name, about.multiply(m));
      }
    }
    return out;
  };
  for (let k = 0; k < 30; k++) {
    sim.setTargets(sway(20 * Math.sin(2 * Math.PI * 3 * k * DT)));
    sim.step(DT);
  }
  sim.setTargets(restTargets);
  const d: number[] = [];
  for (let k = 0; k < 180; k++) {
    sim.step(DT);
    d.push(read().dot(dir) - rest);
  }
  sim.dispose();
  return analyse(d);
}
