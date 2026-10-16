/** The camera: orbits a target that follows the frog. Gestures move goals (yaw, pitch, zoom); the camera eases to
 *  them, keeps spinning a little after a flick, and never goes under the floor. Shake is trauma based (squared,
 *  decaying) so small knocks stay subtle and big ones punch. */
import * as THREE from "three";

export const FOV = 35;
/** Default view: a little to the frog's right (its eyes are on the sides of the head) and a little from above. */
export const DEFAULT_YAW = 0.32;
export const DEFAULT_PITCH = 0.2;
const PITCH_MIN = 0.06;
const PITCH_MAX = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.6;
/** Half extent of what the default framing keeps in view around the target: the whole 1 m frog with some air. */
const FRAME_HALF_H = 1.05;
const FRAME_HALF_W = 0.75;
const MIN_DISTANCE = 1.25;
const CAMERA_MIN_Y = 0.08;
/** Where the target may go: the frog's centre, kept a little off the floor and within the stage. */
const TARGET_MIN_Y = 0.42;
const TARGET_MAX_Y = 2.4;
/** A frog thrown up is followed only partly in height, and the camera backs off as it rises (m per m), so the
 *  flight stays in frame instead of the view swinging up to the sky. */
const REST_Y = 0.5;
const VERTICAL_FOLLOW = 0.6;
const LIFT_BACKOFF = 0.9;
const TARGET_MAX_R = 14;
const EASE = 14; // 1/s, how fast the camera reaches its orbit goals
const FLING_FRICTION = 3.5; // 1/s
const FOLLOW_TIME_XZ = 0.18; // s, smoothing of the follow
const FOLLOW_TIME_Y = 0.3;
/** The framing ignores the frog's centre moving less than this (m): a poked or dancing belly sways its centre, and
 *  a view that sways along hides the jiggle. Beyond it (a throw, a stumble) the camera follows; at rest it recentres
 *  slowly. */
const DEAD_ZONE = 0.14;
const RECENTER = 0.8; // 1/s
const SHAKE_DECAY = 1.6; // trauma per second
const SHAKE_OFFSET = 0.07; // m at full trauma
const SHAKE_ROLL = 0.05; // rad at full trauma

