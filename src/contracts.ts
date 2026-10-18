/**
 * Contracts between the modules of Naiwa Motion Lab.
 *
 * Each folder under src/ is owned by one module (sim, character, motion, stage, ui, media); modules meet only through
 * the types below and in src/main.ts, the integration. Every module compiles against this file, so change it only by
 * agreement (tell the integrator what you need instead of editing it).
 *
 * World units are meters, +Y is up, the frog stands on the floor plane y = 0 at the origin and faces +Z (towards the
 * default camera). "_L" is the character's own left, which is +X when it faces +Z.
 */
import type * as THREE from "three";
import type { Lang, Text } from "./i18n";

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

/** The whole frog is soft (flesh over every bone); each region can have its own softness, the belly most. */
export const FLESH_REGIONS = ["belly", "body", "head", "arm", "hand", "leg", "foot"] as const;
export type FleshRegion = (typeof FLESH_REGIONS)[number];

/** One closed piece of flesh: the Body (torso + head), or one arm or leg. */
export interface FleshPart {
  /** "body", "arm_L", "arm_R", "leg_L", "leg_R". */
  name: string;
  /** Closed, manifold surface in the rest pose, world space, xyz per vertex. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Per-vertex softness 0..1 from the asset (belly ≈ 1, back of the head ≈ 0.2); optional. */
  softness?: Float32Array;
  /** Per-vertex index into FLESH_REGIONS; optional. */
  regions?: Uint8Array;
  /** The bones this flesh rides on. */
  bones: BoneName[];
  /** Skin binding of each vertex: 4 bone indices into RigSpec.bones and 4 weights (from the GLB), so the simulation
   *  can compute the skinned target shape the flesh deviates from (docs/soft-binding.md). */
  skinIndices?: Uint16Array;
  skinWeights?: Float32Array;
}

/** What the character module hands the simulation: the rest skeleton and the soft flesh, in world space with the
 *  frog at home (root at the origin, facing +Z). */
export interface RigSpec {
  bones: RigBone[];
  /** The Body (torso + head). */
  body: Omit<FleshPart, "name" | "bones"> & Partial<Pick<FleshPart, "name" | "bones">>;
  /** The arms and legs as soft flesh too (each closed); without them the limbs are rigid skinned meshes. */
  limbs?: FleshPart[];
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
  /** Short text for the user in the current language (src/i18n.ts tr()), e.g. "正在加载姿态模型…" / "Loading the pose model…". */
  message?: string;
  /** Detector frames per second while tracking. */
  fps?: number;
  /** 0..1 while an uploaded video is being analysed before it plays. */
  progress?: number;
  /** The retargeter's quality readouts (fidelity, smoothness, limbs in the body, foot sliding), formatted. */
  metrics?: { label: Text; value: string }[];
}

export interface MotionSource {
  readonly kind: MotionKind;
  /** Advance to wall time nowMs (performance.now()); returns the pose to show, or null while nothing is tracked. */
  update(nowMs: number, dt: number): PoseFrame | null;
  /** The camera or uploaded video playing in the preview (for side-by-side recording and its music). */
  readonly media?: HTMLVideoElement;
  /** An uploaded video's analysed motion, once analysed (to keep as one of "我的舞蹈"). */
  track?(): DanceTrack | null;
  dispose(): void;
}

export interface DanceInfo {
  id: string;
  /** Chinese name shown in the UI, e.g. "捧腹大笑". */
  name: string;
  /** English name, e.g. "Belly Laugh". */
  nameEn?: string;
  /** Loop length in seconds. */
  duration: number;
  /** procedural: made in code; video: captured from a real video (credit shown); mine: the user's own saved dance. */
  origin?: "procedural" | "video" | "mine";
  /** Credit line for video dances, e.g. the source title. */
  credit?: string;
}

/** A dance captured from a real video (public/dances/<id>.json, listed in public/dances/index.json): the person's
 *  MediaPipe pose per frame, retargeted live by the same code as the webcam. The video itself is never shipped. */
