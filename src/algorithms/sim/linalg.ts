/**
 * The small linear algebra the solvers share, on plain arrays: 3 × 3 matrices (row-major, 9 numbers), the rotation of
 * a deformation (polar decomposition), a symmetric 3 × 3 eigen solver, a dense Cholesky factorisation, and a block
 * sparse matrix (3 × 3 blocks over the free particles) with a preconditioned conjugate gradient solve.
 */

export type M3 = Float64Array;
export const m3 = () => new Float64Array(9);

/** out = A B */
export function mul3(A: ArrayLike<number>, B: ArrayLike<number>, out: M3): M3 {
  for (let r = 0; r < 3; r++) {
    const a0 = A[r * 3], a1 = A[r * 3 + 1], a2 = A[r * 3 + 2];
    out[r * 3] = a0 * B[0] + a1 * B[3] + a2 * B[6];
    out[r * 3 + 1] = a0 * B[1] + a1 * B[4] + a2 * B[7];
    out[r * 3 + 2] = a0 * B[2] + a1 * B[5] + a2 * B[8];
  }
  return out;
}

/** out = A Bᵀ */
export function mulT3(A: ArrayLike<number>, B: ArrayLike<number>, out: M3): M3 {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3] * B[c * 3] + A[r * 3 + 1] * B[c * 3 + 1] + A[r * 3 + 2] * B[c * 3 + 2];
  }
  return out;
}

/** out = Aᵀ B */
export function tMul3(A: ArrayLike<number>, B: ArrayLike<number>, out: M3): M3 {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r] * B[c] + A[3 + r] * B[3 + c] + A[6 + r] * B[6 + c];
  }
  return out;
}

export function det3(A: ArrayLike<number>): number {
  return A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
}

export function inv3(A: ArrayLike<number>, out: M3): M3 {
  const d = 1 / det3(A);
  out[0] = (A[4] * A[8] - A[5] * A[7]) * d;
  out[1] = (A[2] * A[7] - A[1] * A[8]) * d;
  out[2] = (A[1] * A[5] - A[2] * A[4]) * d;
  out[3] = (A[5] * A[6] - A[3] * A[8]) * d;
  out[4] = (A[0] * A[8] - A[2] * A[6]) * d;
  out[5] = (A[2] * A[3] - A[0] * A[5]) * d;
  out[6] = (A[3] * A[7] - A[4] * A[6]) * d;
  out[7] = (A[1] * A[6] - A[0] * A[7]) * d;
  out[8] = (A[0] * A[4] - A[1] * A[3]) * d;
  return out;
}

/** Rotation matrix of the unit quaternion (x, y, z, w) at q[o..o+4]. */
export function quatToM3(q: ArrayLike<number>, out: M3, o = 0): M3 {
  const x = q[o], y = q[o + 1], z = q[o + 2], w = q[o + 3];
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * w); out[2] = 2 * (x * z + y * w);
  out[3] = 2 * (x * y + z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - x * w);
  out[6] = 2 * (x * z - y * w); out[7] = 2 * (y * z + x * w); out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

/**
 * The rotation R of A = R S (polar decomposition), warm-started from the quaternion at q[o..o+4] (updated in place):
 * Müller et al., "A Robust Method to Extract the Rotational Part of Deformations" (2016): turn R by the axis-angle
 * that best aligns its columns with A's, a few times. Never returns a reflection, also for an inverted A.
 */
