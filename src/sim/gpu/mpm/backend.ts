/** What the two backends (WebGPU, CPU workers) have in common: a frame in, a frame's results out. */
import type { BackendKind } from "../device";
import { ACC, MAX_BODIES, MAX_COLLIDERS, MAX_GRIDS, type FrameOutput } from "./layout";

/** One frame (one 1/60 s step) of work, laid out as layout.ts says. */
export interface FrameInput {
  substeps: number;
  /** substeps × S.WORDS; the throw (S.DV) and the edit count (S.EDITS) in substep 0's words. */
  steps: Float32Array;
  grids: ArrayBuffer;
  bodies: Float32Array;
  colliders: Float32Array;
  /** Coalesced edits: `edits` records of E.STRIDE words. */
  editWords: ArrayBuffer;
  edits: number;
}

export interface MpmBackend {
  readonly kind: BackendKind;
  /** Replace the whole particle state (at build and on reset). */
  setState(state: ArrayBuffer): void;
  /** Start a frame. The previous one must have been collected (CPU) or may still run (GPU: it queues). */
  submit(frame: FrameInput): void;
  /** The results of frames finished since the last call (state of the newest, impulses summed), or null. The CPU
   *  backend waits here for the frame in flight; the GPU backend never waits. */
  collect(): FrameOutput | null;
  dispose(): void;
}

/** The accumulators in SI units: impulses × particle mass (kg). */
export function decodeAccumulators(acc: ArrayLike<number>, scale: number, particleMass: number) {
  const k = scale * particleMass;
  const bodyImpulse = new Float64Array(MAX_BODIES * 6), colliderImpulse = new Float64Array(MAX_COLLIDERS * 6);
  const colliderContacts = new Uint32Array(MAX_COLLIDERS), floorContacts = new Uint32Array(MAX_GRIDS);
  for (let b = 0; b < MAX_BODIES; b++) for (let c = 0; c < 6; c++) bodyImpulse[b * 6 + c] = acc[ACC.BODY + b * 8 + c] * k;
  for (let b = 0; b < MAX_COLLIDERS; b++) {
    for (let c = 0; c < 6; c++) colliderImpulse[b * 6 + c] = acc[ACC.COLLIDER + b * 8 + c] * k;
    colliderContacts[b] = acc[ACC.COLLIDER + b * 8 + 6];
  }
  for (let g = 0; g < MAX_GRIDS; g++) floorContacts[g] = acc[ACC.FLOOR + g];
  return { bodyImpulse, colliderImpulse, colliderContacts, floorContacts };
}
