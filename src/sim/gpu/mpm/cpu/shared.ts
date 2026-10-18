/**
 * The CPU backend's memory: everything the workers share, as SharedArrayBuffers (plain ArrayBuffers when it runs on
 * one thread), and the frame every worker runs on its share of the particles and nodes.
 *
 * Scattering (p2g) conflicts when two threads add to one node, and JavaScript has no float atomics: each worker
 * scatters into its own grid instead. The particles are sorted along x each frame, so a worker's particles touch a
 * narrow slab of nodes; the node owners then sum only the slabs that overlap theirs.
 */
import type { CpuArrays } from "../kernels";
import { addVelocity, applyEdits, embedSurface, g2p, gridUpdate, p2g, pack, reduceReactions } from "../kernels";
import { ACC, B, E, G, K, MAX_BODIES, MAX_COLLIDERS, MAX_GRIDS, MAX_SUBSTEPS, NODE_IN, NODE_OUT, P, S } from "../layout";

export const MAX_EDITS = 1 << 16;

/** Control words (Int32). */
export const CTL = { FRAME: 0, DONE: 1, BAR_COUNT: 2, BAR_GEN: 3, SUBSTEPS: 4, EDITS: 5, OUT: 6, QUIT: 7, WORKER: 16, WORKER_STRIDE: 8 } as const;

export interface CpuShared {
  particles: number;
  nodes: number;
  vertices: number;
  workers: number;
  buffers: {
    particles: ArrayBufferLike;
    steps: ArrayBufferLike;
    grids: ArrayBufferLike;
    bodies: ArrayBufferLike;
    colliders: ArrayBufferLike;
    edits: ArrayBufferLike;
    gridOut: ArrayBufferLike;
    priv: ArrayBufferLike[];
    scratch: ArrayBufferLike[];
    order: ArrayBufferLike;
    control: ArrayBufferLike;
    acc: ArrayBufferLike;
    timing: ArrayBufferLike;
    /** Two output buffers, alternating frames, so the page reads one while the workers fill the other. */
    out: ArrayBufferLike[];
    restWords: ArrayBufferLike;
    vertexRest: ArrayBufferLike;
    embedIndex: ArrayBufferLike;
    embedWeight: ArrayBufferLike;
  };
}

export function allocate(
  model: { particles: number; nodes: number; vertices: number; restWords: Float32Array; vertexRest: Float32Array; embedIndex: Uint32Array; embedWeight: Float32Array },
  workers: number, shared: boolean,
): CpuShared {
  const make = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  const copy = (a: Float32Array | Uint32Array) => {
    const b = make(a.byteLength);
    new Uint8Array(b).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return b;
  };
  const { particles: N, nodes, vertices: V } = model;
  const slab = Math.ceil(nodes / workers) + 1;
  return {
    particles: N, nodes, vertices: V, workers,
    buffers: {
      particles: make(N * P.STRIDE * 4),
      steps: make(MAX_SUBSTEPS * S.WORDS * 4),
      grids: make(MAX_GRIDS * G.STRIDE * 4),
      bodies: make(MAX_BODIES * B.STRIDE * 4),
      colliders: make(MAX_COLLIDERS * K.STRIDE * 4),
      edits: make(MAX_EDITS * E.STRIDE * 4),
      gridOut: make(nodes * NODE_OUT * 4),
      priv: Array.from({ length: workers }, () => make(nodes * NODE_IN * 4)),
      scratch: Array.from({ length: workers }, () => make(slab * NODE_IN * 4)),
      order: make(N * 4),
      control: make((CTL.WORKER + workers * CTL.WORKER_STRIDE) * 4),
      acc: make(workers * ACC.WORDS * 8),
      timing: make(workers * 8),
      out: [make((8 * N + 4 * V) * 4), make((8 * N + 4 * V) * 4)],
      restWords: copy(model.restWords),
      vertexRest: copy(model.vertexRest),
      embedIndex: copy(model.embedIndex),
      embedWeight: copy(model.embedWeight),
    },
  };
}

