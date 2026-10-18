/**
 * Projective Dynamics (Bouaziz et al. 2014): implicit Euler as an energy minimisation, solved by alternating
 *
 *   local   each cell projects its deformation F onto its constraint set: the nearest rotation R (as rigid as
 *           possible), and F scaled to keep its volume;
 *   global  one linear solve for all positions, (M/h² + Σ w GᵀG) x = M/h² s + Σ w Gᵀ T, whose matrix does not change
 *           from step to step: it is factored once (sparse Cholesky) and each iteration costs only two triangular
 *           solves per axis.
 *
 * The matrix changes only when particles are attached or detached (they move to the right-hand side) or the material
 * changes; then it is factored again.
 */
import type { PhysicsParams } from "../../contracts";
import type { Settings } from "../../sim/api";
import { deformation, elements, type Elements } from "./elements";
import { particleFleshBlock, type Piece, type PieceSolver } from "./flesh";
import { EnvelopeCholesky, det3, extractRotation, m3 } from "./linalg";
import { lame, youngModulus } from "./material";

class ProjectiveDynamics implements PieceSolver {
  private el: Elements;
  private iterations = 3;
  private poisson = 0.4;
  private E = 0;
  /** Weights of the two constraints of each cell: as rigid as possible (2μV) and volume (λV). */
  private wShape: Float64Array;
  private wVolume: Float64Array;
  private quat: Float64Array;
  private free: number[] = [];
  private freeIndex = new Int32Array(0);
  private chol: EnvelopeCholesky | null = null;
  private dirty = true;
  private s: Float64Array;
  private rhs: Float64Array;
  private target: Float64Array;

  constructor(private piece: Piece, settings: Readonly<Settings>) {
    this.el = elements(piece);
    const nt = this.el.volume.length;
    this.wShape = new Float64Array(nt);
    this.wVolume = new Float64Array(nt);
    this.quat = new Float64Array(nt * 4);
    for (let t = 0; t < nt; t++) this.quat[t * 4 + 3] = 1;
    this.s = new Float64Array(piece.count * 3);
    this.rhs = new Float64Array(piece.count * 3);
    this.target = new Float64Array(nt * 9);
    this.setSettings(settings);
  }

  setParams(p: PhysicsParams) {
    this.E = youngModulus(p);
    this.updateWeights();
  }

  setSettings(s: Readonly<Settings>) {
    this.iterations = Math.max(1, Math.round(Number(s.pdIterations ?? 3)));
    const nu = Number(s.pdPoisson ?? 0.4);
    if (nu !== this.poisson) {
      this.poisson = nu;
      this.updateWeights();
    }
  }

  private updateWeights() {
    const { mu, lambda } = lame(this.E, this.poisson), ts = this.piece.tetStiffness, V = this.el.volume;
    // Only a changed weight needs a new factorisation (the page also sends the sliders while the belly is pumped).
    for (let t = 0; t < V.length; t++) {
      const ws = 2 * mu * V[t] * ts[t], wv = lambda * V[t] * ts[t];
      if (ws !== this.wShape[t] || wv !== this.wVolume[t]) this.dirty = true;
      this.wShape[t] = ws;
      this.wVolume[t] = wv;
    }
  }

  attachmentsChanged() {
    this.dirty = true;
  }

