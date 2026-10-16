/**
 * Closed-surface utilities for the soft Body: welding the render vertices glTF splits at seams back into one
 * manifold, checking that it really is one, and recomputing smooth normals cheaply every frame.
 */

export interface Welded {
  /** Welded vertex positions, xyz. */
  positions: Float32Array;
  /** Triangles over welded vertices. */
  indices: Uint32Array;
  /** Render vertex → welded vertex. */
  map: Uint32Array;
  /** Welded vertex → one render vertex that maps to it (for per-vertex data such as morph offsets). */
  first: Uint32Array;
}

/**
 * Merge render vertices that sit at the same position (within tol), drop vertices no triangle uses, and re-index
 * the triangles. positions are the render vertices (xyz), indices their triangles.
 */
export function weld(positions: Float32Array, indices: ArrayLike<number>, tol = 1e-6): Welded {
  const n = positions.length / 3;
  const inv = 1 / tol;
  const byKey = new Map<string, number>();
  // Render vertex → canonical render vertex (the first one seen at that spot).
  const canon = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(positions[3 * i] * inv)},${Math.round(positions[3 * i + 1] * inv)},${Math.round(positions[3 * i + 2] * inv)}`;
    const c = byKey.get(key);
    if (c === undefined) {
      byKey.set(key, i);
      canon[i] = i;
    } else canon[i] = c;
  }
  // Number the canonical vertices that triangles use, in order of first use.
  const slot = new Int32Array(n).fill(-1);
  const firstList: number[] = [];
  const tri = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const c = canon[indices[k]];
    if (slot[c] < 0) {
      slot[c] = firstList.length;
      firstList.push(c);
    }
    tri[k] = slot[c];
  }
  const map = new Uint32Array(n);
  for (let i = 0; i < n; i++) map[i] = Math.max(slot[canon[i]], 0);
  const first = Uint32Array.from(firstList);
  const out = new Float32Array(first.length * 3);
  for (let j = 0; j < first.length; j++) {
    out[3 * j] = positions[3 * first[j]];
    out[3 * j + 1] = positions[3 * first[j] + 1];
    out[3 * j + 2] = positions[3 * first[j] + 2];
  }
  return { positions: out, indices: tri, map, first };
}

export interface SurfaceReport {
  vertices: number;
  triangles: number;
  edges: number;
  /** Edges used by one triangle only (holes). */
  boundaryEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles run the same way along it (inconsistent winding). */
  misorientedEdges: number;
  /** Vertices whose triangles form more than one fan (two sheets touching at a point). */
  pinchedVertices: number;
  /** Triangles with a repeated vertex or no area. */
  degenerate: number;
  components: number;
  /** V − E + F (2 for one closed sphere-like surface). */
  euler: number;
  /** Signed volume (positive when the normals point outwards), m³. */
  volume: number;
}

/** Topology and orientation numbers of a triangle surface. */
export function checkSurface(positions: Float32Array, indices: Uint32Array): SurfaceReport {
  const nv = positions.length / 3;
  const nt = indices.length / 3;
  // Undirected edge → [uses, a→b minus b→a with a < b].
  const edges = new Map<number, [number, number]>();
  let degenerate = 0;
  let volume = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
    const bx = positions[3 * b], by = positions[3 * b + 1], bz = positions[3 * b + 2];
    const cx = positions[3 * c], cy = positions[3 * c + 1], cz = positions[3 * c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (a === b || b === c || c === a || area2 < 1e-14) degenerate++;
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * nv + q : q * nv + p;
      const e = edges.get(key);
      const dir = p < q ? 1 : -1;
      if (e) {
        e[0]++;
        e[1] += dir;
      } else edges.set(key, [1, dir]);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, misorientedEdges = 0;
  for (const [uses, dir] of edges.values()) {
    if (uses === 1) boundaryEdges++;
    else if (uses > 2) nonManifoldEdges++;
    else if (dir !== 0) misorientedEdges++;
  }

  // Connected components over shared vertices.
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < nt; t++) {
    const a = find(indices[3 * t]);
    parent[find(indices[3 * t + 1])] = a;
    parent[find(indices[3 * t + 2])] = a;
  }
  const used = new Uint8Array(nv);
  for (let k = 0; k < indices.length; k++) used[indices[k]] = 1;
  let components = 0;
  for (let i = 0; i < nv; i++) if (used[i] && find(i) === i) components++;

  // A vertex is pinched when its incident triangles do not form a single fan through shared edges.
  const fans = new Map<number, number>(); // directed edge (v→w at vertex v) → triangle
  const incident: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) incident[indices[3 * t + k]].push(t);
  let pinchedVertices = 0;
  for (let v = 0; v < nv; v++) {
    const tris = incident[v];
    if (tris.length === 0) continue;
    fans.clear();
    const local = new Map<number, number>();
    tris.forEach((t, i) => local.set(t, i));
    const p = tris.map((_, i) => i);
    const f = (i: number): number => {
      while (p[i] !== i) i = p[i] = p[p[i]];
      return i;
    };
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const w = indices[3 * t + k];
        if (w === v) continue;
        const other = fans.get(w);
        if (other === undefined) fans.set(w, t);
        else p[f(local.get(t)!)] = f(local.get(other)!);
      }
    }
    let roots = 0;
    for (let i = 0; i < p.length; i++) if (f(i) === i) roots++;
    if (roots > 1) pinchedVertices++;
  }

  let referenced = 0;
  for (let i = 0; i < nv; i++) referenced += used[i];
  return {
    vertices: referenced,
    triangles: nt,
    edges: edges.size,
    boundaryEdges,
    nonManifoldEdges,
    misorientedEdges,
    pinchedVertices,
    degenerate,
    components,
    euler: referenced - edges.size + nt,
    volume,
  };
}

/** What is wrong with a surface that should be one closed, consistently outward-wound manifold (empty = fine). */
export function surfaceProblems(r: SurfaceReport): string[] {
  const out: string[] = [];
  if (r.boundaryEdges) out.push(`${r.boundaryEdges} open (boundary) edges`);
  if (r.nonManifoldEdges) out.push(`${r.nonManifoldEdges} edges shared by more than two triangles`);
  if (r.misorientedEdges) out.push(`${r.misorientedEdges} edges with inconsistent winding`);
  if (r.pinchedVertices) out.push(`${r.pinchedVertices} pinched vertices`);
  if (r.degenerate) out.push(`${r.degenerate} degenerate triangles`);
  if (r.components !== 1) out.push(`${r.components} separate pieces`);
  if (!(r.volume > 0)) out.push(`non-positive volume ${r.volume.toFixed(5)} m³ (inward normals)`);
  return out;
}

/** Area-weighted smooth vertex normals of a welded surface, written into out (xyz per vertex). */
export function computeNormals(positions: Float32Array, indices: Uint32Array, out: Float32Array): Float32Array {
  out.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    // The cross product's length is twice the area, so summing it weights by area.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}
