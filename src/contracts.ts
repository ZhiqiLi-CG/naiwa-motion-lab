/**
 * Contracts between the modules of 奶蛙 Playground.
 *
 * Each folder under src/ is owned by one module (sim, character, motion, stage, ui, media); modules meet only through
 * the types below and in src/main.ts, the integration. Every module compiles against this file, so change it only by
 * agreement (tell the integrator what you need instead of editing it).
 *
 * World units are meters, +Y is up, the frog stands on the floor plane y = 0 at the origin and faces +Z (towards the
 * default camera). "_L" is the character's own left, which is +X when it faces +Z.
 */
import type * as THREE from "three";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Character asset: public/models/naiwa.glb (built in Blender from assets-src/naiwa, see docs/character-contract.md)  */
/* ------------------------------------------------------------------------------------------------------------------ */

export const CHARACTER_URL = "models/naiwa.glb";

/** Bones every rig has, with these exact names. Hierarchy: root > hips > spine > chest > head; chest > upperarm >
 *  forearm > hand; hips > thigh > shin > foot. */
export const CORE_BONES = [
  "root",
  "hips",
  "spine",
  "chest",
  "head",
  "upperarm_L",
  "forearm_L",
  "hand_L",
  "upperarm_R",
  "forearm_R",
  "hand_R",
  "thigh_L",
  "shin_L",
  "foot_L",
  "thigh_R",
  "shin_R",
  "foot_R",
] as const;
/** Finger bones (one per finger, child of hand_*); a rig may lack them and everything still works. */
export const FINGER_BONES = [
  "thumb_L",
  "index_L",
  "middle_L",
  "ring_L",
  "thumb_R",
  "index_R",
  "middle_R",
  "ring_R",
] as const;
export type CoreBone = (typeof CORE_BONES)[number];
export type FingerBone = (typeof FINGER_BONES)[number];
export type BoneName = CoreBone | FingerBone;

/** Mesh objects of the GLB. Body is the closed soft torso + head (one watertight surface, belly patch included). */
export const MESH_NAMES = {
  body: "Body",
  eyes: "Eyes",
  arms: "Arms",
  legs: "Legs",
  mouth: "MouthInside",
} as const;

/** Facial expressions = morph targets (shape keys) of the same names; any may be missing. Weights 0..1. */
export const EXPRESSIONS = ["laugh", "tongue", "blink", "surprise"] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export type ExpressionWeights = Partial<Record<Expression, number>>;

/** What the character module hands the simulation: the rest skeleton and the soft body surface, in world space with
 *  the frog at home (root at the origin, facing +Z). */
export interface RigSpec {
  bones: RigBone[];
  body: {
    /** Closed, manifold surface of the Body mesh in the rest pose, world space, xyz per vertex. */
    positions: Float32Array;
    indices: Uint32Array;
    /** Per-vertex extra softness 0..1 (belly ≈ 1, back of the head ≈ 0); optional. */
    softness?: Float32Array;
  };
}
export interface RigBone {
  name: BoneName;
  parent: BoneName | null;
  /** The bone's world matrix in the rest pose (joint position + bone frame, as THREE.Bone.matrixWorld). */
  restWorld: THREE.Matrix4;
  /** World position of the bone's end (its child joint, or its tip for end bones). */
  tail: THREE.Vector3;
  /** Rough thickness of the flesh around the bone, for collision capsules (meters). */
  radius: number;
}

