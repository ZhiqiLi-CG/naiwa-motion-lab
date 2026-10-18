/**
 * Solver block: Cyclic Coordinate Descent IK. Each limb is a chain shoulder → elbow → wrist (hip → knee → ankle)
 * whose end must reach the target the goal's directions give on the frog's limbs (limbs.ts). CCD turns one joint at a
 * time, from the end towards the root, by the rotation that points the joint → end vector at the joint → target
 * vector; one sweep over the joints is an iteration. After each sweep the chain is projected onto the constraints
 * (out of the body, bend within the joint limit, legs apart), lightly inside the loop and fully at the end.
 */
import * as THREE from "three";
import type { BlockDefinition, Scene, Settings } from "../../motion/api";
import { CHAIN_PARAMETERS, ChainSolver, dirsOf, joints, project, type Chain, type Dirs } from "./limbs";

class CcdSolver extends ChainSolver {
  constructor(scene: Scene, s: Readonly<Settings>) {
    super(scene, s, "ccd");
  }

  protected solveChain(c: Chain, start: Dirs): Dirs {
    let p = joints(c, project(this.body, c, start, true));
    const q = new THREE.Quaternion();
    for (let it = 0; it < this.iterations && p[2].distanceTo(c.target) > this.tolerance; it++) {
      for (const j of [1, 0]) {
        const toEnd = p[2].clone().sub(p[j]), toTarget = c.target.clone().sub(p[j]);
        if (toEnd.lengthSq() < 1e-12 || toTarget.lengthSq() < 1e-12) continue;
        q.setFromUnitVectors(toEnd.normalize(), toTarget.normalize());
        for (let k = j + 1; k < p.length; k++) p[k].sub(p[j]).applyQuaternion(q).add(p[j]);
      }
      p = joints(c, project(this.body, c, dirsOf(p), true));
    }
    return project(this.body, c, dirsOf(p));
  }
}

export const ccdSolver: BlockDefinition<"solver"> = {
  id: "ccd-ik",
  slot: "solver",
  name: { zh: "CCD 逆运动学", en: "CCD inverse kinematics" },
  summary: {
    zh: "循环坐标下降：从末端往根部，每次只转一个关节，让“关节→末端”对准“关节→目标”；每轮之后把肢体投影回身体之外、关节限制之内。目标是人的肢体方向按奶蛙肢长放出的手腕/脚踝位置。",
    en: "Cyclic coordinate descent: from the end towards the root, turn one joint at a time so joint → end points at joint → target; after each sweep the limb is projected back outside the body and within the joint limits. The target is where the person's limb directions put the wrist or ankle on the frog's limbs.",
  },
  parameters: CHAIN_PARAMETERS("ccd", { iterations: 8, hint: 1 }),
  create: (scene, settings) => new CcdSolver(scene, settings),
};
