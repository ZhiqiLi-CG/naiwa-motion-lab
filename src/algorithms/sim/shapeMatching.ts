/**
 * Shape matching (Müller et al. 2005, "Meshless deformations based on shape matching"): no elements at all. Each
 * cluster of particles finds the rigid motion (rotation R and centre c) that best fits its rest shape to where its
 * particles are, and pulls every particle a fraction α of the way to its goal g = R q + c. Clusters here are the
 * flesh regions (belly, body, head, …), each grown by one ring of neighbours so that they overlap and the regions do
 * not split along a seam; a particle in several clusters goes to the mean of its goals. Attached particles take part
 * in the fit, so the bones carry the clusters.
 */
import type { PhysicsParams } from "../../contracts";
import type { Settings } from "../../sim/api";
import { particleFleshBlock, type Piece, type PieceSolver } from "./flesh";
import { extractRotation, inv3, m3, mul3 } from "./linalg";
import { lerpLog, regionStiffness } from "./material";

interface Cluster {
  ids: Uint32Array;
  /** Rest offsets from the rest centre of mass. */
  q: Float64Array;
  mass: number;
  /** (Σ m q qᵀ)⁻¹, for the linear (affine) blend. */
  Aqq: Float64Array;
  /** Pull per step (0..1) for this cluster's region. */
  alpha: number;
  region: number;
  /** Warm start of the rotation. */
  quat: Float64Array;
}

class ShapeMatching implements PieceSolver {
  private clusters: Cluster[] = [];
  private goal: Float64Array;
  private count: Float64Array;
  private p: Float64Array;
  private iterations = 1;
  private stiffness = 0.25;
  private beta = 0;
  private softness = 0.5;
  private regionK: Float64Array = new Float64Array(0);

