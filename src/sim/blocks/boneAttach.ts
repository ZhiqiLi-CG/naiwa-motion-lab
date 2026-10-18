/**
 * Coupling block: the bones are the flesh's boundary condition. The flesh close to a bone rides on it through Rapier
 * attachments, which act both ways (the flesh's weight and inertia pull on the bone); the flesh further out is free
 * and held by the elastic cells alone.
 *
 * "Close" is measured against how thick the flesh is around that bone, per bone: the skull fills most of the head and
 * the ribs most of the chest, so little there is free and the head keeps its shape when the torso bends; the belly
 * has no bones in front, so much of it is free. The flesh solver's particles may be the nodes of a coarse lattice
 * that covers the surface (many lie outside it): a node stands for the flesh within half a lattice step of it, so it
 * rides on the bone when that flesh reaches into the carried core.
 */
import * as THREE from "three";
import type { BlockDefinition, CouplingBlock, Scene, Settings, SimBone, SimPart } from "../api";
import { carrierBone, particleAttributes } from "../parts";

/** The part of the Body's thickness around a torso bone that rides on it, for the firmest flesh (softness 0). A limb is
 *  only a lattice step or two thick: its flesh rides whole on its bones and bends in the cells across the joints
 *  (free nodes there hung on soft cells, crumpled when the limbs swung and let the feet shuffle on the floor). */
const CARRIED: Record<string, number> = { head: 1, chest: 0.7, spine: 0.5, hips: 0.55 };
/** The softest flesh (the belly) keeps this much less on the bone. */
const SOFT_LOOSENS = 0.35;

/** How thick the flesh is around each bone of a part: the median distance of its surface vertices to the bone. */
function thickness(part: SimPart): Map<SimBone, number> {
  const d = new Map<SimBone, number[]>(part.bones.map((b) => [b, []]));
  const p = new THREE.Vector3();
  for (let v = 0; v < part.positions.length; v += 3) {
    const { bone, distance } = carrierBone(part, p.fromArray(part.positions, v), part.regions[v / 3]);
    d.get(bone)!.push(distance);
  }
  return new Map([...d].map(([b, list]) => [b, list.sort((x, y) => x - y)[list.length >> 1] ?? 0]));
}

/** Typical distance between neighbouring particles (the median nearest-neighbour distance). */
function spacing(P: Float32Array): number {
  const n = P.length / 3, nearest: number[] = [];
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j !== i) best = Math.min(best, (P[i * 3] - P[j * 3]) ** 2 + (P[i * 3 + 1] - P[j * 3 + 1]) ** 2 + (P[i * 3 + 2] - P[j * 3 + 2]) ** 2);
    }
    nearest.push(Math.sqrt(best));
  }
  return nearest.sort((a, b) => a - b)[n >> 1] ?? 0;
}

class BoneAttach implements CouplingBlock {
  /** Free particles of each part. */
  private free = new Map<SimPart, number[]>();

  constructor(private scene: Scene, settings: Readonly<Settings>) {
    const scale = Number(settings.carried);
    const p = new THREE.Vector3();
    for (const part of scene.parts) {
      const view = scene.flesh.particles(part);
      const thick = thickness(part);
      const half = 0.5 * spacing(view.rest);
      const { softness, region } = particleAttributes(part, view.rest);
      const free: number[] = [];
      for (let i = 0; i < view.count; i++) {
        const { bone, distance } = carrierBone(part, p.fromArray(view.rest, i * 3), region[i]);
        const carried = CARRIED[bone.name];
        const reach = carried === undefined ? Infinity : scale * carried * (1 - SOFT_LOOSENS * softness[i]) * (thick.get(bone) ?? 0) + half;
        if (distance < reach) view.attach(i, bone.body);
        else free.push(i);
      }
      this.free.set(part, free);
    }
  }

  /** Mean distance of the free flesh from where its bones would carry it. */
  jiggle(part: SimPart): number {
    const free = this.free.get(part);
    if (!free?.length) return 0;
    const P = this.scene.flesh.particles(part).positions(), T = this.scene.target.targets(part);
    let sum = 0;
    for (const i of free) sum += Math.hypot(P[i * 3] - T[i * 3], P[i * 3 + 1] - T[i * 3 + 1], P[i * 3 + 2] - T[i * 3 + 2]);
    return sum / free.length;
  }
}

export const boneAttach: BlockDefinition<"coupling"> = {
  id: "bone-attachments",
  slot: "coupling",
  name: { zh: "骨骼附着", en: "Bone attachments" },
  summary: {
    zh: "靠近骨头的肉挂在骨头上（双向：肉的重量和惯性也拉骨头），外层的肉自由；头和胸挂得多（颅骨、肋骨），肚子挂得少。",
    en: "The flesh near a bone rides on it (two-way: its weight and inertia pull on the bone), the flesh further out is free; head and chest carry much (skull, ribs), the belly little.",
  },
  device: "cpu",
  parameters: [
    {
      key: "carried", kind: "number", default: 1, min: 0.3, max: 1.5, step: 0.1, rebuild: true,
      label: { zh: "挂骨比例", en: "Flesh on the bones" },
      help: {
        zh: "身体的肉挂在骨头上的比例，相对默认的倍数：越小，自由的肉越多，越软。四肢的肉总是整块挂在骨头上。",
        en: "How much of the Body's flesh rides on the bones, times the default: smaller leaves more free, softer. Limb flesh always rides whole.",
      },
    },
  ],
  create: (scene, settings) => new BoneAttach(scene, settings),
};
