import fs from "node:fs";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { FLESH_REGIONS, type BoneName, type PhysicsParams, type RigSpec } from "../contracts";
import { parseModel } from "../character/asset";
import { createCharacter } from "../character/character";
import { createFrogSim, initPhysics, listSimulators, type LabFrogSim } from ".";
import { untextured } from "./testModel";
import { createTestRigSpec } from "./testRig";

/** The app's default material (jelly). */
const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
const GLB = new URL("../../public/models/naiwa.glb", import.meta.url);

async function frog(spec: RigSpec, mode: "free" | "driven"): Promise<LabFrogSim> {
  const sim = createFrogSim(spec, PARAMS, { id: "cpu-constraints", settings: {} });
  await sim.ready;
  sim.setMode(mode);
  return sim;
}

const position = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);
/** Angle (degrees) between a bone's rest up and its up now. */
function tilt(now: THREE.Matrix4, rest: THREE.Matrix4): number {
  const q = new THREE.Quaternion().setFromRotationMatrix(now).multiply(new THREE.Quaternion().setFromRotationMatrix(rest).invert());
  return THREE.MathUtils.radToDeg(new THREE.Vector3(0, 1, 0).applyQuaternion(q).angleTo(new THREE.Vector3(0, 1, 0)));
}

/** Targets for the rest pose with some bones turned forward about world X (degrees), down the parent chain. */
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

/** Targets with both hands pressed onto the belly: each arm aimed from its shoulder through an elbow at the side to a
 *  palm a few centimetres inside the belly's front, so only the contacts keep the hands out. */
