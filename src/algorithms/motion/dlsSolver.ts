/**
 * Solver block: damped least squares IK (the Levenberg–Marquardt step on the Jacobian, Wampler 1986; Buss 2004).
 * Each limb has two ball joints (shoulder and elbow, hip and knee), so six rotation unknowns ω for the three
 * coordinates of the end. Turning joint j by a small ω moves the end by ω × rⱼ (rⱼ from the joint to the end), so
 * the Jacobian is J = [−[r₀]ₓ  −[r₁]ₓ] and the step
 *
 *   Δω = Jᵀ (J Jᵀ + λ² I)⁻¹ e,   J Jᵀ = Σⱼ (|rⱼ|² I − rⱼ rⱼᵀ)
 *
 * moves the end towards the target by e without the huge turns a plain pseudo-inverse makes near a straight limb
 * (λ trades speed for that robustness). The error is clipped to `dlsMaxStep` per iteration; after each step the chain
 * is projected onto the constraints, lightly inside the loop and fully at the end. Targets: limbs.ts.
 */
import * as THREE from "three";
import type { BlockDefinition, Scene, Settings } from "../../motion/api";
import { CHAIN_PARAMETERS, ChainSolver, joints, project, type Chain, type Dirs } from "./limbs";

const rotate = (v: THREE.Vector3, w: THREE.Vector3) => {
  const a = w.length();
  return a < 1e-12 ? v : v.applyAxisAngle(w.clone().divideScalar(a), a);
};

class DlsSolver extends ChainSolver {
  private readonly A = new THREE.Matrix3();

  constructor(scene: Scene, s: Readonly<Settings>) {
    super(scene, s, "dls");
  }

  protected solveChain(c: Chain, start: Dirs): Dirs {
    const lambda = this.s.dlsDamping as number, maxStep = this.s.dlsMaxStep as number;
    let d = project(this.body, c, start, true);
    for (let it = 0; it < this.iterations; it++) {
      const p = joints(c, d);
      const e = c.target.clone().sub(p[2]);
      if (e.length() <= this.tolerance) break;
      if (e.length() > maxStep) e.setLength(maxStep);
      const r = [p[2].clone().sub(p[0]), p[2].clone().sub(p[1])];
      // J Jᵀ + λ² I, symmetric 3 × 3.
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (const rj of r) {
        const n2 = rj.lengthSq(), v = [rj.x, rj.y, rj.z];
        for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) m[i * 3 + k] += (i === k ? n2 : 0) - v[i] * v[k];
      }
      for (let i = 0; i < 3; i++) m[i * 4] += lambda * lambda;
      const y = e.applyMatrix3(this.A.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]).invert());
      // Δωⱼ = −[rⱼ]ₓᵀ y = rⱼ × y; the shoulder's turn carries the forearm with it.
      const w0 = r[0].clone().cross(y), w1 = r[1].clone().cross(y);
      d = project(this.body, c, [rotate(d[0].clone(), w0), rotate(rotate(d[1].clone(), w0), w1)], true);
    }
    return project(this.body, c, d);
  }
}

export const dlsSolver: BlockDefinition<"solver"> = {
  id: "dls-ik",
  slot: "solver",
  name: { zh: "阻尼最小二乘 IK（雅可比）", en: "Damped least squares IK (Jacobian)" },
  summary: {
    zh: "用雅可比矩阵把末端误差换算成关节转动：Δω = Jᵀ(JJᵀ+λ²I)⁻¹e。阻尼 λ 让肢体伸直（奇异）时也不会猛转，代价是收敛慢一些；每步后投影回身体之外、关节限制之内。",
    en: "The Jacobian turns the end's error into joint turns: Δω = Jᵀ(JJᵀ+λ²I)⁻¹e. The damping λ keeps a straight (singular) limb from spinning wildly, at the cost of slower convergence; projected back outside the body and within the joint limits after each step.",
  },
  parameters: [
    ...CHAIN_PARAMETERS("dls", { iterations: 8, hint: 1 }),
    {
      key: "dlsDamping", kind: "number", default: 0.03, min: 0.001, max: 0.3, step: 0.001, unit: "m",
      label: { zh: "阻尼 λ", en: "Damping λ" },
      help: { zh: "越大越稳（肢体伸直时不乱转），越小收敛越快", en: "Higher is steadier near a straight limb, lower converges faster" },
    },
    {
      key: "dlsMaxStep", kind: "number", default: 0.05, min: 0.005, max: 0.3, step: 0.005, unit: "m",
      label: { zh: "每步最大位移", en: "Max step" },
      help: { zh: "每次迭代末端最多朝目标移动多远", en: "Furthest the end moves towards the target per iteration" },
    },
  ],
  create: (scene, settings) => new DlsSolver(scene, settings),
};
