/** Records a played session, frame by frame, into the session file (format.ts) for the Genesis HD render. */
import * as THREE from "three";
import {
  CORE_BONES,
  EXPRESSIONS,
  FINGER_BONES,
  type BodyMode,
  type BoneName,
  type ExpressionWeights,
  type FrogEvent,
  type PhysicsParams,
} from "../contracts";
import { SESSION_FORMAT, SESSION_VERSION, type SessionEvent, type SessionFile } from "./format";
import { pack, packI16 } from "./pack";

/** What the frame shows, read after the frame was drawn. */
export interface SessionFrame {
  /** World matrices of the bones as shown: the character's bones (`character.rig.bones`, after
   *  `character.update`) include the fingers; `FrogSim.readBones` output works too. */
  bones: ReadonlyMap<BoneName, THREE.Matrix4>;
  camera: THREE.PerspectiveCamera;
  /** As FrogSim.readBalls(): x, y, z, radius per ball. */
  balls: Float32Array;
  /** Expression weights as shown (`readExpressions(character.object)`). */
  expressions: ExpressionWeights;
}

export interface SessionStart {
  params: PhysicsParams;
  mode: BodyMode;
  theme: "light" | "dark";
}

export interface SessionRecorderOptions {
  /** The character asset as loaded (default the contract's models/naiwa.glb). */
  characterUrl?: string;
  characterBytes?: number;
  /** Frames closer than 1 / maxFps to the previous one are skipped (default 60). */
  maxFps?: number;
}

const BONE_ORDER: readonly BoneName[] = [...CORE_BONES, ...FINGER_BONES];
const v3 = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

export class SessionRecorder {
  private readonly opts: SessionRecorderOptions;
  private t0 = 0;
  private recording = false;
  private createdAt = "";
  private boneNames: BoneName[] = [];
  private time: number[] = [];
  private bonePos: number[] = [];
  private boneRot: number[] = [];
  private camPos: number[] = [];
  private camRot: number[] = [];
  private camLens: number[] = [];
  private expr: number[] = [];
  private ballCount: number[] = [];
  private ballData: number[] = [];
  private paramLog: SessionFile["params"] = [];
  private events: SessionEvent[] = [];
  private theme: "light" | "dark" = "light";
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();

  constructor(opts: SessionRecorderOptions = {}) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.recording;
  }

  /** Start at the moment the browser video starts (performance.now()). */
  start(nowMs: number, init: SessionStart): void {
    this.t0 = nowMs;
    this.recording = true;
    this.createdAt = new Date().toISOString();
    this.boneNames = [];
    for (const a of [this.time, this.bonePos, this.boneRot, this.camPos, this.camRot, this.camLens, this.expr,
      this.ballCount, this.ballData]) a.length = 0;
    this.paramLog = [{ t: 0, params: { ...init.params }, mode: init.mode }];
    this.events = [];
    this.theme = init.theme;
  }

  /** Call once per drawn frame, after the stage drew it. */
  frame(nowMs: number, f: SessionFrame): void {
    if (!this.recording) return;
    const t = (nowMs - this.t0) / 1000;
    const minGap = 1 / (this.opts.maxFps ?? 60) - 1e-3;
    if (this.time.length && t - this.time[this.time.length - 1] < minGap) return;
    if (!this.boneNames.length) this.boneNames = BONE_ORDER.filter((b) => f.bones.has(b));
    const nb = this.boneNames.length;
    const at = this.time.length;
    this.time.push(t);
    this.boneNames.forEach((name, k) => {
      const m = f.bones.get(name);
      if (m) {
        m.decompose(this.p, this.q, this.s);
        this.bonePos.push(this.p.x, this.p.y, this.p.z);
        this.boneRot.push(this.q.x, this.q.y, this.q.z, this.q.w);
      } else {
        // A bone missing this frame keeps its last pose (or rest, which the renderer fills in, when never seen).
        const i = (at - 1) * nb + k;
        this.bonePos.push(...(at ? this.bonePos.slice(3 * i, 3 * i + 3) : [0, 0, 0]));
        this.boneRot.push(...(at ? this.boneRot.slice(4 * i, 4 * i + 4) : [0, 0, 0, 1]));
      }
    });
    const cam = f.camera;
    cam.matrixWorld.decompose(this.p, this.q, this.s);
    this.camPos.push(this.p.x, this.p.y, this.p.z);
    this.camRot.push(this.q.x, this.q.y, this.q.z, this.q.w);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / cam.zoom));
    this.camLens.push(fov, cam.aspect);
    for (const e of EXPRESSIONS) this.expr.push(THREE.MathUtils.clamp(f.expressions[e] ?? 0, 0, 1));
    const n = Math.min(255, Math.floor(f.balls.length / 4));
    this.ballCount.push(n);
    for (let i = 0; i < 4 * n; i++) this.ballData.push(f.balls[i]);
  }

  /** A FrogEvent; dir is the push direction where the caller knows it (poke direction, slap velocity). */
  event(nowMs: number, e: FrogEvent, dir?: THREE.Vector3): void {
    if (!this.recording) return;
    const ev: SessionEvent = { t: (nowMs - this.t0) / 1000, kind: e.kind, point: v3(e.point), strength: e.strength };
    if (e.region) ev.region = e.region;
    if (dir && dir.lengthSq() > 0) ev.dir = v3(dir.clone().normalize());
    this.events.push(ev);
  }

  /** The material or body mode now (logged only when it changed). */
  setParams(nowMs: number, params: PhysicsParams, mode: BodyMode): void {
    if (!this.recording) return;
    const last = this.paramLog[this.paramLog.length - 1];
    const same = last.mode === mode && (Object.keys(params) as (keyof PhysicsParams)[]).every((k) => last.params[k] === params[k]);
    if (!same) this.paramLog.push({ t: (nowMs - this.t0) / 1000, params: { ...params }, mode });
  }

  stop(): SessionFile {
    this.recording = false;
    const n = this.time.length, nb = this.boneNames.length;
    const totalBalls = this.ballData.length / 4;
    return {
      format: SESSION_FORMAT,
      version: SESSION_VERSION,
      createdAt: this.createdAt,
      character: { url: this.opts.characterUrl ?? "models/naiwa.glb", ...(this.opts.characterBytes ? { bytes: this.opts.characterBytes } : {}) },
      bones: [...this.boneNames],
      expressions: [...EXPRESSIONS],
      frameCount: n,
      time: pack("f32", [n], this.time),
      bonePos: packI16([n, nb, 3], Float32Array.from(this.bonePos)),
      boneRot: pack("i16", [n, nb, 4], this.boneRot, 1 / 32767),
      camera: {
        pos: packI16([n, 3], Float32Array.from(this.camPos)),
        rot: pack("i16", [n, 4], this.camRot, 1 / 32767),
        lens: pack("f32", [n, 2], this.camLens),
      },
      expressionWeights: pack("u8", [n, EXPRESSIONS.length], this.expr, 1 / 255),
      balls: { count: pack("u8", [n], this.ballCount), data: pack("f32", [totalBalls, 4], this.ballData) },
      params: this.paramLog,
      events: this.events,
      stage: { theme: this.theme },
    };
  }
}
