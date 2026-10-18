/**
 * Tetrahedralise a closed surface the simple way, as Rapier does: a regular lattice of cubes, keep the cubes that are
 * inside the surface or hold one of its vertices, and split each cube into six tetrahedra (Kuhn / Freudenthal split
 * along the cube's main diagonal, so neighbouring cubes share their faces' diagonals and the mesh is conforming).
 * Lattice nodes on the boundary may lie a little outside the surface; the render surface is embedded in the
 * tetrahedra (barycentric coordinates of each surface vertex in its cell) and so follows them.
 */

export interface TetMesh {
  /** Rest node positions, xyz. */
  readonly nodes: Float32Array;
  /** 4 node indices per tetrahedron, positively oriented at rest. */
  readonly tets: Uint32Array;
  /** Unique edges of the tetrahedra, 2 node indices each. */
  readonly edges: Uint32Array;
  /** Lattice step (m). */
  readonly cell: number;
  /** For each surface vertex: its tetrahedron and its 4 barycentric weights. */
  readonly embedTet: Uint32Array;
  readonly embedWeight: Float32Array;
}

/** The 6 tetrahedra of a cube with corners numbered x + 2y + 4z: every path 0 → 7 along the three axes in some order. */
const KUHN: [number, number, number, number][] = [
  [0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7],
];

/** Inside intervals along z of each lattice column (x, y): the parity of the surface crossings of a ray along +z. */
function columnCrossings(P: Float32Array, I: Uint32Array, x: number, y: number): number[] {
  const zs: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[a] - x, ay = P[a + 1] - y, bx = P[b] - x, by = P[b + 1] - y, cx = P[c] - x, cy = P[c + 1] - y;
    // Is (0, 0) inside the triangle's projection? Same sign of the three edge functions.
    const w0 = bx * cy - by * cx, w1 = cx * ay - cy * ax, w2 = ax * by - ay * bx;
    if ((w0 < 0 || w1 < 0 || w2 < 0) && (w0 > 0 || w1 > 0 || w2 > 0)) continue;
    const s = w0 + w1 + w2;
    if (Math.abs(s) < 1e-18) continue;
    zs.push((w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2]) / s);
  }
  return zs.sort((p, q) => p - q);
}

function insideAlong(zs: number[], z: number): boolean {
  let n = 0;
  for (const c of zs) if (c < z) n++;
  return (n & 1) === 1;
}

function bounds(P: Float32Array) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[i + k]);
      hi[k] = Math.max(hi[k], P[i + k]);
    }
  }
  return { lo, hi };
}

/** The cubes kept for a lattice step: inside (by their centre) or holding a surface vertex. */
function keptCubes(P: Float32Array, I: Uint32Array, cell: number) {
  const { lo, hi } = bounds(P);
  // A small odd offset keeps the column rays off the surface's vertices and edges.
  const origin = lo.map((v) => v - cell * 0.5 - cell * 0.0137);
  const dims = hi.map((v, k) => Math.max(1, Math.ceil((v - origin[k]) / cell) + 1));
  const [nx, ny, nz] = dims;
  const kept = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const zs = columnCrossings(P, I, origin[0] + (i + 0.5) * cell, origin[1] + (j + 0.5) * cell);
      if (!zs.length) continue;
      for (let k = 0; k < nz; k++) if (insideAlong(zs, origin[2] + (k + 0.5) * cell)) kept[i + nx * (j + ny * k)] = 1;
    }
  }
  const cubeOf = (x: number, y: number, z: number) => {
    const i = Math.min(nx - 1, Math.max(0, Math.floor((x - origin[0]) / cell)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((y - origin[1]) / cell)));
    const k = Math.min(nz - 1, Math.max(0, Math.floor((z - origin[2]) / cell)));
    return i + nx * (j + ny * k);
  };
  for (let v = 0; v < P.length; v += 3) kept[cubeOf(P[v], P[v + 1], P[v + 2])] = 1;
  return { origin, dims, kept, cubeOf };
}

/** Lattice nodes used by a lattice step (to aim at a particle count). */
export function latticeNodeCount(P: Float32Array, I: Uint32Array, cell: number): number {
  const { dims, kept } = keptCubes(P, I, cell);
  const [nx, ny] = dims, used = new Set<number>();
  kept.forEach((k, c) => {
    if (!k) return;
    const i = c % nx, j = Math.floor(c / nx) % ny, kk = Math.floor(c / (nx * ny));
    for (let corner = 0; corner < 8; corner++) used.add((i + (corner & 1)) + (nx + 1) * ((j + ((corner >> 1) & 1)) + (ny + 1) * (kk + (corner >> 2))));
  });
  return used.size;
}

/** The lattice step that gives about `particles` nodes (a few trial counts). */
export function cellForParticles(P: Float32Array, I: Uint32Array, volume: number, particles: number): number {
  let cell = Math.cbrt(Math.abs(volume) / particles);
  for (let k = 0; k < 5; k++) {
    const n = latticeNodeCount(P, I, cell);
    if (Math.abs(n - particles) < 0.06 * particles) break;
    cell *= Math.cbrt(n / particles);
  }
  return cell;
}

