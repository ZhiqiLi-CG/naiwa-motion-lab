/**
 * The simulation's plugin API (docs/simulator-api.md explains it with examples).
 *
 * The core (core.ts) is a small loop over named slots. Each slot holds one block; a simulator is a named assembly of
 * blocks, and anyone can swap one block (their own floor collision, their own flesh solver…) and keep the others.
 * docs/soft-binding.md explains why the flesh is split this way.
 *
 *   skeleton     bone dynamics and drive (free: hold the pose, right itself; driven: follow pose targets)
 *   flesh        the soft-body time step; exposes its particles
 *   target       the target shape: where each particle would be if the flesh were firm (skinning under the bones)
 *   coupling     how flesh and bones exchange motion: the flesh is pulled to its target, the deepest rides on bones
 *   collision    contacts of the flesh with the floor, balls, bones and limbs
 *   interaction  pokes, slaps and pinches applied to the flesh
 *   output       the rendered surfaces from the simulated state
 *   metrics      quality numbers for the readouts and benchmarks
 *
 * Every fixed step (1/60 s) the core calls, in slot order, each block's beforeStep, then steps the shared Rapier world
 * once (rigid bones, balls and whatever Rapier objects blocks added: the CPU example's soft bodies, contacts and
 * attachments all live there), then each block's afterStep, then turns contacts into events. A flesh solver outside
 * Rapier advances in afterStep, when this step's bones and targets are known.
 *
 * Blocks meet through the Scene: bone poses and collision shapes, the floor, the balls, the flesh parts and their
 * particles. A block that does a neighbour's job itself declares it (`covers`), and the core leaves that slot empty:
 * an MPM flesh solver resolving contacts on its grid covers "collision".
 */
import type RAPIER from "@dimforge/rapier3d-compat";
import type * as THREE from "three";
import type { BodyMode, BoneName, CoreBone, PhysicsParams, RigSpec, SimParameter } from "../contracts";
import type { Text } from "../i18n";

export const SLOTS = ["skeleton", "flesh", "target", "coupling", "collision", "interaction", "output", "metrics"] as const;
export type Slot = (typeof SLOTS)[number];
export type Settings = Record<string, number | string | boolean>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* The scene: what every block can read                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A collision shape of a bone in the bone's frame. `core` is the hard bone (meets floor and balls); `contact` is a
 *  limb's flesh, as thick as it is, which presses into the Body's flesh. */
export type BoneShape = (
  | { kind: "capsule"; role: "core" | "contact"; a: THREE.Vector3; b: THREE.Vector3; radius: number }
  | { kind: "hull"; role: "core"; points: Float32Array }
) & {
  /** Its Rapier collider, when the skeleton lives in Rapier. */
  collider?: RAPIER.Collider;
};

export interface SimBone {
  readonly name: CoreBone;
  /** Its Rapier body: pose and velocity, and `applyImpulseAtPoint` for flesh pushing back on it. */
  readonly body: RAPIER.RigidBody;
  readonly parent: SimBone | null;
  readonly restPos: THREE.Vector3;
  readonly restRot: THREE.Quaternion;
  /** Rest world → bone frame. */
  readonly restInverse: THREE.Matrix4;
  /** World position of the bone's end, rest pose. */
  readonly tail: THREE.Vector3;
  readonly shapes: readonly BoneShape[];
  /** Current world pose (no scale). */
  pose(out: THREE.Matrix4): THREE.Matrix4;
}

/** One closed piece of flesh, resolved from the RigSpec: softness and regions per vertex are always present, and the
 *  bones are skeleton bones (ones the skeleton does not simulate, such as fingers, become their nearest ancestor). */
export interface SimPart {
  /** "body", "arm_L", "arm_R", "leg_L", "leg_R". */
  readonly name: string;
  readonly limb: boolean;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** 0 firm … 1 softest (the belly). */
  readonly softness: Float32Array;
  /** Index into FLESH_REGIONS. */
  readonly regions: Uint8Array;
  readonly bones: readonly SimBone[];
}

