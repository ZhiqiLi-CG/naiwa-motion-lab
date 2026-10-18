/**
 * Metrics block: the built-in quality metrics, with the flesh's velocities read from any solver that gives them (the
 * built-in block reads velocities from Rapier soft bodies only, so jitter, momentum and energy would leave out the
 * flesh of the library's solvers).
 */
import type { BlockDefinition, Metrics, MetricsBlock, Scene } from "../../sim/api";
import { qualityMetrics } from "../../sim/blocks/qualityMetrics";
import { isSimParticles } from "./flesh";

function measure(base: MetricsBlock, scene: Scene): Metrics {
  const out = base.measure(scene);
  if (scene.flesh.rapier) return out;
  const g = -scene.world.gravity.y;
  let jitter = 0, n = 0, energy = out.energy;
  const momentum = [...out.momentum] as [number, number, number];
  for (const part of scene.parts) {
    const view = scene.flesh.particles(part);
    if (!isSimParticles(view)) continue;
    const P = view.positions(), V = view.velocities(), TV = scene.target.targetVelocities(part);
    for (let i = 0; i < view.count; i++) {
      const m = view.mass(i), vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      jitter += Math.hypot(vx - TV[i * 3], vy - TV[i * 3 + 1], vz - TV[i * 3 + 2]);
      n++;
      // Attached particles' mass rides on their bones (flesh.ts), which the base already counted.
      if (view.attachedTo(i)) continue;
      momentum[0] += m * vx;
      momentum[1] += m * vy;
      momentum[2] += m * vz;
      energy += 0.5 * m * (vx * vx + vy * vy + vz * vz) + m * g * P[i * 3 + 1];
    }
  }
  return { ...out, jitter: jitter / Math.max(1, n), momentum, energy };
}

export const particleMetrics: BlockDefinition<"metrics"> = {
  id: "particle-metrics",
  slot: "metrics",
  name: { zh: "质量指标（粒子速度）", en: "Quality metrics (particle velocities)" },
  summary: {
    zh: "内置质量指标，抖动、动量和能量用求解器自己的粒子速度。",
    en: "The built-in quality metrics, with jitter, momentum and energy from the solver's own particle velocities.",
  },
  device: "cpu",
  parameters: [],
  create: (scene, settings) => {
    const base = qualityMetrics.create(scene, settings) as MetricsBlock;
    return { measure: (s) => measure(base, s) };
  },
};
