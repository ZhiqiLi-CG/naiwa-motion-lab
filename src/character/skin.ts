/**
 * Showing the simulated flesh: each rendered piece (the Body, an arm, a leg) is its rest surface skinned to the
 * simulated bones plus the simulation's own deformation on top (the residual), lightly smoothed so a coarse
 * simulation lattice never shows as facets or creases; expressions are added in the head's frame; normals are
 * recomputed every frame on the welded surface, so no seam ever shows. Limb roots sunk into the Body take the Body's
 * residual, so the joins ride on the belly's wobble without gaps.
 */
import * as THREE from "three";
import type { Expression } from "../contracts";
import { computeNormals } from "./surface";

export interface FleshInit {
  rest: Float32Array;
  indices: Uint32Array;
  /** Per welded vertex: four bone slots (indices into the bone list) and weights. */
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  boneCount: number;
  softness: Float32Array;
  /** Expression → per welded vertex offsets (rest world frame). */
  morphs: Map<Expression, Float32Array>;
  /**
   * Spacing (meters) of the smooth basis the simulated deformation is shown through: about half a cell of a coarse
   * simulation lattice, so the kinks where its cells meet never show, while every dent the lattice can make stays.
   */
  smoothing: number;
}
/** Breathing swells the soft belly by this much (meters, at softness 1). */
const BREATH = 0.0035;

export class FleshSkin {
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
  private smoother: Smoother;
  private boneDelta: Float32Array;
  private morphs: [Expression, Float32Array, Uint32Array][];

  constructor(init: FleshInit) {
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
    this.boneDelta = new Float32Array(16 * init.boneCount);
    this.smoother = new Smoother(init.rest, init.smoothing);

    // Only the vertices an expression moves are visited each frame.
    this.morphs = [...init.morphs].map(([name, d]) => {
      const moved: number[] = [];
      for (let i = 0; i < n; i++) if (d[3 * i] || d[3 * i + 1] || d[3 * i + 2]) moved.push(i);
      return [name, d, Uint32Array.from(moved)];
    });
    computeNormals(init.rest, init.indices, this.normals);
  }

  /**
   * The deformed surface (fills surface and residual). sim: simulated surface (world, welded order), null when the
   * simulation does not move this piece; deltas: per bone world · rest⁻¹; tie: vertices that take another piece's
   * residual instead of their own (limb roots in the Body).
   */
  deform(sim: Float32Array | null, deltas: THREE.Matrix4[], tie?: { roots: RootTie; residual: Float32Array }): void {
    const n = this.count;
    const rest = this.rest, res = this.residual, surf = this.surface;
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
      if (sim) (res[3 * i] = sim[3 * i] - sx), (res[3 * i + 1] = sim[3 * i + 1] - sy), (res[3 * i + 2] = sim[3 * i + 2] - sz);
    }
    if (!sim) res.fill(0);
    // The root follows the flesh it sinks into (blended before smoothing, so the join is smooth too).
    if (tie) {
      const { vertex, body, weight } = tie.roots, other = tie.residual;
      for (let k = 0; k < vertex.length; k++) {
        const i = 3 * vertex[k], j = 3 * body[k], w = weight[k];
        res[i] += (other[j] - res[i]) * w;
        res[i + 1] += (other[j + 1] - res[i + 1]) * w;
        res[i + 2] += (other[j + 2] - res[i + 2]) * w;
      }
    }
    // Smooth the residual (not the shape: the rest detail stays crisp, only the simulated deformation is softened).
    if (sim || tie) this.smoother.apply(res);

