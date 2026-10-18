/** The real frog in Node for the library's tests and benchmark: naiwa.glb without textures, pose targets, shape checks
 *  (the same measures as src/sim/sim.test.ts). */
import fs from "node:fs";
import * as THREE from "three";
import { parseModel } from "../../character/asset";
import { createCharacter } from "../../character/character";
import { FLESH_REGIONS, type BoneName, type PhysicsParams, type RigSpec } from "../../contracts";
import type { LabFrogSim } from "../../sim";

/** The app's default material (jelly). */
export const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
export const GLB = new URL("../../../public/models/naiwa.glb", import.meta.url);

/** The GLB without its textures (Node has no image decoder; the simulation only needs the geometry). */
function untextured(buf: Buffer): ArrayBuffer {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  delete json.images;
  delete json.textures;
  delete json.samplers;
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

let frog: Promise<RigSpec | null> | null = null;
/** The real frog's RigSpec, or null when the model is not there. */
export function loadFrog(): Promise<RigSpec | null> {
  return (frog ??= (async () => {
    if (!fs.existsSync(GLB)) return null;
    const model = await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb");
    return createCharacter(model, "glb", "models/naiwa.glb").spec;
  })());
}

export const position = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

/** Angle (degrees) between a bone's rest up and its up now. */
export function tilt(now: THREE.Matrix4, rest: THREE.Matrix4): number {
  const q = new THREE.Quaternion().setFromRotationMatrix(now).multiply(new THREE.Quaternion().setFromRotationMatrix(rest).invert());
  return THREE.MathUtils.radToDeg(new THREE.Vector3(0, 1, 0).applyQuaternion(q).angleTo(new THREE.Vector3(0, 1, 0)));
}

/** Targets for the rest pose with some bones turned forward about world X (degrees), down the parent chain. */
export function bent(spec: RigSpec, turns: Partial<Record<BoneName, number>>): Map<BoneName, THREE.Matrix4> {
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
export function handsOnBelly(spec: RigSpec): Map<BoneName, THREE.Matrix4> {
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
export function headShape(sim: LabFrogSim, spec: RigSpec) {
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
