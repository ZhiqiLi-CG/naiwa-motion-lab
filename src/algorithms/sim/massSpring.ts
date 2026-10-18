/**
 * Mass–spring flesh: a damped spring along every edge of the tetrahedra, integrated either explicitly (symplectic
 * Euler in substeps) or semi-implicitly (one linearised backward Euler step, Baraff & Witkin 1998, solved by CG).
 */
import type { PhysicsParams } from "../../contracts";
import type { Settings } from "../../sim/api";
import { particleFleshBlock, type Piece, type PieceSolver } from "./flesh";
import { edgeStiffness, elements, updateEdgeShares, type Elements } from "./elements";
import { BlockSparse, CGWork } from "./linalg";
import { youngModulus } from "./material";

class MassSpring implements PieceSolver {
  private el: Elements;
  private rest: Float64Array;
  private k: Float64Array;
  private implicit = false;
  /** Explicit: the substeps asked for, and those the stability limit needs (whichever is more). */
  private substeps = 10;
  private omega = 0;
  private dampingRatio = 0.3;
  private E = 0;
  private f: Float64Array;
  // Semi-implicit: the system over the free particles.
  private freeIndex = new Int32Array(0);
  private free: number[] = [];
  private A: BlockSparse | null = null;
  private work: CGWork | null = null;
  private iterations = 30;

  constructor(private piece: Piece, settings: Readonly<Settings>) {
    this.el = elements(piece);
    this.rest = this.el.restLength;
    this.k = new Float64Array(this.rest.length);
    this.f = new Float64Array(piece.count * 3);
    this.setSettings(settings);
    this.attachmentsChanged();
  }

  setParams(p: PhysicsParams) {
    this.E = youngModulus(p);
    updateEdgeShares(this.piece, this.el);
    edgeStiffness(this.el, this.E, this.k);
    // Symplectic Euler is stable while h·ω < 2 for the fastest particle, ω² ≈ Σ k / m over its springs (h·ω < 1 for a
    // margin with the damping).
    const sum = new Float64Array(this.piece.count), E = this.piece.mesh.edges;
    for (let e = 0; e < this.k.length; e++) {
      sum[E[e * 2]] += this.k[e];
      sum[E[e * 2 + 1]] += this.k[e];
    }
    let w2 = 0;
    for (let i = 0; i < sum.length; i++) w2 = Math.max(w2, sum[i] / this.piece.m[i]);
    this.omega = Math.sqrt(w2);
  }

  setSettings(s: Readonly<Settings>) {
    this.implicit = s.integrator === "semi-implicit";
    this.substeps = Math.max(1, Math.round(Number(s.springSubsteps ?? 10)));
    this.dampingRatio = Number(s.springDamping ?? 0.3);
    this.iterations = Math.max(1, Math.round(Number(s.springCgIterations ?? 30)));
  }

  attachmentsChanged() {
    const piece = this.piece;
    this.free = [];
    this.freeIndex = new Int32Array(piece.count).fill(-1);
    for (let i = 0; i < piece.count; i++) if (!piece.fixed[i]) this.freeIndex[i] = this.free.push(i) - 1;
    const E = piece.mesh.edges, F = this.freeIndex, pairs: [number, number][] = [];
    for (const e of piece.activeEdges) {
      const a = F[E[e * 2]], b = F[E[e * 2 + 1]];
      if (a >= 0 && b >= 0) pairs.push([a, b]);
    }
    this.A = new BlockSparse(this.free.length, pairs);
    this.work = new CGWork(this.free.length);
  }

