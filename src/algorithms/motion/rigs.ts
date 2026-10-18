/** The frogs the harness runs on (Node): the test skeleton of src/motion/testFrog.ts and the real naiwa.glb. */
import { readFileSync } from "node:fs";
import { parseModel } from "../../character/asset";
import { createCharacter, type NaiwaCharacter } from "../../character/character";
import type { BoneName } from "../../contracts";
import * as THREE from "three";
import { bindRig, type Binding } from "../../motion/rig";
import { buildTestFrog } from "../../motion/testFrog";
import type { Track } from "../../motion/track";

export const GLB = "public/models/naiwa.glb";

export const testRig = (): Binding => bindRig(buildTestFrog().rig);

/** naiwa.glb without its textures (Node has no image decoder; the rig is all the harness needs). */
export async function glbRig(): Promise<Binding> {
  return bindRig((await glbCharacter()).rig);
}

/** The character built from naiwa.glb (untextured). */
export async function glbCharacter(): Promise<NaiwaCharacter> {
  const buf = readFileSync(GLB);
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
  const scene = await parseModel(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, GLB);
  return createCharacter(scene, "glb", GLB);
}

export const loadTrack = (id: string): Track => JSON.parse(readFileSync(`public/dances/${id}.json`, "utf8")) as Track;

/** Each foot's toe (its bone's tail) from the ankle at rest, world frame: what the page's e2e measures besides the heel. */
export function toeOffsets(c: NaiwaCharacter): Record<"foot_L" | "foot_R", THREE.Vector3> {
  const at = (k: BoneName) => {
    const b = c.spec.bones.find((x) => x.name === k)!;
    return b.tail.clone().sub(new THREE.Vector3().setFromMatrixPosition(b.restWorld));
  };
  return { foot_L: at("foot_L"), foot_R: at("foot_R") };
}
