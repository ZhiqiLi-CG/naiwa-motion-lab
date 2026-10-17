/** Mesh queries the simulation needs once, when it builds the frog: closest points, inside tests, a coarse skin. */
import type * as THREE from "three";

/** Distance from p to the segment ab. */
export function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / Math.max(1e-12, abx * abx + aby * aby + abz * abz)));
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t);
}

/** Nearest hit (t > 0) of a ray with a triangle mesh, and the hit triangle's normal facing the ray. */
export function rayHitMesh(
  ray: THREE.Ray, P: Float32Array, I: Uint32Array,
): { t: number; normal: THREE.Vector3 } | null {
  const o = ray.origin, d = ray.direction;
  let best = Infinity, tri = -1;
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
    const t = rayTriangle(o.x, o.y, o.z, d.x, d.y, d.z, P, a, b, c);
    if (t > 0 && t < best) {
      best = t;
      tri = k;
    }
  }
  if (tri < 0) return null;
  const a = I[tri] * 3, b = I[tri + 1] * 3, c = I[tri + 2] * 3;
  const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
  const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
  const n = new (ray.origin.constructor as typeof THREE.Vector3)(
    e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0],
  ).normalize();
  if (n.dot(d) > 0) n.negate();
  return { t: best, normal: n };
}

/** Möller–Trumbore: distance along the ray to triangle (a, b, c) (offsets into P), or -1. */
function rayTriangle(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, P: Float32Array, a: number, b: number,
  c: number,
): number {
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2];
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** A closed triangle mesh with per-triangle bounding spheres for culled closest-point queries. */
export class TriMesh {
  readonly centers: Float32Array;
  readonly radii: Float32Array;
  constructor(
    readonly positions: Float32Array,
    readonly indices: Uint32Array,
  ) {
    const n = indices.length / 3;
    this.centers = new Float32Array(n * 3);
    this.radii = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] * 3;
        cx += positions[v] / 3;
        cy += positions[v + 1] / 3;
        cz += positions[v + 2] / 3;
      }
      let r = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k] * 3;
        r = Math.max(r, Math.hypot(positions[v] - cx, positions[v + 1] - cy, positions[v + 2] - cz));
      }
      this.centers.set([cx, cy, cz], t * 3);
      this.radii[t] = r;
    }
  }

  /** Closest point of the surface to (x, y, z), written into out; returns the distance. */
  closest(x: number, y: number, z: number, out: Float64Array): number {
    const P = this.positions, I = this.indices, C = this.centers, R = this.radii;
    let best = Infinity;
    const tmp = new Float64Array(3);
    for (let t = 0; t < R.length; t++) {
      const dc = Math.hypot(x - C[t * 3], y - C[t * 3 + 1], z - C[t * 3 + 2]);
      if (dc - R[t] >= best) continue;
      const d = closestOnTriangle(x, y, z, P, I[t * 3] * 3, I[t * 3 + 1] * 3, I[t * 3 + 2] * 3, tmp);
      if (d < best) {
        best = d;
        out.set(tmp);
      }
    }
    return best;
  }

  /** Is the point inside the closed surface? (Parity of the crossings of a ray in a generic direction.) */
  contains(x: number, y: number, z: number): boolean {
    const P = this.positions, I = this.indices;
    const dx = 0.5773, dy = 0.5821, dz = 0.5726;
    let crossings = 0;
    for (let t = 0; t < I.length; t += 3) {
      if (rayTriangle(x, y, z, dx, dy, dz, P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3) > 0) crossings++;
    }
    return (crossings & 1) === 1;
  }

  /** Signed distance to the surface: negative inside. */
  signedDistance(x: number, y: number, z: number): number {
    const d = this.closest(x, y, z, new Float64Array(3));
    return this.contains(x, y, z) ? -d : d;
  }

  /** Volume enclosed (positive when the triangles wind counter-clockwise seen from outside). */
  volume(): number {
    const P = this.positions, I = this.indices;
    let v = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      v +=
        (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) -
          P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) +
          P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
    }
    return v;
  }
}

/** Closest point on triangle (a, b, c) (offsets into P) to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(
  px: number, py: number, pz: number, P: Float32Array, a: number, b: number, c: number, out: Float64Array,
): number {
  const ax = P[a], ay = P[a + 1], az = P[a + 2];
  const abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az;
  const acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number;
  if (d1 <= 0 && d2 <= 0) {
    u = 0; v = 0;
  } else {
    const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      u = 1; v = 0;
    } else if (d6 >= 0 && d5 <= d6) {
      u = 0; v = 1;
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      u = d1 / (d1 - d3); v = 0;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      u = 0; v = d2 / (d2 - d6);
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      u = 1 - w; v = w;
    } else {
      const denom = 1 / (va + vb + vc);
      u = vb * denom; v = vc * denom;
    }
  }
  out[0] = ax + abx * u + acx * v;
  out[1] = ay + aby * u + acy * v;
  out[2] = az + abz * u + acz * v;
  return Math.hypot(px - out[0], py - out[1], pz - out[2]);
}

/**
 * A coarse copy of the surface for collisions: the boundary of the soft body's lattice (closed, as coarse as its
 * cells), its vertices moved onto the fine surface and spread evenly over it by a few relax-and-project rounds.
 * Returns the vertices and the triangles (indices into the vertices, same winding as the boundary).
 */
export function coarseSkin(
  surface: TriMesh, particles: Float32Array, boundary: Uint32Array, rounds = 8,
): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<number, number>();
  const indices = new Uint32Array(boundary.length);
  for (let i = 0; i < boundary.length; i++) {
    let v = map.get(boundary[i]);
    if (v === undefined) map.set(boundary[i], (v = map.size));
    indices[i] = v;
  }
  const n = map.size;
  const pos = new Float32Array(n * 3);
  for (const [particle, v] of map) pos.set(particles.subarray(particle * 3, particle * 3 + 3), v * 3);
  const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      neighbours[indices[t + k]].add(indices[t + ((k + 1) % 3)]);
      neighbours[indices[t + k]].add(indices[t + ((k + 2) % 3)]);
    }
  }
  const out = new Float64Array(3);
  const project = (v: number, x: number, y: number, z: number) => {
    surface.closest(x, y, z, out);
    pos[v * 3] = out[0];
    pos[v * 3 + 1] = out[1];
    pos[v * 3 + 2] = out[2];
  };
  for (let v = 0; v < n; v++) project(v, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  for (let r = 0; r < rounds; r++) {
    const prev = pos.slice();
    for (let v = 0; v < n; v++) {
      let ax = 0, ay = 0, az = 0;
      for (const w of neighbours[v]) {
        ax += prev[w * 3];
        ay += prev[w * 3 + 1];
        az += prev[w * 3 + 2];
      }
      const k = neighbours[v].size;
      const x = prev[v * 3], y = prev[v * 3 + 1], z = prev[v * 3 + 2];
      project(v, x + 0.6 * (ax / k - x), y + 0.6 * (ay / k - y), z + 0.6 * (az / k - z));
    }
  }
  return { positions: pos, indices };
}
