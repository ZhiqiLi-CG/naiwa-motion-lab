import fs from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { FLESH_REGIONS, type BoneName, type PhysicsParams, type RigSpec } from "../../contracts";
import { parseModel } from "../../character/asset";
import { createCharacter } from "../../character/character";
import { createFrogSim, initPhysics, listSimulators, type LabFrogSim } from "..";
import { createTestRigSpec } from "../testRig";
import { forceBackend, MpmFlesh, probeDevices, registerGpuSimulators } from ".";

/** The app's default material (jelly). */
const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
const GLB = new URL("../../../public/models/naiwa.glb", import.meta.url);
/** Coarse enough for one thread in a test. */
const SETTINGS = { gridCell: 5 };

/** The GLB without its textures (Node has no image decoder). */
function untextured(buf: Buffer): ArrayBuffer {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  for (const k of ["images", "textures", "samplers"]) delete json[k];
  for (const m of json.materials ?? []) {
    for (const k of ["normalTexture", "occlusionTexture", "emissiveTexture"]) delete m[k];
    for (const k of ["baseColorTexture", "metallicRoughnessTexture"]) delete m.pbrMetallicRoughness?.[k];
  }
  const raw = Buffer.from(JSON.stringify(json), "utf8");
  const text = Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, text, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

const position = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
function tilt(now: THREE.Matrix4, rest: THREE.Matrix4): number {
  const q = new THREE.Quaternion().setFromRotationMatrix(now).multiply(new THREE.Quaternion().setFromRotationMatrix(rest).invert());
  return THREE.MathUtils.radToDeg(new THREE.Vector3(0, 1, 0).applyQuaternion(q).angleTo(new THREE.Vector3(0, 1, 0)));
}

/** Rest pose with bones turned forward about world X (degrees), down the parent chain. */
function bent(spec: RigSpec, turns: Partial<Record<BoneName, number>>): Map<BoneName, THREE.Matrix4> {
  const rest = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
  const out = new Map<BoneName, THREE.Matrix4>();
  for (const b of spec.bones) {
    const local = b.parent ? rest.get(b.parent)!.clone().invert().multiply(b.restWorld) : b.restWorld.clone();
    const deg = turns[b.name];
    if (deg) {
      const restQ = new THREE.Quaternion().setFromRotationMatrix(b.restWorld);
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(deg));
      local.multiply(new THREE.Matrix4().makeRotationFromQuaternion(restQ.clone().invert().multiply(turn).multiply(restQ)));
    }
    out.set(b.name, b.parent ? out.get(b.parent)!.clone().multiply(local) : local);
  }
  return out;
}

/** The head region of the Body's surface against where the head bone carries it rigidly (m), and its size. */
function headShape(sim: LabFrogSim, spec: RigSpec) {
  const bones = new Map<BoneName, THREE.Matrix4>();
  sim.readBones(bones);
  const restHead = spec.bones.find((b) => b.name === "head")!.restWorld;
  const carry = bones.get("head")!.clone().multiply(restHead.clone().invert());
  const part = sim.scene.parts[0], S = sim.readBody(), R = part.positions, head = FLESH_REGIONS.indexOf("head");
  const centre = position(bones.get("head")!), restCentre = position(restHead);
  let error = 0, size = 0, restSize = 0, n = 0;
  const p = new THREE.Vector3(), r = new THREE.Vector3();
  for (let v = 0; v < part.regions.length; v++) {
    if (part.regions[v] !== head) continue;
    p.fromArray(S, v * 3);
    r.fromArray(R, v * 3);
    restSize += r.distanceTo(restCentre);
    error += p.distanceTo(r.applyMatrix4(carry));
    size += p.distanceTo(centre);
    n++;
  }
  return { error: error / n, size: size / restSize };
}

async function frog(spec: RigSpec, mode: "free" | "driven", id = "gpu-mpm"): Promise<LabFrogSim> {
  const sim = createFrogSim(spec, PARAMS, { id, settings: SETTINGS });
  await sim.ready;
  sim.setMode(mode);
  return sim;
}