/** The character's skeleton as loaded, for retargeting. */
export interface RigInfo {
  skeleton: THREE.Skeleton;
  /** Bones by contract name, in the rest pose when handed over. */
  bones: Map<BoneName, THREE.Bone>;
  /** Total height of the frog in the rest pose (meters). */
  height: number;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Motion: camera / uploaded video / built-in dances → pose targets                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A target pose for the frog. */
export interface PoseFrame {
  /** Local quaternions that replace bone.quaternion (bones absent here keep their rest local rotation). */
  bones: Partial<Record<BoneName, THREE.Quaternion>>;
  /** Offset of the root from the frog's home spot, world meters (y > 0 means in the air). */
  rootOffset?: THREE.Vector3;
  /** Heading of the whole frog around +Y in radians (0 = facing +Z). */
  rootYaw?: number;
  expressions?: ExpressionWeights;
}

export type MotionKind = "camera" | "video" | "dance";
export type MotionState = "idle" | "loading" | "ready" | "tracking" | "lost" | "error";
export interface MotionStatus {
  state: MotionState;
  /** Short Chinese text for the user, e.g. "正在加载姿态模型…". */
  message?: string;
  /** Detector frames per second while tracking. */
  fps?: number;
}

export interface MotionSource {
  readonly kind: MotionKind;
  /** Advance to wall time nowMs (performance.now()); returns the pose to show, or null while nothing is tracked. */
  update(nowMs: number, dt: number): PoseFrame | null;
  dispose(): void;
}

export interface DanceInfo {
  id: string;
  /** Chinese name shown in the UI, e.g. "捧腹大笑". */
  name: string;
  /** Loop length in seconds. */
  duration: number;
}

export interface MotionModule {
  /** Bind to the character's skeleton (called again if the character asset is replaced). */
  bind(rig: RigInfo): void;
  /** Webcam → pose. The preview element receives the camera image with the tracked skeleton drawn over it. */
  startCamera(opts: { mirror: boolean; preview: HTMLElement }): Promise<MotionSource>;
  /** Uploaded video → pose, played in the preview element (looping). */
  startVideo(file: File | string, opts: { mirror: boolean; preview: HTMLElement }): Promise<MotionSource>;
  /** A built-in dance (no camera needed). */
  startDance(id: string): MotionSource;
  dances(): DanceInfo[];
  onStatus(cb: (s: MotionStatus) => void): () => void;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Simulation: Rapier 0.21 rigid skeleton + soft-body flesh                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PhysicsParams {
  /** 0 firm … 1 very soft jelly. */
  softness: number;
  /** 0 dead (damped) … 1 wobbles for a long time. */
  bounciness: number;
  /** Multiplier of 9.81 m/s². */
  gravity: number;
  /** Volume factor of the soft body (1 = as modelled; > 1 inflates the belly). */
  bellySize: number;
  /** 0 flops over and stays … 1 always springs back upright (free mode). */
  stubbornness: number;
}

/** free: the simulation owns the whole frog (poke mode: it can be knocked over, grabbed and thrown).
 *  driven: pose targets drive the skeleton, the root is held at home (+ rootOffset); the flesh still jiggles and the
 *  frog can still be poked. */
export type BodyMode = "free" | "driven";

export type HitRegion = "belly" | "head" | "body" | "arm" | "leg";
export interface FrogHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  region: HitRegion;
}

export type FrogEventKind = "poke" | "slap" | "grab" | "release" | "land" | "ball" | "squish";
export interface FrogEvent {
  kind: FrogEventKind;
  point: THREE.Vector3;
  /** 0..1, how hard (drives sound volume, fx size and the character's reaction). */
  strength: number;
  region?: HitRegion;
}

export interface GrabHandle {
  /** Pull the grabbed spot towards this world point. */
  move(target: THREE.Vector3): void;
  /** Let go; the velocity (m/s, world) carries on, so a fast release throws the frog. */
  release(velocity: THREE.Vector3): void;
}

export interface FrogSim {
  setParams(p: PhysicsParams): void;
  setMode(m: BodyMode): void;
  /** Driven mode: target world matrices for the simulated bones (from the posed skeleton), and the root offset. */
  setTargets(boneWorld: Map<BoneName, THREE.Matrix4>): void;
  /** Advance by dt seconds (fixed substeps inside). */
  step(dt: number): void;
  /** Current world matrices of the simulated bones (written into out). */
  readBones(out: Map<BoneName, THREE.Matrix4>): void;
  /** Deformed Body surface, world space, same vertex order as RigSpec.body.positions. */
  readBody(): Float32Array;
  raycast(ray: THREE.Ray): FrogHit | null;
  /** A quick jab at hit.point along direction (unit, world). */
  poke(hit: FrogHit, strength: number, direction: THREE.Vector3): void;
  grab(hit: FrogHit): GrabHandle;
  /** A fast swipe passing through point with this world velocity (m/s). */
  slap(point: THREE.Vector3, velocity: THREE.Vector3): void;
  throwBall(origin: THREE.Vector3, velocity: THREE.Vector3, radius?: number): void;
  /** Ball positions for rendering (world, xyz + radius per ball). */
  readBalls(): Float32Array;
  clearBalls(): void;
  /** Put the frog back at home, upright, at rest. */
  reset(): void;
  onEvent(cb: (e: FrogEvent) => void): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Character: the rendered frog                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Character {
  /** Add to the scene. */
  readonly object: THREE.Object3D;
  readonly rig: RigInfo;
  readonly spec: RigSpec;
  /** Target bone world matrices for the simulation from a pose (FK of the rest skeleton; null = rest/idle pose). */
  targetsFromPose(pose: PoseFrame | null, out: Map<BoneName, THREE.Matrix4>): void;
  /** Show the simulated state: bones (world) and the deformed body surface (world, RigSpec order). */
  applySim(bones: Map<BoneName, THREE.Matrix4>, body: Float32Array): void;
  /** Expressions requested by the motion (dance/camera); the character blends them with its own life. */
  setExpressions(w: ExpressionWeights | undefined): void;
  /** Where the eyes look (world point), or null to look at the camera. */
  lookAt(target: THREE.Vector3 | null): void;
  /** React to what happens to it (surprise on a poke, giggles when tickled, laughs when thrown…). */
  react(e: FrogEvent): void;
  /** Blink, breathe, expression easing. */
  update(dt: number, camera: THREE.Camera): void;
  /** World centre of the frog (for the camera to follow). */
  center(out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Stage: renderer, scene, camera, gestures, effects                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PointerInfo {
  ray: THREE.Ray;
  /** Normalised device coordinates (-1..1). */
  ndc: THREE.Vector2;
  clientX: number;
  clientY: number;
  /** performance.now() */
  time: number;
  pointerType: string;
}

export interface GestureHandler {
  /** Does a press here start an interaction (true) or orbit the camera (false)? */
  hitTest(ray: THREE.Ray): boolean;
  onTap(p: PointerInfo): void;
  onDragStart(p: PointerInfo): void;
  onDragMove(p: PointerInfo): void;
  /** velocity: pointer speed at release, px/s in client coordinates. */
  onDragEnd(p: PointerInfo, velocity: THREE.Vector2): void;
  onHover(p: PointerInfo | null): void;
}

export interface Fx {
  /** Comic text that pops at a world point and floats away, e.g. "DUANG~". Drawn in the 3D canvas (recorded). */
  popText(at: THREE.Vector3, text: string, opts?: { color?: string; size?: number }): void;
  burst(at: THREE.Vector3, kind: "stars" | "hearts" | "drops" | "sweat", count?: number): void;
  shake(amount: number): void;
}

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly fx: Fx;
  setGestureHandler(h: GestureHandler): void;
  /** The camera follows this point smoothly. */
  setFocus(target: THREE.Vector3): void;
  /** Rendered balls (positions + radius per ball, as FrogSim.readBalls()). */
  setBalls(balls: Float32Array): void;
  setTheme(theme: "light" | "dark"): void;
  /** Advance effects and draw one frame. */
  frame(dt: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Media: sound effects, recording, sharing                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export type SfxKind = "boing" | "squish" | "slap" | "pop" | "whoosh" | "land" | "giggle" | "laugh" | "pump" | "ball";
export interface Sfx {
  /** Call from a user gesture (browsers start audio only then). */
  unlock(): void;
  setEnabled(on: boolean): void;
  play(kind: SfxKind, strength?: number): void;
  /** Audio of every effect, for recording alongside the canvas. */
  readonly stream: MediaStream | null;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  /** Object URL of blob. */
  url: string;
  /** Suggested file name, e.g. "naiwa-20261016-153000.mp4". */
  fileName: string;
}
export interface Recorder {
  readonly active: boolean;
  start(canvas: HTMLCanvasElement, audio: MediaStream | null): void;
  stop(): Promise<Recording>;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* App state (src/store.ts) and the commands the UI may call (implemented in src/main.ts)                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** play = 捏捏奶蛙, camera = 跟着我跳, video = 视频模仿, dance = 舞蹈库. */
export type Mode = "play" | "camera" | "video" | "dance";
/** hand: tap pokes, drag grabs/throws, a fast swipe slaps; ball: tap throws a ball; feather: rub to tickle;
 *  pump: hold to inflate the belly. */
export type Tool = "hand" | "ball" | "feather" | "pump";
export type ThemeChoice = "system" | "light" | "dark";

export interface AppState {
  mode: Mode;
  tool: Tool;
  params: PhysicsParams;
  /** Material preset id last picked (params may have been changed since). */
  preset: string;
  dance: string;
  mirror: boolean;
  sound: boolean;
  theme: ThemeChoice;
  recording: { active: boolean; startedAt: number | null };
  lastRecording: Recording | null;
  motion: MotionStatus;
  stats: { pokes: number; throws: number; fps: number };
  /** Character asset status shown while loading. */
  loading: { active: boolean; message: string };
}

export interface MaterialPreset {
  id: string;
  /** Chinese name, e.g. "果冻". */
  name: string;
  params: PhysicsParams;
}

export interface AppCommands {
  resetFrog(): void;
  startRecording(): void;
  stopRecording(): void;
  /** Mode "video" with this file. */
  loadVideo(file: File): void;
  /** Copy a link that reproduces the current settings (mode, params, dance…). */
  copyConfigLink(): Promise<void>;
  rainBalls(): void;
  /** Save or share the last recording (Web Share on phones, download elsewhere). */
  shareRecording(): Promise<void>;
}

export interface UIHandles {
  /** Container for the camera/video preview (picture in picture). */
  readonly preview: HTMLElement;
  toast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
}
