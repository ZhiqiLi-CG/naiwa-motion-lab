/**
 * Metrics block: the quality numbers of docs/soft-binding.md, from the flesh's particles, its targets and the bones.
 * A pass over everything, so the page calls it a few times a second.
 */
import * as THREE from "three";
import type { BlockDefinition, Metrics, MetricsBlock, Scene } from "../api";

function measure(scene: Scene): Metrics {
  const g = -scene.world.gravity.y;
  let devSum = 0, devMax = 0, jitter = 0, n = 0, inverted = 0, energy = 0;
  const momentum: [number, number, number] = [0, 0, 0];
  const volume: Record<string, number> = {};
  for (const part of scene.parts) {
    const view = scene.flesh.particles(part);
    const P = view.positions(), T = scene.target.targets(part), TV = scene.target.targetVelocities(part);
    const rapier = scene.flesh.rapier?.(part);
    const V = rapier?.particleVelocities();
    for (let i = 0; i < view.count; i++) {
      const d = Math.hypot(P[i * 3] - T[i * 3], P[i * 3 + 1] - T[i * 3 + 1], P[i * 3 + 2] - T[i * 3 + 2]);
      devSum += d;
      devMax = Math.max(devMax, d);
      n++;
      if (!V) continue;
      const m = view.mass(i);
      const vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      jitter += Math.hypot(vx - TV[i * 3], vy - TV[i * 3 + 1], vz - TV[i * 3 + 2]);
      momentum[0] += m * vx;
      momentum[1] += m * vy;
      momentum[2] += m * vz;
      energy += 0.5 * m * (vx * vx + vy * vy + vz * vz) + m * g * P[i * 3 + 1];
    }
    volume[part.name] = scene.flesh.volumeRatio?.(part) ?? 1;
    const cells = scene.flesh.cells?.(part);
    if (cells) inverted += invertedCells(cells, view.rest, P);
  }
  for (const b of scene.skeleton.bones.values()) {
    const m = b.body.mass(), v = b.body.linvel(), t = b.body.translation();
    momentum[0] += m * v.x;
    momentum[1] += m * v.y;
    momentum[2] += m * v.z;
    energy += 0.5 * m * (v.x * v.x + v.y * v.y + v.z * v.z) + m * g * t.y;
  }
  return {
    deviation: devSum / Math.max(1, n), deviationMax: devMax, invertedCells: inverted, volume,
    penetration: penetration(scene), jitter: jitter / Math.max(1, n), momentum, energy,
  };
}

/** Cells whose signed volume has the opposite sign of their rest volume. */
function invertedCells(cells: Uint32Array, rest: Float32Array, P: Float32Array): number {
  let count = 0;
  for (let c = 0; c < cells.length; c += 4) {
    if (signedVolume(rest, cells, c) * signedVolume(P, cells, c) < 0) count++;
  }
  return count;
}

function signedVolume(P: Float32Array, cells: Uint32Array, c: number): number {
  const a = cells[c] * 3, b = cells[c + 1] * 3, d = cells[c + 2] * 3, e = cells[c + 3] * 3;
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
  const wx = P[e] - P[a], wy = P[e + 1] - P[a + 1], wz = P[e + 2] - P[a + 2];
  return ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx);
}

/** Deepest a limb's contact capsule reaches into the Body: the most any Body surface vertex is inside one. */
function penetration(scene: Scene): number {
  const body = scene.parts.find((p) => !p.limb);
  if (!body) return 0;
  const S = scene.flesh.surface?.(body) ?? scene.flesh.particles(body).positions();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), m = new THREE.Matrix4();
  const seg = new THREE.Line3(), closest = new THREE.Vector3();
  let deepest = 0;
  for (const bone of scene.skeleton.bones.values()) {
    for (const shape of bone.shapes) {
      if (shape.kind !== "capsule" || shape.role !== "contact") continue;
      bone.pose(m);
      seg.set(a.copy(shape.a).applyMatrix4(m), b.copy(shape.b).applyMatrix4(m));
      for (let v = 0; v < S.length; v += 3) {
        seg.closestPointToPoint(p.fromArray(S, v), true, closest);
        deepest = Math.max(deepest, shape.radius - closest.distanceTo(p));
      }
    }
  }
  return deepest;
}

export const qualityMetrics: BlockDefinition<"metrics"> = {
  id: "quality-metrics",
  slot: "metrics",
  name: { zh: "质量指标", en: "Quality metrics" },
  summary: {
    zh: "偏离目标、翻转单元、各部分体积、四肢入体深度、静止抖动、动量和能量。",
    en: "Deviation from the target, inverted cells, volume per part, limb penetration, jitter at rest, momentum and energy.",
  },
  device: "cpu",
  parameters: [],
  create: (): MetricsBlock => ({ measure }),
};
