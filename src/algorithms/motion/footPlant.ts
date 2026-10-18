/**
 * Output block: foot planting (foot-contact clean-up). The built-in output copies the goal's heading and side step
 * onto the root, so a dancer who twists in place (狗熊哆嗦毛: ±0.7 rad) swivels the frog's planted feet across the
 * floor. Here a foot standing on the floor (within `contactHeight` of it, small hops included) is pinned where it touched down, and the root is placed to keep it there:
 *
 *   a foot down       the heading holds (a standing foot turns with the root, so turning it would swivel the toe
 *                     round the heel); what the goal turns goes into the upper body as a twist (up to
 *                     `twistLimit`); the root offset keeps the standing feet on their anchors (exact for one,
 *                     least squares for two)
 *   none (in the air) the twist eases back into the heading and the root follows the goal
 *
 * The twist eases back to the root in the air (time constant `blend`). Pivoting on alternate feet walks (a
 * swivel step: 狗熊哆嗦毛 would wander off at 8 cm/s), so the root is pulled home towards the goal's heading and side step
 * like a spring (HOME_TIME), no faster than `homing` m/s at the feet while one stands (the one slide this block
 * allows), freely during a hop. The twist is applied to the FrogPose in place
 * (spine and everything above it turned about the spine joint), so the metrics measure what is shown.
 */
import * as THREE from "three";
import type { BoneName, PoseFrame } from "../../contracts";
import type { BlockDefinition, ConstraintsBlock, FrogPose, LimbSample, OutputBlock, Scene, Settings, Side } from "../../motion/api";
import { plantedRotations } from "../../motion/blocks/plantedRotations";
import { SIDES } from "../../motion/pose";
import type { Binding } from "../../motion/rig";

type XZ = { x: number; z: number };
const UP = new THREE.Vector3(0, 1, 0);
const turn = (p: XZ, yaw: number): XZ => ({ x: p.x * Math.cos(yaw) + p.z * Math.sin(yaw), z: -p.x * Math.sin(yaw) + p.z * Math.cos(yaw) });
/** Below this height (m) a free foot sweeps no faster than LOW_SPEED (m/s). */
const LOW = 0.03;
const LOW_SPEED = 0.6;
/** A free foot sweeping faster than about 0.5 m/s is lifted to this height (m), eased in and out over RAISE_EASE s. */
const SWING_CLEAR = 0.05;
const RAISE_EASE = 0.04;
/** Time constant (s) of a lifted foot's leg correction fading out. */
const LIFT_EASE = 0.12;
/** Largest correction the leg IK makes to a planted ankle (m). */
const MAX_FIX = 0.08;
/** How deep (m) the leg IK may push a leg point into the body, or no deeper than it already was. */
const SINK = 0.01;
/** Heel to toe of the frog's foot (m), the lever a turn of a planted foot swings the toe on. */
const TOE = 0.15;
/** How much higher than `contactHeight` a pinned foot must rise to let go (m). */
const RELEASE = 0.01;
/** Time constant of the pull home (s). */
const HOME_TIME = 0.5;
/** From `from` towards `to` like a spring of time constant HOME_TIME over dt, by at most `most`. */
const home = (from: number, to: number, dt: number, most: number) => {
  const step = Math.min(Math.abs(to - from) * (1 - Math.exp(-dt / HOME_TIME)), most);
  return from + Math.sign(to - from) * step;
};

class FootPlant implements OutputBlock {
  private readonly b: Binding;
  private readonly inner: OutputBlock;
  private readonly body: ConstraintsBlock;
  /** Spine and every contract bone above it: what the twist turns. */
  private readonly upper: BoneName[];
  private anchor: Record<Side, XZ | null> = { L: null, R: null };
  /** Root heading (unwrapped), root offset in the floor plane, and the upper body's turn on top of the root. */
  private yaw: number | null = null;
  private offset: XZ = { x: 0, z: 0 };
  private twist = 0;
  /** The leg IK's correction of each ankle in the floor plane (frog frame), faded out once the foot lifts. */
  private carry: Record<Side, XZ> = { L: { x: 0, z: 0 }, R: { x: 0, z: 0 } };
  /** How far each free foot is lifted for its swing (m), eased. */
  private raise: Record<Side, number> = { L: 0, R: 0 };
  /** Where each ankle was shown last frame (floor plane, world) and its height. */
  private lastFoot: Record<Side, (XZ & { h: number }) | null> = { L: null, R: null };

