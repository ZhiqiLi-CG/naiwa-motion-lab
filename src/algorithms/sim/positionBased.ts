/**
 * The position-based solver PBD and XPBD share: predict positions, project the constraints one at a time
 * (Gauss–Seidel), take the velocities from the motion. Two constraints per piece:
 *
 *   distance  C = |xᵢ − xⱼ| − L         on every edge of the tetrahedra
 *   volume    C = V(x₀..x₃) − V₀         on every tetrahedron (V signed, so an inverted cell is pushed back out)
 *
 * PBD (Müller et al. 2007) scales each correction by a stiffness k ∈ [0, 1], which in effect depends on the iteration
 * count and the time step. XPBD (Macklin et al. 2016) gives each constraint a compliance α (the inverse of a physical
 * stiffness) and keeps its Lagrange multiplier λ, so the material does not change with iterations or substeps; here
 * with small steps (Macklin et al. 2019): many substeps of one iteration each.
 *
 * A fixed (attached) particle has inverse mass 0 and is not moved; the impulse λ∇C/h the constraint puts on it goes
 * to its bone (flesh.ts).
 */
import type { PhysicsParams } from "../../contracts";
import { edgeStiffness, elements, updateEdgeShares, type Elements } from "./elements";
import type { Piece, PieceSolver } from "./flesh";
import { tetVolume } from "./lattice";
import { youngModulus } from "./material";

export interface PositionBasedOptions {
  /** XPBD (compliance, multipliers) or PBD (stiffness). */
  xpbd: boolean;
  /** PBD: iterations per step; XPBD: substeps (one iteration each). */
  iterations: number;
  /** PBD: stiffness of the distance and volume constraints, 0..1 (scaled by the material and regions). */
  stiffness: number;
  volumeStiffness: number;
  /** XPBD: Poisson ratio, for the volume compliance (bulk modulus). */
  poisson: number;
  /** Rest volume factor of the Body's cells (the belly-size slider). */
  volumeFactor: number;
}

export class PositionBased implements PieceSolver {
  private el: Elements;
  /** Distance compliance (XPBD, 1/k) or stiffness factor (PBD) per edge; volume compliance per tetrahedron. */
  private edgeK: Float64Array;
  private tetK: Float64Array;
  private E = 0;
  private p: Float64Array;
  private prev: Float64Array;

  constructor(private piece: Piece, private o: PositionBasedOptions) {
    this.el = elements(piece);
    this.edgeK = new Float64Array(this.el.restLength.length);
    this.tetK = new Float64Array(this.el.volume.length);
    this.p = new Float64Array(piece.count * 3);
    this.prev = new Float64Array(piece.count * 3);
  }

  setOptions(o: Partial<PositionBasedOptions>) {
    Object.assign(this.o, o);
    this.update();
  }

  setParams(p: PhysicsParams) {
    this.E = youngModulus(p);
    this.o.volumeFactor = this.piece.part.limb ? 1 : Math.min(2, Math.max(0.5, p.bellySize));
    this.update();
  }

  /** Stiffness per constraint from the material: XPBD compliance α = 1/k (edges: k = 2E·share/L²; cells: k = K/V₀,
   *  K the bulk modulus); PBD the stiffness slider times the modulus against the default's, capped at 1. */
  private update() {
    updateEdgeShares(this.piece, this.el);
    edgeStiffness(this.el, this.E, this.edgeK);
    const ts = this.piece.tetStiffness, V = this.el.volume;
    if (this.o.xpbd) {
      for (let e = 0; e < this.edgeK.length; e++) this.edgeK[e] = 1 / this.edgeK[e];
      const K = this.E / (3 * (1 - 2 * this.o.poisson));
      for (let t = 0; t < V.length; t++) this.tetK[t] = V[t] / (K * ts[t]);
    } else {
      const rel = this.E / 8500;
      for (let e = 0; e < this.edgeK.length; e++) this.edgeK[e] = Math.min(1, this.o.stiffness * rel * this.el.edgeShare[e] / meanShare(this.el));
      for (let t = 0; t < V.length; t++) this.tetK[t] = Math.min(1, this.o.volumeStiffness * ts[t]);
    }
  }

