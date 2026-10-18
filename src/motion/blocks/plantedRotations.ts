/**
 * Output block: the posed skeleton → the character's pose target. World rotations from rest become each bone's local
 * rotation under its actual parent (extra bones between contract bones stay at rest), the root is lowered or raised so
 * the lower foot stands on the floor (plus the goal's lift), and the heading is wrapped to ±π.
 */
import type { PoseFrame } from "../../contracts";
import type { BlockDefinition, FrogPose, OutputBlock, Scene } from "../api";
import type { Binding } from "../rig";
import * as THREE from "three";

class PlantedRotations implements OutputBlock {
  private readonly b: Binding;

  constructor(scene: Scene) {
    this.b = scene.rig;
  }

  pose(frog: FrogPose): PoseFrame {
    const D = frog.rotations;
    const bones: PoseFrame["bones"] = {};
    for (const [name, r] of this.b.rest) {
      if (name === "root") continue;
      const parentWorld = D.get(r.anc!)!.clone().multiply(r.parentQ);
      bones[name] = parentWorld.invert().multiply(D.get(name)!.clone().multiply(r.q));
    }
    const expressions: PoseFrame["expressions"] = {};
    for (const [k, x] of Object.entries(frog.expressions)) if (x > 0.01) expressions[k as keyof typeof expressions] = Math.min(x, 1);
    const lowest = Math.min(frog.joints.get("foot_L")!.y, frog.joints.get("foot_R")!.y);
    return {
      bones,
      rootOffset: new THREE.Vector3(frog.shift, this.b.restFootY - lowest + Math.max(0, frog.lift), 0),
      rootYaw: Math.atan2(Math.sin(frog.yaw), Math.cos(frog.yaw)),
      expressions,
    };
  }
}

export const plantedRotations: BlockDefinition<"output"> = {
  id: "planted-rotations",
  slot: "output",
  name: { zh: "骨骼旋转 + 脚踩地", en: "Bone rotations, feet on the floor" },
  summary: {
    zh: "把姿态换成每根骨头相对父骨骼的旋转；整体上下移动让较低的那只脚踩在地上（跳起时再加上离地高度）。",
    en: "Turns the posed skeleton into each bone's rotation under its parent, and moves the whole frog up or down so the lower foot stands on the floor (plus the hop height).",
  },
  parameters: [],
  create: (scene) => new PlantedRotations(scene),
};
