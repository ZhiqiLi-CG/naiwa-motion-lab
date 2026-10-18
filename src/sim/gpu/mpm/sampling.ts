/** Filling a closed surface with material points: the lattice points inside it, found row by row. */

/**
 * The points of the lattice { h·(i + ½) } (world-aligned, so with grid cells of 2h every cell gets 2×2×2 points) that
 * lie inside the closed triangle mesh. One ray along +x per (y, z) row: its crossings with the triangles, sorted,
 * bound the inside (even-odd), so the cost is rows × the triangles spanning each row, not points × triangles.
 */
export function fillVolume(positions: Float32Array, indices: Uint32Array, h: number): Float32Array {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], positions[i + k]);
      hi[k] = Math.max(hi[k], positions[i + k]);
    }
  }
  const first = lo.map((v) => Math.floor(v / h - 0.5)), last = hi.map((v) => Math.ceil(v / h - 0.5));
  const coord = (i: number) => h * (i + 0.5);
  // Triangles by the rows (iy) their y-range spans.
  const ny = last[1] - first[1] + 1;
  const rows: number[][] = Array.from({ length: ny }, () => []);
  for (let t = 0; t < indices.length; t += 3) {
    let y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const y = positions[indices[t + k] * 3 + 1];
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    for (let r = Math.max(0, Math.ceil(y0 / h - 0.5) - first[1]); r <= Math.min(ny - 1, Math.floor(y1 / h - 0.5) - first[1]); r++) rows[r].push(t);
  }
  const out: number[] = [];
  const hits: number[] = [];
  // A tiny irrational nudge keeps rays off vertices and edges, where a crossing would count twice or not at all.
  const ey = h * 1.37e-4, ez = h * 2.71e-4;
  for (let r = 0; r < ny; r++) {
    const y = coord(first[1] + r) + ey;
    for (let iz = first[2]; iz <= last[2]; iz++) {
      const z = coord(iz) + ez;
      hits.length = 0;
      for (const t of rows[r]) {
        const x = crossing(positions, indices, t, y, z);
        if (x !== null) hits.push(x);
      }
      if (hits.length < 2) continue;
      hits.sort((a, b) => a - b);
      for (let k = 0; k + 1 < hits.length; k += 2) {
        for (let ix = Math.ceil(hits[k] / h - 0.5); coord(ix) < hits[k + 1]; ix++) out.push(coord(ix), coord(first[1] + r), coord(iz));
      }
    }
  }
  return new Float32Array(out);
}

/** Where the line { (x, y, z) : x ∈ ℝ } crosses triangle t, or null. */
function crossing(P: Float32Array, I: Uint32Array, t: number, y: number, z: number): number | null {
  const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
  // Barycentric coordinates of (y, z) in the triangle's projection onto the yz-plane.
  const y0 = P[a + 1], z0 = P[a + 2], y1 = P[b + 1] - y0, z1 = P[b + 2] - z0, y2 = P[c + 1] - y0, z2 = P[c + 2] - z0;
  const det = y1 * z2 - y2 * z1;
  if (Math.abs(det) < 1e-14) return null;
  const py = y - y0, pz = z - z0;
  const u = (py * z2 - y2 * pz) / det, v = (y1 * pz - py * z1) / det;
  if (u < 0 || v < 0 || u + v > 1) return null;
  return P[a] + u * (P[b] - P[a]) + v * (P[c] - P[a]);
}

/**
 * The largest connected piece of a lattice point set (neighbours one step h apart along an axis). Thin tips (a
 * finger the lattice catches as a point or two) would otherwise be free points nothing elastic holds: they fall
 * out of the part.
 */
export function largestPiece(P: Float32Array, h: number): Float32Array {
  const n = P.length / 3, key = (i: number) => P.subarray(i * 3, i * 3 + 3).map((v) => Math.round(v / h - 0.5)).join(",");
  const index = new Map<string, number>();
  for (let i = 0; i < n; i++) index.set(key(i), i);
  const piece = new Int32Array(n).fill(-1), sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (piece[s] >= 0) continue;
    const id = sizes.length, stack = [s];
    piece[s] = id;
    let size = 0;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const [x, y, z] = key(i).split(",").map(Number);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const j = index.get(`${x + dx},${y + dy},${z + dz}`);
        if (j !== undefined && piece[j] < 0) {
          piece[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(size);
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (piece[i] === keep) out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  return new Float32Array(out);
}
