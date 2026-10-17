/** The flesh parts of a RigSpec, resolved for the blocks: every vertex gets a softness and a region, every part the
 *  skeleton bones it rides on. */
import * as THREE from "three";
import { FLESH_REGIONS, type BoneName, type CoreBone, type FleshRegion, type RigSpec } from "../contracts";
import type { SimBone, SimPart } from "./api";
import { segmentDistance } from "./geometry";

/** Softness of each region when the asset gives none (belly softest, hands and feet firmest). */
export const REGION_SOFTNESS: Record<FleshRegion, number> = {
  belly: 1, body: 0.55, head: 0.35, arm: 0.5, hand: 0.15, leg: 0.45, foot: 0.1,
};

export function resolveParts(spec: RigSpec, bones: ReadonlyMap<CoreBone, SimBone>): SimPart[] {
  const parentOf = new Map(spec.bones.map((b) => [b.name, b.parent]));
  // Bones the skeleton does not simulate (fingers, root) hand their flesh to their nearest simulated ancestor.
  const simulated = (name: BoneName): SimBone => {
    let n: BoneName | null | undefined = name;
    while (n && !bones.has(n as CoreBone)) n = n === "root" ? "hips" : parentOf.get(n);
    const b = bones.get((n ?? "hips") as CoreBone);
    if (!b) throw new Error(`sim: no skeleton bone for ${name}`);
    return b;
  };
  const inputs = [
    { ...spec.body, name: spec.body.name ?? "body", bones: spec.body.bones ?? ["hips", "spine", "chest", "head"] },
    ...(spec.limbs ?? []),
  ];
  return inputs.map((p, k) => {
    const partBones = [...new Set(p.bones.map(simulated))];
    const regions = p.regions ?? deriveRegions(p.positions, partBones, p.softness);
    const softness = p.softness ?? Float32Array.from(regions, (r) => REGION_SOFTNESS[FLESH_REGIONS[r]]);
    return { name: p.name, limb: k > 0, positions: p.positions, indices: p.indices, softness, regions, bones: partBones };
  });
}

/** Regions by the nearest bone (head, hand, foot, arm, leg), the belly where the asset marks the flesh soft. */
function deriveRegions(V: Float32Array, bones: readonly SimBone[], softness?: Float32Array): Uint8Array {
  const out = new Uint8Array(V.length / 3);
  const p = new THREE.Vector3();
  for (let v = 0; v < out.length; v++) {
    p.set(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]);
    let bone = bones[0], bd = Infinity;
    for (const b of bones) {
      const d = segmentDistance(p, b.restPos, b.tail);
      if (d < bd) {
        bd = d;
        bone = b;
      }
    }
    const n = bone.name;
    const r: FleshRegion = n === "head" ? "head" : /hand/.test(n) ? "hand" : /foot/.test(n) ? "foot"
      : /arm/.test(n) ? "arm" : /thigh|shin/.test(n) ? "leg" : (softness?.[v] ?? 0) > 0.6 ? "belly" : "body";
    out[v] = FLESH_REGIONS.indexOf(r);
  }
  return out;
}