export function tetVolume(X: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const ax = X[a * 3], ay = X[a * 3 + 1], az = X[a * 3 + 2];
  const ux = X[b * 3] - ax, uy = X[b * 3 + 1] - ay, uz = X[b * 3 + 2] - az;
  const vx = X[c * 3] - ax, vy = X[c * 3 + 1] - ay, vz = X[c * 3 + 2] - az;
  const wx = X[d * 3] - ax, wy = X[d * 3 + 1] - ay, wz = X[d * 3 + 2] - az;
  return (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
}

/** Fill a closed surface with tetrahedra on a lattice of step `cell`, and embed its vertices. */
export function tetrahedralise(P: Float32Array, I: Uint32Array, cell: number): TetMesh {
  const { origin, dims, kept, cubeOf } = keptCubes(P, I, cell);
  const [nx, ny] = dims;
  const nodeId = new Map<number, number>();
  const nodes: number[] = [];
  const node = (i: number, j: number, k: number) => {
    const key = i + (nx + 1) * (j + (ny + 1) * k);
    let id = nodeId.get(key);
    if (id === undefined) {
      nodeId.set(key, (id = nodes.length / 3));
      nodes.push(origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell);
    }
    return id;
  };
  const tets: number[] = [];
  /** First tetrahedron of each kept cube. */
  const firstTet = new Map<number, number>();
  kept.forEach((k, c) => {
    if (!k) return;
    const i = c % nx, j = Math.floor(c / nx) % ny, kk = Math.floor(c / (nx * ny));
    const corner = Array.from({ length: 8 }, (_, q) => node(i + (q & 1), j + ((q >> 1) & 1), kk + (q >> 2)));
    firstTet.set(c, tets.length / 4);
    for (const t of KUHN) tets.push(corner[t[0]], corner[t[1]], corner[t[2]], corner[t[3]]);
  });
  const X = new Float32Array(nodes), T = new Uint32Array(tets);
  for (let t = 0; t < T.length; t += 4) {
    if (tetVolume(X, T[t], T[t + 1], T[t + 2], T[t + 3]) < 0) [T[t + 2], T[t + 3]] = [T[t + 3], T[t + 2]];
  }
  const edgeSet = new Set<number>();
  const n = X.length / 3;
  for (let t = 0; t < T.length; t += 4) {
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const p = Math.min(T[t + a], T[t + b]), q = Math.max(T[t + a], T[t + b]);
        edgeSet.add(p * n + q);
      }
    }
  }
  const edges = new Uint32Array(edgeSet.size * 2);
  let e = 0;
  for (const key of edgeSet) {
    edges[e++] = Math.floor(key / n);
    edges[e++] = key % n;
  }

  // Embed each surface vertex in the tetrahedron of its cube that holds it best (largest smallest weight).
  const nv = P.length / 3;
  const embedTet = new Uint32Array(nv), embedWeight = new Float32Array(nv * 4);
  const w = new Float64Array(4);
  for (let v = 0; v < nv; v++) {
    const first = firstTet.get(cubeOf(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]))!;
    let best = -Infinity;
    for (let t = first; t < first + 6; t++) {
      barycentric(X, T, t, P[v * 3], P[v * 3 + 1], P[v * 3 + 2], w);
      const m = Math.min(w[0], w[1], w[2], w[3]);
      if (m > best) {
        best = m;
        embedTet[v] = t;
        embedWeight.set(w, v * 4);
      }
    }
  }
  return { nodes: X, tets: T, edges, cell, embedTet, embedWeight };
}

/** Barycentric weights of a point in tetrahedron t. */
export function barycentric(X: ArrayLike<number>, T: Uint32Array, t: number, x: number, y: number, z: number, out: Float64Array) {
  const a = T[t * 4], b = T[t * 4 + 1], c = T[t * 4 + 2], d = T[t * 4 + 3];
  const ids = [a, b, c, d], p = [x, y, z], Y = new Float64Array(12);
  const v = tetVolume(X, a, b, c, d);
  for (let slot = 0; slot < 4; slot++) {
    // The weight of a vertex: the volume with that vertex replaced by the point, over the whole.
    for (let k = 0; k < 4; k++) for (let m = 0; m < 3; m++) Y[k * 3 + m] = k === slot ? p[m] : X[ids[k] * 3 + m];
    out[slot] = tetVolume(Y, 0, 1, 2, 3) / v;
  }
}

/** The embedded surface for current node positions. */
export function embeddedSurface(mesh: TetMesh, x: Float32Array, out: Float32Array): Float32Array {
  const T = mesh.tets, ET = mesh.embedTet, EW = mesh.embedWeight;
  for (let v = 0; v < ET.length; v++) {
    const t = ET[v] * 4;
    let px = 0, py = 0, pz = 0;
    for (let k = 0; k < 4; k++) {
      const n = T[t + k] * 3, wk = EW[v * 4 + k];
      px += wk * x[n];
      py += wk * x[n + 1];
      pz += wk * x[n + 2];
    }
    out[v * 3] = px;
    out[v * 3 + 1] = py;
    out[v * 3 + 2] = pz;
  }
  return out;
}
