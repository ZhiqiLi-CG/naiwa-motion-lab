/**
 * Coupling block "soft-limb-attachments": the built-in bone attachments for the Body (the deep flesh rides on the
 * torso bones, more of it on the head and chest than on the belly), but a limb carries only its core on its bones and
 * keeps a soft outer layer. That layer is what stands on the floor and meets the balls: on the MPM grid it gives the
 * feet friction and some give, as the flesh under a real sole does. Riding whole on its bones, a limb would stand on
 * the bones' hard soles alone, which rock and creep along the floor.
 */
import * as THREE from "three";
import type { BlockDefinition, CouplingBlock, Scene, Settings, SimBone, SimPart } from "../api";
import { boneAttach } from "../blocks/boneAttach";
import { nearestBone, particleAttributes } from "../parts";

/** Share of the thickness around each bone that rides on it (Body: as the built-in block; limbs: the core). */
const CARRIED: Record<string, number> = { head: 0.8, chest: 0.7, spine: 0.5, hips: 0.55 };
const SOFT_LOOSENS = 0.35;
/** A limb's sole (m above its lowest particle) that stays free: one particle layer at any grid. */
const SOLE = 0.01;

/** The lattice step: the distance from a particle to its nearest neighbour. */
function spacing(P: Float32Array): number {
  let best = Infinity;
  for (let j = 3; j < P.length; j += 3) best = Math.min(best, Math.hypot(P[j] - P[0], P[j + 1] - P[1], P[j + 2] - P[2]));
  return best;
}

function lowest(P: Float32Array): number {
  let y = Infinity;
  for (let i = 1; i < P.length; i += 3) y = Math.min(y, P[i]);
  return y;
}

/** How thick the flesh is around each bone of a part: the median distance of its surface vertices to the bone. */
function thickness(part: SimPart): Map<SimBone, number> {
  const d = new Map<SimBone, number[]>(part.bones.map((b) => [b, []]));
  const p = new THREE.Vector3();
  for (let v = 0; v < part.positions.length; v += 3) {
    const { bone, distance } = nearestBone(part, p.fromArray(part.positions, v));
    d.get(bone)!.push(distance);
  }
  return new Map([...d].map(([b, list]) => [b, list.sort((x, y) => x - y)[list.length >> 1] ?? 0]));
}

class SoftLimbs implements CouplingBlock {
  private free = new Map<SimPart, number[]>();

  constructor(private scene: Scene, settings: Readonly<Settings>) {
    const body = Number(settings.carried), limb = Number(settings.limbCore);
    const p = new THREE.Vector3();
    for (const part of scene.parts) {
      const view = scene.flesh.particles(part), thick = thickness(part);
      const { softness } = particleAttributes(part, view.rest);
      // A limb's sole: its lowest layer of flesh stays free, so the feet stand on soft pads — where the lattice
      // resolves the foot (a layer under half its thickness); on a coarser one that layer would be the whole foot.
      const sole = part.limb ? lowest(view.rest) + SOLE : -Infinity, step = spacing(view.rest);
      const free: number[] = [];
      for (let i = 0; i < view.count; i++) {
        const { bone, distance } = nearestBone(part, p.fromArray(view.rest, i * 3));
        const share = part.limb ? limb : body * (CARRIED[bone.name] ?? 1) * (1 - SOFT_LOOSENS * softness[i]);
        const t = thick.get(bone) ?? 0, soft = view.rest[i * 3 + 1] <= sole && step < 0.5 * t;
        // A limb's free layer must be a continuum, two lattice steps thick at least: a single loose layer is torn
        // off when the limb whips round (a dance's forearm turns at 15 rad/s). Thinner, the limb rides whole.
        const core = part.limb && t * (1 - share) < 2 * step ? Infinity : share * t;
        if (distance < core && !soft) view.attach(i, bone.body);
        else free.push(i);
      }
      this.free.set(part, free);
    }
  }

  jiggle(part: SimPart): number {
    const free = this.free.get(part);
    if (!free?.length) return 0;
    const P = this.scene.flesh.particles(part).positions(), T = this.scene.target.targets(part);
    let sum = 0;
    for (const i of free) sum += Math.hypot(P[i * 3] - T[i * 3], P[i * 3 + 1] - T[i * 3 + 1], P[i * 3 + 2] - T[i * 3 + 2]);
    return sum / free.length;
  }
}

export const softLimbs: BlockDefinition<"coupling"> = {
  id: "soft-limb-attachments",
  slot: "coupling",
  name: { zh: "骨骼附着（软四肢）", en: "Bone attachments (soft limbs)" },
  summary: {
    zh: "身体同内置的骨骼附着；四肢只有靠近骨头的芯挂在骨头上，外层的肉是软的，站在地上、碰到球的是它。",
    en: "The Body as the built-in bone attachments; a limb carries only its core on its bones and keeps a soft outer layer, which is what stands on the floor and meets the balls.",
  },
  device: "cpu",
  parameters: [
    ...boneAttach.parameters,
    {
      key: "limbCore", kind: "number", default: 0.6, min: 0.2, max: 1.2, step: 0.05, rebuild: true,
      label: { zh: "四肢骨芯比例", en: "Limb core" },
      help: {
        zh: "四肢的肉挂在骨头上的部分占肉厚的比例；1 以上整块挂上（内置做法）。",
        en: "The share of a limb's thickness that rides on its bones; 1 and more carries it whole (the built-in way).",
      },
    },
  ],
  create: (scene, settings) => new SoftLimbs(scene, settings),
};