let glb: RigSpec | null = null;
beforeAll(async () => {
  await initPhysics();
  await probeDevices();
  forceBackend("cpu-inline");
  registerGpuSimulators();
  if (fs.existsSync(GLB)) glb = createCharacter(await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb"), "glb", "models/naiwa.glb").spec;
}, 60000);

describe("gpu-mpm (CPU backend, one thread)", () => {
  it("survives pokes, a grab and throw, balls, driven/free switches and reset; resets a particle gone astray", async () => {
    const spec = createTestRigSpec();
    const sim = await frog(spec, "free");
    const flesh = sim.scene.flesh as MpmFlesh;
    const finite = () => {
      const all = [sim.readBody(), ...[...(() => { const m = new Map<string, Float32Array>(); sim.readLimbs(m); return m.values(); })()]];
      return all.every((a) => a.every(Number.isFinite));
    };
    const run = (n: number) => { for (let k = 0; k < n; k++) sim.step(1 / 60); };
    run(20);
    // Corrupt two free particles: one non-finite, one flung a metre away.
    const view = flesh.particles(sim.scene.parts[0]);
    const free = [...Array(view.count).keys()].filter((i) => !view.attachedTo(i));
    view.setPosition(free[0], NaN, NaN, NaN);
    view.setPosition(free[1], 1.5, 2, 0);
    run(4);
    expect(flesh.timing.resets).toBeGreaterThanOrEqual(2);
    expect(finite()).toBe(true);
    const P = view.positions();
    expect(Math.hypot(P[free[1] * 3] - 1.5, P[free[1] * 3 + 1] - 2, P[free[1] * 3 + 2])).toBeGreaterThan(0.5);
    // Poke, grab and throw, balls.
    const ray = new THREE.Ray(new THREE.Vector3(0, 0.5, 1.5), new THREE.Vector3(0, 0, -1));
    const hit = sim.raycast(ray)!;
    sim.poke(hit, 1, ray.direction);
    run(10);
    const g = sim.grab(sim.raycast(ray)!);
    for (let k = 0; k < 10; k++) {
      g.move(new THREE.Vector3(0, 0.6, 0.3 + 0.01 * k));
      run(1);
    }
    g.release(new THREE.Vector3(0, 2, 3));
    run(10);
    sim.throwBall(new THREE.Vector3(0, 0.5, 1.2), new THREE.Vector3(0, 0, -9), 0.08);
    run(20);
    // Driven and back, twice, then reset.
    sim.setMode("driven");
    sim.transition();
    sim.setTargets(bent(spec, { spine: 30, chest: 20, upperarm_L: 80, forearm_L: 90 }));
    run(20);
    sim.setMode("free");
    run(20);
    sim.reset();
    run(10);
    expect(finite()).toBe(true);
    const s = sim.stats();
    expect(Number.isFinite(s.energy) && Number.isFinite(s.deviation)).toBe(true);
    sim.dispose();
  }, 120000);

  it("is registered with its parameters and backend", () => {
    const info = listSimulators().find((s) => s.id === "gpu-mpm");
    expect(info?.unavailable).toBeNull();
    expect(info?.device).toBe("gpu");
    expect(info?.parameters.map((p) => p.key)).toEqual(expect.arrayContaining(["youngModulus", "poissonRatio", "density", "gridCell", "substeps"]));
    expect(info?.backend).toEqual({ zh: "CPU · 单线程", en: "CPU · 1 thread" });
  });

  it("follows pose targets in driven mode (test rig)", async () => {
    const spec = createTestRigSpec();
    const sim = await frog(spec, "driven");
    const targets = bent(spec, {});
    sim.setTargets(targets);
    for (let k = 0; k < 90; k++) sim.step(1 / 60);
    const bones = new Map<BoneName, THREE.Matrix4>();
    sim.readBones(bones);
    const s = sim.stats();
    expect(position(bones.get("chest")!).distanceTo(position(targets.get("chest")!))).toBeLessThan(0.01);
    expect(s.invertedCells).toBe(0);
    expect(Number.isFinite(s.deviation)).toBe(true);
    sim.dispose();
  }, 60000);
});

/** The real frog on one CPU thread takes minutes: MPM_FROG=1 npx vitest run src/sim/gpu/frog.test.ts */
describe.skipIf(!fs.existsSync(GLB) || !process.env.MPM_FROG)("gpu-mpm against cpu-constraints, the real frog", () => {
  for (const id of ["gpu-mpm", "cpu-constraints"]) {
    it(`${id}: stands in free mode for 10 s`, async () => {
      const spec = glb!;
      const sim = await frog(spec, "free", id);
      const rest = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
      const bones = new Map<BoneName, THREE.Matrix4>();
      const head0 = position(rest.get("head")!).y, hips0 = position(rest.get("hips")!);
      const t0 = performance.now();
      for (let k = 0; k < 600; k++) sim.step(1 / 60);
      const ms = (performance.now() - t0) / 600;
      sim.readBones(bones);
      const s = sim.stats();
      const head = position(bones.get("head")!).y / head0, lean = tilt(bones.get("hips")!, rest.get("hips")!);
      const drift = position(bones.get("hips")!).setY(0).distanceTo(hips0.setY(0));
      console.log(`${id} free 10 s:`, { ms, head, lean, drift, momentum: Math.hypot(...s.momentum!), jitter: s.jitter, deviation: s.deviation, deviationMax: s.deviationMax, volume: s.volume, particles: s.particles });
      expect(head).toBeGreaterThan(0.95);
      expect(lean).toBeLessThan(8);
      expect(Number.isFinite(s.energy)).toBe(true);
      // rapier-skeleton creeps along the floor under any flesh but Rapier's own soft bodies (which it sleeps with):
      // about 0.05 m/s bare or with rigid flesh. Measured and reported here, held to the CPU example's bound there.
      if (id === "cpu-constraints") expect(drift).toBeLessThan(0.2);
      sim.dispose();
    }, 300000);

    it(`${id}: keeps head and chest in shape through a forward bend`, async () => {
      const spec = glb!;
      const sim = await frog(spec, "driven", id);
      sim.setTargets(bent(spec, { spine: 25, chest: 25, head: 17 }));
      for (let k = 0; k < 180; k++) sim.step(1 / 60);
      const s = sim.stats(), head = headShape(sim, spec);
      console.log(`${id} bend 50°:`, { head, inverted: s.invertedCells, volume: s.volume, deviation: s.deviation, penetration: s.penetration });
      expect(s.invertedCells).toBe(0);
      expect(head.error).toBeLessThan(0.03);
      sim.dispose();
    }, 300000);
  }
});