  step(h: number, g: readonly [number, number, number]) {
    const { x: X, v: Vel, w, fixed, count: n } = this.piece, p = this.p, prev = this.prev;
    const substeps = this.o.xpbd ? Math.max(1, Math.round(this.o.iterations)) : 1;
    const iterations = this.o.xpbd ? 1 : Math.max(1, Math.round(this.o.iterations));
    const hs = h / substeps;
    // Attached particles move with their prescribed velocity, from the start of the step.
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) p[i * 3 + k] = fixed[i] ? X[i * 3 + k] - Vel[i * 3 + k] * h : X[i * 3 + k];
    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < n * 3; i++) prev[i] = p[i];
      // Predict.
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          if (!fixed[i]) Vel[i * 3 + k] += hs * g[k];
          p[i * 3 + k] += hs * Vel[i * 3 + k];
        }
      }
      // PBD's stiffness per iteration so that `iterations` passes give k: 1 − (1 − k)^(1/iterations).
      for (let it = 0; it < iterations; it++) {
        this.distances(hs, iterations);
        this.volumes(hs, iterations);
      }
      // Velocities from the motion.
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        for (let k = 0; k < 3; k++) Vel[i * 3 + k] = (p[i * 3 + k] - prev[i * 3 + k]) / hs;
      }
    }
    for (let i = 0; i < n * 3; i++) X[i] = p[i];
  }

  /** Project the distance constraints of the active edges. */
  private distances(hs: number, iterations: number) {
    const p = this.p, w = this.piece.w, E = this.piece.mesh.edges, L = this.el.restLength, R = this.piece.reaction;
    const xpbd = this.o.xpbd;
    for (const e of this.piece.activeEdges) {
      const a = E[e * 2], b = E[e * 2 + 1];
      const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-12) continue;
      const C = l - L[e], nx = dx / l, ny = dy / l, nz = dz / l;
      const W = w[a] + w[b];
      // ∇ₐC = n, ∇ᵦC = −n.
      const dl = xpbd
        ? -C / (W + this.edgeK[e] / (hs * hs))
        : (-C / W) * (1 - Math.pow(1 - this.edgeK[e], 1 / iterations));
      p[a * 3] += w[a] * dl * nx; p[a * 3 + 1] += w[a] * dl * ny; p[a * 3 + 2] += w[a] * dl * nz;
      p[b * 3] -= w[b] * dl * nx; p[b * 3 + 1] -= w[b] * dl * ny; p[b * 3 + 2] -= w[b] * dl * nz;
      if (w[a] === 0) addReaction(R, a, (dl / hs) * nx, (dl / hs) * ny, (dl / hs) * nz);
      if (w[b] === 0) addReaction(R, b, (-dl / hs) * nx, (-dl / hs) * ny, (-dl / hs) * nz);
    }
  }

  /** Project the volume constraints of the active tetrahedra: ∇C of a node is a sixth of the cross product of the
   *  opposite face's edges (pointing away from it). */
  private volumes(hs: number, iterations: number) {
    const p = this.p, w = this.piece.w, T = this.piece.mesh.tets, V0 = this.el.volume, R = this.piece.reaction;
    const factor = this.o.volumeFactor, grad = new Float64Array(12);
    for (const t of this.piece.activeTets) {
      const i0 = T[t * 4], i1 = T[t * 4 + 1], i2 = T[t * 4 + 2], i3 = T[t * 4 + 3];
      const C = tetVolume(p, i0, i1, i2, i3) - V0[t] * factor;
      volumeGradient(p, i0, i1, i2, i3, grad);
      let W = 0;
      for (let k = 0; k < 4; k++) W += w[T[t * 4 + k]] * (grad[k * 3] ** 2 + grad[k * 3 + 1] ** 2 + grad[k * 3 + 2] ** 2);
      if (W < 1e-20) continue;
      const dl = this.o.xpbd
        ? -C / (W + this.tetK[t] / (hs * hs))
        : (-C / W) * (1 - Math.pow(1 - this.tetK[t], 1 / iterations));
      for (let k = 0; k < 4; k++) {
        const i = T[t * 4 + k];
        if (w[i] === 0) addReaction(R, i, (dl / hs) * grad[k * 3], (dl / hs) * grad[k * 3 + 1], (dl / hs) * grad[k * 3 + 2]);
        else for (let c = 0; c < 3; c++) p[i * 3 + c] += w[i] * dl * grad[k * 3 + c];
      }
    }
  }
}

function addReaction(R: Float64Array, i: number, x: number, y: number, z: number) {
  R[i * 3] += x;
  R[i * 3 + 1] += y;
  R[i * 3 + 2] += z;
}

const shareMeans = new WeakMap<Elements, number>();
function meanShare(el: Elements): number {
  let m = shareMeans.get(el);
  if (m === undefined) {
    m = el.edgeShare.reduce((a, b) => a + b, 0) / Math.max(1, el.edgeShare.length);
    shareMeans.set(el, m);
  }
  return m;
}

/** ∂V/∂xₖ for the signed volume V = (x₁−x₀)·((x₂−x₀)×(x₃−x₀))/6. */
export function volumeGradient(p: ArrayLike<number>, i0: number, i1: number, i2: number, i3: number, out: Float64Array) {
  const c = (a: number, b: number, d: number, o: number) => {
    // (x_b − x_a) × (x_d − x_a) / 6
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[d * 3] - p[a * 3], vy = p[d * 3 + 1] - p[a * 3 + 1], vz = p[d * 3 + 2] - p[a * 3 + 2];
    out[o] = (uy * vz - uz * vy) / 6;
    out[o + 1] = (uz * vx - ux * vz) / 6;
    out[o + 2] = (ux * vy - uy * vx) / 6;
  };
  c(i0, i2, i3, 3); // ∂V/∂x₁ = (x₂−x₀)×(x₃−x₀)/6
  c(i0, i3, i1, 6); // ∂V/∂x₂ = (x₃−x₀)×(x₁−x₀)/6
  c(i0, i1, i2, 9); // ∂V/∂x₃ = (x₁−x₀)×(x₂−x₀)/6
  for (let k = 0; k < 3; k++) out[k] = -(out[3 + k] + out[6 + k] + out[9 + k]);
}
