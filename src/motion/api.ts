/**
 * The motion-transfer plugin API.
 *
 * Motion transfer turns a person's pose (MediaPipe landmarks from the webcam, an uploaded video or a dance track) into
 * pose targets for the frog. The core (core.ts) is a small loop over five slots; each holds one block, a retargeter is
 * a named assembly of blocks, and anyone can swap one block and keep the others:
 *
 *   filter       smooths the person's landmarks: causally for the live camera, with frames before and after for a
 *                recorded video (analysed before it plays)
 *   goal         the person's pose → what the frog should do (a Goal: limb directions, belly holds, hops, face)
 *   constraints  the frog's own body: clearance of a point from its surface (limbs stay outside), joint limits
 *   solver       a Goal → the frog's skeleton pose under the constraints (the numerical core)
 *   output       the skeleton pose → bone rotations for the character (PoseFrame), feet on the floor
 *
 * Per person frame the core runs filter → goal; per shown frame solver (asking the constraints) → output, and keeps
 * quality numbers (metrics). Procedural dances are written as Goals and enter at the solver. The split at the Goal
 * lets a source fade or hold a pose between the two halves (a person stepping out of view).
 *
 * Frames: the person's world landmarks are MediaPipe's (metres, hip-centred, x to the image right, y down, z away from
 * the camera). Everything of the frog is in the frog's own frame: metres, root at its rest spot, +X its left (the
 * viewer's right when it faces us), +Y up, +Z forward (towards the camera).
 */
import type * as THREE from "three";
import type { BoneName, ExpressionWeights, PoseFrame, SimParameter } from "../contracts";
import type { Text } from "../i18n";
import type { BodyPose } from "./pose";
import type { Binding, LimbSample } from "./rig";

/** Build order: a block may use the ones before it (the goal block reads the constraints' torso limits). */
export const SLOTS = ["filter", "constraints", "goal", "solver", "output"] as const;
export type Slot = (typeof SLOTS)[number];
export type Settings = Record<string, number | string | boolean>;
export type Side = "L" | "R";
export type { BodyPose as Goal, LimbSample };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Data                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** 33 × [x, y, z, visibility]: MediaPipe pose landmarks (indices: blocks/personDirections.ts LM). Empty: nobody. */
export type Landmarks = number[][];

export interface LandmarkFrame {
  world: Landmarks;
  /** Normalised to the picture (x, y in 0..1), for hops, squats and steps. */
  image: Landmarks;
}

/** The person at one instant, with the picture's width / height. */
export interface PersonFrame extends LandmarkFrame {
  aspect: number;
}

/** What a source knows from a whole recording (nothing, live): the feet's floor line (image y) and the hips' home
 *  (image x × aspect). */
export interface Recording {
  floor?: number;
  home?: number;
}

/** The skeleton posed: world rotation of each bone from rest (bone world = rotation · rest world) and joint positions,
 *  in the frog's frame before the root offset and heading. The solver's result, the output block's input. */
export interface FrogPose {
  rotations: Map<BoneName, THREE.Quaternion>;
  joints: Map<BoneName, THREE.Vector3>;
  /** Height above the planted feet (m), sideways step (m, + its left), heading (rad, + turns to its left). */
  lift: number;
  shift: number;
  yaw: number;
  expressions: ExpressionWeights;
}

/** Quality numbers over the last two seconds. */
export interface RetargetMetrics {
  /** Mean angle between the goal's limb directions and the frog's (degrees; 0 = the person's pose exactly). */
  fidelity: number;
  /** Mean jerk of the frog's elbows, wrists, knees, ankles and head (m/s³; lower is smoother). */
  jerk: number;
  /** Deepest a limb point sank into the body beyond what it may (m; 0 = clear). */
  penetration: number;
  /** Mean horizontal speed of a foot standing on the floor (m/s; 0 = planted). */
  footSlide: number;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The scene: what every block can read                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Scene {
  /** The frog's rest skeleton: joints, bone lengths, limb samples and thickness, the body's shape (rig.ts). */
  readonly rig: Binding;
  /** Live: null. */
  readonly recording: Recording | null;
  /** Blocks built before this one (slot order); reading one not built yet throws. */
  readonly filter: FilterBlock;
  readonly constraints: ConstraintsBlock;
  readonly goal: GoalBlock;
  readonly solver: SolverBlock;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Blocks                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What every block may implement. */
export interface Block {
  /** Its parameters changed. Without it (or for a `rebuild` parameter) the pipeline is rebuilt instead. */
  setSettings?(settings: Readonly<Settings>): void;
  /** The person was lost or the source changed: forget the past. */
  reset?(): void;
}

export interface FilterBlock extends Block {
  /** A live frame at time t seconds (a new frame; the input stays as it was). */
  live(frame: PersonFrame, t: number): PersonFrame;
  /** A whole recording at fps; frames with nobody stay empty or get bridged. */
  recorded(frames: PersonFrame[], fps: number): PersonFrame[];
}

export interface GoalBlock extends Block {
  /** What the frog should do for this person frame, dt seconds after the previous one (null: nobody usable). Not
   *  mirrored: the core mirrors for a selfie view. */
  goal(person: PersonFrame, dt: number): BodyPose | null;
}

/** The torso as the solver posed it: world rotations from rest and joint positions (FrogPose's maps, being filled). */
export interface Torso {
  rotations: ReadonlyMap<BoneName, THREE.Quaternion>;
  joints: ReadonlyMap<BoneName, THREE.Vector3>;
}

export interface ConstraintsBlock extends Block {
  /** Pose the body before any query of this frame. */
  setTorso(torso: Torso): void;
  /** Signed clearance of a point from the body's surface (m, < 0 inside). */
  clearance(p: THREE.Vector3): number;
  /** A limb point at p: its clearance, and the clearance it needs there (its thickness, less near the buried roots
   *  of the limbs and their rest spots). */
  check(sample: LimbSample, p: THREE.Vector3): { clearance: number; needed: number };
  /** How far a free limb point's centre stays off the surface (its flesh plus a safety margin). */
  thickness(sample: LimbSample): number;
  /** The nearest position `margin` outside the body, or null when p already is (side breaks ties at the axis). */
  pushOut(p: THREE.Vector3, margin: number, side: Side): THREE.Vector3 | null;
  /** A spot on the belly: height 0 (hips) … 1 (chest), radians around from the front towards `side`; its outward
   *  normal, the horizontal tangent towards the front centre, and the body's down there (all unit). */
  bellySpot(height: number, around: number, side: Side): { point: THREE.Vector3; normal: THREE.Vector3; tangent: THREE.Vector3; down: THREE.Vector3 };
  /** Largest rotation (rad) of the chest and head from rest, and bend of the elbow and knee. */
  limit(joint: "chest" | "head" | "elbow" | "knee"): number;
  /** Smallest |x| (m) of a knee or ankle, so the legs never cross. */
  spread(joint: "knee" | "ankle", side: Side): number;
}

export interface SolverBlock extends Block {
  /** The skeleton pose for a goal (after constraints.setTorso it may query the body). */
  solve(goal: BodyPose): FrogPose;
}

export interface OutputBlock extends Block {
  /** Bone rotations and the rest of the pose target for the character. */
  pose(frog: FrogPose): PoseFrame;
}

export interface SlotBlocks {
  filter: FilterBlock;
  goal: GoalBlock;
  constraints: ConstraintsBlock;
  solver: SolverBlock;
  output: OutputBlock;
}

/** A block as registered. Parameter keys are unique within a retargeter. */
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
