/**
 * Rest-state quantities of the tetrahedra and their edges that several solvers share: rest volumes, the shape
 * gradients (∇N of each node, so that the deformation gradient is F = Σₖ xₖ ⊗ ∇Nₖ), rest lengths, and each edge's
 * share of the volume around it.
 */
import type { Piece } from "./flesh";
import { tetVolume } from "./lattice";
import { inv3, m3 } from "./linalg";

export interface Elements {
  /** Rest volume of each tetrahedron. */
  volume: Float64Array;
  /** Shape gradients: 4 nodes × 3 per tetrahedron (node 0's is minus the sum of the others'). */
  grad: Float64Array;
  /** Rest length of each edge, and its share of the surrounding volume (each tetrahedron gives a sixth of its volume
   *  times its region stiffness to each of its edges). */
  restLength: Float64Array;
  edgeShare: Float64Array;
  /** The 6 edges of each tetrahedron. */
  tetEdges: Uint32Array;
}

export function elements(piece: Piece): Elements {
  const T = piece.mesh.tets, E = piece.mesh.edges, X = piece.rest, n = piece.count;
  const nt = T.length / 4, ne = E.length / 2;
  const volume = new Float64Array(nt), grad = new Float64Array(nt * 12);
  const Dm = m3(), inv = m3();
  for (let t = 0; t < nt; t++) {
    const a = T[t * 4];
    volume[t] = tetVolume(X, a, T[t * 4 + 1], T[t * 4 + 2], T[t * 4 + 3]);
    // Dm: columns are the edges from node 0 at rest; ∇Nₖ (k = 1..3) is row k−1 of Dm⁻¹.
    for (let k = 0; k < 3; k++) {
      const b = T[t * 4 + 1 + k];
      for (let r = 0; r < 3; r++) Dm[r * 3 + k] = X[b * 3 + r] - X[a * 3 + r];
    }
    inv3(Dm, inv);
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        grad[t * 12 + (k + 1) * 3 + r] = inv[k * 3 + r];
        s += inv[k * 3 + r];
      }
      grad[t * 12 + r] = -s;
    }
  }
  const restLength = new Float64Array(ne), edgeOf = new Map<number, number>();
  for (let e = 0; e < ne; e++) {
    const a = E[e * 2], b = E[e * 2 + 1];
    restLength[e] = Math.hypot(X[b * 3] - X[a * 3], X[b * 3 + 1] - X[a * 3 + 1], X[b * 3 + 2] - X[a * 3 + 2]);
    edgeOf.set(Math.min(a, b) * n + Math.max(a, b), e);
  }
  const tetEdges = new Uint32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    let k = 0;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const a = T[t * 4 + p], b = T[t * 4 + q];
        tetEdges[t * 6 + k++] = edgeOf.get(Math.min(a, b) * n + Math.max(a, b))!;
      }
    }
  }
  const out = { volume, grad, restLength, edgeShare: new Float64Array(ne), tetEdges };
  updateEdgeShares(piece, out);
  return out;
}

/** Recompute the edges' volume shares after the region stiffness changed (piece.tetStiffness). */
export function updateEdgeShares(piece: Piece, el: Elements) {
  el.edgeShare.fill(0);
  for (let t = 0; t < el.volume.length; t++) {
    const v = (el.volume[t] * piece.tetStiffness[t]) / 6;
    for (let k = 0; k < 6; k++) el.edgeShare[el.tetEdges[t * 6 + k]] += v;
  }
}

/** Spring stiffness of each edge for Young's modulus E: k = 2 E · share / L² (springs only resist along their edge;
 *  twice the volume share gives about the modulus of the continuum). */
export function edgeStiffness(el: Elements, E: number, out: Float64Array): Float64Array {
  for (let e = 0; e < out.length; e++) out[e] = (2 * E * el.edgeShare[e]) / (el.restLength[e] * el.restLength[e]);
  return out;
}

/** Deformation gradient F (row-major) of tetrahedron t at positions x. */
export function deformation(T: Uint32Array, grad: Float64Array, x: ArrayLike<number>, t: number, F: Float64Array): Float64Array {
  F.fill(0);
  for (let k = 0; k < 4; k++) {
    const n = T[t * 4 + k] * 3, g = t * 12 + k * 3;
    for (let r = 0; r < 3; r++) {
      const xr = x[n + r];
      F[r * 3] += xr * grad[g];
      F[r * 3 + 1] += xr * grad[g + 1];
      F[r * 3 + 2] += xr * grad[g + 2];
    }
  }
  return F;
}

/** Add −V · P ∇Nₖ (the elastic force of stress P on each node of tetrahedron t, times `scale`) into f. */
export function addStressForces(T: Uint32Array, grad: Float64Array, V: number, P: ArrayLike<number>, t: number, f: Float64Array, scale = 1) {
  for (let k = 0; k < 4; k++) {
    const n = T[t * 4 + k] * 3, g = t * 12 + k * 3;
    for (let r = 0; r < 3; r++) f[n + r] -= scale * V * (P[r * 3] * grad[g] + P[r * 3 + 1] * grad[g + 1] + P[r * 3 + 2] * grad[g + 2]);
  }
}