  /** Spring and damping forces at the current state into f (only active edges). Damping: ζ of each spring's own
   *  critical damping, along the spring. */
  private forces(X: Float32Array, V: Float32Array) {
    const f = this.f, E = this.piece.mesh.edges, m = this.piece.m;
    f.fill(0);
    for (const e of this.piece.activeEdges) {
      const a = E[e * 2], b = E[e * 2 + 1];
      const dx = X[b * 3] - X[a * 3], dy = X[b * 3 + 1] - X[a * 3 + 1], dz = X[b * 3 + 2] - X[a * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-12) continue;
      const nx = dx / l, ny = dy / l, nz = dz / l;
      const vrel = (V[b * 3] - V[a * 3]) * nx + (V[b * 3 + 1] - V[a * 3 + 1]) * ny + (V[b * 3 + 2] - V[a * 3 + 2]) * nz;
      const c = 2 * this.dampingRatio * Math.sqrt(this.k[e] * Math.min(m[a], m[b]));
      const s = this.k[e] * (l - this.rest[e]) + c * vrel;
      f[a * 3] += s * nx; f[a * 3 + 1] += s * ny; f[a * 3 + 2] += s * nz;
      f[b * 3] -= s * nx; f[b * 3 + 1] -= s * ny; f[b * 3 + 2] -= s * nz;
    }
  }

  step(h: number, g: readonly [number, number, number]) {
    const { x: X, v: V, fixed, w, count: n } = this.piece;
    // Back to the start of the step for the attached particles: they move with their prescribed velocity.
    for (let i = 0; i < n; i++) if (fixed[i]) for (let k = 0; k < 3; k++) X[i * 3 + k] -= V[i * 3 + k] * h;
    if (this.implicit) this.implicitStep(h, g);
    else {
      // Explicit: symplectic Euler in substeps short enough for the stiffest spring.
      const substeps = Math.max(this.substeps, Math.ceil(h * this.omega)), hs = h / substeps;
      for (let s = 0; s < substeps; s++) {
        this.forces(X, V);
        for (let i = 0; i < n; i++) {
          // A free particle moves by the force; an attached one passes it to its bone.
          if (!fixed[i]) for (let k = 0; k < 3; k++) V[i * 3 + k] += hs * (g[k] + this.f[i * 3 + k] * w[i]);
          else for (let k = 0; k < 3; k++) this.piece.reaction[i * 3 + k] += this.f[i * 3 + k] * hs;
          for (let k = 0; k < 3; k++) X[i * 3 + k] += hs * V[i * 3 + k];
        }
      }
      return;
    }
    // Semi-implicit: what the springs pull on the attached particles with at the end of the step, over the step.
    this.forces(X, V);
    for (let i = 0; i < n; i++) if (fixed[i]) for (let k = 0; k < 3; k++) this.piece.reaction[i * 3 + k] += this.f[i * 3 + k] * h;
  }