  /** Factor M/h² + Σ (w_shape + w_volume) GᵀG over the free particles. */
  private factor(h: number) {
    const piece = this.piece, T = piece.mesh.tets, grad = this.el.grad;
    this.free = [];
    this.freeIndex = new Int32Array(piece.count).fill(-1);
    for (let i = 0; i < piece.count; i++) if (!piece.fixed[i]) this.freeIndex[i] = this.free.push(i) - 1;
    const F = this.freeIndex, nf = this.free.length;
    const nb: Set<number>[] = Array.from({ length: nf }, () => new Set());
    for (const t of piece.activeTets) {
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const i = F[T[t * 4 + a]], j = F[T[t * 4 + b]];
          if (i >= 0 && j >= 0 && i !== j) nb[i].add(j);
        }
      }
    }
    const chol = new EnvelopeCholesky(nf, nb.map((s) => [...s]));
    for (let k = 0; k < nf; k++) chol.add(k, k, piece.m[this.free[k]] / (h * h));
    for (const t of piece.activeTets) {
      const w = this.wShape[t] + this.wVolume[t];
      for (let a = 0; a < 4; a++) {
        const i = F[T[t * 4 + a]];
        if (i < 0) continue;
        for (let b = 0; b <= a; b++) {
          const j = F[T[t * 4 + b]];
          if (j < 0) continue;
          const ga = t * 12 + a * 3, gb = t * 12 + b * 3;
          const d = w * (grad[ga] * grad[gb] + grad[ga + 1] * grad[gb + 1] + grad[ga + 2] * grad[gb + 2]);
          // Each unordered pair once (the matrix is symmetric; add() stores the lower triangle).
          chol.add(i, j, d);
        }
      }
    }
    chol.factor();
    this.chol = chol;
    this.dirty = false;
  }

  /** Local step: the projections T of every active cell's F (the weighted mean of its two targets). */
  private local() {
    const piece = this.piece, T = piece.mesh.tets, grad = this.el.grad, F = m3(), R = m3();
    for (const t of piece.activeTets) {
      deformation(T, grad, piece.x, t, F);
      extractRotation(F, this.quat, R, 2, t * 4);
      const d = det3(F);
      // Volume: F scaled to det 1 (an inverted cell: towards its rotation).
      const s = d > 1e-6 ? 1 / Math.cbrt(d) : 0;
      const ws = this.wShape[t], wv = this.wVolume[t], w = ws + wv;
      for (let k = 0; k < 9; k++) this.target[t * 9 + k] = (ws * R[k] + wv * (s > 0 ? F[k] * s : R[k])) / w;
    }
  }

  step(h: number, g: readonly [number, number, number]) {
    if (this.dirty || !this.chol) this.factor(h);
    const piece = this.piece, { x: X, v: V, fixed, m } = piece, n = piece.count, T = piece.mesh.tets, grad = this.el.grad;
    const free = this.free, rhs = this.rhs, s = this.s;
    // Inertial target s = x + h v + h² g; start from it.
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        s[i * 3 + k] = X[i * 3 + k] + h * V[i * 3 + k] + h * h * g[k];
      }
    }
    const old = Float64Array.from(X);
    for (const i of free) for (let k = 0; k < 3; k++) X[i * 3 + k] = s[i * 3 + k];
    for (let it = 0; it < this.iterations; it++) {
      this.local();
      // rhs = M/h² s + Σ w Gᵀ T − (coupling to the attached particles, which sit on the right-hand side).
      rhs.fill(0);
      for (const i of free) for (let k = 0; k < 3; k++) rhs[i * 3 + k] = (m[i] / (h * h)) * s[i * 3 + k];
      for (const t of piece.activeTets) {
        const w = this.wShape[t] + this.wVolume[t];
        for (let a = 0; a < 4; a++) {
          const i = T[t * 4 + a];
          if (fixed[i]) continue;
          const ga = t * 12 + a * 3;
          for (let r = 0; r < 3; r++) {
            const Tr = t * 9 + r * 3;
            rhs[i * 3 + r] += w * (this.target[Tr] * grad[ga] + this.target[Tr + 1] * grad[ga + 1] + this.target[Tr + 2] * grad[ga + 2]);
          }
          for (let b = 0; b < 4; b++) {
            const j = T[t * 4 + b];
            if (!fixed[j]) continue;
            const gb = t * 12 + b * 3;
            const d = w * (grad[ga] * grad[gb] + grad[ga + 1] * grad[gb + 1] + grad[ga + 2] * grad[gb + 2]);
            for (let r = 0; r < 3; r++) rhs[i * 3 + r] -= d * X[j * 3 + r];
          }
        }
      }
      // Global step: the prefactored solve, axis by axis, on the free particles' entries.
      const b = new Float64Array(free.length * 3);
      free.forEach((i, k) => {
        for (let r = 0; r < 3; r++) b[k * 3 + r] = rhs[i * 3 + r];
      });
      for (let r = 0; r < 3; r++) this.chol!.solve(b, 3, r);
      free.forEach((i, k) => {
        for (let r = 0; r < 3; r++) X[i * 3 + r] = b[k * 3 + r];
      });
    }
    for (const i of free) for (let k = 0; k < 3; k++) V[i * 3 + k] = (X[i * 3 + k] - old[i * 3 + k]) / h;
    // The elastic force on each attached particle, −Σ w (F − T) ∇N, over the step (T from the last local step).
    const F = m3();
    for (const t of piece.boundaryTets) {
      deformation(T, grad, X, t, F);
      const w = this.wShape[t] + this.wVolume[t];
      for (let a = 0; a < 4; a++) {
        const i = T[t * 4 + a];
        if (!fixed[i]) continue;
        const ga = t * 12 + a * 3;
        for (let r = 0; r < 3; r++) {
          let f = 0;
          for (let c = 0; c < 3; c++) f -= w * (F[r * 3 + c] - this.target[t * 9 + r * 3 + c]) * grad[ga + c];
          piece.reaction[i * 3 + r] += f * h;
        }
      }
    }
  }
}

export const projectiveDynamics = particleFleshBlock({
  id: "projective-dynamics",
  name: { zh: "投影动力学", en: "Projective Dynamics" },
  summary: {
    zh: "隐式欧拉写成能量最小化：局部步把每个单元投影到最近的旋转和保体积形状，全局步解一个预先分解好的线性方程组。",
    en: "Implicit Euler as energy minimisation: a local step projects each cell onto its nearest rotation and a volume-keeping shape, a global step solves one prefactored linear system.",
  },
  parameters: [
    { key: "pdIterations", kind: "number", default: 3, min: 1, max: 30, step: 1, label: { zh: "局部/全局迭代", en: "Local/global iterations" } },
    { key: "pdPoisson", kind: "number", default: 0.4, min: 0, max: 0.48, step: 0.02, label: { zh: "泊松比（体积权重）", en: "Poisson ratio (volume weight)" } },
  ],
  solver: (piece, scene, settings) => {
    const s = new ProjectiveDynamics(piece, settings);
    s.setParams(scene.params);
    return s;
  },
});
