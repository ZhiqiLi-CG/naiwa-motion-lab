/**
 * Tetrahedral finite elements with an implicit (backward Euler) step, for three materials:
 *
 *   linear         small-strain elasticity, ψ = μ|ε|² + λ/2 tr(ε)², ε = sym(F) − I: one linear solve per step, but
 *                  not rotation-invariant (a cell that turns is "stretched" and grows)
 *   corotational   the same, measured in each cell's own rotation R (F = R S): ψ_lin(Rᵀ F), R from the current shape
 *   neo-Hookean    the stable neo-Hookean of Smith et al. 2018, ψ = μ/2 (tr FᵀF − 3) + λ'/2 (J − α)², J = det F:
 *                  large deformations, and an inverted cell is pushed back out
 *
 * Backward Euler minimises Φ(x) = Σ m/(2h²) |x − s|² + Σ V ψ(F(x)), s = xₙ + h vₙ + h² g, by Newton's method: each
 * iteration assembles the gradient and Hessian over the free particles and solves H Δx = −∇Φ by preconditioned
 * conjugate gradients (stopping at negative curvature, since the neo-Hookean Hessian may be indefinite), with a
 * backtracking line search on Φ for the neo-Hookean material.
 */
import type { PhysicsParams } from "../../contracts";
import type { Settings } from "../../sim/api";
import { addStressForces, deformation, elements, type Elements } from "./elements";
import { particleFleshBlock, type Piece, type PieceSolver } from "./flesh";
import { BlockSparse, CGWork, det3, extractRotation, m3, mulT3 } from "./linalg";
import { lame, youngModulus } from "./material";

type Material = "linear" | "corotational" | "neohookean";

/** A material: stress P(F), its differential dP(F; dF), and the energy density ψ(F). `R` is the cell's rotation
 *  (corotational only). */
interface Model {
  P(F: Float64Array, R: Float64Array, mu: number, la: number, out: Float64Array): void;
  dP(F: Float64Array, R: Float64Array, mu: number, la: number, dF: Float64Array, out: Float64Array): void;
  psi(F: Float64Array, R: Float64Array, mu: number, la: number): number;
}

/** Linear elasticity in a frame turned by R (the identity for the linear material): Fr = Rᵀ F,
 *  P = R [μ (Fr + Frᵀ − 2I) + λ tr(Fr − I) I]. */
const rotatedLinear = (useR: boolean): Model => {
  const Fr = m3(), Pr = m3();
  const toLocal = (F: Float64Array, R: Float64Array, out: Float64Array) => {
    if (!useR) return out.set(F);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = R[r] * F[c] + R[3 + r] * F[3 + c] + R[6 + r] * F[6 + c];
  };
  const toWorld = (R: Float64Array, A: Float64Array, out: Float64Array) => {
    if (!useR) return out.set(A);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = R[r * 3] * A[c] + R[r * 3 + 1] * A[3 + c] + R[r * 3 + 2] * A[6 + c];
  };
  const linear = (A: Float64Array, mu: number, la: number, rest: number, out: Float64Array) => {
    const tr = A[0] + A[4] + A[8] - 3 * rest;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = mu * (A[r * 3 + c] + A[c * 3 + r]) + (r === c ? la * tr - 2 * mu * rest : 0);
  };
  return {
    P(F, R, mu, la, out) {
      toLocal(F, R, Fr);
      linear(Fr, mu, la, 1, Pr);
      toWorld(R, Pr, out);
    },
    dP(_F, R, mu, la, dF, out) {
      toLocal(dF, R, Fr);
      linear(Fr, mu, la, 0, Pr);
      toWorld(R, Pr, out);
    },
    psi(F, R, mu, la) {
      toLocal(F, R, Fr);
      let e2 = 0;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e2 += (0.5 * (Fr[r * 3 + c] + Fr[c * 3 + r]) - (r === c ? 1 : 0)) ** 2;
      const tr = Fr[0] + Fr[4] + Fr[8] - 3;
      return mu * e2 + 0.5 * la * tr * tr;
    },
  };
};

