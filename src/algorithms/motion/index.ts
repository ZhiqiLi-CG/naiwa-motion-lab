/**
 * The motion-transfer algorithm library: well-known retargeting algorithms as blocks (one per file), each with a
 * learning page in docs/learn/motion/<block id>.{zh,en}.md, and retargeters that assemble them with the built-in
 * blocks. Direction copy itself (the default retargeter, src/motion/blocks) is the reference they are compared with.
 *
 *   filter   kalman-cv        constant-velocity Kalman filter, RTS smoother for recordings
 *            savitzky-golay   local polynomial least squares
 *   solver   ccd-ik           cyclic coordinate descent IK
 *            fabrik-ik        forward and backward reaching IK
 *            dls-ik           damped least squares (Jacobian) IK
 *            penalty-opt      constrained optimisation, penalty Gauss–Newton
 *   output   foot-plant       stance feet pinned to the floor
 */
import type { BlockDefinition, RetargeterDefinition } from "../../motion/api";
import { registerRetargetBlock, registerRetargeter } from "../../motion/api";
import { ccdSolver } from "./ccdSolver";
import { dlsSolver } from "./dlsSolver";
import { fabrikSolver } from "./fabrikSolver";
import { footPlant } from "./footPlant";
import { kalmanFilter } from "./kalmanFilter";
import { penaltyOptSolver } from "./penaltyOptSolver";
import { savitzkyGolay } from "./savitzkyGolay";

export const MOTION_LIBRARY_BLOCKS: BlockDefinition[] = [kalmanFilter, savitzkyGolay, ccdSolver, fabrikSolver, dlsSolver, penaltyOptSolver, footPlant];

/** The built-in blocks the assemblies keep (src/motion/blocks), with feet planted. */
const BASE = { filter: "one-euro", constraints: "frog-body", goal: "person-directions", solver: "projected-directions", output: footPlant.id };

export const MOTION_LIBRARY_RETARGETERS: RetargeterDefinition[] = [
  {
    id: "planted-feet",
    name: { zh: "方向拷贝 + 脚踩实", en: "Direction copy, feet planted" },
    summary: {
      zh: "默认的方向拷贝，输出换成脚踩实：着地的脚不再随转身在地上打滑，多余的转动交给上半身。",
      en: "The default direction copy with foot planting: standing feet no longer swivel on the floor as the frog turns; the rest of the turn twists the upper body.",
    },
    blocks: BASE,
  },
  {
    id: "kalman-planted",
    name: { zh: "卡尔曼滤波 + 方向拷贝", en: "Kalman filter, direction copy" },
    summary: {
      zh: "匀速模型卡尔曼滤波（视频用 RTS 平滑），方向拷贝，脚踩实。",
      en: "Constant-velocity Kalman filter (RTS smoother for videos), direction copy, feet planted.",
    },
    blocks: { ...BASE, filter: kalmanFilter.id },
  },
  {
    id: "savgol-planted",
    name: { zh: "Savitzky–Golay 滤波 + 方向拷贝", en: "Savitzky–Golay filter, direction copy" },
    summary: {
      zh: "局部多项式最小二乘滤波（保留动作峰值），方向拷贝，脚踩实。",
      en: "Local polynomial least-squares filter (keeps the peaks of a move), direction copy, feet planted.",
    },
    blocks: { ...BASE, filter: savitzkyGolay.id },
  },
  {
    id: "ccd-ik",
    name: { zh: "CCD 逆运动学", en: "CCD inverse kinematics" },
    summary: {
      zh: "手腕、脚踝的目标由人的肢体方向按奶蛙肢长给出，CCD 逐关节转向目标，投影到身体之外；脚踩实。",
      en: "Wrist and ankle targets from the person's limb directions on the frog's limb lengths, reached joint by joint by CCD and projected out of the body; feet planted.",
    },
    blocks: { ...BASE, solver: ccdSolver.id },
  },
  {
    id: "fabrik-ik",
    name: { zh: "FABRIK 逆运动学", en: "FABRIK inverse kinematics" },
    summary: {
      zh: "手腕、脚踝的目标由人的肢体方向按奶蛙肢长给出，FABRIK 前后向迭代够到目标，投影到身体之外；脚踩实。",
      en: "Wrist and ankle targets from the person's limb directions on the frog's limb lengths, reached by FABRIK's forward and backward passes and projected out of the body; feet planted.",
    },
    blocks: { ...BASE, solver: fabrikSolver.id },
  },
  {
    id: "dls-ik",
    name: { zh: "阻尼最小二乘 IK", en: "Damped least squares IK" },
    summary: {
      zh: "手腕、脚踝的目标由人的肢体方向按奶蛙肢长给出，雅可比阻尼最小二乘迭代够到目标，投影到身体之外；脚踩实。",
      en: "Wrist and ankle targets from the person's limb directions on the frog's limb lengths, reached by damped least squares on the Jacobian and projected out of the body; feet planted.",
    },
    blocks: { ...BASE, solver: dlsSolver.id },
  },
  {
    id: "constrained-opt",
    name: { zh: "约束优化", en: "Constrained optimisation" },
    summary: {
      zh: "四肢方向尽量接近人，同时不穿进身体、不超关节限制：罚函数 Gauss–Newton；脚踩实。",
      en: "Limb directions as close to the person's as the body and joint limits allow: penalty Gauss–Newton; feet planted.",
    },
    blocks: { ...BASE, solver: penaltyOptSolver.id },
  },
];

/** Register the library's blocks and retargeters (as built-ins); returns a function that removes them again. The
 *  assemblies use the motion module's own blocks too (registerBuiltins), so register those as well. */
export function registerMotionLibrary(): () => void {
  const removers = [
    ...MOTION_LIBRARY_BLOCKS.map((def) => registerRetargetBlock(def, "builtin")),
    ...MOTION_LIBRARY_RETARGETERS.map((def) => registerRetargeter(def, "builtin")),
  ];
  return () => removers.forEach((r) => r());
}
