/**
 * Coupling block: the bones are the flesh's boundary condition. The deep flesh (and the flesh hugging a bone, since
 * thin limbs have little that is deep) rides on its nearest bone through Rapier attachments, which act both ways: the
 * flesh's weight and inertia pull on the bone. The flesh over that core is free, thickest where the region is softest,
 * and the flesh next to a joint stays free so it can fold there.
 */
import * as THREE from "three";
import type { BlockDefinition, CouplingBlock, Scene, Settings, SimPart } from "../api";
import { TriMesh } from "../geometry";
import { nearestBone, particleAttributes } from "../parts";

/** Free flesh over the attached core (m): at softness 0, and its growth up to softness 1. */
const FREE_DEPTH = { body: [0.05, 0.07], limb: [0.012, 0.02] } as const;

class BoneAttach implements CouplingBlock {
  /** Free particles of each part. */
  private free = new Map<SimPart, number[]>();

  constructor(private scene: Scene, settings: Readonly<Settings>) {
    const scale = Number(settings.freeDepth);
    const p = new THREE.Vector3();
    for (const part of scene.parts) {
      const view = scene.flesh.particles(part);
      const surface = new TriMesh(part.positions, part.indices);
      // The lattice spacing, from the part's volume and particle count (as the flesh block sizes its cells).
      const spacing = Math.cbrt((4.7 * surface.volume()) / view.count);
      const [depth, depthSoft] = part.limb ? FREE_DEPTH.limb : FREE_DEPTH.body;
      const joints = part.bones.filter((b) => b.parent && part.bones.includes(b.parent)).map((b) => b.restPos);
      const { softness } = particleAttributes(part, view.rest);
      const free: number[] = [];
      for (let i = 0; i < view.count; i++) {
        p.fromArray(view.rest, i * 3);
        const { bone, distance } = nearestBone(part, p);
        const inside = -surface.signedDistance(p.x, p.y, p.z);
        const nearJoint = joints.some((j) => j.distanceTo(p) < 0.35 * spacing);
        const deep = inside > scale * (depth + depthSoft * softness[i]) || distance < 0.45 * spacing;
        if (deep && !nearJoint) view.attach(i, bone.body);
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
    zh: "深层的肉挂在最近的骨头上（双向：肉的重量和惯性也拉骨头），表层的肉自由，关节附近不挂好让它能折。",
    en: "Deep flesh rides on its nearest bone (two-way: its weight and inertia pull on the bone); the flesh over it is free, and so is the flesh at the joints so it can fold.",
  },
  device: "cpu",
  parameters: [
    {
      key: "freeDepth", kind: "number", default: 1, min: 0.4, max: 2, step: 0.1, rebuild: true,
      label: { zh: "自由肉厚度", en: "Free flesh depth" },
      help: { zh: "相对默认厚度的倍数：越大，挂在骨头上的越少，越软。", en: "Times the default: more free flesh, fewer particles on the bones, softer." },
    },
  ],
  create: (scene, settings) => new BoneAttach(scene, settings),
};
