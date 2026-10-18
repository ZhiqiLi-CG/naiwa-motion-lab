/**
 * The memory layout both backends share, word by word (4 bytes each): the GPU's storage and uniform buffers and the
 * CPU workers' SharedArrayBuffers hold exactly these records, so one kernel reads the same in WGSL and TypeScript.
 */

/** A particle: 56 words (224 bytes). mat3 = three columns of vec3 padded to 4 words, as WGSL lays out mat3x3f. */
export const P = {
  STRIDE: 56,
  /** x, y, z, and J = det F (written each step, for the volume readout). */
  X: 0,
  /** velocity; w unused. */
  V: 4,
  /** APIC affine velocity C (≈ ∇v). */
  C: 8,
  /** Deformation gradient F. */
  F: 20,
  /** Attached: F in the body's frame (F = R_body · FL). */
  FL: 32,
  /** Attached: position in the body's frame. */
  LOC: 44,
  /** Attached: impulse the free flesh gave it this frame (particle-mass units · m/s). */
  REACT: 48,
  /** Int words: grid (-1 none), body slot (-1 free), splats (1: near free flesh, takes part in the grid), region. */
  INFO: 52,
} as const;

/** A grid (one per part, so parts touch through contact shapes instead of gluing together): 16 words. */
export const G = {
  STRIDE: 16,
  ORIGIN: 0,
  DX: 3,
  /** Int words: nx, ny, nz, first node. Nodes are x-major: offset + (ix·ny + iy)·nz + iz. */
  NX: 4,
  NY: 5,
  NZ: 6,
  OFFSET: 7,
  /** Lamé μ, λ (Pa), 1/ρ (m³/kg: rest volume per unit particle mass), viscosity η (Pa·s). */
  MU: 8,
  LAMBDA: 9,
  INV_RHO: 10,
  ETA: 11,
  /** (rest volume factor)^(-1/3): the rest shape scaled, e.g. a bigger belly. */
  REST_SCALE: 12,
} as const;

/** Words per grid node: the scattered sums (free mass, momentum; attached mass, momentum)… */
export const NODE_IN = 8;
/** …and the grid's answer: new velocity (w: has free mass) and the bone impulse per unit attached mass. */
export const NODE_OUT = 8;

/** A rigid body particles ride on: its pose at the start and the end of the frame (column-major mat4 each). */
export const B = { STRIDE: 32, M0: 0, M1: 16 } as const;
export const MAX_BODIES = 64;

/** A contact shape: a capsule (a bone's flesh) or a sphere (a ball), its ends at the start and end of the frame.
 *  Words: a0 xyz radius | b0 xyz kind | a1 xyz grid mask | b1 xyz friction. */
export const K = { STRIDE: 16, A0: 0, R: 3, B0: 4, KIND: 7, A1: 8, MASK: 11, B1: 12, FRICTION: 15 } as const;
export const MAX_COLLIDERS = 64;
export const KIND_CAPSULE = 0;
export const KIND_SPHERE = 1;

/** Per substep (dynamic uniform offsets on the GPU): dt, t0, t1, frameDt | gravity xyz, floor friction |
 *  particles, nodes, colliders, grids (ints) | dv xyz (a throw, first substep), edits | stiffness per region (8). */
export const S = { WORDS: 24, DT: 0, T0: 1, T1: 2, FRAME_DT: 3, GRAVITY: 4, FLOOR_FRICTION: 7, COUNTS: 8, DV: 12, EDITS: 15, REGION: 16 } as const;
/** Bytes between two substeps' uniforms (minUniformBufferOffsetAlignment). */
export const S_ALIGN = 256;
export const MAX_SUBSTEPS = 48;

/** An edit from the blocks (ParticleView), coalesced per particle: index, flags, body slot | (splats << 16) |
 *  position | velocity (set, or added). */
export const E = { STRIDE: 12, INDEX: 0, FLAGS: 1, BODY: 2, POS: 4, VEL: 8 } as const;
export const EDIT = { DETACH: 1, SET_POS: 2, SET_VEL: 4, ADD_VEL: 8, ATTACH: 16 } as const;

/** The accumulators read back each frame (ints on the GPU, fixed point): per body impulse and moment about the
 *  origin; per collider the same and a contact count; per grid the floor contacts. */
export const ACC = { BODY: 0, COLLIDER: MAX_BODIES * 8, FLOOR: MAX_BODIES * 8 + MAX_COLLIDERS * 8, WORDS: MAX_BODIES * 8 + MAX_COLLIDERS * 8 + 8 } as const;
export const MAX_GRIDS = 8;

/** Fixed-point scales for the GPU's integer atomics (WGSL has no float atomics). Masses are in particle masses, so a
 *  node holds about 8; 2^18 resolves 4e-6 m/s and holds momenta to ±8000. */
export const GRID_SCALE = 1 << 18;
export const ACC_SCALE = 1 << 10;

/** The per-frame output both backends hand back: positions (x, y, z, J) and velocities per particle, the rendered
 *  surface per vertex (x, y, z, 1), and the accumulators in SI units. */
export interface FrameOutput {
  positions: Float32Array;
  velocities: Float32Array;
  surface: Float32Array;
  /** Per body slot: impulse (kg·m/s) and moment about the world origin (kg·m²/s). */
  bodyImpulse: Float64Array;
  colliderImpulse: Float64Array;
  colliderContacts: Uint32Array;
  floorContacts: Uint32Array;
  /** Time the device spent on this frame (ms), if it can tell. */
  deviceMs: number | null;
}
