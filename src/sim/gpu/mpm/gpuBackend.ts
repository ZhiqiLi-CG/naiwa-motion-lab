/**
 * The WebGPU backend: the particles live on the GPU; a frame is one command buffer (edits, the substeps, the outputs)
 * and its results come back asynchronously through a small ring of staging buffers.
 *
 * Latency: a frame's results (particle positions, the surface, the impulses on the bones) are read on a later step,
 * usually the next one, when the GPU has finished and the buffer is mapped. The simulation itself never waits: its
 * state stays on the GPU, and impulses that could not be read yet keep accumulating there until they can.
 */
import { gpuDevice } from "../device";
import type { GpuBindGroup, GpuBuffer, GpuComputePipeline, GpuDevice, GpuQuerySet } from "../webgpu";
import { BUFFER, MAP_READ, SHADER_STAGE_COMPUTE } from "../webgpu";
import type { FrameInput, MpmBackend } from "./backend";
import { decodeAccumulators } from "./backend";
import type { MpmModel } from "./model";
import { ACC, ACC_SCALE, B, E, G, K, MAX_BODIES, MAX_COLLIDERS, MAX_GRIDS, MAX_SUBSTEPS, NODE_IN, NODE_OUT, P, S, S_ALIGN } from "./layout";
import { BIND, KERNELS, READ_ONLY, SHADER, WORKGROUP, type KernelName } from "./shaders";

const MAX_EDITS = 1 << 16;
const RING = 4;
/** Uniform slots after the substeps': the frame's (edits, throw) and the surface's. */
const SLOT_FRAME = MAX_SUBSTEPS, SLOT_SURFACE = MAX_SUBSTEPS + 1;

interface Staging {
  buffer: GpuBuffer;
  state: "free" | "pending" | "ready";
  frame: number;
}

export class GpuBackend implements MpmBackend {
  readonly kind = "webgpu" as const;
  private pipelines = new Map<KernelName, GpuComputePipeline>();
  /** Per kernel: the uniforms' group, and its storage group with grid buffer A or B as gridIn. */
  private groups = new Map<KernelName, [GpuBindGroup, GpuBindGroup, GpuBindGroup]>();
  private buf!: Record<"step" | "grids" | "bodies" | "colliders" | "particles" | "gridIn" | "gridNext" | "gridOut" | "acc" | "edits" | "restWords" | "embedIndex" | "embedWeight" | "vertexRest" | "out" | "query", GpuBuffer>;
  private ring: Staging[] = [];
  private querySet: GpuQuerySet | null = null;
  /** Per-kernel timing (a pass per dispatch, every 30th frame; slower): set `profiling` to fill `profile` (ms/frame). */
  profiling = false;
  profile: Record<string, number> = {};
  private profileQueries: GpuQuerySet | null = null;
  private profileBuffers: [GpuBuffer, GpuBuffer] | null = null;
  private profileBusy = false;
  private frames = 0;
  private outBytes: number;
  private stepWords = new Float32Array((MAX_SUBSTEPS + 2) * (S_ALIGN / 4));
  private disposed = false;
  /** Bumped when the state is replaced: results computed before then are dropped. */
  private generation = 0;
  /** Outputs read back but not collected yet (newest last). */
  private ready: { frame: number; data: ArrayBuffer }[] = [];

  static async create(model: MpmModel): Promise<GpuBackend> {
    const b = new GpuBackend(model, await gpuDevice());
    await b.init();
    return b;
  }

  private constructor(private model: MpmModel, private device: GpuDevice) {
    this.outBytes = (2 * model.particles + model.vertices) * 16;
  }

