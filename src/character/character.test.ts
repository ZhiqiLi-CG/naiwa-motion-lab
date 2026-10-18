import fs from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CORE_BONES, type BoneName } from "../contracts";
import { parseModel } from "./asset";
import { createCharacter, type NaiwaCharacter } from "./character";
import { buildPlaceholder } from "./placeholder";
import { checkSurface, surfaceProblems, weld } from "./surface";

const GLB = new URL("../../public/models/naiwa.glb", import.meta.url);

/** The GLB without its textures (Node has no image decoder; geometry is all these tests look at). */
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
  const head = Buffer.alloc(20);
  const rest = buf.subarray(20 + jsonLen);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([head, text, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

async function loadGlb(): Promise<NaiwaCharacter> {
  const scene = await parseModel(untextured(fs.readFileSync(GLB)), "models/naiwa.glb");
  return createCharacter(scene, "glb", "models/naiwa.glb");
}

function contractChecks(c: NaiwaCharacter) {
  const { positions, indices, softness } = c.spec.body;
  const r = checkSurface(positions, indices);
  expect(surfaceProblems(r)).toEqual([]);
  expect(r.euler).toBe(2);
  // Seams are welded: fewer simulation vertices than render vertices, never more.
  expect(r.vertices).toBe(positions.length / 3);
  expect(r.vertices).toBeLessThanOrEqual(c.bodyReport.renderVertices);
  expect(softness!.length).toBe(positions.length / 3);
  expect(Math.min(...softness!)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...softness!)).toBeLessThanOrEqual(1);
  const names = c.spec.bones.map((b) => b.name);
  for (const n of CORE_BONES) expect(names).toContain(n);
  for (const b of c.spec.bones) {
    if (b.parent) expect(names.indexOf(b.parent)).toBeLessThan(names.indexOf(b.name));
    expect(b.radius).toBeGreaterThanOrEqual(0);
    expect(b.tail.distanceTo(new THREE.Vector3().setFromMatrixPosition(b.restWorld))).toBeGreaterThan(0.005);
  }
  for (const part of [c.spec.body, ...(c.spec.limbs ?? [])]) {
    // Skin binding: four bones of RigSpec.bones per vertex, weights summing to one.
    const n = part.positions.length / 3;
    expect(part.skinIndices!.length).toBe(4 * n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += part.skinWeights![4 * i + k];
        expect(part.skinIndices![4 * i + k]).toBeLessThan(c.spec.bones.length);
      }
      expect(sum).toBeCloseTo(1, 3);
    }
  }
  for (const l of c.spec.limbs ?? []) {
    const lr = checkSurface(l.positions, l.indices);
    expect(surfaceProblems(lr), l.name).toEqual([]);
    expect(l.regions!.length).toBe(l.positions.length / 3);
    expect(l.bones.length).toBeGreaterThan(1);
  }
  expect(c.rig.height).toBeGreaterThan(0.9);
  expect(c.rig.height).toBeLessThan(1.1);
  return r;
}

describe("surface", () => {
  it("welds split seam vertices of a sphere into one closed manifold", () => {
    const g = new THREE.SphereGeometry(1, 16, 12);
    const w = weld(g.attributes.position.array as Float32Array, g.index!.array, 1e-6);
    const r = checkSurface(w.positions, w.indices);
    // SphereGeometry repeats the seam column and every pole vertex; three's poles also keep degenerate fans.
    expect(r.vertices).toBe(16 * 11 + 2);
    expect(r.boundaryEdges).toBe(0);
    expect(r.misorientedEdges).toBe(0);
    expect(r.euler).toBe(2);
    expect(r.volume).toBeGreaterThan(0);
  });

  it("reports holes and flipped triangles", () => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const idx = Array.from(g.index!.array);
    const w = weld(g.attributes.position.array as Float32Array, idx.slice(3));
    expect(checkSurface(w.positions, w.indices).boundaryEdges).toBe(3);
    const flipped = idx.slice();
    [flipped[1], flipped[2]] = [flipped[2], flipped[1]];
    const w2 = weld(g.attributes.position.array as Float32Array, flipped);
    expect(checkSurface(w2.positions, w2.indices).misorientedEdges).toBe(3);
  });
});

describe("placeholder", () => {
  it("follows the asset contract", () => {
    const c = createCharacter(buildPlaceholder(), "placeholder", "placeholder");
    const r = contractChecks(c);
    expect(r.vertices).toBeLessThan(c.bodyReport.renderVertices);
    console.log("placeholder body", JSON.stringify(c.bodyReport));
  });
});