function handsOnBelly(spec: RigSpec): Map<BoneName, THREE.Matrix4> {
  const out = bent(spec, {});
  const body = spec.body.positions;
  let front = -Infinity;
  for (let v = 0; v < body.length; v += 3) if (Math.abs(body[v + 1] - 0.48) < 0.03 && Math.abs(body[v]) < 0.05) front = Math.max(front, body[v + 2]);
  const aim = (name: BoneName, from: THREE.Vector3, to: THREE.Vector3) => {
    const b = spec.bones.find((x) => x.name === name)!;
    const restQ = new THREE.Quaternion().setFromRotationMatrix(b.restWorld);
    const restDir = b.tail.clone().sub(position(b.restWorld)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(restDir, to.clone().sub(from).normalize()).multiply(restQ);
    out.set(name, new THREE.Matrix4().compose(from, q, new THREE.Vector3(1, 1, 1)));
  };
  for (const [s, side] of [[1, "L"], [-1, "R"]] as const) {
    const shoulder = position(out.get(`upperarm_${side}`)!);
    const elbow = new THREE.Vector3(s * 0.26, 0.55, 0.06), wrist = new THREE.Vector3(s * 0.11, 0.5, front - 0.03);
    aim(`upperarm_${side}`, shoulder, elbow);
    aim(`forearm_${side}`, elbow, wrist);
    aim(`hand_${side}`, wrist, new THREE.Vector3(s * 0.04, 0.48, front - 0.04));
  }
  return out;
}

/** How well the head keeps its shape: the head region of the Body's surface against where the head bone would carry
 *  it rigidly (mean distance, m), and its size against rest (mean distance from the head bone). */
function headShape(sim: LabFrogSim, spec: RigSpec) {
  const bones = new Map<BoneName, THREE.Matrix4>();
  sim.readBones(bones);
  const restHead = spec.bones.find((b) => b.name === "head")!.restWorld;
  const carry = bones.get("head")!.clone().multiply(restHead.clone().invert());
  const part = sim.scene.parts[0], S = sim.readBody(), R = part.positions;
  const headRegion = FLESH_REGIONS.indexOf("head");
  const centre = position(bones.get("head")!), restCentre = position(restHead);
  let error = 0, size = 0, restSize = 0, n = 0;
  const p = new THREE.Vector3(), r = new THREE.Vector3();
  for (let v = 0; v < part.regions.length; v++) {
    if (part.regions[v] !== headRegion) continue;
    p.fromArray(S, v * 3);
    r.fromArray(R, v * 3);
    restSize += r.distanceTo(restCentre);
    error += p.distanceTo(r.applyMatrix4(carry));
    size += p.distanceTo(centre);
    n++;
  }
  return { error: error / n, size: size / restSize };
}

let glb: RigSpec | null = null;
beforeAll(async () => {
  await initPhysics();
  if (fs.existsSync(GLB)) glb = createCharacter(await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb"), "glb", "models/naiwa.glb").spec;
}, 60000);

describe("cpu-constraints", () => {
  it("is registered with its blocks' parameters", () => {
    const info = listSimulators().find((s) => s.id === "cpu-constraints");
    expect(info?.unavailable).toBeNull();
    expect(info?.parameters.map((p) => p.key)).toContain("cellModel");
  });

  it("follows pose targets in driven mode (test rig)", async () => {
    const spec = createTestRigSpec();
    const sim = await frog(spec, "driven");
    const targets = bent(spec, {});
    sim.setTargets(targets);
    for (let k = 0; k < 120; k++) sim.step(1 / 60);
    const bones = new Map<BoneName, THREE.Matrix4>();
    sim.readBones(bones);
    expect(position(bones.get("chest")!).distanceTo(position(targets.get("chest")!))).toBeLessThan(0.01);
    expect(sim.stats().invertedCells).toBe(0);
    sim.dispose();
  });
});

describe.skipIf(!fs.existsSync(GLB))("cpu-constraints, the real frog (public/models/naiwa.glb)", () => {
  it("stands upright in free mode, comes to rest and stays put", async () => {
    const spec = glb!;
    const sim = await frog(spec, "free");
    const rest = new Map(spec.bones.map((b) => [b.name, b.restWorld]));
    const bones = new Map<BoneName, THREE.Matrix4>();
    const head0 = position(rest.get("head")!).y, hips0 = position(rest.get("hips")!);
    for (let k = 0; k < 600; k++) sim.step(1 / 60);
    sim.readBones(bones);
    const s = sim.stats();
    const head = position(bones.get("head")!).y / head0, lean = tilt(bones.get("hips")!, rest.get("hips")!);
    const drift = position(bones.get("hips")!).setY(0).distanceTo(hips0.setY(0));
    const momentum = Math.hypot(...s.momentum!);
    console.log("free 10 s:", { head, lean, drift, momentum, jitter: s.jitter, deviation: s.deviation, volume: s.volume });
    expect(head).toBeGreaterThan(0.95);
    expect(lean).toBeLessThan(8);
    expect(drift).toBeLessThan(0.2);
    expect(momentum).toBeLessThan(0.5);
    expect(s.jitter!).toBeLessThan(0.01);
    sim.dispose();
  }, 60000);

  it("keeps head and chest in shape through a forward bend", async () => {
    const spec = glb!;
    const sim = await frog(spec, "driven");
    const targets = bent(spec, { spine: 25, chest: 25, head: 17 });
    sim.setTargets(targets);
    for (let k = 0; k < 180; k++) sim.step(1 / 60);
    const s = sim.stats(), head = headShape(sim, spec);
    console.log("bend 50°:", { head, inverted: s.invertedCells, volume: s.volume, deviation: s.deviation });
    expect(s.invertedCells).toBe(0);
    expect(Math.abs(s.volume!.body - 1)).toBeLessThan(0.03);
    expect(head.error).toBeLessThan(0.02);
    expect(head.size).toBeGreaterThan(0.95);
    sim.dispose();
  }, 60000);

  it("keeps the hands out of the belly", async () => {
    const spec = glb!;
    const sim = await frog(spec, "driven");
    sim.setTargets(handsOnBelly(spec));
    for (let k = 0; k < 120; k++) sim.step(1 / 60);
    const s = sim.stats();
    console.log("hands on the belly:", { penetration: s.penetration, volume: s.volume, inverted: s.invertedCells });
    expect(s.penetration!).toBeLessThan(0.015);
    sim.dispose();
  }, 60000);
});