export function extractRotation(A: ArrayLike<number>, q: Float64Array, R: M3, iterations = 8, o = 0): M3 {
  for (let it = 0; it < iterations; it++) {
    quatToM3(q, R, o);
    let ox = 0, oy = 0, oz = 0, dot = 0;
    for (let c = 0; c < 3; c++) {
      const rx = R[c], ry = R[3 + c], rz = R[6 + c], ax = A[c], ay = A[3 + c], az = A[6 + c];
      ox += ry * az - rz * ay;
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const s = 1 / (Math.abs(dot) + 1e-9);
    ox *= s; oy *= s; oz *= s;
    const w = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (w < 1e-9) break;
    const h = Math.sin(w / 2) / w, qw = Math.cos(w / 2), qx = ox * h, qy = oy * h, qz = oz * h;
    const x = q[o], y = q[o + 1], z = q[o + 2], ww = q[o + 3];
    let nx = qw * x + qx * ww + qy * z - qz * y;
    let ny = qw * y - qx * z + qy * ww + qz * x;
    let nz = qw * z + qx * y - qy * x + qz * ww;
    let nw = qw * ww - qx * x - qy * y - qz * z;
    const n = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    nx *= n; ny *= n; nz *= n; nw *= n;
    q[o] = nx; q[o + 1] = ny; q[o + 2] = nz; q[o + 3] = nw;
  }
  return quatToM3(q, R, o);
}

/** Eigen decomposition of a symmetric 3 × 3 matrix by Jacobi rotations: values, and vectors as V's columns. */
export function symEigen3(S: ArrayLike<number>): { values: [number, number, number]; vectors: M3 } {
  const A = Float64Array.from(S), V = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 12; sweep++) {
    let off = 0;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) off += A[p * 3 + q] ** 2;
    if (off < 1e-20) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p], akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq;
        A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k], aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk;
        A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq;
        V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [A[0], A[4], A[8]], vectors: V };
}

/** Dense Cholesky factor L (lower, row-major n × n) of an SPD matrix, in place. */
export function cholesky(A: Float64Array, n: number): Float64Array {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j];
    for (let k = 0; k < j; k++) d -= A[j * n + k] ** 2;
    const ljj = Math.sqrt(Math.max(d, 1e-12));
    A[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= A[i * n + k] * A[j * n + k];
      A[i * n + j] = s / ljj;
    }
    for (let k = j + 1; k < n; k++) A[j * n + k] = 0;
  }
  return A;
}

/** Solve L Lᵀ x = b in place (b becomes x), for `stride`-interleaved right-hand sides (x, y, z of each particle). */
export function choleskySolve(L: Float64Array, n: number, b: Float64Array, stride = 1, offset = 0) {
  for (let i = 0; i < n; i++) {
    let s = b[i * stride + offset];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * b[k * stride + offset];
    b[i * stride + offset] = s / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i * stride + offset];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[k * stride + offset];
    b[i * stride + offset] = s / L[i * n + i];
  }
}

/**
 * A symmetric matrix of 3 × 3 blocks over n particles with a fixed sparsity (the particles' neighbours in the cells).
 * `slot(i, j)` gives where block (i, j) lives, so elements can add into it directly.
 */
export class BlockSparse {
  readonly rowStart: Int32Array;
  readonly cols: Int32Array;
  readonly values: Float64Array;
  private diag: Int32Array;

