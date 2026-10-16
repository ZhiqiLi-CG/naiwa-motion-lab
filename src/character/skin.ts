/**
 * Showing the simulated flesh: the rendered Body is the rest surface skinned to the simulated bones plus the
 * simulation's own deformation on top (the residual), lightly smoothed so a coarse simulation lattice never shows
 * as facets or creases; expressions are added in the head's frame; normals are recomputed every frame on the welded
 * surface, so no seam ever shows. The limbs' roots, sunk into the Body, follow the same residual.
 */
import * as THREE from "three";
import type { Expression } from "../contracts";
import { computeNormals } from "./surface";

export interface BodySkinInit {
  rest: Float32Array;
  indices: Uint32Array;
  /** Per welded vertex: four bone slots (indices into the bone list) and weights. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  boneCount: number;
  softness: Float32Array;
  /** Expression → per welded vertex offsets (rest world frame). */
  morphs: Map<Expression, Float32Array>;
}

/**
 * How far the simulated deformation is blurred (meters): about half a cell of a coarse simulation lattice, so the
 * kinks where its cells meet never show, while every dent the lattice can make stays.
 */
const SMOOTH_RADIUS = 0.025;
/** Breathing swells the soft belly by this much (meters, at softness 1). */
const BREATH = 0.0035;

export class BodySkin {
  readonly count: number;
  readonly rest: Float32Array;
  readonly indices: Uint32Array;
  /** Final rendered positions and normals (welded). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Skinned rest + smoothed residual, without expressions (what the eyes, mouth and limb roots ride on). */
  readonly surface: Float32Array;
  /** The smoothed residual (simulation − skinning), world. */
  readonly residual: Float32Array;

  private skinIndex: Uint16Array;
  private skinWeight: Float32Array;
  private softness: Float32Array;
  private adjStart: Uint32Array;
  private adj: Uint32Array;
  private tmp: Float32Array;
  private boneDelta: Float32Array;
  private morphs: [Expression, Float32Array, Uint32Array][];
  private passes: number;

  constructor(init: BodySkinInit) {
    const n = (this.count = init.rest.length / 3);
    this.rest = init.rest;
    this.indices = init.indices;
    this.skinIndex = init.skinIndex;
    this.skinWeight = init.skinWeight;
    this.softness = init.softness;
    this.positions = new Float32Array(3 * n);
    this.normals = new Float32Array(3 * n);
    this.surface = new Float32Array(3 * n);
    this.residual = new Float32Array(3 * n);
    this.tmp = new Float32Array(3 * n);
    this.boneDelta = new Float32Array(16 * init.boneCount);

    // Vertex neighbours (CSR) for smoothing.
    const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
    const t = init.indices;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k], b = t[k + 1], c = t[k + 2];
      sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
    }
    this.adjStart = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.adjStart[i + 1] = this.adjStart[i] + sets[i].size;
    this.adj = new Uint32Array(this.adjStart[n]);
    for (let i = 0; i < n; i++) this.adj.set([...sets[i]], this.adjStart[i]);
    // Each half-weight averaging pass spreads the residual like diffusion: about edge·sqrt(passes/2).
    let len = 0;
    for (let i = 0; i < n; i++) {
      for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
        const j = this.adj[k];
        len += Math.hypot(init.rest[3 * i] - init.rest[3 * j], init.rest[3 * i + 1] - init.rest[3 * j + 1], init.rest[3 * i + 2] - init.rest[3 * j + 2]);
      }
    }
    const edge = len / this.adj.length;
    this.passes = Math.min(12, Math.max(1, Math.round(2 * (SMOOTH_RADIUS / edge) ** 2)));

    // Only the vertices an expression moves are visited each frame.
    this.morphs = [...init.morphs].map(([name, d]) => {
      const moved: number[] = [];
      for (let i = 0; i < n; i++) if (d[3 * i] || d[3 * i + 1] || d[3 * i + 2]) moved.push(i);
      return [name, d, Uint32Array.from(moved)];
    });
    computeNormals(init.rest, init.indices, this.normals);
  }

  /** Which expressions the Body has shapes for. */
  has(e: Expression): boolean {
    return this.morphs.some(([n]) => n === e);
  }

  /**
   * sim: simulated surface (world, welded order); deltas: per bone world · rest⁻¹; headTurn: head rotation
   * relative to rest; weights: expression weights; breath: −1…1.
   */
  update(
    sim: Float32Array,
    deltas: THREE.Matrix4[],
    headTurn: THREE.Quaternion,
    weights: Record<Expression, number>,
    breath: number,
  ): void {
    const n = this.count;
    const rest = this.rest, res = this.residual, surf = this.surface, P = this.positions;
    const D = this.boneDelta;
    for (let b = 0; b < deltas.length; b++) D.set(deltas[b].elements, 16 * b);
    const si = this.skinIndex, sw = this.skinWeight;

    // Skinning of the rest surface; the residual is what the simulation adds to it.
    for (let i = 0; i < n; i++) {
      const x = rest[3 * i], y = rest[3 * i + 1], z = rest[3 * i + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw[4 * i + k];
        if (w === 0) continue;
        const m = 16 * si[4 * i + k];
        sx += w * (D[m] * x + D[m + 4] * y + D[m + 8] * z + D[m + 12]);
        sy += w * (D[m + 1] * x + D[m + 5] * y + D[m + 9] * z + D[m + 13]);
        sz += w * (D[m + 2] * x + D[m + 6] * y + D[m + 10] * z + D[m + 14]);
      }
      surf[3 * i] = sx; surf[3 * i + 1] = sy; surf[3 * i + 2] = sz;
      res[3 * i] = sim[3 * i] - sx; res[3 * i + 1] = sim[3 * i + 1] - sy; res[3 * i + 2] = sim[3 * i + 2] - sz;
    }
    // Smooth the residual (not the shape: the rest detail stays crisp, only the simulated deformation is softened).
    const st = this.adjStart, adj = this.adj, tmp = this.tmp;
    for (let pass = 0; pass < this.passes; pass++) {
      for (let i = 0; i < n; i++) {
        let ax = 0, ay = 0, az = 0;
        const s = st[i], e = st[i + 1];
        for (let k = s; k < e; k++) {
          const j = 3 * adj[k];
          ax += res[j]; ay += res[j + 1]; az += res[j + 2];
        }
        const inv = 0.5 / (e - s);
        tmp[3 * i] = 0.5 * res[3 * i] + ax * inv;
        tmp[3 * i + 1] = 0.5 * res[3 * i + 1] + ay * inv;
        tmp[3 * i + 2] = 0.5 * res[3 * i + 2] + az * inv;
      }
      res.set(tmp);
    }
    // Breathing along last frame's normals, mostly in the soft belly.
    const nrm = this.normals, soft = this.softness;
    const bAmp = BREATH * breath;
    for (let i = 0; i < 3 * n; i++) surf[i] += res[i];
    P.set(surf);
    if (bAmp) {
      for (let i = 0; i < n; i++) {
        const a = bAmp * soft[i] * soft[i];
        P[3 * i] += a * nrm[3 * i]; P[3 * i + 1] += a * nrm[3 * i + 1]; P[3 * i + 2] += a * nrm[3 * i + 2];
      }
    }
    // Expressions on top, turned with the head.
    const q = headTurn;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    for (const [name, d, moved] of this.morphs) {
      const w = weights[name];
      if (!(w > 1e-4)) continue;
      for (let k = 0; k < moved.length; k++) {
        const i = 3 * moved[k];
        const vx = d[i] * w, vy = d[i + 1] * w, vz = d[i + 2] * w;
        // Quaternion rotation v' = v + 2w(q×v) + 2q×(q×v).
        const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
        P[i] += vx + qw * tx + (qy * tz - qz * ty);
        P[i + 1] += vy + qw * ty + (qz * tx - qx * tz);
        P[i + 2] += vz + qw * tz + (qx * ty - qy * tx);
      }
    }
    computeNormals(P, this.indices, nrm);
  }
}