  constructor(scene: Scene, private s: Readonly<Settings>) {
    this.b = scene.rig;
    this.inner = plantedRotations.create(scene, {});
    this.body = scene.constraints;
    const above = (n: BoneName): boolean => n === "spine" || (!!this.b.rest.get(n)?.anc && above(this.b.rest.get(n)!.anc!));
    this.upper = [...this.b.rest.keys()].filter(above);
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  reset() {
    this.anchor = { L: null, R: null };
    this.yaw = null;
    this.twist = 0;
    this.carry = { L: { x: 0, z: 0 }, R: { x: 0, z: 0 } };
    this.lastFoot = { L: null, R: null };
    this.raise = { L: 0, R: 0 };
  }

  /** Move side s's ankle towards T (frog frame) by turning thigh and shin, the knee bending in its current plane: at
   *  most MAX_FIX (a nudge of the leg, not a new pose), and only as far as the leg stays out of the body (the
   *  constraints must be posed: setTorso). */
  private reach(frog: FrogPose, s: Side, target: THREE.Vector3) {
    const P = frog.joints, D = frog.rotations, l = this.b.leg[s];
    const H = P.get(`thigh_${s}`)!, K = P.get(`shin_${s}`)!, A = P.get(`foot_${s}`)!;
    const fix = A.distanceTo(target);
    if (fix < 1e-5) return;
    const T = fix > MAX_FIX ? A.clone().lerp(target, MAX_FIX / fix) : target;
    const l1 = K.distanceTo(H), l2 = A.distanceTo(K);
    const bent = K.clone().sub(H);
    const leg = (to: THREE.Vector3) => {
      const d = Math.min(Math.max(to.distanceTo(H), Math.abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4);
      const axis = to.clone().sub(H).normalize();
      const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
      const pole = bent.clone().addScaledVector(axis, -bent.dot(axis));
      if (pole.lengthSq() < 1e-10) pole.set(0, 0, 1).addScaledVector(axis, -axis.z);
      pole.normalize();
      return { K: H.clone().addScaledVector(axis, l1 * cosA).addScaledVector(pole, l1 * Math.sqrt(Math.max(0, 1 - cosA * cosA))), A: H.clone().addScaledVector(axis, d) };
    };
    // How deep the leg's sample points sink into the body (m, ≤ 0 clear).
    const sink = (k: THREE.Vector3, a: THREE.Vector3) => {
      let worst = -Infinity;
      const along = (from: THREE.Vector3, to: THREE.Vector3, list: LimbSample[]) => {
        const dir = to.clone().sub(from).normalize();
        for (const sm of list) {
          const c = this.body.check(sm, from.clone().addScaledVector(dir, sm.len));
          worst = Math.max(worst, c.needed - c.clearance);
        }
      };
      along(H, k, l.thighS);
      along(k, a, l.shinS);
      return worst;
    };
    const allowed = Math.max(SINK, sink(K, A) + 0.0005);
    let sol = leg(T);
    if (sink(sol.K, sol.A) > allowed) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2, x = leg(A.clone().lerp(T, mid));
        if (sink(x.K, x.A) > allowed) hi = mid;
        else lo = mid;
      }
      if (lo === 0) return;
      sol = leg(A.clone().lerp(T, lo));
    }
    const K2 = sol.K, A2 = sol.A;
    const swing = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
    D.get(`thigh_${s}`)!.premultiply(swing(K.clone().sub(H), K2.clone().sub(H)));
    D.get(`shin_${s}`)!.premultiply(swing(A.clone().sub(K), A2.clone().sub(K2)));
    K.copy(K2);
    A.copy(A2);
  }