export interface SimBall {
  readonly body: RAPIER.RigidBody;
  readonly radius: number;
}

export interface Scene {
  /** The shared Rapier world, stepped by the core (never call world.step in a block). */
  readonly world: RAPIER.World;
  readonly dt: number;
  /** The rig as the character module handed it over. */
  readonly spec: RigSpec;
  readonly params: PhysicsParams;
  readonly mode: BodyMode;
  readonly parts: readonly SimPart[];
  /** The floor is the plane y = 0 (a Rapier cuboid below it, in `collisionGroups.floor`). */
  readonly floorFriction: number;
  balls(): readonly SimBall[];
  /** Blocks built before this one (slot order), for blocks that use a neighbour: e.g. coupling reads the targets and
   *  the flesh's particles. Reading one that is not built yet (or covered by another block) throws. */
  readonly skeleton: SkeletonBlock;
  readonly flesh: FleshBlock;
  readonly target: TargetBlock;
  readonly coupling: CouplingBlock;
  /** Rapier collision groups (membership << 16 | filter) for colliders blocks add. */
  readonly collisionGroups: {
    /** The Body's flesh: meets the floor, balls and the limbs' contact shapes. */
    readonly body: number;
    /** A limb's flesh: meets the floor and balls. */
    readonly limb: number;
    /** A bone's hard core: meets the floor and balls. */
    readonly core: number;
    /** A limb's contact shape: meets the Body's flesh. */
    readonly contact: number;
  };
  /** Mark a Rapier collider as a part's flesh, so its floor and ball contacts become events. */
  registerCollider(collider: RAPIER.Collider, part: SimPart): void;
  /** For contacts outside Rapier: report one (from beforeStep / afterStep) so it becomes an event. */
  reportContact(contact: { part: SimPart; with: "floor" } | { part: SimPart; with: "ball"; ball: SimBall }): void;
}

/** The particles of a part, the common currency between flesh, coupling, collision, interaction and output blocks.
 *  Positions are world space, xyz per particle. */
