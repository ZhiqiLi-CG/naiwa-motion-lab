/**
 * The page-level quality checks of the e2e run (tests/e2e/lib/instrument.js), for the Node tests: limb flesh that
 * ends up inside the Body, and how far the head's surface is from a rigid copy of its rest shape.
 */
import { TriMesh } from "./geometry";
import type { LabFrogSim } from "./core";

const REGION_NAMES = ["belly", "body", "head", "arm", "hand", "leg", "foot"];

export interface Interpenetration {
  /** Per limb region: vertices outside the Body at rest that are now more than `tol` inside it, and the deepest. */
  per: Record<string, { inside: number; maxDepth: number }>;
  /** Where the head's worst vertex sits at rest. */
  head: { rms: number; max: number; at: number[] };
}

/** The e2e's "no limb inside the body" and "the head keeps its shape" measures for one frame. */
export function interpenetration(sim: LabFrogSim, restInside: Uint8Array[], tol = 0.01): Interpenetration {
  const spec = sim.scene.spec, body = sim.readBody();
  const mesh = new TriMesh(body, spec.body.indices);
  const limbs = new Map<string, Float32Array>();
  sim.readLimbs(limbs);
  const per: Interpenetration["per"] = {};
  (spec.limbs ?? []).forEach((l, li) => {
    const p = limbs.get(l.name);
    if (!p) return;
    for (let i = 0; i < p.length / 3; i++) {
      const region = REGION_NAMES[l.regions?.[i] ?? 3] ?? "arm";
      const r = (per[region] ??= { inside: 0, maxDepth: 0 });
      if (restInside[li][i]) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (!mesh.contains(x, y, z)) continue;
      const depth = -mesh.signedDistance(x, y, z);
      if (depth <= tol) continue;
      r.inside++;
      r.maxDepth = Math.max(r.maxDepth, depth);
    }
  });
  const ids: number[] = [];
  spec.body.regions?.forEach((r, i) => r === 2 && ids.push(i));
  const A = new Float64Array(ids.length * 3), B = new Float64Array(ids.length * 3);
  ids.forEach((v, j) => {
    for (let k = 0; k < 3; k++) {
      A[j * 3 + k] = spec.body.positions[v * 3 + k];
      B[j * 3 + k] = body[v * 3 + k];
    }
  });
  const d = rigidResidual(A, B);
  const worst = d.indexOf(Math.max(...d));
  return {
    per,
    head: { rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length), max: d[worst], at: Array.from(A.slice(worst * 3, worst * 3 + 3)) },
  };
}

/** Which limb vertices lie inside the Body at rest (they are allowed to stay there). */
export function restInside(sim: LabFrogSim): Uint8Array[] {
  const spec = sim.scene.spec, mesh = new TriMesh(spec.body.positions, spec.body.indices);
  return (spec.limbs ?? []).map((l) => {
    const out = new Uint8Array(l.positions.length / 3);
    for (let i = 0; i < out.length; i++) out[i] = mesh.signedDistance(l.positions[i * 3], l.positions[i * 3 + 1], l.positions[i * 3 + 2]) < 0 ? 1 : 0;
    return out;
  });
}

/** Per-point distance of B from the best rigid copy of A (Horn's quaternion method), as the e2e computes it. */
function rigidResidual(A: Float64Array, B: Float64Array): number[] {
  const n = A.length / 3, ca = [0, 0, 0], cb = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { ca[k] += A[i * 3 + k] / n; cb[k] += B[i * 3 + k] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += (A[i * 3 + r] - ca[r]) * (B[i * 3 + c] - cb[c]);
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(N[p][q]) < 1e-15) continue;
      const th = (N[q][q] - N[p][p]) / (2 * N[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const a = N[k][p], b = N[k][q]; N[k][p] = c * a - s * b; N[k][q] = s * a + c * b; }
      for (let k = 0; k < 4; k++) { const a = N[p][k], b = N[q][k]; N[p][k] = c * a - s * b; N[q][k] = s * a + c * b; }
      for (let k = 0; k < 4; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = c * a - s * b; V[k][q] = s * a + c * b; }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (N[k][k] > N[best][best]) best = k;
  const [w, x, y, z] = [V[0][best], V[1][best], V[2][best], V[3][best]];
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = [A[i * 3] - ca[0], A[i * 3 + 1] - ca[1], A[i * 3 + 2] - ca[2]];
    let d = 0;
    for (let r = 0; r < 3; r++) d += (R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2] + cb[r] - B[i * 3 + r]) ** 2;
    out.push(Math.sqrt(d));
  }
  return out;
}