/** Cofactor matrix of F (∂ det F / ∂F): its columns are f₁×f₂, f₂×f₀, f₀×f₁ for F's columns f. */
function cofactor(F: ArrayLike<number>, out: Float64Array) {
  for (let c = 0; c < 3; c++) {
    const a = (c + 1) % 3, b = (c + 2) % 3;
    out[c] = F[3 + a] * F[6 + b] - F[6 + a] * F[3 + b];
    out[3 + c] = F[6 + a] * F[b] - F[a] * F[6 + b];
    out[6 + c] = F[a] * F[3 + b] - F[3 + a] * F[b];
  }
}

/** Stable neo-Hookean (Smith et al. 2018) with λ' = λ + μ (so it matches linear elasticity at rest), α = 1 + μ/λ':
 *  P = μ F + λ' (J − α) cof F, dP = μ dF + λ' (cof F : dF) cof F + λ' (J − α) d(cof F). */
const neoHookean = (): Model => {
  const C = m3(), dC = m3();
  return {
    P(F, _R, mu, la, out) {
      const l = la + mu, alpha = 1 + mu / l, J = det3(F);
      cofactor(F, C);
      for (let k = 0; k < 9; k++) out[k] = mu * F[k] + l * (J - alpha) * C[k];
    },
    dP(F, _R, mu, la, dF, out) {
      const l = la + mu, alpha = 1 + mu / l, J = det3(F);
      cofactor(F, C);
      let cd = 0;
      for (let k = 0; k < 9; k++) cd += C[k] * dF[k];
      // d(cof F): column c is df_a × f_b + f_a × df_b.
      for (let c = 0; c < 3; c++) {
        const a = (c + 1) % 3, b = (c + 2) % 3;
        const fa0 = F[a], fa1 = F[3 + a], fa2 = F[6 + a], fb0 = F[b], fb1 = F[3 + b], fb2 = F[6 + b];
        const da0 = dF[a], da1 = dF[3 + a], da2 = dF[6 + a], db0 = dF[b], db1 = dF[3 + b], db2 = dF[6 + b];
        dC[c] = da1 * fb2 - da2 * fb1 + fa1 * db2 - fa2 * db1;
        dC[3 + c] = da2 * fb0 - da0 * fb2 + fa2 * db0 - fa0 * db2;
        dC[6 + c] = da0 * fb1 - da1 * fb0 + fa0 * db1 - fa1 * db0;
      }
      for (let k = 0; k < 9; k++) out[k] = mu * dF[k] + l * cd * C[k] + l * (J - alpha) * dC[k];
    },
    psi(F, _R, mu, la) {
      const l = la + mu, alpha = 1 + mu / l, J = det3(F);
      let ic = 0;
      for (let k = 0; k < 9; k++) ic += F[k] * F[k];
      return 0.5 * mu * (ic - 3) + 0.5 * l * (J - alpha) ** 2 - 0.5 * l * (1 - alpha) ** 2;
    },
  };
};

class ImplicitFem implements PieceSolver {
  private el: Elements;
  private material: Material = "corotational";
  private model: Model = rotatedLinear(true);
  private newton = 1;
  private cg = 10;
  private poisson = 0.4;
  private E = 0;
  private quat: Float64Array;
  private rot: Float64Array;
  private free: number[] = [];
  private freeIndex = new Int32Array(0);
  private A: BlockSparse | null = null;
  private work: CGWork | null = null;
  private s: Float64Array;
  private f: Float64Array;
  private trial: Float32Array;
  /** Lamé parameters per cell (its region's stiffness). */
  private mu: Float64Array;
  private la: Float64Array;
  /** Per active cell, the 16 block slots (node a, node b) of the matrix, −1 where a node is attached. */
  private slots = new Int32Array(0);
  private R = m3();