export interface DanceTrack {
  id: string;
  name: string;
  nameEn?: string;
  fps: number;
  /** Seconds; the track loops (frames chosen or blended so the loop is seamless). */
  duration: number;
  /** Where the motion came from (title, URL, time range); credited in the UI. */
  source: { title: string; url: string; start: number; end: number };
  /** Per frame: 33 MediaPipe world landmarks [x, y, z, visibility] (meters, hip-centred) and 33 image landmarks
   *  [x, y, z, visibility] (normalised to the video frame, for hops, squats and travel). */
  frames: { world: number[][]; image: number[][] }[];
  /** For a track analysed from a video: the camera's motion per frame, estimated from the background (shift in
   *  picture fractions and zoom, both against the first frame of its shot), and the frames where a new shot starts.
   *  A moving camera otherwise reads as the person travelling, turning or hopping. */
  camera?: { shift: [number, number]; scale: number }[];
  cuts?: number[];
  /** The camera's motion has already been taken out of the image landmarks (it must not be undone twice). */
  cameraUndone?: boolean;
}
export interface DanceIndexEntry {
  id: string;
  name: string;
  nameEn?: string;
  duration: number;
  file: string;
}

export interface MotionModule {
  /** Resolves when the dance list (built-in procedural + public/dances/index.json) is complete. */
  ready(): Promise<void>;
  /** Bind to the character's skeleton (called again if the character asset is replaced). */
  bind(rig: RigInfo): void;
  /** Webcam → pose. The preview element receives the camera image with the tracked skeleton drawn over it. */
  startCamera(opts: { mirror: boolean; preview: HTMLElement }): Promise<MotionSource>;
  /** Uploaded video → pose, played in the preview element (looping). */
  startVideo(file: File | string, opts: { mirror: boolean; preview: HTMLElement }): Promise<MotionSource>;
  /** A built-in dance or one of "我的舞蹈" (no camera needed). */
  startDance(id: string): MotionSource;
  dances(): DanceInfo[];
  /** Keep an analysed video's motion as one of "我的舞蹈" (persisted in this browser); returns its DanceInfo. */
  saveDance(track: DanceTrack, name: string): Promise<DanceInfo>;
  deleteDance(id: string): Promise<void>;
  /** The dance list changed (a dance was saved or deleted). */
  onDancesChanged(cb: (dances: DanceInfo[]) => void): () => void;
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
  /** Relative softness per region, 0 (firm as the bone) … 1 (as soft as it gets); softness scales them all. Regions
   *  left out keep the simulation's defaults (belly softest, hands and feet firmest). */
  regionSoftness?: Partial<Record<FleshRegion, number>>;
}

/** The page is a lab: the simulation is a small core with pluggable simulators around it (src/sim/api.ts registers
 *  them; docs/simulator-api.md documents it). Built in: a CPU example (constraint solver) and a GPU example
 *  (MPM / FEM on WebGPU); users add their own. Each simulator declares its parameters, and the page builds its
 *  controls from that declaration. */
export interface SimParameter {
  key: string;
  label: Text;
  kind: "number" | "choice" | "boolean";
  min?: number;
  max?: number;
  step?: number;
  /** e.g. "Hz", "kPa", "ms". */
  unit?: string;
  choices?: { value: string; label: Text }[];
  default: number | string | boolean;
  /** Changing it rebuilds the simulation (else it applies live). */
  rebuild?: boolean;
  help?: Text;
}
export interface SimulatorInfo {
  id: string;
  name: Text;
  device: "cpu" | "gpu";
  summary: Text;
  parameters: SimParameter[];
  /** null when it can run in this browser, else why not (e.g. no WebGPU). */
  unavailable: Text | null;
  /** What it actually runs on here, when that varies (e.g. "WebGPU", or "CPU 并行 · 8 线程" without a GPU). */
  backend?: Text | string | null;
  /** Built in, or added by the user (editable source). */
  origin: "builtin" | "user";
}
export interface SimulatorOptions {
  /** Id of a registered simulator, e.g. "cpu-constraints", "gpu-mpm", or a user's own. */
  id: string;
  /** Values for its declared parameters (missing ones take their defaults). */
  settings: Record<string, number | string | boolean>;
}