describe.skipIf(!fs.existsSync(GLB))("naiwa.glb", () => {
  it("follows the asset contract", async () => {
    const c = await loadGlb();
    contractChecks(c);
    console.log("glb body", JSON.stringify(c.bodyReport));
    console.log("glb limbs", JSON.stringify(c.limbReport), (c.spec.limbs ?? []).map((l) => `${l.name}:${l.positions.length / 3}v soft=${!!l.softness}`).join(" "));
    console.log("glb bones", c.spec.bones.map((b) => `${b.name}:${b.radius.toFixed(3)}`).join(" "));
  });

  it("rest pose round-trips: FK of the rest pose is the rest skeleton, rest sim shows the rest surface", async () => {
    const c = await loadGlb();
    const out = new Map<BoneName, THREE.Matrix4>();
    c.targetsFromPose({ bones: {} }, out);
    for (const b of c.spec.bones) {
      const m = out.get(b.name)!;
      for (let i = 0; i < 16; i++) expect(m.elements[i]).toBeCloseTo(b.restWorld.elements[i], 5);
    }
    const rest = new Map(c.spec.bones.map((b) => [b.name, b.restWorld.clone()]));
    c.applySim(rest, c.spec.body.positions);
    c.update(1 / 60, new THREE.PerspectiveCamera());
    const body = c.object.getObjectByName("Body") as THREE.Mesh;
    const p = body.geometry.attributes.position;
    const v = new THREE.Vector3();
    let maxErr = 0;
    // Breathing moves the belly by a few millimetres at most.
    for (let i = 0; i < p.count; i++) maxErr = Math.max(maxErr, v.fromBufferAttribute(p, i).length());
    expect(maxErr).toBeGreaterThan(0.5);
    const c2 = new THREE.Vector3();
    c.center(c2);
    expect(c2.y).toBeGreaterThan(0.4);
  });

  it("the tongue grows out of the mouth: over the lower lip onto the chin, never off the face", async () => {
    const c = await loadGlb();
    console.log("tongue:", (c as unknown as { tongueNote: string | null }).tongueNote);
    c.setLively(false);
    const rest = new Map(c.spec.bones.map((b) => [b.name, b.restWorld.clone()]));
    const cam = new THREE.PerspectiveCamera();
    const body = c.object.getObjectByName("Body") as THREE.Mesh;
    const mouth = c.object.getObjectByName("MouthInside") as THREE.SkinnedMesh;
    const col = mouth.geometry.attributes.color;
    const tongue: number[] = [];
    for (let i = 0; i < col.count; i++) if (col.getX(i) > 0.35 && col.getX(i) > 1.8 * col.getY(i)) tongue.push(i);
    expect(tongue.length).toBeGreaterThan(20);
    const measure = (e: "tongue" | "laugh" | "surprise") => {
      c.setExpressions({ [e]: 1 });
      for (let f = 0; f < 120; f++) {
        c.applySim(rest, c.spec.body.positions);
        c.update(1 / 60, cam);
      }
      const bp = body.geometry.attributes.position;
      const b = new THREE.Vector3(), v = new THREE.Vector3();
      let gapMin = Infinity, gapMax = 0, low = Infinity;
      for (const i of tongue) {
        mouth.getVertexPosition(i, v).applyMatrix4(mouth.matrixWorld);
        low = Math.min(low, v.y);
        let dmin = Infinity;
        for (let j = 0; j < bp.count; j++) dmin = Math.min(dmin, b.fromBufferAttribute(bp, j).distanceToSquared(v));
        gapMin = Math.min(gapMin, Math.sqrt(dmin));
        gapMax = Math.max(gapMax, Math.sqrt(dmin));
      }
      console.log(`${e}: tongue to Body nearest ${(gapMin * 1000).toFixed(1)} mm, farthest ${(gapMax * 1000).toFixed(1)} mm, lowest y ${low.toFixed(3)}`);
      return { gapMin, gapMax, low };
    };
    const t = measure("tongue");
    expect(t.gapMin).toBeLessThan(0.004);
    expect(t.gapMax).toBeLessThan(0.02);
    // It hangs below the lower lip (about 0.79 m) onto the chin.
    expect(t.low).toBeLessThan(0.765);
    const l = measure("laugh");
    expect(l.gapMin).toBeLessThan(0.004);
    expect(l.gapMax).toBeLessThan(0.02);
  });
});
