/**
 * Target block: where each particle would be if the flesh were firm — carried rigidly by its nearest bone. The
 * coupling block attaches the deep flesh by it, the metrics measure the jiggle against it. (A skinned target, blending
 * several bones by the skin weights, is the drop-in alternative once the character hands the weights over.)
 */
import * as THREE from "three";
import type { BlockDefinition, Scene, SimBone, SimPart, TargetBlock } from "../api";
import { nearestBone } from "../parts";

interface Carried {
  bone: SimBone[];
  /** Rest offset of each particle in its bone's frame. */
  offset: Float32Array;
  targets: Float32Array;
  velocities: Float32Array;
}

class BoneTarget implements TargetBlock {
  private carried = new Map<SimPart, Carried>();
  private started = false;

  constructor(scene: Scene) {
    const p = new THREE.Vector3();
    for (const part of scene.parts) {
      const rest = scene.flesh.particles(part).rest;
      const n = rest.length / 3;
      const bone: SimBone[] = [], offset = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        p.fromArray(rest, i * 3);
        const b = nearestBone(part, p).bone;
        bone.push(b);
        p.applyMatrix4(b.restInverse).toArray(offset, i * 3);
      }
      this.carried.set(part, { bone, offset, targets: rest.slice(), velocities: new Float32Array(n * 3) });
    }
  }

  private carriedOf(part: SimPart): Carried {
    const c = this.carried.get(part);
    if (!c) throw new Error(`sim: no targets for ${part.name}`);
    return c;
  }

  targets(part: SimPart) {
    return this.carriedOf(part).targets;
  }

  targetVelocities(part: SimPart) {
    return this.carriedOf(part).velocities;
  }

  /** After the bones moved this step. */
  afterStep(scene: Scene) {
    const poses = new Map<SimBone, THREE.Matrix4>();
    const p = new THREE.Vector3();
    for (const c of this.carried.values()) {
      const { bone, offset, targets, velocities } = c;
      for (let i = 0; i < bone.length; i++) {
        let m = poses.get(bone[i]);
        if (!m) poses.set(bone[i], (m = bone[i].pose(new THREE.Matrix4())));
        p.fromArray(offset, i * 3).applyMatrix4(m);
        for (let k = 0; k < 3; k++) {
          const v = p.getComponent(k);
          velocities[i * 3 + k] = this.started ? (v - targets[i * 3 + k]) / scene.dt : 0;
          targets[i * 3 + k] = v;
        }
      }
    }
    this.started = true;
  }

  reset() {
    this.started = false;
  }
}

export const boneTarget: BlockDefinition<"target"> = {
  id: "bone-carried-target",
  slot: "target",
  name: { zh: "骨骼携带目标", en: "Bone-carried target" },
  summary: {
    zh: "每个粒子随最近的骨头刚性移动的位置：肉如果是硬的会在哪里。",
    en: "Where each particle would be if its nearest bone carried it rigidly: the flesh as if it were firm.",
  },
  device: "cpu",
  parameters: [],
  create: (scene) => new BoneTarget(scene),
};