/** Motion transfer is the other numerical core and a lab in the same way (src/motion/api.ts): a person's pose →
 *  filtering → a retargeting solver (e.g. an optimisation / IK under the frog's constraints: limbs outside its body,
 *  planted feet) → pose targets, each block replaceable and editable by users. A retargeter declares its parameters
 *  like a simulator does. */
export type RetargeterInfo = SimulatorInfo;
export type RetargeterOptions = SimulatorOptions;

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

/** tickle: the feather rubbing over it (sent by the integration to Character.react, not by the simulation). */
export type FrogEventKind = "poke" | "slap" | "grab" | "release" | "land" | "ball" | "squish" | "tickle";
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
  /** Deformed limb surfaces by FleshPart name (same vertex order as their RigSpec.limbs positions). */
  readLimbs?(out: Map<string, Float32Array>): void;
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
  /** Show the simulated state: bones (world), the deformed body surface (world, RigSpec order) and the deformed limbs
   *  when they are soft. */
  applySim(bones: Map<BoneName, THREE.Matrix4>, body: Float32Array, limbs?: Map<string, Float32Array>): void;
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
  /** A press accepted by hitTest begins / ends (also when it never moves: the pump is held this way). */
  onPressStart?(p: PointerInfo): void;
  onPressEnd?(p: PointerInfo): void;
  /** A tap (press and release without dragging) anywhere, also where hitTest said false (the ball tool throws at
   *  the background too). */
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
  /** Route a video's own sound (the dance music) through the mix, so it is heard and recorded; null detaches. */
  attachMusic(el: HTMLMediaElement | null): void;
}

export interface RecordOptions {
  /** The uploaded/camera video to show with the frog. */
  companion?: HTMLVideoElement | null;
  /** frog-only, the video as picture-in-picture, or "真人 vs 奶蛙" side by side. */
  layout?: "frog" | "pip" | "side-by-side";
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
  start(canvas: HTMLCanvasElement, audio: MediaStream | null, opts?: RecordOptions): void;
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
  /** Page language; the integration keeps src/i18n.ts in step with it. */
  lang: Lang;
  recording: { active: boolean; startedAt: number | null };
  /** How a recording frames the frog and the camera/uploaded video. */
  recordLayout: "frog" | "pip" | "side-by-side";
  lastRecording: Recording | null;
  /** The live dance list (presets + 我的舞蹈), kept up to date by the integration. */
  dances: DanceInfo[];
  /** The uploaded video's analysed motion can be saved (set by the integration once analysis is done). */
  canSaveDance: boolean;
  motion: MotionStatus;
  /** The soft-body simulator in use, and every simulator registered (built in and the user's). */
  simulator: SimulatorOptions;
  simulators: SimulatorInfo[];
  /** The motion-transfer (retargeting) algorithm in use, and every one registered. */
  retargeter: RetargeterOptions;
  retargeters: RetargeterInfo[];
  /** Simulation playback: paused, and the speed of simulated time (1 = real time, 0.25 = slow motion). */
  playback: { paused: boolean; timeScale: number };
  /** Simulation readouts, refreshed a few times a second by the integration. */
  stats: { fps: number; stepMs: number; particles: number; cells: number; volumeRatio: number };
  /** Character asset status shown while loading. */
  loading: { active: boolean; message: string };
}

export interface MaterialPreset {
  id: string;
  /** Chinese name, e.g. "果冻". */
  name: string;
  /** English name, e.g. "Jelly". */
  nameEn: string;
  params: PhysicsParams;
}

export interface AppCommands {
  resetFrog(): void;
  /** While paused, advance the simulation by one frame. */
  stepSim(): void;
  startRecording(): void;
  stopRecording(): void;
  /** Mode "video" with this file. */
  loadVideo(file: File): void;
  /** Copy a link that reproduces the current settings (mode, params, dance…). */
  copyConfigLink(): Promise<void>;
  rainBalls(): void;
  /** Save or share the last recording (Web Share on phones, download elsewhere). */
  shareRecording(): Promise<void>;
  /** Keep the analysed uploaded video's motion as one of 我的舞蹈. */
  saveDance(name: string): Promise<DanceInfo>;
  deleteDance(id: string): Promise<void>;
}

export interface UIHandles {
  /** Container for the camera/video preview (picture in picture). */
  readonly preview: HTMLElement;
  toast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
}
