/** Reads a session file back and samples it at any time (the browser preview of a session, tests). */
import * as THREE from "three";
import { EXPRESSIONS, type BoneName, type ExpressionWeights } from "../contracts";
import { SESSION_FORMAT, SESSION_VERSION, type SessionFile } from "./format";
import { unpack } from "./pack";

export interface SessionSample {
  bones: Map<BoneName, THREE.Matrix4>;
  camera: { position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number; aspect: number };
  expressions: ExpressionWeights;
  balls: Float32Array;
}

export class SessionPlayer {
  readonly file: SessionFile;
  readonly duration: number;
  private readonly time: Float32Array;
  private readonly pos: Float32Array;
  private readonly rot: Float32Array;
  private readonly camPos: Float32Array;
  private readonly camRot: Float32Array;
  private readonly lens: Float32Array;
  private readonly expr: Float32Array;
  private readonly ballStart: Uint32Array;
  private readonly ballCount: Float32Array;
  private readonly balls: Float32Array;

  constructor(file: SessionFile) {
    if (file.format !== SESSION_FORMAT || file.version !== SESSION_VERSION) {
      throw new Error(`not a ${SESSION_FORMAT} v${SESSION_VERSION} file`);
    }
    this.file = file;
    this.time = unpack(file.time);
    this.pos = unpack(file.bonePos);
    this.rot = unpack(file.boneRot);
    this.camPos = unpack(file.camera.pos);
    this.camRot = unpack(file.camera.rot);
    this.lens = unpack(file.camera.lens);
    this.expr = unpack(file.expressionWeights);
    this.ballCount = unpack(file.balls.count);
    this.balls = unpack(file.balls.data);
    this.ballStart = new Uint32Array(file.frameCount + 1);
    for (let i = 0; i < file.frameCount; i++) this.ballStart[i + 1] = this.ballStart[i] + this.ballCount[i];
    this.duration = file.frameCount ? this.time[file.frameCount - 1] : 0;
  }

  /** The frame pair around t and the blend between them. */
  private bracket(t: number): [number, number, number] {
    const n = this.file.frameCount;
    if (n === 0) throw new Error("empty session");
    let lo = 0, hi = n - 1;
    if (t <= this.time[0]) return [0, 0, 0];
    if (t >= this.time[hi]) return [hi, hi, 0];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid] <= t) lo = mid;
      else hi = mid;
    }
    return [lo, hi, (t - this.time[lo]) / Math.max(1e-9, this.time[hi] - this.time[lo])];
  }

  sample(t: number): SessionSample {
    const [a, b, w] = this.bracket(t);
    const nb = this.file.bones.length;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const bones = new Map<BoneName, THREE.Matrix4>();
    this.file.bones.forEach((name, k) => {
      const i = a * nb + k, j = b * nb + k;
      pa.fromArray(this.pos, 3 * i).lerp(pb.fromArray(this.pos, 3 * j), w);
      qa.fromArray(this.rot, 4 * i).normalize().slerp(qb.fromArray(this.rot, 4 * j).normalize(), w);
      bones.set(name as BoneName, new THREE.Matrix4().compose(pa, qa, one));
    });
    const position = new THREE.Vector3().fromArray(this.camPos, 3 * a).lerp(pb.fromArray(this.camPos, 3 * b), w);
    const quaternion = new THREE.Quaternion().fromArray(this.camRot, 4 * a).normalize()
      .slerp(qb.fromArray(this.camRot, 4 * b).normalize(), w);
    const expressions: ExpressionWeights = {};
    const ne = this.file.expressions.length;
    this.file.expressions.forEach((name, k) => {
      if ((EXPRESSIONS as readonly string[]).includes(name)) {
        expressions[name as keyof ExpressionWeights] = this.expr[a * ne + k] * (1 - w) + this.expr[b * ne + k] * w;
      }
    });
    // Balls appear and vanish between frames, so they are not blended.
    const f = w < 0.5 ? a : b;
    const balls = this.balls.slice(4 * this.ballStart[f], 4 * this.ballStart[f + 1]);
    return {
      bones,
      camera: { position, quaternion, fov: this.lens[2 * a] * (1 - w) + this.lens[2 * b] * w, aspect: this.lens[2 * a + 1] },
      expressions,
      balls,
    };
  }
}