  constructor(private piece: Piece, settings: Readonly<Settings>) {
    const n = piece.count, E = piece.mesh.edges, X = piece.rest;
    this.goal = new Float64Array(n * 3);
    this.count = new Float64Array(n);
    this.p = new Float64Array(n * 3);
    const neighbours: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < E.length; e += 2) {
      neighbours[E[e]].push(E[e + 1]);
      neighbours[E[e + 1]].push(E[e]);
    }
    const regions = [...new Set(piece.region)];
    for (const r of regions) {
      const members = new Set<number>();
      for (let i = 0; i < n; i++) if (piece.region[i] === r) members.add(i);
      // Grow by one ring of neighbours: neighbouring clusters overlap.
      for (const i of [...members]) for (const j of neighbours[i]) members.add(j);
      const ids = Uint32Array.from(members);
      let mass = 0, cx = 0, cy = 0, cz = 0;
      for (const i of ids) {
        mass += piece.m[i];
        cx += piece.m[i] * X[i * 3];
        cy += piece.m[i] * X[i * 3 + 1];
        cz += piece.m[i] * X[i * 3 + 2];
      }
      cx /= mass; cy /= mass; cz /= mass;
      const q = new Float64Array(ids.length * 3), A = m3();
      ids.forEach((i, k) => {
        q[k * 3] = X[i * 3] - cx;
        q[k * 3 + 1] = X[i * 3 + 1] - cy;
        q[k * 3 + 2] = X[i * 3 + 2] - cz;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a * 3 + b] += piece.m[i] * q[k * 3 + a] * q[k * 3 + b];
      });
      this.clusters.push({ ids, q, mass, Aqq: inv3(A, m3()), alpha: 0.5, region: r, quat: new Float64Array([0, 0, 0, 1]) });
    }
    this.setSettings(settings);
  }

  setParams(p: PhysicsParams) {
    this.softness = p.softness;
    this.regionK = regionStiffness(p);
    this.update();
  }

  setSettings(s: Readonly<Settings>) {
    this.iterations = Math.max(1, Math.round(Number(s.smIterations ?? 1)));
    this.stiffness = Number(s.smStiffness ?? 0.25);
    this.beta = Number(s.smLinear ?? 0);
    this.update();
  }

  /** α per cluster: the stiffness slider, firmer for firm regions and for a firm material, per iteration. */
  private update() {
    const material = lerpLog(2, 0.5, Math.min(1, Math.max(0, this.softness)));
    for (const c of this.clusters) {
      const k = Math.min(1, this.stiffness * material * ((this.regionK[c.region] ?? 1) / 2));
      c.alpha = 1 - Math.pow(1 - k, 1 / this.iterations);
    }
  }

  step(h: number, g: readonly [number, number, number]) {
    const { x: X, v: V, fixed, m, count: n } = this.piece, p = this.p, goal = this.goal, cnt = this.count;
    // Predict: attached particles are already where their bones carry them.
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) p[i * 3 + k] = fixed[i] ? X[i * 3 + k] : X[i * 3 + k] + h * (V[i * 3 + k] + h * g[k]);
    }
    const Apq = m3(), R = m3(), G = m3(), A = m3();
    for (let it = 0; it < this.iterations; it++) {
      goal.fill(0);
      cnt.fill(0);
      for (const c of this.clusters) {
        // Centre of mass now, and A_pq = Σ m (p − c) qᵀ.
        let cx = 0, cy = 0, cz = 0;
        for (const i of c.ids) {
          cx += m[i] * p[i * 3];
          cy += m[i] * p[i * 3 + 1];
          cz += m[i] * p[i * 3 + 2];
        }
        cx /= c.mass; cy /= c.mass; cz /= c.mass;
        Apq.fill(0);
        c.ids.forEach((i, k) => {
          const px = p[i * 3] - cx, py = p[i * 3 + 1] - cy, pz = p[i * 3 + 2] - cz, mi = m[i];
          const qx = c.q[k * 3], qy = c.q[k * 3 + 1], qz = c.q[k * 3 + 2];
          Apq[0] += mi * px * qx; Apq[1] += mi * px * qy; Apq[2] += mi * px * qz;
          Apq[3] += mi * py * qx; Apq[4] += mi * py * qy; Apq[5] += mi * py * qz;
          Apq[6] += mi * pz * qx; Apq[7] += mi * pz * qy; Apq[8] += mi * pz * qz;
        });
        extractRotation(Apq, c.quat, R, 4);
        // G = β A + (1 − β) R, A = A_pq A_qq⁻¹ scaled to keep its volume (det A = 1).
        if (this.beta > 0) {
          mul3(Apq, c.Aqq, A);
          const d = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
          const s = d > 1e-9 ? 1 / Math.cbrt(d) : 0;
          for (let k = 0; k < 9; k++) G[k] = this.beta * A[k] * s + (1 - this.beta) * R[k];
        } else G.set(R);
        c.ids.forEach((i, k) => {
          const qx = c.q[k * 3], qy = c.q[k * 3 + 1], qz = c.q[k * 3 + 2];
          goal[i * 3] += c.alpha * (G[0] * qx + G[1] * qy + G[2] * qz + cx - p[i * 3]);
          goal[i * 3 + 1] += c.alpha * (G[3] * qx + G[4] * qy + G[5] * qz + cy - p[i * 3 + 1]);
          goal[i * 3 + 2] += c.alpha * (G[6] * qx + G[7] * qy + G[8] * qz + cz - p[i * 3 + 2]);
          cnt[i]++;
        });
      }
      // Each particle moves by the mean of its clusters' pulls; an attached one passes that pull to its bone.
      for (let i = 0; i < n; i++) {
        if (!cnt[i]) continue;
        for (let k = 0; k < 3; k++) {
          const d = goal[i * 3 + k] / cnt[i];
          if (fixed[i]) this.piece.reaction[i * 3 + k] += (m[i] * d) / h;
          else p[i * 3 + k] += d;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        V[i * 3 + k] = (p[i * 3 + k] - X[i * 3 + k]) / h;
        X[i * 3 + k] = p[i * 3 + k];
      }
    }
  }
}

export const shapeMatching = particleFleshBlock({
  id: "shape-matching",
  name: { zh: "形状匹配", en: "Shape matching" },
  summary: {
    zh: "每个区域一簇粒子（相邻簇重叠），拟合最佳刚体运动 R、c，把粒子按 α 拉向目标 Rq+c；无网格、无条件稳定。",
    en: "One cluster of particles per region (neighbouring clusters overlap) fits its best rigid motion R, c and pulls each particle a fraction α towards its goal Rq + c; meshless and unconditionally stable.",
  },
  parameters: [
    { key: "smStiffness", kind: "number", default: 0.25, min: 0.02, max: 1, step: 0.02, label: { zh: "拉回强度 α", en: "Pull α" } },
    { key: "smIterations", kind: "number", default: 1, min: 1, max: 8, step: 1, label: { zh: "迭代次数", en: "Iterations" } },
    {
      key: "smLinear", kind: "number", default: 0, min: 0, max: 1, step: 0.05,
      label: { zh: "线性形变 β", en: "Linear deformation β" },
      help: { zh: "目标从刚体运动混向保体积的仿射变换：簇可以拉伸、剪切。", en: "Blend the goal from the rigid motion towards a volume-keeping affine map: clusters may stretch and shear." },
    },
  ],
  solver: (piece, scene, settings) => {
    const s = new ShapeMatching(piece, settings);
    s.setParams(scene.params);
    return s;
  },
});