  private async init() {
    const d = this.device, m = this.model;
    d.pushErrorScope("validation");
    const module = d.createShaderModule({ code: SHADER, label: "mpm" });
    const info = await module.getCompilationInfo?.();
    for (const msg of info?.messages ?? []) if (msg.type === "error") throw new Error(`sim/gpu: WGSL line ${msg.lineNum}: ${msg.message}`);
    const names = Object.keys(KERNELS) as KernelName[];
    // Explicit layouts: group 0 (the uniforms, the step at a dynamic offset per substep) shared, group 1 per kernel.
    const g0 = d.createBindGroupLayout({
      label: "uniforms",
      entries: [BIND.step, BIND.grids, BIND.bodies, BIND.colliders].map((binding) => ({
        binding, visibility: SHADER_STAGE_COMPUTE, buffer: { type: "uniform" as const, hasDynamicOffset: binding === BIND.step },
      })),
    });
    const g1 = new Map(names.map((n) => [n, d.createBindGroupLayout({
      label: n,
      entries: KERNELS[n].g1.map((binding) => ({
        binding, visibility: SHADER_STAGE_COMPUTE, buffer: { type: READ_ONLY.includes(binding) ? "read-only-storage" as const : "storage" as const },
      })),
    })]));
    const pipes = await Promise.all(names.map((entryPoint) => d.createComputePipelineAsync({
      layout: d.createPipelineLayout({ bindGroupLayouts: [g0, g1.get(entryPoint)!] }), compute: { module, entryPoint }, label: entryPoint,
    })));
    names.forEach((n, k) => this.pipelines.set(n, pipes[k]));

    const storage = BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC, uniform = BUFFER.UNIFORM | BUFFER.COPY_DST;
    const make = (size: number, usage: number, label: string) => d.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage, label });
    this.buf = {
      step: make(this.stepWords.byteLength, uniform, "step"),
      grids: make(MAX_GRIDS * G.STRIDE * 4, uniform, "grids"),
      bodies: make(MAX_BODIES * B.STRIDE * 4, uniform, "bodies"),
      colliders: make(MAX_COLLIDERS * K.STRIDE * 4, uniform, "colliders"),
      particles: make(m.particles * P.STRIDE * 4, storage, "particles"),
      // Two scatter grids: a substep's gather scatters into the other one for the next substep.
      gridIn: make(m.nodes * NODE_IN * 4, storage, "gridA"),
      gridNext: make(m.nodes * NODE_IN * 4, storage, "gridB"),
      gridOut: make(m.nodes * NODE_OUT * 4, storage, "gridOut"),
      acc: make(ACC.WORDS * 4, storage, "acc"),
      edits: make(MAX_EDITS * E.STRIDE * 4, storage, "edits"),
      restWords: make(m.restWords.byteLength, storage, "restWords"),
      embedIndex: make(m.embedIndex.byteLength, storage, "embedIndex"),
      embedWeight: make(m.embedWeight.byteLength, storage, "embedWeight"),
      vertexRest: make(m.vertexRest.byteLength, storage, "vertexRest"),
      out: make(this.outBytes, storage, "out"),
      query: make(16, BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC, "query"),
    };
    const q = d.queue;
    q.writeBuffer(this.buf.restWords, 0, m.restWords);
    q.writeBuffer(this.buf.embedIndex, 0, m.embedIndex);
    q.writeBuffer(this.buf.embedWeight, 0, m.embedWeight);
    q.writeBuffer(this.buf.vertexRest, 0, m.vertexRest);
    if (d.features.has("timestamp-query")) this.querySet = d.createQuerySet({ type: "timestamp", count: 2 });
    for (let k = 0; k < RING; k++) {
      this.ring.push({ buffer: d.createBuffer({ size: this.outBytes + ACC.WORDS * 4 + 16, usage: BUFFER.MAP_READ | BUFFER.COPY_DST, label: `staging${k}` }), state: "free", frame: -1 });
    }
    const ref = (b: GpuBuffer, size?: number) => ({ buffer: b, ...(size ? { size } : {}) });
    const byBinding0: Record<number, { buffer: GpuBuffer; size?: number }> = {
      [BIND.step]: ref(this.buf.step, S.WORDS * 4), [BIND.grids]: ref(this.buf.grids), [BIND.bodies]: ref(this.buf.bodies), [BIND.colliders]: ref(this.buf.colliders),
    };
    const byBinding1 = (grid: GpuBuffer): Record<number, { buffer: GpuBuffer }> => ({
      [BIND.particles]: ref(this.buf.particles), [BIND.gridIn]: ref(grid), [BIND.gridOut]: ref(this.buf.gridOut), [BIND.acc]: ref(this.buf.acc),
      [BIND.edits]: ref(this.buf.edits), [BIND.restWords]: ref(this.buf.restWords), [BIND.embedIndex]: ref(this.buf.embedIndex),
      [BIND.embedWeight]: ref(this.buf.embedWeight), [BIND.vertexRest]: ref(this.buf.vertexRest), [BIND.out]: ref(this.buf.out),
    });
    const uniforms = d.createBindGroup({ layout: g0, entries: Object.entries(byBinding0).map(([b, resource]) => ({ binding: Number(b), resource })) });
    for (const name of names) {
      const group = (grid: GpuBuffer) => d.createBindGroup({ layout: g1.get(name)!, entries: KERNELS[name].g1.map((binding) => ({ binding, resource: byBinding1(grid)[binding] })) });
      this.groups.set(name, [uniforms, group(this.buf.gridIn), group(this.buf.gridNext)]);
    }
    const err = await d.popErrorScope();
    if (err) throw new Error(`sim/gpu: ${err.message}`);
  }

  setState(state: ArrayBuffer) {
    this.generation++;
    this.ready = [];
    this.device.queue.writeBuffer(this.buf.particles, 0, state);
    this.device.queue.writeBuffer(this.buf.gridIn, 0, new Int32Array(this.model.nodes * NODE_IN));
    this.device.queue.writeBuffer(this.buf.gridNext, 0, new Int32Array(this.model.nodes * NODE_IN));
    this.device.queue.writeBuffer(this.buf.acc, 0, new Int32Array(ACC.WORDS));
  }

  submit(frame: FrameInput) {
    if (this.disposed) return;
    const d = this.device, q = d.queue, m = this.model, n = frame.substeps;
    // Uniforms: one slot per substep, then the frame's and the surface's (dynamic offsets into one buffer).
    const slot = S_ALIGN / 4;
    for (let s = 0; s < n; s++) this.stepWords.set(frame.steps.subarray(s * S.WORDS, (s + 1) * S.WORDS), s * slot);
    this.stepWords.set(frame.steps.subarray(0, S.WORDS), SLOT_FRAME * slot);
    this.stepWords[SLOT_FRAME * slot + S.EDITS] = frame.edits;
    this.stepWords.set(frame.steps.subarray(0, S.WORDS), SLOT_SURFACE * slot);
    this.stepWords[SLOT_SURFACE * slot + S.EDITS] = m.vertices;
    q.writeBuffer(this.buf.step, 0, this.stepWords);
    q.writeBuffer(this.buf.grids, 0, frame.grids);
    q.writeBuffer(this.buf.bodies, 0, frame.bodies);
    q.writeBuffer(this.buf.colliders, 0, frame.colliders);
    if (frame.edits) q.writeBuffer(this.buf.edits, 0, frame.editWords, 0, frame.edits * E.STRIDE * 4);

    const enc = d.createCommandEncoder();
    const profile = this.profiling && this.querySet && !this.profileBusy && this.frames % 30 === 0 ? this.profilePass() : null;
    let pass = enc.beginComputePass(this.querySet && !profile ? { timestampWrites: { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : undefined);
    /** `grid`: which scatter grid the kernel's gridIn is (0: A, 1: B). */
    const run = (name: KernelName, slotIndex: number, threads: number, grid = 0) => {
      if (threads <= 0) return;
      if (profile) {
        pass.end();
        const k = profile.names.length;
        profile.names.push(name);
        pass = enc.beginComputePass({ timestampWrites: { querySet: profile.queries, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 } });
      }
      const [g0, ...g1] = this.groups.get(name)!;
      pass.setPipeline(this.pipelines.get(name)!);
      pass.setBindGroup(0, g0, [slotIndex * S_ALIGN]);
      pass.setBindGroup(1, g1[grid]);
      pass.dispatchWorkgroups(Math.ceil(threads / WORKGROUP));
    };
    const N = m.particles;
    run("applyEdits", SLOT_FRAME, frame.edits);
    const dv = frame.steps.subarray(S.DV, S.DV + 3);
    if (dv[0] || dv[1] || dv[2]) run("addVelocity", SLOT_FRAME, N);
    // Substep s reads grid s % 2 and scatters into the other; the frame starts and ends with both clear.
    run("p2g", 0, N, 0);
    for (let s = 0; s < n; s++) {
      run("gridUpdate", s, m.nodes, s % 2);
      run("g2p2g", s, N, (s + 1) % 2);
    }
    run("reduceReactions", SLOT_FRAME, N);
    run("pack", SLOT_FRAME, N);
    run("embedSurface", SLOT_SURFACE, m.vertices);
    pass.end();
    if (profile) {
      enc.resolveQuerySet(profile.queries, 0, 2 * profile.names.length, profile.resolve, 0);
      enc.copyBufferToBuffer(profile.resolve, 0, profile.read, 0, 16 * profile.names.length);
    }

    // Read back into a free staging buffer; with none free the accumulators keep summing until the next frame.
    const st = this.ring.find((r) => r.state === "free");
    if (st) {
      enc.copyBufferToBuffer(this.buf.out, 0, st.buffer, 0, this.outBytes);
      enc.copyBufferToBuffer(this.buf.acc, 0, st.buffer, this.outBytes, ACC.WORDS * 4);
      enc.clearBuffer(this.buf.acc);
      if (this.querySet) {
        enc.resolveQuerySet(this.querySet, 0, 2, this.buf.query, 0);
        enc.copyBufferToBuffer(this.buf.query, 0, st.buffer, this.outBytes + ACC.WORDS * 4, 16);
      }
    }
    q.submit([enc.finish()]);
    if (profile) {
      this.profileBusy = true;
      profile.read.mapAsync(MAP_READ).then(() => {
        const t = new BigUint64Array(profile.read.getMappedRange(), 0, 2 * profile.names.length);
        const sums: Record<string, number> = {};
        profile.names.forEach((n, k) => (sums[n] = (sums[n] ?? 0) + Number(t[2 * k + 1] - t[2 * k]) / 1e6));
        this.profile = sums;
        profile.read.unmap();
        this.profileBusy = false;
      }, () => (this.profileBusy = false));
    }
    const frameNo = this.frames++, generation = this.generation;
    if (st) {
      st.state = "pending";
      st.frame = frameNo;
      st.buffer.mapAsync(MAP_READ).then(() => {
        if (this.disposed) return;
        // Copy out and give the buffer back at once, so the ring stays free.
        if (generation === this.generation) this.ready.push({ frame: frameNo, data: st.buffer.getMappedRange().slice(0) });
        st.buffer.unmap();
        st.state = "free";
      }, () => (st.state = "free"));
    }
  }

  private profilePass() {
    const d = this.device, max = 512;
    this.profileQueries ??= d.createQuerySet({ type: "timestamp", count: 2 * max });
    this.profileBuffers ??= [
      d.createBuffer({ size: 16 * max, usage: BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC }),
      d.createBuffer({ size: 16 * max, usage: BUFFER.MAP_READ | BUFFER.COPY_DST }),
    ];
    return { queries: this.profileQueries, resolve: this.profileBuffers[0], read: this.profileBuffers[1], names: [] as string[] };
  }

  collect() {
    if (!this.ready.length) return null;
    // Older outputs carry impulses too: sum the accumulators of all, keep the newest state.
    const all = this.ready.splice(0);
    const newest = all[all.length - 1].data;
    const m = this.model, N = m.particles;
    const accs = all.map((r) => new Int32Array(r.data, this.outBytes, ACC.WORDS));
    const summed = new Float64Array(ACC.WORDS);
    for (const a of accs) for (let k = 0; k < ACC.WORDS; k++) summed[k] += a[k];
    let deviceMs: number | null = null;
    if (this.querySet) {
      const t = new BigUint64Array(newest, this.outBytes + ACC.WORDS * 4, 2);
      const ns = Number(t[1] - t[0]);
      if (ns > 0 && ns < 1e9) deviceMs = ns / 1e6;
    }
    return {
      positions: new Float32Array(newest, 0, 4 * N),
      velocities: new Float32Array(newest, 16 * N, 4 * N),
      surface: new Float32Array(newest, 32 * N, 4 * m.vertices),
      ...decodeAccumulators(summed, 1 / ACC_SCALE, m.particleMass),
      deviceMs,
    };
  }

  dispose() {
    this.disposed = true;
    for (const b of Object.values(this.buf ?? {})) b.destroy();
    for (const r of this.ring) r.buffer.destroy();
    this.querySet?.destroy();
  }
}