export function arrays(sh: CpuShared): CpuArrays {
  const b = sh.buffers;
  return {
    pf: new Float32Array(b.particles), pi: new Int32Array(b.particles),
    steps: new Float32Array(b.steps), stepsI: new Int32Array(b.steps),
    grids: new Float32Array(b.grids), gridsI: new Int32Array(b.grids),
    bodies: new Float32Array(b.bodies), colliders: new Float32Array(b.colliders),
    edits: new Float32Array(b.edits), editsI: new Int32Array(b.edits),
    gridOut: new Float32Array(b.gridOut),
    restWords: new Float32Array(b.restWords), vertexRest: new Float32Array(b.vertexRest),
    embedIndex: new Uint32Array(b.embedIndex), embedWeight: new Float32Array(b.embedWeight),
  };
}

/** One worker's view and the frame it runs. */
export class FrameRunner {
  private a: CpuArrays;
  private ctl: Int32Array;
  private order: Int32Array;
  private priv: Float32Array[];
  private scratch: Float32Array;
  private acc: Float64Array;
  private timing: Float64Array;
  private out: { positions: Float32Array; velocities: Float32Array; surface: Float32Array }[];
  private range = new Int32Array(2);

  constructor(private sh: CpuShared, private w: number) {
    const b = sh.buffers, N = sh.particles;
    this.a = arrays(sh);
    this.ctl = new Int32Array(b.control);
    this.order = new Int32Array(b.order);
    this.priv = b.priv.map((p) => new Float32Array(p));
    this.scratch = new Float32Array(b.scratch[w]);
    this.acc = new Float64Array(b.acc, w * ACC.WORDS * 8, ACC.WORDS);
    this.timing = new Float64Array(b.timing);
    this.out = b.out.map((o) => ({
      positions: new Float32Array(o, 0, 4 * N), velocities: new Float32Array(o, 16 * N, 4 * N), surface: new Float32Array(o, 32 * N, 4 * sh.vertices),
    }));
  }

  /** Wait until all workers reach this point (one thread: returns at once). */
  private barrier() {
    const W = this.sh.workers, ctl = this.ctl;
    if (W === 1) return;
    const gen = Atomics.load(ctl, CTL.BAR_GEN);
    if (Atomics.add(ctl, CTL.BAR_COUNT, 1) === W - 1) {
      Atomics.store(ctl, CTL.BAR_COUNT, 0);
      Atomics.add(ctl, CTL.BAR_GEN, 1);
      Atomics.notify(ctl, CTL.BAR_GEN);
      return;
    }
    // A short spin first: the others usually arrive within microseconds, and a wait/notify round trip costs more.
    for (let k = 0; k < 4000; k++) if (Atomics.load(ctl, CTL.BAR_GEN) !== gen) return;
    while (Atomics.load(ctl, CTL.BAR_GEN) === gen) Atomics.wait(ctl, CTL.BAR_GEN, gen, 50);
  }

  private mine(slot: number): [number, number] {
    const o = CTL.WORKER + this.w * CTL.WORKER_STRIDE + slot;
    return [this.ctl[o], this.ctl[o + 1]];
  }