/** Critically damped spring (as Unity's SmoothDamp): returns the new value, updates vel[i]. */
function smoothDamp(cur: number, goal: number, vel: number[], i: number, time: number, dt: number): number {
  const omega = 2 / time;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - goal;
  const temp = (vel[i] + omega * change) * dt;
  vel[i] = (vel[i] - omega * temp) * exp;
  return goal + (change + temp) * exp;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Distance at which the default framing box fits a view of this aspect (width / height). */
export function fitDistance(aspect: number, fovDeg = FOV): number {
  const t = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return Math.max(FRAME_HALF_H / t, FRAME_HALF_W / (t * aspect));
}

export class CameraRig {
  yaw = DEFAULT_YAW;
  pitch = DEFAULT_PITCH;
  zoom = 1;
  readonly target = new THREE.Vector3(0, 0.5, 0);
  private yawGoal = DEFAULT_YAW;
  private pitchGoal = DEFAULT_PITCH;
  private zoomGoal = 1;
  private yawRate = 0;
  private pitchRate = 0;
  private readonly focus = new THREE.Vector3(0, 0.5, 0);
  /** What the target eases to: the focus, less the dead zone. */
  private readonly anchor = new THREE.Vector3(0, 0.5, 0);
  private readonly lag = new THREE.Vector3();
  private readonly followVel = [0, 0, 0];
  private trauma = 0;
  private time = 0;
  /** Shake is scaled down for people who asked for less motion. */
  shakeScale = 1;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  setFocus(p: THREE.Vector3): void {
    const r = Math.hypot(p.x, p.z);
    const s = r > TARGET_MAX_R ? TARGET_MAX_R / r : 1;
    const y = REST_Y + (p.y - REST_Y) * VERTICAL_FOLLOW;
    this.focus.set(p.x * s, clamp(y, TARGET_MIN_Y, TARGET_MAX_Y), p.z * s);
  }

  /** Orbit by angles (radians); stops any spin left from a flick. */
  orbitBy(dYaw: number, dPitch: number): void {
    this.yawRate = this.pitchRate = 0;
    this.yawGoal += dYaw;
    this.pitchGoal = clamp(this.pitchGoal + dPitch, PITCH_MIN, PITCH_MAX);
  }

  /** Keep spinning at these rates (rad/s), slowing down. */
  fling(yawRate: number, pitchRate: number): void {
    this.yawRate = yawRate;
    this.pitchRate = pitchRate;
  }

  /** The orbit goals, to undo a gesture's orbit (a swipe that turned out to slap the frog). */
  mark(): [number, number] {
    return [this.yawGoal, this.pitchGoal];
  }
  restore(m: [number, number]): void {
    this.yawRate = this.pitchRate = 0;
    [this.yawGoal, this.pitchGoal] = m;
  }

  zoomBy(factor: number): void {
    this.zoomGoal = clamp(this.zoomGoal * factor, ZOOM_MIN, ZOOM_MAX);
  }

  shake(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  reset(): void {
    this.yawGoal = DEFAULT_YAW;
    this.pitchGoal = DEFAULT_PITCH;
    this.zoomGoal = 1;
    this.yawRate = this.pitchRate = 0;
  }

  /** Jump to the goals and the focus (first frame). */
  snap(): void {
    this.yaw = this.yawGoal;
    this.pitch = this.pitchGoal;
    this.zoom = this.zoomGoal;
    this.target.copy(this.focus);
    this.anchor.copy(this.focus);
    this.followVel.fill(0);
  }

  update(dt: number): void {
    this.time += dt;
    if (this.yawRate !== 0 || this.pitchRate !== 0) {
      this.yawGoal += this.yawRate * dt;
      this.pitchGoal = clamp(this.pitchGoal + this.pitchRate * dt, PITCH_MIN, PITCH_MAX);
      const f = Math.exp(-FLING_FRICTION * dt);
      this.yawRate *= f;
      this.pitchRate *= f;
      if (Math.abs(this.yawRate) + Math.abs(this.pitchRate) < 1e-3) this.yawRate = this.pitchRate = 0;
    }
    const k = 1 - Math.exp(-EASE * dt);
    this.yaw += (this.yawGoal - this.yaw) * k;
    this.pitch += (this.pitchGoal - this.pitch) * k;
    this.zoom += (this.zoomGoal - this.zoom) * k;

    const a = this.anchor;
    const lag = this.lag.subVectors(this.focus, a);
    const far = lag.length();
    if (far > DEAD_ZONE) a.addScaledVector(lag, 1 - DEAD_ZONE / far);
    a.lerp(this.focus, 1 - Math.exp(-RECENTER * dt));
    const t = this.target;
    const v = this.followVel;
    t.x = smoothDamp(t.x, a.x, v, 0, FOLLOW_TIME_XZ, dt);
    t.y = smoothDamp(t.y, a.y, v, 1, FOLLOW_TIME_Y, dt);
    t.z = smoothDamp(t.z, a.z, v, 2, FOLLOW_TIME_XZ, dt);

    const cam = this.camera;
    const lift = Math.max(0, t.y - REST_Y) * (LIFT_BACKOFF / VERTICAL_FOLLOW);
    const d = Math.max(MIN_DISTANCE, fitDistance(cam.aspect, cam.fov) * this.zoom) + lift;
    const cp = Math.cos(this.pitch);
    cam.position.set(
      t.x + d * cp * Math.sin(this.yaw),
      t.y + d * Math.sin(this.pitch),
      t.z + d * cp * Math.cos(this.yaw),
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(t);

    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    const s = this.trauma * this.trauma * this.shakeScale;
    if (s > 0) {
      const w = this.time;
      // Sums of incommensurate sines: smooth, non-repeating jitter without a noise table.
      const nx = Math.sin(w * 47.3) * 0.6 + Math.sin(w * 83.1 + 1.3) * 0.4;
      const ny = Math.sin(w * 53.7 + 2.1) * 0.6 + Math.sin(w * 91.9 + 0.4) * 0.4;
      const nr = Math.sin(w * 39.1 + 4.2) * 0.7 + Math.sin(w * 71.3) * 0.3;
      cam.translateX(nx * s * SHAKE_OFFSET);
      cam.translateY(ny * s * SHAKE_OFFSET);
      cam.rotateZ(nr * s * SHAKE_ROLL);
    }
    if (cam.position.y < CAMERA_MIN_Y) cam.position.y = CAMERA_MIN_Y;
    cam.updateMatrixWorld();
  }
}