  /**
   * Baraff–Witkin: (M + h C + h² K) Δv = h (f₀ − h K v), K = −∂f/∂x and C = −∂f/∂v of the springs (the transverse part
   * of K clamped to stay positive), over the free particles; the attached ones enter through K v.
   */
  private implicitStep(h: number, g: readonly [number, number, number]) {
    const A = this.A!, piece = this.piece, { x: X, v: V, m } = piece, E = piece.mesh.edges, F = this.freeIndex;
    const nf = this.free.length;
    if (!nf) {
      for (let i = 0; i < piece.count; i++) for (let k = 0; k < 3; k++) X[i * 3 + k] += h * V[i * 3 + k];
      return;
    }
    this.forces(X, V);
    const b = new Float64Array(nf * 3), dv = new Float64Array(nf * 3);
    for (let a = 0; a < nf; a++) {
      const i = this.free[a];
      for (let k = 0; k < 3; k++) b[a * 3 + k] = h * (this.f[i * 3 + k] + m[i] * g[k]);
    }
    A.clear();
    for (let a = 0; a < nf; a++) A.addDiagonal(a, m[this.free[a]]);
    const blk = new Float64Array(9);
    for (const e of piece.activeEdges) {
      const i = E[e * 2], j = E[e * 2 + 1];
      const dx = X[j * 3] - X[i * 3], dy = X[j * 3 + 1] - X[i * 3 + 1], dz = X[j * 3 + 2] - X[i * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-12) continue;
      const n = [dx / l, dy / l, dz / l];
      const k = this.k[e], c = 2 * this.dampingRatio * Math.sqrt(k * Math.min(m[i], m[j]));
      const t = Math.max(0, 1 - this.rest[e] / l);
      // Block of K (and C) for this spring: k (n nᵀ + t (I − n nᵀ)), c n nᵀ.
      for (let r = 0; r < 3; r++) {
        for (let q = 0; q < 3; q++) {
          const nn = n[r] * n[q];
          const kb = k * (nn + t * ((r === q ? 1 : 0) - nn));
          blk[r * 3 + q] = h * h * kb + h * c * nn;
        }
      }
      // −h² K v: the spring's stiffness acting on the motion of both ends (attached ones included).
      const fi = F[i], fj = F[j];
      for (let r = 0; r < 3; r++) {
        let kvi = 0;
        for (let q = 0; q < 3; q++) {
          const kb = k * (n[r] * n[q] + t * ((r === q ? 1 : 0) - n[r] * n[q]));
          kvi += kb * (V[i * 3 + q] - V[j * 3 + q]);
        }
        if (fi >= 0) b[fi * 3 + r] -= h * h * kvi;
        if (fj >= 0) b[fj * 3 + r] += h * h * kvi;
      }
      addBlock(A, fi, fi, blk, 1);
      addBlock(A, fj, fj, blk, 1);
      addBlock(A, fi, fj, blk, -1);
      addBlock(A, fj, fi, blk, -1);
    }
    A.solve(b, dv, this.iterations, 1e-5, this.work!);
    for (let a = 0; a < nf; a++) {
      const i = this.free[a];
      for (let k = 0; k < 3; k++) V[i * 3 + k] += dv[a * 3 + k];
    }
    for (let i = 0; i < piece.count; i++) for (let k = 0; k < 3; k++) X[i * 3 + k] += h * V[i * 3 + k];
  }
}

function addBlock(A: BlockSparse, i: number, j: number, blk: Float64Array, sign: number) {
  if (i < 0 || j < 0) return;
  const s = A.slot(i, j) * 9;
  for (let k = 0; k < 9; k++) A.values[s + k] += sign * blk[k];
}

export const massSpring = particleFleshBlock({
  id: "mass-spring",
  name: { zh: "质点–弹簧", en: "Mass–spring" },
  summary: {
    zh: "四面体每条边一根带阻尼的弹簧；显式（辛欧拉分步）或半隐式（线性化后向欧拉，Baraff–Witkin，共轭梯度求解）。",
    en: "A damped spring on every edge of the tetrahedra; explicit (symplectic Euler in substeps) or semi-implicit (linearised backward Euler, Baraff–Witkin, solved by conjugate gradients).",
  },
  parameters: [
    {
      key: "integrator", kind: "choice", default: "explicit",
      label: { zh: "积分器", en: "Integrator" },
      choices: [
        { value: "explicit", label: { zh: "显式（辛欧拉）", en: "Explicit (symplectic Euler)" } },
        { value: "semi-implicit", label: { zh: "半隐式（Baraff–Witkin）", en: "Semi-implicit (Baraff–Witkin)" } },
      ],
    },
    {
      key: "springSubsteps", kind: "number", default: 10, min: 1, max: 40, step: 1,
      label: { zh: "显式分步", en: "Explicit substeps" },
      help: { zh: "显式积分每步的子步数：太少会炸开。", en: "Substeps per step of the explicit integrator: too few and it blows up." },
    },
    {
      key: "springDamping", kind: "number", default: 0.3, min: 0, max: 1, step: 0.05,
      label: { zh: "弹簧阻尼比", en: "Spring damping ratio" },
    },
    {
      key: "springCgIterations", kind: "number", default: 30, min: 5, max: 100, step: 5,
      label: { zh: "CG 迭代（半隐式）", en: "CG iterations (semi-implicit)" },
    },
  ],
  solver: (piece, scene, settings) => {
    const s = new MassSpring(piece, settings);
    s.setParams(scene.params);
    return s;
  },
});