  /** Run one frame: edits, then the substeps, then the outputs. */
  frame() {
    const t0 = performance.now();
    const { a, ctl, order, w } = this, W = this.sh.workers, substeps = ctl[CTL.SUBSTEPS];
    this.acc.fill(0);
    if (w === 0) {
      applyEdits(a, ctl[CTL.EDITS]);
      this.partition();
    }
    this.barrier();
    const [kFrom, kTo] = this.mine(0), [rFrom, rTo] = this.mine(2);
    const dv = a.steps.subarray(S.DV, S.DV + 3);
    if (dv[0] || dv[1] || dv[2]) {
      addVelocity(a, order, kFrom, kTo, dv);
      addVelocity(a, order, rFrom, rTo, dv);
    }
    const priv = this.priv[w], nodes = this.sh.nodes;
    const slab = Math.ceil(nodes / W), nFrom = Math.min(nodes, w * slab), nTo = Math.min(nodes, nFrom + slab);
    for (let s = 0; s < substeps; s++) {
      p2g(a, s, order, kFrom, kTo, priv, this.range);
      const wo = CTL.WORKER + w * CTL.WORKER_STRIDE;
      ctl[wo + 4] = this.range[0];
      ctl[wo + 5] = this.range[1];
      this.barrier();
      this.gather(nFrom, nTo);
      gridUpdate(a, s, nFrom, nTo, this.scratch, nFrom);
      this.barrier();
      g2p(a, s, order, kFrom, kTo, this.acc);
      g2p(a, s, order, rFrom, rTo, this.acc);
      if (this.range[1] >= this.range[0]) priv.fill(0, this.range[0] * NODE_IN, (this.range[1] + 1) * NODE_IN);
    }
    this.barrier();
    const out = this.out[ctl[CTL.OUT]];
    reduceReactions(a, order, kFrom, kTo, this.acc);
    reduceReactions(a, order, rFrom, rTo, this.acc);
    pack(a, order, kFrom, kTo, out.positions, out.velocities);
    pack(a, order, rFrom, rTo, out.positions, out.velocities);
    const V = this.sh.vertices, vs = Math.ceil(V / W);
    embedSurface(a, Math.min(V, w * vs), Math.min(V, (w + 1) * vs), out.surface);
    this.timing[w] = performance.now() - t0;
  }

  /** Sum the private grids overlapping nodes [from, to) into this worker's scratch. */
  private gather(from: number, to: number) {
    const { ctl, scratch } = this, W = this.sh.workers;
    scratch.fill(0, 0, (to - from) * NODE_IN);
    for (let u = 0; u < W; u++) {
      const uo = CTL.WORKER + u * CTL.WORKER_STRIDE, lo = Math.max(from, ctl[uo + 4]), hi = Math.min(to - 1, ctl[uo + 5]);
      if (hi < lo) continue;
      const src = this.priv[u];
      for (let i = lo * NODE_IN, j = (lo - from) * NODE_IN, end = (hi + 1) * NODE_IN; i < end; i++, j++) scratch[j] += src[i];
    }
  }

  /** Sort the particles taking part in the grid along x (grid by grid, slab by slab: a contiguous node range per
   *  worker), the rest (riding deep on a bone) after them; give each worker an equal share of both. */
  private partition() {
    const { a, ctl, order } = this, { pf, pi, grids, gridsI } = a, N = this.sh.particles, W = this.sh.workers;
    const start: number[] = [];
    let keys = 0;
    for (let g = 0; g < MAX_GRIDS; g++) {
      start.push(keys);
      keys += gridsI[g * G.STRIDE + G.NX];
    }
    const key = new Int32Array(N), count = new Int32Array(keys + 1);
    for (let i = 0; i < N; i++) {
      const o = i * P.STRIDE, g = pi[o + P.INFO];
      if (g < 0 || (pi[o + P.INFO + 1] >= 0 && pi[o + P.INFO + 2] === 0)) {
        key[i] = keys;
      } else {
        const go = g * G.STRIDE, n = gridsI[go + G.NX];
        key[i] = start[g] + Math.min(n - 1, Math.max(0, Math.floor((pf[o] - grids[go]) / grids[go + G.DX])));
      }
      count[key[i]]++;
    }
    let sum = 0;
    for (let k = 0; k <= keys; k++) {
      const c = count[k];
      count[k] = sum;
      sum += c;
    }
    const keyed = count[keys];
    for (let i = 0; i < N; i++) order[count[key[i]]++] = i;
    for (let u = 0; u < W; u++) {
      const o = CTL.WORKER + u * CTL.WORKER_STRIDE;
      ctl[o] = Math.floor((keyed * u) / W);
      ctl[o + 1] = Math.floor((keyed * (u + 1)) / W);
      ctl[o + 2] = keyed + Math.floor(((N - keyed) * u) / W);
      ctl[o + 3] = keyed + Math.floor(((N - keyed) * (u + 1)) / W);
    }
  }
}
