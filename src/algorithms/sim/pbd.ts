/**
 * Position-based dynamics (Müller et al. 2007): distance constraints on the cells' edges and volume constraints on
 * the cells, projected one at a time with a stiffness k ∈ [0, 1]. The solver is in positionBased.ts.
 */
import { particleFleshBlock } from "./flesh";
import { PositionBased } from "./positionBased";

export const pbd = particleFleshBlock({
  id: "pbd",
  name: { zh: "PBD 位置动力学", en: "Position-based dynamics (PBD)" },
  summary: {
    zh: "预测位置，逐个投影边长和体积约束（高斯–赛德尔），由位移得到速度；刚度 k∈[0,1] 随迭代次数变。",
    en: "Predict positions, project edge-length and volume constraints one at a time (Gauss–Seidel), take velocities from the motion; the stiffness k ∈ [0, 1] depends on the iteration count.",
  },
  parameters: [
    { key: "pbdIterations", kind: "number", default: 6, min: 1, max: 40, step: 1, label: { zh: "迭代次数", en: "Iterations" } },
    {
      key: "pbdStiffness", kind: "number", default: 0.5, min: 0.05, max: 1, step: 0.05,
      label: { zh: "边刚度 k", en: "Edge stiffness k" },
      help: { zh: "乘以材质软硬（相对默认）后封顶为 1。", en: "Times the material's modulus against the default, capped at 1." },
    },
    { key: "pbdVolumeStiffness", kind: "number", default: 0.5, min: 0, max: 1, step: 0.05, label: { zh: "体积刚度", en: "Volume stiffness" } },
  ],
  solver: (piece, scene, s) => {
    const solver = new PositionBased(piece, {
      xpbd: false, iterations: Number(s.pbdIterations), stiffness: Number(s.pbdStiffness),
      volumeStiffness: Number(s.pbdVolumeStiffness), poisson: 0.45, volumeFactor: 1,
    });
    solver.setParams(scene.params);
    return Object.assign(solver, {
      setSettings: (x: typeof s) => solver.setOptions({
        iterations: Number(x.pbdIterations), stiffness: Number(x.pbdStiffness), volumeStiffness: Number(x.pbdVolumeStiffness),
      }),
    });
  },
});
