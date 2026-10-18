/**
 * The CPU backend: the same kernels on Web Workers over SharedArrayBuffer, or on this thread when there are none
 * (Node tests, or a page that is not cross-origin isolated).
 *
 * Frames are pipelined like the GPU's: the workers compute a frame while the page goes on (renders, steps the bones);
 * the next step collects it, waiting only for what is left of it.
 */
import type { BackendKind } from "../../device";
import { decodeAccumulators, type FrameInput, type MpmBackend } from "../backend";
import { ACC, E, S, type FrameOutput } from "../layout";
import type { MpmModel } from "../model";
import { CTL, FrameRunner, MAX_EDITS, allocate, arrays, type CpuShared } from "./shared";

export class CpuBackend implements MpmBackend {
  readonly kind: BackendKind;
  private sh: CpuShared;
  private ctl: Int32Array;
  private workers: Worker[] = [];
  private inline: FrameRunner | null = null;
  private inFlight = false;
  private outIndex = 0;
  /** Time the page's thread spent waiting for the workers at the last collect (ms). */
  waitMs = 0;

  static async create(model: MpmModel, workers: number): Promise<CpuBackend> {
    const b = new CpuBackend(model, workers);
    await b.start();
    return b;
  }

  private constructor(private model: MpmModel, workerCount: number) {
    const parallel = workerCount > 0;
    this.kind = parallel ? "cpu-parallel" : "cpu-inline";
    this.sh = allocate(model, Math.max(1, workerCount), parallel);
    this.ctl = new Int32Array(this.sh.buffers.control);
    if (!parallel) this.inline = new FrameRunner(this.sh, 0);
  }

  private async start() {
    if (this.inline) return;
    const ready: Promise<void>[] = [];
    for (let index = 0; index < this.sh.workers; index++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      ready.push(new Promise((resolve, reject) => {
        w.onmessage = () => resolve();
        w.onerror = (e) => reject(new Error(`sim/gpu: CPU worker failed: ${e.message}`));
      }));
      w.postMessage({ shared: this.sh, index });
      this.workers.push(w);
    }
    await Promise.all(ready);
  }

  setState(state: ArrayBuffer) {
    this.finish();
    new Uint8Array(this.sh.buffers.particles).set(new Uint8Array(state));
    for (const p of this.sh.buffers.priv) new Float32Array(p).fill(0);
  }

  submit(frame: FrameInput) {
    this.finish();
    const a = arrays(this.sh);
    if (frame.edits > MAX_EDITS) throw new Error("sim/gpu: too many particle edits in one step");
    a.steps.set(frame.steps.subarray(0, frame.substeps * S.WORDS));
    new Uint8Array(this.sh.buffers.grids).set(new Uint8Array(frame.grids));
    a.bodies.set(frame.bodies);
    a.colliders.set(frame.colliders);
    new Int32Array(this.sh.buffers.edits).set(new Int32Array(frame.editWords, 0, frame.edits * E.STRIDE));
    this.ctl[CTL.SUBSTEPS] = frame.substeps;
    this.ctl[CTL.EDITS] = frame.edits;
    this.ctl[CTL.OUT] = this.outIndex;
    this.inFlight = true;
    if (this.inline) {
      this.inline.frame();
      return;
    }
    Atomics.store(this.ctl, CTL.DONE, 0);
    Atomics.add(this.ctl, CTL.FRAME, 1);
    Atomics.notify(this.ctl, CTL.FRAME);
  }

  /** Wait for the frame in flight (the page's thread may not block in Atomics.wait: it spins). */
  private finish(): boolean {
    if (!this.inFlight) return false;
    const t0 = performance.now();
    if (!this.inline) while (Atomics.load(this.ctl, CTL.DONE) < this.sh.workers);
    this.waitMs = performance.now() - t0;
    this.inFlight = false;
    return true;
  }

  collect(): FrameOutput | null {
    if (!this.finish()) return null;
    const N = this.sh.particles, V = this.sh.vertices, W = this.sh.workers;
    const out = this.sh.buffers.out[this.outIndex];
    this.outIndex ^= 1;
    const acc = new Float64Array(this.sh.buffers.acc), summed = new Float64Array(ACC.WORDS);
    for (let w = 0; w < W; w++) for (let k = 0; k < ACC.WORDS; k++) summed[k] += acc[w * ACC.WORDS + k];
    const timing = new Float64Array(this.sh.buffers.timing);
    return {
      // Copies: the workers reuse this buffer two frames on.
      positions: new Float32Array(out, 0, 4 * N).slice(),
      velocities: new Float32Array(out, 16 * N, 4 * N).slice(),
      surface: new Float32Array(out, 32 * N, 4 * V).slice(),
      ...decodeAccumulators(summed, 1, this.model.particleMass),
      deviceMs: Math.max(...timing),
    };
  }

  dispose() {
    this.finish();
    Atomics.store(this.ctl, CTL.QUIT, 1);
    Atomics.add(this.ctl, CTL.FRAME, 1);
    Atomics.notify(this.ctl, CTL.FRAME);
    for (const w of this.workers) w.terminate();
  }
}