/** Limb vertices sunk into (or just outside) the Body, each tied to its nearest Body vertex. */
export interface RootTie {
  /** Limb vertex, Body vertex, weight (1 inside the Body, fading to 0 a few centimetres out). */
  vertex: Uint32Array;
  body: Uint32Array;
  weight: Float32Array;
}

/** Ties for limb vertices (rest world) within reach of the Body surface (rest positions + normals). */
export function tieRoots(limb: Float32Array, rest: Float32Array, normals: Float32Array, fade = 0.04): RootTie {
  const v: number[] = [], b: number[] = [], w: number[] = [];
  const nb = rest.length / 3;
  for (let i = 0; i < limb.length / 3; i++) {
    const x = limb[3 * i], y = limb[3 * i + 1], z = limb[3 * i + 2];
    let best = -1, bestD = 0.12 * 0.12;
    for (let j = 0; j < nb; j++) {
      const dx = x - rest[3 * j], dy = y - rest[3 * j + 1], dz = z - rest[3 * j + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) (bestD = d), (best = j);
    }
    if (best < 0) continue;
    const s = (x - rest[3 * best]) * normals[3 * best] + (y - rest[3 * best + 1]) * normals[3 * best + 1] +
      (z - rest[3 * best + 2]) * normals[3 * best + 2];
    const weight = s <= 0 ? 1 : 1 - s / fade;
    if (weight <= 0) continue;
    v.push(i); b.push(best); w.push(weight);
  }
  return { vertex: Uint32Array.from(v), body: Uint32Array.from(b), weight: Float32Array.from(w) };
}

/**
 * The skin material with cheap cues that sell softness: a glossy coat whose highlight slides over the wobble,
 * a warm sheen, and warm light at grazing angles as if scattered under the skin. rootOffset adds the per-vertex
 * attribute that moves skinned limb roots with the flesh.
 */
export function softSkinMaterial(src: THREE.Material, rootOffset: boolean): THREE.MeshPhysicalMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshPhysicalMaterial({
    name: `${s.name} (soft)`,
    color: s.color?.clone() ?? new THREE.Color(1, 1, 1),
    map: s.map ?? null,
    vertexColors: s.vertexColors,
    roughness: 0.5,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.28,
    sheen: 0.5,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(1, 0.72, 0.4),
  });
  m.onBeforeCompile = (sh) => {
    if (rootOffset) {
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute vec3 rootOffset;")
        .replace("#include <skinning_vertex>", "#include <skinning_vertex>\ntransformed += rootOffset;");
    }
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <emissivemap_fragment>",
      `#include <emissivemap_fragment>
      {
        // Light scattered in the jelly: warm, strongest where the skin turns away from the eye.
        float facing = saturate(dot(normal, normalize(vViewPosition)));
        float rim = (1.0 - facing) * (1.0 - facing);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.62, 0.32) * (0.035 + 0.16 * rim);
      }`,
    );
  };
  m.customProgramCacheKey = () => (rootOffset ? "naiwa-soft-root" : "naiwa-soft");
  return m;
}
