/**
 * Metrics block "mpm-quality-metrics": the built-in quality metrics, plus what they read from Rapier's soft bodies
 * only (particle velocities: jitter, the flesh's momentum and energy), here from the MPM flesh. Inverted cells are
 * particles whose deformation turned inside out (det F ≤ 0): MPM has no cells.
 */
import type { BlockDefinition, Metrics, MetricsBlock, Scene } from "../api";
import { qualityMetrics } from "../blocks/qualityMetrics";
import { MpmFlesh } from "./mpmFlesh";

function measure(base: MetricsBlock, scene: Scene): Metrics {
  const m = base.measure(scene);
  const flesh = scene.flesh;
  if (!(flesh instanceof MpmFlesh)) return m;
  const g = -scene.world.gravity.y;
  let jitter = 0, n = 0, inverted = 0;
  for (const part of scene.parts) {
    const view = flesh.particles(part), P = view.positions(), V = flesh.velocities(part), TV = scene.target.targetVelocities(part);
    const J = flesh.output?.positions;
    const first = (view as unknown as { pm: { first: number } }).pm.first;
    for (let i = 0; i < view.count; i++) {
      const mass = view.mass(i), vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      jitter += Math.hypot(vx - TV[i * 3], vy - TV[i * 3 + 1], vz - TV[i * 3 + 2]);
      n++;
      // Attached particles are part of their bones' rigid bodies, which the base metrics count already.
      if (view.attachedTo(i)) continue;
      m.momentum[0] += mass * vx;
      m.momentum[1] += mass * vy;
      m.momentum[2] += mass * vz;
      m.energy += 0.5 * mass * (vx * vx + vy * vy + vz * vz) + mass * g * P[i * 3 + 1];
      if (J && J[(first + i) * 4 + 3] <= 0) inverted++;
    }
  }
  return { ...m, jitter: jitter / Math.max(1, n), invertedCells: inverted };
}

export const mpmMetrics: BlockDefinition<"metrics"> = {
  id: "mpm-quality-metrics",
  slot: "metrics",
  name: { zh: "质量指标（MPM）", en: "Quality metrics (MPM)" },
  summary: {
    zh: "内置的质量指标，加上从 MPM 粒子读出的静止抖动、肉的动量和能量；“翻转单元”是 det F ≤ 0 的粒子。",
    en: "The built-in quality metrics, plus jitter, the flesh's momentum and energy read from the MPM particles; \"inverted cells\" are particles with det F ≤ 0.",
  },
  device: "cpu",
  parameters: [],
  create: async (scene, settings) => {
    const base = await qualityMetrics.create(scene, settings);
    return { measure: (s: Scene) => measure(base, s) };
  },
};