    for (let i = 0; i < 3 * n; i++) surf[i] += res[i];
  }

  /**
   * What is shown (fills positions and normals): the deformed surface with breathing and the expressions on top,
   * the expression offsets turned by turn (the face's rotation from rest); weights: expression weights; breath: −1…1.
   */
  finish(turn: THREE.Quaternion, weights: Record<Expression, number>, breath: number): void {
    const n = this.count, P = this.positions;
    // Breathing along last frame's normals, mostly in the soft belly.
    const nrm = this.normals, soft = this.softness;
    const bAmp = BREATH * breath;
    P.set(this.surface);
    if (bAmp) {
      for (let i = 0; i < n; i++) {
        const a = bAmp * soft[i] * soft[i];
        P[3 * i] += a * nrm[3 * i]; P[3 * i + 1] += a * nrm[3 * i + 1]; P[3 * i + 2] += a * nrm[3 * i + 2];
      }
    }
    // Expressions on top, turned with the face.
    const q = turn;
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

/**
 * A smooth basis over a surface: control points about h apart (greedy Poisson-disk over the rest vertices). A field
 * is gathered onto them with Gaussian weights and spread back the same way, so it keeps no detail finer than about
 * 2h whatever the mesh resolution, at a fixed cost per frame.
 */
class Smoother {
  private gStart: Uint32Array;
  private gIndex: Uint32Array;
  private gWeight: Float32Array;
  private sStart: Uint32Array;
  private sIndex: Uint32Array;
  private sWeight: Float32Array;
  private ctrl: Float32Array;

  constructor(rest: Float32Array, h: number) {
    const n = rest.length / 3;
    const cell = 2 * h;
    const key = (x: number, y: number, z: number) =>
      (Math.floor(x / cell) + 512) * 1048576 + (Math.floor(y / cell) + 512) * 1024 + (Math.floor(z / cell) + 512);
    const grid = (pts: Float32Array, count: number) => {
      const g = new Map<number, number[]>();
      for (let i = 0; i < count; i++) {
        const k = key(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
        let l = g.get(k);
        if (!l) g.set(k, (l = []));
        l.push(i);
      }
      return g;
    };
    /** Points of pts (in grid g) within r of (x, y, z): [index, squared distance][]. */
    const near = (g: Map<number, number[]>, pts: Float32Array, x: number, y: number, z: number, r: number) => {
      const out: [number, number][] = [];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = g.get((cx + dx + 512) * 1048576 + (cy + dy + 512) * 1024 + (cz + dz + 512));
        if (!l) continue;
        for (const i of l) {
          const d = (pts[3 * i] - x) ** 2 + (pts[3 * i + 1] - y) ** 2 + (pts[3 * i + 2] - z) ** 2;
          if (d < r * r) out.push([i, d]);
        }
      }
      return out;
    };

    // Controls: a vertex becomes one unless a control is already within h.
    const all = new Float32Array(3 * n);
    const taken = new Map<number, number[]>();
    let nc = 0;
    for (let i = 0; i < n; i++) {
      const x = rest[3 * i], y = rest[3 * i + 1], z = rest[3 * i + 2];
      if (near(taken, all, x, y, z, h).length) continue;
      const k = key(x, y, z);
      let l = taken.get(k);
      if (!l) taken.set(k, (l = []));
      l.push(nc);
      all.set([x, y, z], 3 * nc++);
    }
    const ctrl = all.slice(0, 3 * nc);
    const vGrid = grid(rest, n), cGrid = grid(ctrl, nc);
    const rows = (count: number, pts: Float32Array, g: Map<number, number[]>, src: Float32Array, r: number, sigma: number) => {
      const start = new Uint32Array(count + 1), idx: number[] = [], wt: number[] = [];
      for (let i = 0; i < count; i++) {
        const nb = near(g, src, pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], r);
        let sum = 0;
        for (const [, d] of nb) sum += Math.exp(-d / (sigma * sigma));
        for (const [j, d] of nb) (idx.push(j)), wt.push(Math.exp(-d / (sigma * sigma)) / sum);
        start[i + 1] = idx.length;
      }
      return [start, Uint32Array.from(idx), Float32Array.from(wt)] as const;
    };
    [this.gStart, this.gIndex, this.gWeight] = rows(nc, ctrl, vGrid, rest, 1.5 * h, h);
    [this.sStart, this.sIndex, this.sWeight] = rows(n, rest, cGrid, ctrl, 1.6 * h, 0.8 * h);
    this.ctrl = new Float32Array(3 * nc);
  }

  /** Replace the field (xyz per vertex) by its smooth version. */
  apply(f: Float32Array): void {
    const c = this.ctrl;
    for (const [start, index, weight, from, to] of [
      [this.gStart, this.gIndex, this.gWeight, f, c],
      [this.sStart, this.sIndex, this.sWeight, c, f],
    ] as const) {
      for (let i = 0; i + 1 < start.length; i++) {
        let x = 0, y = 0, z = 0;
        for (let k = start[i]; k < start[i + 1]; k++) {
          const j = 3 * index[k], w = weight[k];
          x += from[j] * w; y += from[j + 1] * w; z += from[j + 2] * w;
        }
        to[3 * i] = x; to[3 * i + 1] = y; to[3 * i + 2] = z;
      }
    }
  }
}

/** Limb-root vertices sunk into (or just outside) the Body, each tied to its nearest Body vertex. */
export interface RootTie {
  /** Limb vertex, Body vertex, weight (1 inside the Body near the joint, fading to 0 outside and along the limb). */
  vertex: Uint32Array;
  body: Uint32Array;
  weight: Float32Array;
}

/** Where a limb enters the Body: its root joint, and how far along the limb the tie may reach. */
export interface LimbRoot {
  joint: THREE.Vector3;
  reach: number;
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * Ties for the root of a limb (rest world positions) in the Body (rest positions + normals): only vertices near a
 * root joint, so a limb that merely hangs close to the belly keeps its own motion.
 */
export function tieRoots(limb: Float32Array, rest: Float32Array, normals: Float32Array, roots: LimbRoot[], fade = 0.025): RootTie {
  const v: number[] = [], b: number[] = [], w: number[] = [];
  const nb = rest.length / 3;
  const p = new THREE.Vector3();
  for (let i = 0; i < limb.length / 3; i++) {
    p.fromArray(limb, 3 * i);
    let near = 0;
    for (const r of roots) near = Math.max(near, 1 - smoothstep((p.distanceTo(r.joint) / r.reach - 0.5) / 0.5));
    if (near <= 0) continue;
    let best = -1, bestD = Infinity;
    for (let j = 0; j < nb; j++) {
      const dx = p.x - rest[3 * j], dy = p.y - rest[3 * j + 1], dz = p.z - rest[3 * j + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) (bestD = d), (best = j);
    }
    const s = (p.x - rest[3 * best]) * normals[3 * best] + (p.y - rest[3 * best + 1]) * normals[3 * best + 1] +
      (p.z - rest[3 * best + 2]) * normals[3 * best + 2];
    const weight = near * (1 - smoothstep(s / fade));
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