export interface ParticleView {
  readonly count: number;
  readonly rest: Float32Array;
  /** Current positions (valid until the next step). */
  positions(): Float32Array;
  mass(i: number): number;
  applyImpulse(i: number, x: number, y: number, z: number): void;
  setPosition(i: number, x: number, y: number, z: number): void;
  setVelocity(i: number, x: number, y: number, z: number): void;
  /** From now on the particle rides on the body, at its current offset; `detach` lets it go. */
  attach(i: number, body: RAPIER.RigidBody): void;
  detach(i: number): void;
  attachedTo(i: number): RAPIER.RigidBody | null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Blocks                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What every block may implement. */
export interface Block {
  /** Each fixed step, in slot order, before the world steps and after it. */
  beforeStep?(scene: Scene): void;
  afterStep?(scene: Scene): void;
  /** The physics sliders changed. */
  setParams?(params: PhysicsParams): void;
  /** One of its parameters that is not `rebuild` changed. */
  setSettings?(settings: Readonly<Settings>): void;
  /** Back to rest (after the skeleton and flesh are back at rest). */
  reset?(): void;
  dispose?(): void;
}

export interface SkeletonBlock extends Block {
  readonly bones: ReadonlyMap<CoreBone, SimBone>;
  setMode(mode: BodyMode): void;
  /** Driven mode: target world matrices of the bones. */
  setTargets(boneWorld: ReadonlyMap<BoneName, THREE.Matrix4>): void;
  /** Free mode: the frog was knocked about (a landing, a throw): it goes floppy and gathers itself again. */
  knock(): void;
  /** Mass-weighted velocity of the bones, and adding one to them all (a throw). */
  velocity(): THREE.Vector3;
  addVelocity(dv: THREE.Vector3): void;
  /** Root's world matrix (it is not simulated: it follows the hips, or the target in driven mode). */
  root(out: THREE.Matrix4): THREE.Matrix4;
}

export interface TargetBlock extends Block {
  /** Where the flesh's particles of a part would be if it were firm, this step (xyz, the flesh's particle order), and
   *  how fast those targets move (for damping relative to the motion, not to the world). */
  targets(part: SimPart): Float32Array;
  targetVelocities(part: SimPart): Float32Array;
}

export interface FleshBlock extends Block {
  particles(part: SimPart): ParticleView;
  /** The part's surface if the solver tracks one itself (the "flesh surface" output block shows it). */
  surface?(part: SimPart): Float32Array;
  /** The Rapier soft body of a part, for blocks that work with Rapier directly (the Rapier collision block). */
  rapier?(part: SimPart): RAPIER.SoftBody;
  /** The part's cells (tetrahedra, 4 particle indices each) and its volume against the rest volume. */
  cells?(part: SimPart): Uint32Array;
  volumeRatio?(part: SimPart): number;
  addVelocity(dv: THREE.Vector3): void;
  stats(): { particles: number; cells: number; volumeRatio: number };
}

export interface CouplingBlock extends Block {
  /** How far, on average, the free flesh of a part is from where its bones would carry it rigidly (m): the jiggle. */
  jiggle(part: SimPart): number;
}

export type CollisionBlock = Block;

/** Flesh pinched at a point, following a moving target. */
export interface FleshGrab {
  move(target: THREE.Vector3): void;
  release(): void;
}

export interface InteractionBlock extends Block {
  /** Change the flesh's velocity around a point by dv (m/s), fading smoothly to nothing at radius. */
  push(part: SimPart, point: THREE.Vector3, dv: THREE.Vector3, radius: number): void;
  grab(part: SimPart, point: THREE.Vector3): FleshGrab;
}

export interface OutputBlock extends Block {
  /** The part's rendered surface, same vertex order as its positions. */
  read(part: SimPart): Float32Array;
}

/** Quality numbers (docs/soft-binding.md). Lengths in metres. */
export interface Metrics {
  /** Distance of the flesh's particles from the skinned target shape: mean and max. */
  deviation: number;
  deviationMax: number;
  /** Cells turned inside out. */
  invertedCells: number;
  /** Volume against the rest volume, per part. */
  volume: Record<string, number>;
  /** Deepest overlap of a limb's contact shape into the Body's flesh. */
  penetration: number;
  /** Mean speed of the particles relative to their targets (m/s): jitter when nothing is happening. */
  jitter: number;
  /** The frog's linear momentum (kg·m/s, bones and flesh) and energy (kinetic + gravitational, J): their drift when
   *  nothing pushes the frog shows how physical a set-up is. */
  momentum: [number, number, number];
  energy: number;
}

export interface MetricsBlock extends Block {
  /** Measure now (costs a pass over the flesh: call it a few times a second, not every step). */
  measure(scene: Scene): Metrics;
}

export interface SlotBlocks {
  skeleton: SkeletonBlock;
  flesh: FleshBlock;
  target: TargetBlock;
  coupling: CouplingBlock;
  collision: CollisionBlock;
  interaction: InteractionBlock;
  output: OutputBlock;
  metrics: MetricsBlock;
}

/** A block as registered. */
export interface BlockDefinition<S extends Slot = Slot> {
  id: string;
  slot: S;
  name: Text;
  summary: Text;
  device: "cpu" | "gpu";
  parameters: SimParameter[];
  /** Neighbouring slots whose job this block does itself; the core builds no block there. */
  covers?: Slot[];
  /** null when it can run in this browser (and with these neighbours), else why not. */
  available?(): Text | null;
  /** Build it. Blocks of the earlier slots are in the scene already (a slot it covers is not). */
  create(scene: Scene, settings: Readonly<Settings>): SlotBlocks[S] | Promise<SlotBlocks[S]>;
}

/** A simulator: a named assembly of blocks, one per slot (or none for a slot another block covers). */
export interface AssemblyDefinition {
  id: string;
  name: Text;
  summary: Text;
  blocks: Partial<Record<Slot, string>>;
}

export { registerBlock, registerSimulator, listBlocks, listSimulators, onSimulatorsChanged } from "./registry";
export { createFrogSim, type LabFrogSim } from "./core";
