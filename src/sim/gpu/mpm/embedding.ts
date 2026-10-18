/**
 * The rendered surface embedded in the material points. Each surface vertex X follows its K nearest particles p,
 * each carrying it along its own deformation:
 *
 *     x = Σ w_p (x_p + F_p (X − X_p))
 *
 * MPM tracks F per particle, so this is first-order accurate (exact for any affine motion, rotations included) and
 * never drifts, unlike surface markers advected through the grid. The weights fall smoothly to zero at the
 * (K+1)-th nearest particle, so neighbouring vertices blend continuously.
 */
export const EMBED_K = 8;

export interface Embedding {
  /** Per vertex: K particle indices (global) and weights. */
  index: Uint32Array;
  weight: Float32Array;
}

/**
 * Weights for the vertices V (xyz) over the particles P (xyz, rest), whose global indices start at `first`.
 * `spacing` is the particle spacing (sets the hash cell size).
 */
export function embed(V: Float32Array, P: Float32Array, first: number, spacing: number): Embedding {
  const nv = V.length / 3, np = P.length / 3;
  const index = new Uint32Array(nv * EMBED_K), weight = new Float32Array(nv * EMBED_K);
  const cell = 2 * spacing;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const buckets = new Map<string, number[]>();
  for (let p = 0; p < np; p++) {
    const k = key(Math.floor(P[p * 3] / cell), Math.floor(P[p * 3 + 1] / cell), Math.floor(P[p * 3 + 2] / cell));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const near: { p: number; d: number }[] = [];
  for (let v = 0; v < nv; v++) {
    const x = V[v * 3], y = V[v * 3 + 1], z = V[v * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    // Grow the search shell until K+1 candidates are found and the shell is farther than the (K+1)-th.
    near.length = 0;
    for (let r = 0; ; r++) {
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            for (const p of buckets.get(key(cx + i, cy + j, cz + k)) ?? []) {
              near.push({ p, d: Math.hypot(P[p * 3] - x, P[p * 3 + 1] - y, P[p * 3 + 2] - z) });
            }
          }
        }
      }
      if (near.length > EMBED_K) {
        near.sort((a, b) => a.d - b.d);
        if (near[EMBED_K].d <= r * cell) break;
      }
      if (r > 64) break;
    }
    near.sort((a, b) => a.d - b.d);
    const n = Math.min(EMBED_K, near.length);
    const radius = (near[EMBED_K]?.d ?? near[n - 1].d) * 1.0001 + 1e-9;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const w = (1 - (near[k].d / radius) ** 2) ** 3;
      index[v * EMBED_K + k] = first + near[k].p;
      weight[v * EMBED_K + k] = w;
      sum += w;
    }
    for (let k = 0; k < n; k++) weight[v * EMBED_K + k] /= sum;
  }
  return { index, weight };
}

/** For each query point (xyz), the index of the nearest of `points` (xyz), with a hash of the given cell size. */
export function nearestOf(queries: Float32Array, points: Float32Array, cell: number): Uint32Array {
  const buckets = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let p = 0; p < points.length / 3; p++) {
    const k = key(Math.floor(points[p * 3] / cell), Math.floor(points[p * 3 + 1] / cell), Math.floor(points[p * 3 + 2] / cell));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const out = new Uint32Array(queries.length / 3);
  for (let q = 0; q < out.length; q++) {
    const x = queries[q * 3], y = queries[q * 3 + 1], z = queries[q * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = Infinity;
    // Shells outward until the nearest found is closer than any unvisited cell can be.
    for (let r = 0; r < 256 && !(best >= 0 && Math.sqrt(bd) <= r * cell); r++) {
      for (let i = -r; i <= r; i++) {
        for (let j = -r; j <= r; j++) {
          for (let k = -r; k <= r; k++) {
            if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
            for (const p of buckets.get(key(cx + i, cy + j, cz + k)) ?? []) {
              const d = (points[p * 3] - x) ** 2 + (points[p * 3 + 1] - y) ** 2 + (points[p * 3 + 2] - z) ** 2;
              if (d < bd) {
                bd = d;
                best = p;
              }
            }
          }
        }
      }
    }
    out[q] = Math.max(0, best);
  }
  return out;
}