  pose(frog: FrogPose, dt: number): PoseFrame {
    const contact = this.s.contactHeight as number, limit = this.s.twistLimit as number;
    const homing = (this.s.homing as number) * dt;
    const feet = { L: frog.joints.get("foot_L")!, R: frog.joints.get("foot_R")! };
    const lowest = Math.min(feet.L.y, feet.R.y);
    // Height above the floor: the output puts the lower foot on it, raised by the hop. A foot skimming the floor in a
    // small hop still stands (seen from outside it is down, and moving it would read as a slide).
    const height = (s: Side) => feet[s].y - lowest + Math.max(0, frog.lift);
    // Hysteresis: a pinned foot lets go only 1 cm higher than a foot touches down, so a foot hovering at the
    // threshold does not flicker between pinned and free (each release lets it move).
    const stance = SIDES.filter((s) => height(s) < contact + (this.anchor[s] ? RELEASE : 0));
    const goalOffset = { x: frog.shift, z: 0 };

    if (this.yaw === null) (this.yaw = frog.yaw), (this.offset = goalOffset), (this.twist = 0);
    const planted = stance.filter((s) => this.anchor[s]);
    // A standing foot turns with the root (its own rotation is only the toe's pitch), so while any foot stands the
    // heading holds: the goal's turn goes into the upper body. In the air the twist eases back into the heading.
    const free = frog.yaw - this.twist * Math.exp(-dt / Math.max(1e-3, this.s.blend as number));
    let yaw = stance.length ? this.yaw : free;
    // Homing: the heading drifts towards the goal's, the feet no faster than `homing` m/s. A turn of the root swings
    // a planted toe round its heel and the far foot round the near one: the longer lever sets the rate. The goal's
    // turn beyond the heading twists the upper body, within the limit.
    const lever = Math.max(TOE, Math.hypot(feet.R.x - feet.L.x, feet.R.z - feet.L.z));
    yaw = home(yaw, frog.yaw, dt, homing / lever);
    this.twist = Math.max(-limit, Math.min(limit, frog.yaw - yaw));
    this.yaw = frog.yaw - this.twist;

    // The root offset that best keeps the planted feet on their anchors: exact for one; for two (whose legs may move
    // them apart) weighted least squares, the foot flat on the floor holding and one about to lift giving way.
    if (planted.length) {
      let x = 0, z = 0, sum = 0;
      for (const s of planted) {
        const p = turn(feet[s], this.yaw);
        const w = Math.max(1e-3, contact + RELEASE - height(s)) ** 2;
        x += w * (this.anchor[s]!.x - p.x);
        z += w * (this.anchor[s]!.z - p.z);
        sum += w;
      }
      this.offset = { x: x / sum, z: z / sum };
    }
    const away = Math.hypot(goalOffset.x - this.offset.x, goalOffset.z - this.offset.z);
    if (away > 1e-9) {
      // In the air (no foot down) the frog moves home freely: landing there costs no slide.
      const k = home(0, away, dt, stance.length ? homing : Infinity) / away;
      this.offset = { x: this.offset.x + (goalOffset.x - this.offset.x) * k, z: this.offset.z + (goalOffset.z - this.offset.z) * k };
    }

    // The upper body takes the twist (before the legs are touched: the leg IK keeps them out of the body as posed).
    if (Math.abs(this.twist) > 1e-6) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, this.twist);
      const pivot = frog.joints.get("spine")!.clone();
      for (const n of this.upper) {
        frog.rotations.get(n)!.premultiply(q);
        if (n !== "spine") frog.joints.get(n)!.sub(pivot).applyQuaternion(q).add(pivot);
      }
    }
    this.body.setTorso(frog);

    // What the root cannot do (two feet the legs move apart, the slow pull home) the legs do: each planted ankle is
    // brought back over its anchor by two-bone IK, its height kept. A foot that lifts lets its correction fade
    // (LIFT_EASE) rather than snap: a jump of the target there makes the simulated foot drag along the floor.
    for (const s of SIDES) {
      if (planted.includes(s)) {
        const local = turn({ x: this.anchor[s]!.x - this.offset.x, z: this.anchor[s]!.z - this.offset.z }, -this.yaw);
        this.carry[s] = { x: local.x - feet[s].x, z: local.z - feet[s].z };
      } else {
        const k = Math.exp(-dt / LIFT_EASE);
        this.carry[s] = { x: this.carry[s].x * k, z: this.carry[s].z * k };
        // Near the floor (now or last frame) a foot may not sweep faster than LOW_SPEED (a recording's one-frame leg
        // jumps, a foot arriving sideways): a simulated foot touching down that fast drags along the floor.
        const was = this.lastFoot[s];
        let swing = 0;
        if (was) {
          const w = turn({ x: feet[s].x + this.carry[s].x, z: feet[s].z + this.carry[s].z }, this.yaw);
          const dx = w.x + this.offset.x - was.x, dz = w.z + this.offset.z - was.z, step = Math.hypot(dx, dz), most = LOW_SPEED * dt;
          // A foot sweeping fast is lifted clear of the floor (the toe hangs 4 cm below the ankle): a recorded shuffle
          // would otherwise drag the simulated toe along it.
          const k = Math.min(1, Math.max(0, (step / dt - 0.2) / 0.6));
          swing = k * k * (3 - 2 * k) * Math.max(0, SWING_CLEAR - height(s));
          if (step > most && Math.min(height(s), was.h) < LOW) {
            const local = turn({ x: was.x + (dx * most) / step - this.offset.x, z: was.z + (dz * most) / step - this.offset.z }, -this.yaw);
            this.carry[s] = { x: local.x - feet[s].x, z: local.z - feet[s].z };
          }
        }
        this.raise[s] += (swing - this.raise[s]) * (1 - Math.exp(-dt / RAISE_EASE));
      }
      if (planted.includes(s)) this.raise[s] = 0;
      if (Math.hypot(this.carry[s].x, this.carry[s].z) > 1e-5 || this.raise[s] > 1e-5) {
        this.reach(frog, s, new THREE.Vector3(feet[s].x + this.carry[s].x, feet[s].y + this.raise[s], feet[s].z + this.carry[s].z));
      }
      const p = turn(feet[s], this.yaw);
      this.lastFoot[s] = { x: p.x + this.offset.x, z: p.z + this.offset.z, h: height(s) };
    }

    // Feet that stand keep (or take) the spot they are at now; lifted feet let go.
    for (const s of SIDES) {
      const p = turn(feet[s], this.yaw);
      this.anchor[s] = stance.includes(s) ? { x: p.x + this.offset.x, z: p.z + this.offset.z } : null;
    }

    frog.yaw = this.yaw;
    frog.shift = this.offset.x;
    const frame = this.inner.pose(frog, dt);
    frame.rootOffset!.z = this.offset.z;
    return frame;
  }
}