  constructor(readonly n: number, pairs: Iterable<[number, number]>) {
    const rows: Set<number>[] = Array.from({ length: n }, (_, i) => new Set([i]));
    for (const [i, j] of pairs) {
      rows[i].add(j);
      rows[j].add(i);
    }
    this.rowStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.rowStart[i + 1] = this.rowStart[i] + rows[i].size;
    this.cols = new Int32Array(this.rowStart[n]);
    this.diag = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const sorted = [...rows[i]].sort((a, b) => a - b);
      sorted.forEach((j, k) => {
        this.cols[this.rowStart[i] + k] = j;
        if (j === i) this.diag[i] = this.rowStart[i] + k;
      });
    }
    this.values = new Float64Array(this.cols.length * 9);
  }

  /** Index of block (i, j) in `values` (times 9), or -1. */
  slot(i: number, j: number): number {
    if (i === j) return this.diag[i];
    let lo = this.rowStart[i], hi = this.rowStart[i + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, c = this.cols[mid];
      if (c === j) return mid;
      if (c < j) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  clear() {
    this.values.fill(0);
  }

  /** Add d to the diagonal of block (i, i). */
  addDiagonal(i: number, d: number) {
    const s = this.diag[i] * 9;
    this.values[s] += d;
    this.values[s + 4] += d;
    this.values[s + 8] += d;
  }

  /** y = A x */
  multiply(x: Float64Array, y: Float64Array) {
    const V = this.values, C = this.cols, R = this.rowStart;
    for (let i = 0; i < this.n; i++) {
      let y0 = 0, y1 = 0, y2 = 0;
      for (let k = R[i]; k < R[i + 1]; k++) {
        const j = C[k] * 3, b = k * 9, x0 = x[j], x1 = x[j + 1], x2 = x[j + 2];
        y0 += V[b] * x0 + V[b + 1] * x1 + V[b + 2] * x2;
        y1 += V[b + 3] * x0 + V[b + 4] * x1 + V[b + 5] * x2;
        y2 += V[b + 6] * x0 + V[b + 7] * x1 + V[b + 8] * x2;
      }
      y[i * 3] = y0;
      y[i * 3 + 1] = y1;
      y[i * 3 + 2] = y2;
    }
  }

  /**
   * Solve A x = b by conjugate gradients with a block-Jacobi preconditioner, from x's current value (warm start).
   * Stops early at a relative residual of `tolerance`, or on negative curvature (an indefinite Newton matrix): then
   * the last direction that still went downhill is kept. Returns the iterations used.
   */
  solve(b: Float64Array, x: Float64Array, iterations: number, tolerance = 1e-4, work = new CGWork(this.n)): number {
    const { r, z, p, q, pre } = work;
    const n3 = this.n * 3;
    // Block-Jacobi: the inverse of each diagonal block (fall back to its diagonal when it is not positive).
    const V = this.values;
    for (let i = 0; i < this.n; i++) {
      const s = this.diag[i] * 9, o = i * 9;
      const d = det3(V.subarray(s, s + 9));
      if (d > 1e-18 && V[s] > 0) inv3(V.subarray(s, s + 9), pre.subarray(o, o + 9));
      else {
        pre.fill(0, o, o + 9);
        for (let k = 0; k < 3; k++) pre[o + k * 4] = 1 / Math.max(Math.abs(V[s + k * 4]), 1e-12);
      }
    }
    const precondition = (from: Float64Array, to: Float64Array) => {
      for (let i = 0; i < this.n; i++) {
        const o = i * 9, a = from[i * 3], bb = from[i * 3 + 1], c = from[i * 3 + 2];
        to[i * 3] = pre[o] * a + pre[o + 1] * bb + pre[o + 2] * c;
        to[i * 3 + 1] = pre[o + 3] * a + pre[o + 4] * bb + pre[o + 5] * c;
        to[i * 3 + 2] = pre[o + 6] * a + pre[o + 7] * bb + pre[o + 8] * c;
      }
    };
    this.multiply(x, q);
    let bnorm = 0;
    for (let k = 0; k < n3; k++) {
      r[k] = b[k] - q[k];
      bnorm += b[k] * b[k];
    }
    bnorm = Math.sqrt(bnorm) || 1;
    precondition(r, z);
    p.set(z);
    let rz = 0;
    for (let k = 0; k < n3; k++) rz += r[k] * z[k];
    let it = 0;
    for (; it < iterations; it++) {
      let rr = 0;
      for (let k = 0; k < n3; k++) rr += r[k] * r[k];
      if (Math.sqrt(rr) < tolerance * bnorm) break;
      this.multiply(p, q);
      let pq = 0;
      for (let k = 0; k < n3; k++) pq += p[k] * q[k];
      // Negative curvature (an indefinite Newton matrix): keep what went downhill so far.
      if (pq <= 0) break;
      const alpha = rz / pq;
      for (let k = 0; k < n3; k++) {
        x[k] += alpha * p[k];
        r[k] -= alpha * q[k];
      }
      precondition(r, z);
      let rzNew = 0;
      for (let k = 0; k < n3; k++) rzNew += r[k] * z[k];
      const beta = rzNew / rz;
      rz = rzNew;
      for (let k = 0; k < n3; k++) p[k] = z[k] + beta * p[k];
    }
    return it;
  }
}

/** Scratch vectors of a CG solve. */
export class CGWork {
  readonly r: Float64Array;
  readonly z: Float64Array;
  readonly p: Float64Array;
  readonly q: Float64Array;
  readonly pre: Float64Array;
  constructor(n: number) {
    this.r = new Float64Array(n * 3);
    this.z = new Float64Array(n * 3);
    this.p = new Float64Array(n * 3);
    this.q = new Float64Array(n * 3);
    this.pre = new Float64Array(n * 9);
  }
}

/**
 * Cholesky factorisation of a sparse SPD matrix in envelope (skyline) storage, its rows and columns reordered by
 * reverse Cuthill–McKee so that the envelope stays narrow: each row keeps the columns from its first non-zero to
 * the diagonal, and the factor fills in only there. Factor once, solve many times (Projective Dynamics).
 */
export class EnvelopeCholesky {
  /** perm[k] = original index at position k, and its inverse. */
  readonly perm: Int32Array;
  readonly rank: Int32Array;
  private first: Int32Array;
  private start: Int32Array;
  private L: Float64Array;
  private tmp: Float64Array;

  constructor(readonly n: number, neighbours: readonly (readonly number[])[]) {
    this.perm = reverseCuthillMcKee(n, neighbours);
    this.rank = new Int32Array(n);
    this.perm.forEach((orig, k) => (this.rank[orig] = k));
    this.first = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      let f = k;
      for (const j of neighbours[this.perm[k]]) f = Math.min(f, this.rank[j]);
      this.first[k] = f;
    }
    this.start = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) this.start[k + 1] = this.start[k] + (k - this.first[k] + 1);
    this.L = new Float64Array(this.start[n]);
    this.tmp = new Float64Array(n);
  }

  /** Envelope size (stored entries). */
  get size(): number {
    return this.L.length;
  }

  clear() {
    this.L.fill(0);
  }

  /** Add v to entry (i, j) (original indices; symmetric, so either triangle). */
  add(i: number, j: number, v: number) {
    let a = this.rank[i], b = this.rank[j];
    if (b > a) [a, b] = [b, a];
    this.L[this.start[a] + b - this.first[a]] += v;
  }

  factor() {
    const { L, first, start, n } = this;
    for (let i = 0; i < n; i++) {
      const fi = first[i], si = start[i] - fi;
      for (let j = fi; j <= i; j++) {
        const sj = start[j] - first[j];
        let s = L[si + j];
        for (let k = Math.max(fi, first[j]); k < j; k++) s -= L[si + k] * L[sj + k];
        if (j < i) L[si + j] = s / L[sj + j];
        else L[si + i] = Math.sqrt(Math.max(s, 1e-12));
      }
    }
  }

  /** Solve A x = b for one component of interleaved vectors (b[i * stride + offset]), in place. */
  solve(b: Float64Array, stride = 1, offset = 0) {
    const { L, first, start, n, perm, tmp } = this;
    for (let k = 0; k < n; k++) tmp[k] = b[perm[k] * stride + offset];
    for (let i = 0; i < n; i++) {
      const si = start[i] - first[i];
      let s = tmp[i];
      for (let k = first[i]; k < i; k++) s -= L[si + k] * tmp[k];
      tmp[i] = s / L[si + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      const si = start[i] - first[i];
      tmp[i] /= L[si + i];
      const t = tmp[i];
      for (let k = first[i]; k < i; k++) tmp[k] -= L[si + k] * t;
    }
    for (let k = 0; k < n; k++) b[perm[k] * stride + offset] = tmp[k];
  }
}

/** Reverse Cuthill–McKee ordering: breadth-first from a far-out node, neighbours by increasing degree, reversed. */
function reverseCuthillMcKee(n: number, nb: readonly (readonly number[])[]): Int32Array {
  const order: number[] = [], seen = new Uint8Array(n);
  const bfs = (s: number, record: boolean) => {
    const level = new Int32Array(n).fill(-1);
    const queue = [s];
    level[s] = 0;
    let last = s;
    for (let q = 0; q < queue.length; q++) {
      const v = queue[q];
      last = v;
      if (record) order.push(v);
      const next = nb[v].filter((w) => level[w] < 0 && !(record && seen[w]));
      next.sort((a, b) => nb[a].length - nb[b].length);
      for (const w of next) {
        level[w] = level[v] + 1;
        if (record) seen[w] = 1;
        queue.push(w);
      }
    }
    return last;
  };
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    // A pseudo-peripheral start: the last node reached from s, twice.
    let start = bfs(bfs(s, false), false);
    if (seen[start]) start = s;
    seen[start] = 1;
    bfs(start, true);
  }
  return Int32Array.from(order.reverse());
}
