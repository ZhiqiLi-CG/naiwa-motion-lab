/**
 * The motion-transfer plugin API (docs/motion-api.md explains it with an example).
 *
 * Motion transfer turns a person's pose (MediaPipe landmarks from the webcam, an uploaded video or a dance track) into
 * pose targets for the frog. The core (core.ts) is a small loop over four slots; each holds one block, a retargeter is
 * a named assembly of blocks, and anyone can swap one block and keep the others:
 *
 *   filter       smooths the person's landmarks: causally for the live camera, with frames before and after for a
 *                recorded video (analysed before it plays)
 *   constraints  the frog's own body: how far a point is from its surface (limbs stay outside), joint limits, floor
 *   solver       the person's pose → the frog's joint positions, under the constraints (the numerical core)
 *   output       the frog's joint positions → bone rotations (PoseFrame), hands and face
 *
 * Every frame the core calls filter → solver (which asks the constraints) → output, and measures how good the result
 * is (metrics: fidelity to the person, smoothness, limbs inside the body, feet sliding).
 *
 * Frames: the person's world landmarks are MediaPipe's (metres, hip-centred, x to the image right, y down, z away from
 * the camera). Everything of the frog is in the frog's own frame: metres, root at the origin before the root offset,
 * +X its left (the viewer's right when it faces us), +Y up, +Z forward (towards the camera).
 */
import type * as THREE from "three";
import type { BoneName, ExpressionWeights, PoseFrame, SimParameter } from "../contracts";
import type { Text } from "../i18n";
import type { Binding } from "./rig";

export const SLOTS = ["filter", "constraints", "solver", "output"] as const;
export type Slot = (typeof SLOTS)[number];
export type Settings = Record<string, number | string | boolean>;
export type Side = "L" | "R";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Data                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** 33 × [x, y, z, visibility]: MediaPipe pose landmarks (indices: person.ts LM). */
export type Landmarks = number[][];

/** The person at one instant. `world` is empty when nobody was found. */
export interface PersonFrame {
  world: Landmarks;
  /** Normalised to the picture (x, y in 0..1), for hops, squats and steps. */
  image: Landmarks;
  /** Picture width / height. */
  aspect: number;
}

/** What the frog's joints do this frame: the solver's result, the output block's input. */
export interface FrogPose {
  /** Torso rotations, each relative to its parent's frame (hips relative to the frog), from rest. */
  torso: { hips: THREE.Quaternion; spine: THREE.Quaternion; chest: THREE.Quaternion; head: THREE.Quaternion };
  /** Joint positions in the frog's frame: elbow (forearm_*), wrist (hand_*), knee (shin_*), ankle (foot_*). The
   *  shoulders and hips follow from the torso. */
  joints: Partial<Record<BoneName, THREE.Vector3>>;
  /** Where each hand's fingers point and its palm faces (unit, frog frame); null: along the forearm. */
  hands: Record<Side, { finger: THREE.Vector3; palm: THREE.Vector3 } | null>;
  /** Root: sideways step (m, + its left), height above the planted feet (m), heading (rad, + turns to its left). */
  shift: number;
  lift: number;
  yaw: number;
  expressions: ExpressionWeights;
}

/** Quality numbers, averaged over the last couple of seconds. */
export interface RetargetMetrics {
  /** Mean angle between the person's and the frog's limb and torso directions (degrees; 0 = same pose). */
  fidelity: number;
  /** Mean jerk of the frog's joints (m/s³; lower is smoother). */
  jerk: number;
  /** Deepest a limb point sinks into the body beyond what it may (m; 0 = clear). */
  penetration: number;
  /** Mean speed of a foot on the floor along it (m/s; 0 = planted). */
  footSlide: number;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The scene: what every block can read                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Scene {
  /** The frog's rest skeleton: joints, bone lengths, limb thickness, the Body's shape (rig.ts). */
  readonly rig: Binding;
  /** Mirror the person (a selfie view): their left drives the frog's right. */
  readonly mirror: boolean;
  /** Blocks built before this one (slot order). */
  readonly filter: FilterBlock;
  readonly constraints: ConstraintsBlock;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Blocks                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What every block may implement. */
export interface Block {
  /** One of its parameters changed. */
  setSettings?(settings: Readonly<Settings>): void;
  /** The person was lost or the source changed: forget the past. */
  reset?(): void;
}

export interface FilterBlock extends Block {
  /** A live frame (in place or a new one), at time t seconds. */
  live(frame: PersonFrame, t: number): PersonFrame;
  /** A whole recorded sequence at fps (frames with nobody stay empty or get bridged). */
  recorded(frames: PersonFrame[], fps: number): PersonFrame[];
}

/** A point on a limb that must stay out of the body (see rig.ts LimbSample). */
export interface LimbPoint {
  /** Where it is (frog frame). */
  at: THREE.Vector3;
  /** Which sample of the rig it is: its flesh thickness and how deep it may sit near its rest spot. */
  sample: import("./rig").LimbSample;
}

export interface ConstraintsBlock extends Block {
  /** Pose the body: the torso rotations of this frame (relative, as FrogPose.torso), before any query. */
  setTorso(torso: FrogPose["torso"]): void;
  /** Where a joint of the torso or a limb root is now (shoulders upperarm_*, hips thigh_*, head, chest…). */
  joint(name: BoneName): THREE.Vector3;
  /** Signed clearance of a point from the body's surface (m, < 0 inside), and the surface's outward normal there. */
  clearance(p: THREE.Vector3): { distance: number; normal: THREE.Vector3 };
  /** How much clearance a limb point needs where it is (its thickness, less for the buried roots of the limbs). */
  needed(point: LimbPoint): number;
  /** The nearest position at least `margin` outside the body (p itself when it already is). */
  pushOut(p: THREE.Vector3, margin: number): THREE.Vector3;
  /** Elbow or knee: largest bend (rad) and the side it bends to (unit vector the middle joint goes towards). */
  bend(chain: "arm" | "leg", side: Side): { max: number; towards: THREE.Vector3 };
}

export interface SolverBlock extends Block {
  /** The frog's pose for this person frame (null: nobody usable), dt seconds after the previous one. */
  solve(person: PersonFrame, dt: number, scene: Scene): FrogPose | null;
}

export interface OutputBlock extends Block {
  /** Bone rotations and the rest of the pose target for the character. */
  pose(frog: FrogPose, person: PersonFrame, dt: number, scene: Scene): PoseFrame;
}

export interface SlotBlocks {
  filter: FilterBlock;
  constraints: ConstraintsBlock;
  solver: SolverBlock;
  output: OutputBlock;
}

/** A block as registered. */
export interface BlockDefinition<S extends Slot = Slot> {
  id: string;
  slot: S;
  name: Text;
  summary: Text;
  parameters: SimParameter[];
  /** Build it. Blocks of the earlier slots are in the scene already. */
  create(scene: Scene, settings: Readonly<Settings>): SlotBlocks[S];
}

/** A retargeter: a named assembly of blocks, one per slot. */
export interface RetargeterDefinition {
  id: string;
  name: Text;
  summary: Text;
  blocks: Record<Slot, string>;
}

export { listRetargetBlocks, listRetargeters, onRetargetersChanged, registerRetargetBlock, registerRetargeter } from "./registry";
export { createRetargetPipeline, type RetargetPipeline } from "./core";
