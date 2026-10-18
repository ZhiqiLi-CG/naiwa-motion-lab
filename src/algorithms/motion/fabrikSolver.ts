/**
 * Solver block: FABRIK (Forward And Backward Reaching IK, Aristidou & Lasenby 2011). Joints are points, not angles:
 * the backward pass puts the end on the target and pulls each joint towards the one after it at the segment's
 * length; the forward pass pins the root back and pushes each joint out from the one before it. Every move is a point
 * on a line, so an iteration is cheap and never overshoots. After each iteration the chain is projected onto the
 * constraints (out of the body, bend within the joint limit, legs apart), lightly inside the loop and fully at the
 * end. Targets: limbs.ts.
 */
import type * as THREE from "three";
import type { BlockDefinition, Scene, Settings } from "../../motion/api";
import { CHAIN_PARAMETERS, ChainSolver, dirsOf, joints, project, type Chain, type Dirs } from "./limbs";

/** Move `p` onto the line from `anchor` through p, `len` from the anchor. */
const reach = (p: THREE.Vector3, anchor: THREE.Vector3, len: number) => {
  const d = p.clone().sub(anchor);
  const n = d.length();
  return n < 1e-9 ? p : p.copy(anchor).addScaledVector(d, len / n);
};

class FabrikSolver extends ChainSolver {
  constructor(scene: Scene, s: Readonly<Settings>) {
    super(scene, s, "fabrik");
  }

  protected solveChain(c: Chain, start: Dirs): Dirs {
    let p = joints(c, project(this.body, c, start, true));
    for (let it = 0; it < this.iterations && p[2].distanceTo(c.target) > this.tolerance; it++) {
      // Backward: the end on the target, each joint towards its successor.
      p[2].copy(c.target);
      for (let j = 1; j >= 0; j--) reach(p[j], p[j + 1], c.len[j]);
      // Forward: the root back in place, each joint from its predecessor.
      p[0].copy(c.root);
      for (let j = 1; j <= 2; j++) reach(p[j], p[j - 1], c.len[j - 1]);
      p = joints(c, project(this.body, c, dirsOf(p), true));
    }
    return project(this.body, c, dirsOf(p));
  }
}

export const fabrikSolver: BlockDefinition<"solver"> = {
  id: "fabrik-ik",
  slot: "solver",
  name: { zh: "FABRIK 逆运动学", en: "FABRIK inverse kinematics" },
  summary: {
    zh: "前后向迭代：把末端放到目标上，沿连线把每个关节按骨长拉回来（后向）；再把根部放回原处，逐个往外推（前向）。只做点到直线的移动，便宜、不过冲；每轮后投影回身体之外、关节限制之内。",
    en: "Forward and backward reaching: put the end on the target and pull each joint back along the line at its bone length (backward), then pin the root and push each joint out again (forward). Only points moved along lines: cheap, no overshoot; projected back outside the body and within the joint limits after each iteration.",
  },
  parameters: CHAIN_PARAMETERS("fabrik", { iterations: 8, hint: 1 }),
  create: (scene, settings) => new FabrikSolver(scene, settings),
};
