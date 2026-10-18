/**
 * Extended position-based dynamics (Macklin et al. 2016) with small steps (Macklin et al. 2019): the same distance
 * and volume constraints as PBD, each with a compliance α = 1/k from the material (Young's modulus, Poisson ratio),
 * so the flesh is as stiff whatever the substeps. The solver is in positionBased.ts.
 */
import { particleFleshBlock } from "./flesh";
import { PositionBased } from "./positionBased";

export const xpbd = particleFleshBlock({
  id: "xpbd",
  name: { zh: "XPBD 柔度位置动力学", en: "Extended PBD (XPBD)" },
  summary: {
    zh: "PBD 加上柔度 α=1/k 和拉格朗日乘子：刚度来自杨氏模量，不随迭代次数变；小步长（多子步、每步一次迭代）。",
    en: "PBD with compliance α = 1/k and Lagrange multipliers: the stiffness comes from Young's modulus and does not change with iterations; small steps (many substeps, one iteration each).",
  },
  parameters: [
    {
      key: "xpbdSubsteps", kind: "number", default: 8, min: 1, max: 30, step: 1,
      label: { zh: "子步数", en: "Substeps" },
      help: { zh: "越多越接近真实刚度（硬的材质需要更多）。", en: "More gets closer to the true stiffness (firm material needs more)." },
    },
    { key: "xpbdPoisson", kind: "number", default: 0.45, min: 0, max: 0.49, step: 0.01, label: { zh: "泊松比", en: "Poisson ratio" } },
  ],
  solver: (piece, scene, s) => {
    const solver = new PositionBased(piece, {
      xpbd: true, iterations: Number(s.xpbdSubsteps), stiffness: 1, volumeStiffness: 1, poisson: Number(s.xpbdPoisson), volumeFactor: 1,
    });
    solver.setParams(scene.params);
    return Object.assign(solver, {
      setSettings: (x: typeof s) => solver.setOptions({ iterations: Number(x.xpbdSubsteps), poisson: Number(x.xpbdPoisson) }),
    });
  },
});