  constructor(private piece: Piece, settings: Readonly<Settings>) {
    this.el = elements(piece);
    const nt = this.el.volume.length;
    this.quat = new Float64Array(nt * 4);
    for (let t = 0; t < nt; t++) this.quat[t * 4 + 3] = 1;
    this.rot = new Float64Array(nt * 9);
    for (let t = 0; t < nt; t++) this.rot.set([1, 0, 0, 0, 1, 0, 0, 0, 1], t * 9);
    this.s = new Float64Array(piece.count * 3);
    this.f = new Float64Array(piece.count * 3);
    this.trial = new Float32Array(piece.count * 3);
    this.mu = new Float64Array(nt);
    this.la = new Float64Array(nt);
    this.setSettings(settings);
    this.attachmentsChanged();
  }

  setParams(p: PhysicsParams) {
    this.E = youngModulus(p);
    this.updateLame();
  }

  private updateLame() {
    for (let t = 0; t < this.mu.length; t++) {
      const { mu, lambda } = lame(this.E * this.piece.tetStiffness[t], this.poisson);
      this.mu[t] = mu;
      this.la[t] = lambda;
    }
  }

  setSettings(s: Readonly<Settings>) {
    const m = String(s.femMaterial ?? "corotational") as Material;
    if (m !== this.material) this.model = m === "neohookean" ? neoHookean() : rotatedLinear(m === "corotational");
    this.material = m;
    this.newton = Math.max(1, Math.round(Number(s.femNewton ?? 1)));
    this.cg = Math.max(1, Math.round(Number(s.femCgIterations ?? 10)));
    this.poisson = Number(s.femPoisson ?? 0.4);
    this.updateLame();
  }

