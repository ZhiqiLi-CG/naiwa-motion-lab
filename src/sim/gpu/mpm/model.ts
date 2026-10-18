/**
 * The discretised frog, built once on the CPU and shared by both backends: material points filling each part, one
 * background grid per part (a cube that follows the part, big enough for it in any orientation), and the rendered
 * surface embedded in the points.
 */
import type { SimPart } from "../../api";
import { embed, EMBED_K, nearestOf } from "./embedding";
import { G, MAX_GRIDS, P } from "./layout";
import { fillVolume, largestPiece } from "./sampling";

export interface PartModel {
  readonly part: SimPart;
  /** Its grid's index, and its particles: [first, first + count). */
  readonly grid: number;
  readonly first: number;
  readonly count: number;
  /** Rest positions, xyz. */
  readonly rest: Float32Array;
  /** Region (FLESH_REGIONS index) per particle. */
  readonly region: Uint8Array;
  /** Its surface vertices in the global vertex list. */
  readonly vertexFirst: number;
  /** Cells along each side of its cubic grid, and its first node. */
  readonly cells: number;
  readonly nodeOffset: number;
}

export class MpmModel {
  /** Particle spacing and grid cell (dx = 2h: 2×2×2 particles per cell). */
  readonly h: number;
  readonly dx: number;
  /** kg per particle. */
  readonly particleMass: number;
  readonly parts: PartModel[] = [];
  readonly particles: number;
  readonly nodes: number;
  readonly vertices: number;
  /** Rest position per particle (x, y, z, 1) and per surface vertex, and the embedding (EMBED_K per vertex). */
  readonly restWords: Float32Array;
  readonly vertexRest: Float32Array;
  readonly embedIndex: Uint32Array;
  readonly embedWeight: Float32Array;

  constructor(parts: readonly SimPart[], dx: number, readonly density: number) {
    if (parts.length > MAX_GRIDS) throw new Error(`sim/gpu: at most ${MAX_GRIDS} parts`);
    this.dx = dx;
    this.h = dx / 2;
    this.particleMass = density * this.h ** 3;
    let first = 0, vertexFirst = 0, nodeOffset = 0;
    const embeds: { index: Uint32Array; weight: Float32Array }[] = [];
    parts.forEach((part, grid) => {
      let rest = largestPiece(fillVolume(part.positions, part.indices, this.h), this.h);
      // A part thinner than the lattice still needs a few points: its vertices then stand in for it.
      if (rest.length < 8 * 3) rest = part.positions.slice();
      shuffle(rest);
      const count = rest.length / 3;
      const nearest = nearestOf(rest, part.positions, 2 * this.h);
      const region = Uint8Array.from(nearest, (v) => part.regions[v]);
      let extent = 0;
      for (let k = 0; k < 3; k++) {
        let lo = Infinity, hi = -Infinity;
        for (let v = k; v < part.positions.length; v += 3) {
          lo = Math.min(lo, part.positions[v]);
          hi = Math.max(hi, part.positions[v]);
        }
        extent = Math.max(extent, hi - lo);
      }
      // Room for the part turned any way and its flesh swinging out, plus the stencil's reach at the borders.
      const cells = Math.ceil((1.25 * extent) / dx) + 6;
      this.parts.push({ part, grid, first, count, rest, region, vertexFirst, cells, nodeOffset });
      embeds.push(embed(part.positions, rest, first, this.h));
      first += count;
      vertexFirst += part.positions.length / 3;
      nodeOffset += cells ** 3;
    });
    this.particles = first;
    this.vertices = vertexFirst;
    this.nodes = nodeOffset;
    this.restWords = new Float32Array(first * 4);
    this.vertexRest = new Float32Array(vertexFirst * 4);
    this.embedIndex = new Uint32Array(vertexFirst * EMBED_K);
    this.embedWeight = new Float32Array(vertexFirst * EMBED_K);
    this.parts.forEach((pm, k) => {
      for (let i = 0; i < pm.count; i++) this.restWords.set([pm.rest[i * 3], pm.rest[i * 3 + 1], pm.rest[i * 3 + 2], 1], (pm.first + i) * 4);
      const V = pm.part.positions;
      for (let v = 0; v < V.length / 3; v++) this.vertexRest.set([V[v * 3], V[v * 3 + 1], V[v * 3 + 2], 1], (pm.vertexFirst + v) * 4);
      this.embedIndex.set(embeds[k].index, pm.vertexFirst * EMBED_K);
      this.embedWeight.set(embeds[k].weight, pm.vertexFirst * EMBED_K);
    });
  }

  /** The particles at rest, all free (attachments come from the coupling block). */
  initialState(): ArrayBuffer {
    const buf = new ArrayBuffer(this.particles * P.STRIDE * 4);
    const f = new Float32Array(buf), n = new Int32Array(buf);
    for (const pm of this.parts) {
      for (let i = 0; i < pm.count; i++) {
        const o = (pm.first + i) * P.STRIDE;
        f.set([pm.rest[i * 3], pm.rest[i * 3 + 1], pm.rest[i * 3 + 2], 1], o + P.X);
        for (const m of [P.F, P.FL]) {
          f[o + m] = 1;
          f[o + m + 5] = 1;
          f[o + m + 10] = 1;
        }
        n.set([pm.grid, -1, 0, pm.region[i]], o + P.INFO);
      }
    }
    return buf;
  }

  /** The grids' table for a frame: each grid's cube centred (snapped to whole cells, so a resting part sees the same
   *  grid every frame) on its part's centre. */
  gridTable(centres: Float32Array, material: (pm: PartModel) => { mu: number; lambda: number; eta: number; restScale: number }): ArrayBuffer {
    const buf = new ArrayBuffer(MAX_GRIDS * G.STRIDE * 4);
    const f = new Float32Array(buf), n = new Uint32Array(buf);
    for (const pm of this.parts) {
      const o = pm.grid * G.STRIDE, half = (pm.cells * this.dx) / 2;
      for (let k = 0; k < 3; k++) f[o + G.ORIGIN + k] = Math.round((centres[pm.grid * 3 + k] - half) / this.dx) * this.dx;
      f[o + G.DX] = this.dx;
      n.set([pm.cells, pm.cells, pm.cells, pm.nodeOffset], o + G.NX);
      const m = material(pm);
      f[o + G.MU] = m.mu;
      f[o + G.LAMBDA] = m.lambda;
      f[o + G.INV_RHO] = 1 / this.density;
      f[o + G.ETA] = m.eta;
      f[o + G.REST_SCALE] = m.restScale;
    }
    return buf;
  }
}

/** Shuffle points (xyz) in place, reproducibly. In lattice order, the threads of one GPU wave would add into the
 *  same grid nodes at once and their atomics would queue; scattered, they rarely meet. */
function shuffle(P: Float32Array) {
  let seed = 0x9e3779b9;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  for (let i = P.length / 3 - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    for (let k = 0; k < 3; k++) {
      const t = P[i * 3 + k];
      P[i * 3 + k] = P[j * 3 + k];
      P[j * 3 + k] = t;
    }
  }
}