export const footPlant: BlockDefinition<"output"> = {
  id: "foot-plant",
  slot: "output",
  name: { zh: "脚踩实（接触清理）", en: "Foot planting (contact clean-up)" },
  summary: {
    zh: "踩在地上的脚钉在落地的位置：单脚着地时绕这只脚转身，双脚着地时朝向由两脚连线决定，多出来的转动交给上半身扭转；抬脚时扭转渐渐还给整体，并以有限速度回到目标位置。",
    en: "A foot on the floor stays where it touched down: on one foot the frog turns about it, on two the line between them fixes the heading and the rest of the turn twists the upper body; the twist eases back when a foot lifts, and the frog homes to the goal at a bounded speed.",
  },
  parameters: [
    {
      key: "contactHeight", kind: "number", default: 0.015, min: 0.002, max: 0.06, step: 0.001, unit: "m",
      label: { zh: "着地高度", en: "Contact height" },
      help: { zh: "比较低的那只脚高出不到这么多就算踩在地上", en: "A foot less than this above the lower one stands on the floor" },
    },
    {
      key: "twistLimit", kind: "number", default: 0.8, min: 0, max: 1.6, step: 0.05, unit: "rad",
      label: { zh: "上半身最大扭转", en: "Upper-body twist limit" },
      help: { zh: "双脚踩实时上半身相对下半身最多转多少；超出的部分只能让脚滑", en: "How far the upper body may turn against the planted legs; beyond it the feet slide" },
    },
    {
      key: "blend", kind: "number", default: 0.25, min: 0.02, max: 1, step: 0.01, unit: "s",
      label: { zh: "扭转回正时间", en: "Twist release time" },
      help: { zh: "双脚离地时，上半身的扭转交还给整体朝向的时间常数", en: "Time constant for the twist to pass back to the heading while both feet are off the floor" },
    },
    {
      key: "homing", kind: "number", default: 0.03, min: 0, max: 0.5, step: 0.01, unit: "m/s",
      label: { zh: "最大回位速度", en: "Homing speed limit" },
      help: { zh: "脚踩实时整体像弹簧一样被拉回目标朝向和侧步位置（时间常数 0.5 s），最快这么快：也是允许的最大脚滑", en: "The frog is pulled back to the goal heading and side step like a spring (0.5 s) while planted, at most this fast: the slide it allows" },
    },
  ],
  create: (scene, settings) => new FootPlant(scene, settings),
};