  attachmentsChanged() {
    const piece = this.piece, T = piece.mesh.tets;
    this.free = [];
    this.freeIndex = new Int32Array(piece.count).fill(-1);
    for (let i = 0; i < piece.count; i++) if (!piece.fixed[i]) this.freeIndex[i] = this.free.push(i) - 1;
    const pairs: [number, number][] = [];
    for (const t of piece.activeTets) {
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
          const i = this.freeIndex[T[t * 4 + a]], j = this.freeIndex[T[t * 4 + b]];
          if (i >= 0 && j >= 0) pairs.push([i, j]);
        }
      }
    }
    this.A = new BlockSparse(this.free.length, pairs);
    this.work = new CGWork(this.free.length);
    const tets = piece.activeTets;
    this.slots = new Int32Array(tets.length * 16).fill(-1);
    tets.forEach((t, q) => {
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const i = this.freeIndex[T[t * 4 + a]], j = this.freeIndex[T[t * 4 + b]];
          if (i >= 0 && j >= 0) this.slots[q * 16 + a * 4 + b] = this.A!.slot(i, j) * 9;
        }
      }
    });
  }

  /** Cell t's rotation (corotational), into this.R. */
  private rotOf(t: number): Float64Array {
    for (let k = 0; k < 9; k++) this.R[k] = this.rot[t * 9 + k];
    return this.R;
  }

  /** Corotational: each active cell's rotation from its current shape. */
  private rotations(x: ArrayLike<number>) {
    if (this.material !== "corotational") return;
    const T = this.piece.mesh.tets, F = m3(), R = m3();
    for (const t of this.piece.activeTets) {
      deformation(T, this.el.grad, x, t, F);
      extractRotation(F, this.quat, R, 3, t * 4);
      this.rot.set(R, t * 9);
    }
  }

  /** Elastic forces of the active cells into f. */
  private forces(x: ArrayLike<number>) {
    const T = this.piece.mesh.tets, grad = this.el.grad, V = this.el.volume, F = m3(), P = m3();
    this.f.fill(0);
    for (const t of this.piece.activeTets) {
      const R = this.rotOf(t);
      deformation(T, grad, x, t, F);
      this.model.P(F, R, this.mu[t], this.la[t], P);
      addStressForces(T, grad, V[t], P, t, this.f);
    }
  }

  /** Φ(x): inertia plus elastic energy (for the line search). */
  private objective(x: ArrayLike<number>): number {
    const { m } = this.piece, s = this.s, h2 = this.h * this.h;
    let phi = 0;
    for (const i of this.free) {
      const dx = x[i * 3] - s[i * 3], dy = x[i * 3 + 1] - s[i * 3 + 1], dz = x[i * 3 + 2] - s[i * 3 + 2];
      phi += (m[i] / (2 * h2)) * (dx * dx + dy * dy + dz * dz);
    }
    const T = this.piece.mesh.tets, F = m3();
    for (const t of this.piece.activeTets) {
      deformation(T, this.el.grad, x, t, F);
      phi += this.el.volume[t] * this.model.psi(F, this.rotOf(t), this.mu[t], this.la[t]);
    }
    return phi;
  }

  private h = 1 / 60;

  /** H = M/h² + Σ V ∂P/∂x over the free particles. */
  private assemble(x: ArrayLike<number>) {
    const A = this.A!, piece = this.piece, h2 = this.h * this.h;
    A.clear();
    this.free.forEach((i, k) => A.addDiagonal(k, piece.m[i] / h2));
    if (this.material === "neohookean") this.assembleNonlinear(x);
    else this.assembleRotated();
  }

  /** Linear and corotational: each cell's constant stiffness K turned by its rotation, R K_ab Rᵀ for each pair of
   *  nodes, with K_ab = V [μ (∇N_a·∇N_b) I + μ ∇N_b ∇N_aᵀ + λ ∇N_a ∇N_bᵀ]. */
  private assembleRotated() {
    const piece = this.piece, grad = this.el.grad, slots = this.slots, Av = this.A!.values;
    const K = m3(), KR = m3(), corot = this.material === "corotational";
    piece.activeTets.forEach((t, q) => {
      const V = this.el.volume[t], mu = this.mu[t], la = this.la[t], R = this.rotOf(t);
      for (let a = 0; a < 4; a++) {
        const ga = t * 12 + a * 3;
        for (let b = 0; b < 4; b++) {
          const s = slots[q * 16 + a * 4 + b];
          if (s < 0) continue;
          const gb = t * 12 + b * 3;
          const dot = grad[ga] * grad[gb] + grad[ga + 1] * grad[gb + 1] + grad[ga + 2] * grad[gb + 2];
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) K[r * 3 + c] = V * ((r === c ? mu * dot : 0) + mu * grad[gb + r] * grad[ga + c] + la * grad[ga + r] * grad[gb + c]);
          }
          if (!corot) {
            for (let k = 0; k < 9; k++) Av[s + k] += K[k];
            continue;
          }
          // R K Rᵀ
          mulT3(K, R, KR);
          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) Av[s + r * 3 + c] += R[r * 3] * KR[c] + R[r * 3 + 1] * KR[3 + c] + R[r * 3 + 2] * KR[6 + c];
          }
        }
      }
    });
  }

  /** Neo-Hookean: each cell's 12 × 12 block column by column, from dP for each node moving along each axis. */
  private assembleNonlinear(x: ArrayLike<number>) {
    const piece = this.piece, T = piece.mesh.tets, grad = this.el.grad, slots = this.slots, Av = this.A!.values;
    const F = m3(), dF = m3(), dP = m3();
    piece.activeTets.forEach((t, q) => {
      const R = this.rotOf(t), V = this.el.volume[t], mu = this.mu[t], la = this.la[t];
      deformation(T, grad, x, t, F);
      for (let b = 0; b < 4; b++) {
        if (piece.fixed[T[t * 4 + b]]) continue;
        const gb = t * 12 + b * 3;
        for (let c = 0; c < 3; c++) {
          // dF for node b moving along axis c: row c is ∇N_b.
          dF.fill(0);
          dF[c * 3] = grad[gb];
          dF[c * 3 + 1] = grad[gb + 1];
          dF[c * 3 + 2] = grad[gb + 2];
          this.model.dP(F, R, mu, la, dF, dP);
          for (let a = 0; a < 4; a++) {
            const s = slots[q * 16 + a * 4 + b];
            if (s < 0) continue;
            const ga = t * 12 + a * 3;
            for (let r = 0; r < 3; r++) Av[s + r * 3 + c] += V * (dP[r * 3] * grad[ga] + dP[r * 3 + 1] * grad[ga + 1] + dP[r * 3 + 2] * grad[ga + 2]);
          }
        }
      }
    });
  }

  step(h: number, g: readonly [number, number, number]) {
    this.h = h;
    const piece = this.piece, { x: X, v: V, m } = piece, s = this.s, free = this.free, nf = free.length;
    for (const i of free) for (let k = 0; k < 3; k++) s[i * 3 + k] = X[i * 3 + k] + h * V[i * 3 + k] + h * h * g[k];
    const old = Float64Array.from(X);
    for (const i of free) for (let k = 0; k < 3; k++) X[i * 3 + k] = s[i * 3 + k];
    const b = new Float64Array(nf * 3), dx = new Float64Array(nf * 3);
    for (let it = 0; it < this.newton && nf; it++) {
      this.rotations(X);
      this.forces(X);
      // −∇Φ = elastic force − M/h² (x − s)
      free.forEach((i, k) => {
        for (let r = 0; r < 3; r++) b[k * 3 + r] = this.f[i * 3 + r] - (m[i] / (h * h)) * (X[i * 3 + r] - s[i * 3 + r]);
      });
      this.assemble(X);
      dx.fill(0);
      this.A!.solve(b, dx, this.cg, 1e-3, this.work!);
      // The quadratic models (linear, corotational with R held) take the full step; neo-Hookean backtracks on Φ.
      let step = 1;
      if (this.material === "neohookean") {
        const phi0 = this.objective(X);
        this.trial.set(X);
        for (let k = 0; k < 6; k++, step *= 0.5) {
          free.forEach((i, q) => {
            for (let r = 0; r < 3; r++) this.trial[i * 3 + r] = X[i * 3 + r] + step * dx[q * 3 + r];
          });
          if (this.objective(this.trial) <= phi0) break;
        }
        if (step < 1 / 32) step = 0;
      }
      free.forEach((i, q) => {
        for (let r = 0; r < 3; r++) X[i * 3 + r] += step * dx[q * 3 + r];
      });
    }
    for (const i of free) for (let k = 0; k < 3; k++) V[i * 3 + k] = (X[i * 3 + k] - old[i * 3 + k]) / h;
    // What the flesh pulls on the attached particles with, over the step.
    this.forces(X);
    for (let i = 0; i < piece.count; i++) if (piece.fixed[i]) for (let k = 0; k < 3; k++) piece.reaction[i * 3 + k] += this.f[i * 3 + k] * h;
  }
}

export const implicitFem = particleFleshBlock({
  id: "implicit-fem",
  name: { zh: "隐式有限元", en: "Implicit FEM" },
  summary: {
    zh: "四面体有限元，线性 / 共旋 / Neo-Hookean 材料，后向欧拉一步（牛顿法 + 共轭梯度）。",
    en: "Tetrahedral finite elements with a linear, corotational or neo-Hookean material, one backward Euler step (Newton's method with conjugate gradients).",
  },
  parameters: [
    {
      key: "femMaterial", kind: "choice", default: "corotational",
      label: { zh: "材料", en: "Material" },
      choices: [
        { value: "linear", label: { zh: "线性", en: "Linear" } },
        { value: "corotational", label: { zh: "共旋", en: "Corotational" } },
        { value: "neohookean", label: { zh: "Neo-Hookean", en: "Neo-Hookean" } },
      ],
      help: {
        zh: "线性材料转动时会变形变大；共旋和 Neo-Hookean 对旋转不变。",
        en: "The linear material grows when it turns; corotational and neo-Hookean are rotation-invariant.",
      },
    },
    { key: "femNewton", kind: "number", default: 1, min: 1, max: 5, step: 1, label: { zh: "牛顿迭代", en: "Newton iterations" } },
    { key: "femCgIterations", kind: "number", default: 10, min: 5, max: 100, step: 5, label: { zh: "CG 迭代", en: "CG iterations" } },
    { key: "femPoisson", kind: "number", default: 0.4, min: 0, max: 0.48, step: 0.02, label: { zh: "泊松比", en: "Poisson ratio" } },
  ],
  solver: (piece, scene, settings) => {
    const s = new ImplicitFem(piece, settings);
    s.setParams(scene.params);
    return s;
  },
});
