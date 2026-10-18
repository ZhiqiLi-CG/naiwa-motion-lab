/**
 * Output block: foot planting (foot-contact clean-up). The built-in output copies the goal's heading and side step
 * onto the root, so a dancer who twists in place (狗熊哆嗦毛: ±0.7 rad) swivels the frog's planted feet across the
 * floor. Here a foot standing on the floor is pinned where it touched down, and the root is placed to keep it there:
 *
 *   one stance foot   the heading holds while the other foot shuffles, and turns about the standing foot as the
 *                     other really lifts (by `releaseHeight`); offset = anchor − R·foot
 *   two stance feet   the heading is fixed by the line between the two anchors; what the goal turns beyond it goes
 *                     into the upper body as a twist (up to `twistLimit`), the root shifts to fit both feet
 *   none (a hop)      the root follows the goal
 *
 * The twist eases back to the root (time constant `blend`) when a foot lifts. Pivoting on alternate feet walks (a
 * swivel step: 狗熊哆嗦毛 would wander off at 8 cm/s), so the root is pulled home towards the goal's heading and side step
 * like a spring (HOME_TIME), no faster than `homing` m/s at the feet while one stands (the one slide this block
 * allows), freely during a hop. The twist is applied to the FrogPose in place
 * (spine and everything above it turned about the spine joint), so the metrics measure what is shown.
 */
import * as THREE from "three";
import type { BoneName, PoseFrame } from "../../contracts";
import type { BlockDefinition, FrogPose, OutputBlock, Scene, Settings, Side } from "../../motion/api";
import { plantedRotations } from "../../motion/blocks/plantedRotations";
import { SIDES } from "../../motion/pose";
import type { Binding } from "../../motion/rig";

type XZ = { x: number; z: number };
const UP = new THREE.Vector3(0, 1, 0);
/** Display frame time used until the core passes dt to output blocks. */

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Heading of a horizontal vector, so that a turn by ψ about +Y adds ψ (three.js: x' = x cos ψ + z sin ψ). */
const heading = (v: XZ) => Math.atan2(v.x, v.z);
const turn = (p: XZ, yaw: number): XZ => ({ x: p.x * Math.cos(yaw) + p.z * Math.sin(yaw), z: -p.x * Math.sin(yaw) + p.z * Math.cos(yaw) });
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
  /** Spine and every contract bone above it: what the twist turns. */
  private readonly upper: BoneName[];
  private anchor: Record<Side, XZ | null> = { L: null, R: null };
  /** Root heading (unwrapped), root offset in the floor plane, and the upper body's turn on top of the root. */
  private yaw: number | null = null;
  private offset: XZ = { x: 0, z: 0 };
  private twist = 0;

  constructor(scene: Scene, private s: Readonly<Settings>) {
    this.b = scene.rig;
    this.inner = plantedRotations.create(scene, {});
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
  }

  pose(frog: FrogPose, dt: number): PoseFrame {
    const contact = this.s.contactHeight as number, limit = this.s.twistLimit as number;
    const homing = (this.s.homing as number) * dt;
    const feet = { L: frog.joints.get("foot_L")!, R: frog.joints.get("foot_R")! };
    const lowest = Math.min(feet.L.y, feet.R.y);
    const stance = SIDES.filter((s) => frog.lift < 0.005 && feet[s].y - lowest < contact);
    const goalOffset = { x: frog.shift, z: 0 };

    if (this.yaw === null) (this.yaw = frog.yaw), (this.offset = goalOffset), (this.twist = 0);
    const planted = stance.filter((s) => this.anchor[s]);
    let yaw: number;
    if (planted.length === 2) {
      // The anchors' line fixes the heading.
      const [A, B] = [this.anchor.L!, this.anchor.R!];
      yaw = heading({ x: B.x - A.x, z: B.z - A.z }) - heading({ x: feet.R.x - feet.L.x, z: feet.R.z - feet.L.z });
      yaw = this.yaw + wrap(yaw - this.yaw);
    } else {
      // One foot down: the heading holds while the other foot only shuffles, and turns about the standing foot (the
      // twist easing back) as it really lifts; none down (a hop): it turns freely.
      const swing = stance.length === 1 ? feet[stance[0] === "L" ? "R" : "L"].y - lowest : Infinity;
      const k = Math.min(1, Math.max(0, (swing - contact) / Math.max(1e-3, (this.s.releaseHeight as number) - contact)));
      const free = frog.yaw - this.twist * Math.exp(-dt / Math.max(1e-3, this.s.blend as number));
      yaw = this.yaw + (free - this.yaw) * k * k * (3 - 2 * k);
    }
    // Homing: the heading drifts towards the goal's, the feet no faster than `homing` m/s; the goal's turn beyond
    // the heading twists the upper body, within the limit.
    const halfStance = Math.max(0.05, Math.hypot(feet.R.x - feet.L.x, feet.R.z - feet.L.z) / 2);
    yaw = home(yaw, frog.yaw, dt, homing / halfStance);
    this.twist = Math.max(-limit, Math.min(limit, frog.yaw - yaw));
    this.yaw = frog.yaw - this.twist;

    // The root offset that best keeps the planted feet on their anchors (exact for one, least squares for two).
    if (planted.length) {
      let x = 0, z = 0;
      for (const s of planted) {
        const p = turn(feet[s], this.yaw);
        x += this.anchor[s]!.x - p.x;
        z += this.anchor[s]!.z - p.z;
      }
      this.offset = { x: x / planted.length, z: z / planted.length };
    }
    const away = Math.hypot(goalOffset.x - this.offset.x, goalOffset.z - this.offset.z);
    if (away > 1e-9) {
      // In the air (no foot down) the frog moves home freely: landing there costs no slide.
      const k = home(0, away, dt, stance.length ? homing : Infinity) / away;
      this.offset = { x: this.offset.x + (goalOffset.x - this.offset.x) * k, z: this.offset.z + (goalOffset.z - this.offset.z) * k };
    }

    // Feet that stand keep (or take) the spot they are at now; lifted feet let go.
    for (const s of SIDES) {
      const p = turn(feet[s], this.yaw);
      this.anchor[s] = stance.includes(s) ? { x: p.x + this.offset.x, z: p.z + this.offset.z } : null;
    }

    if (Math.abs(this.twist) > 1e-6) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, this.twist);
      const pivot = frog.joints.get("spine")!.clone();
      for (const n of this.upper) {
        frog.rotations.get(n)!.premultiply(q);
        if (n !== "spine") frog.joints.get(n)!.sub(pivot).applyQuaternion(q).add(pivot);
      }
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
      key: "releaseHeight", kind: "number", default: 0.05, min: 0.01, max: 0.2, step: 0.005, unit: "m",
      label: { zh: "抬脚转身高度", en: "Step height" },
      help: { zh: "单脚着地时，另一只脚抬到这么高才让整体绕站立脚转身；更低只算蹭地，朝向不动", en: "On one foot, the other must rise this high before the frog turns about the standing foot; lower it only shuffles and the heading holds" },
    },
    {
      key: "blend", kind: "number", default: 0.25, min: 0.02, max: 1, step: 0.01, unit: "s",
      label: { zh: "扭转回正时间", en: "Twist release time" },
      help: { zh: "抬起一只脚后，上半身的扭转交还给整体朝向的时间常数", en: "Time constant for the twist to pass back to the heading once a foot lifts" },
    },
    {
      key: "homing", kind: "number", default: 0.05, min: 0, max: 0.5, step: 0.01, unit: "m/s",
      label: { zh: "最大回位速度", en: "Homing speed limit" },
      help: { zh: "脚踩实时整体像弹簧一样被拉回目标朝向和侧步位置（时间常数 0.5 s），最快这么快：也是允许的最大脚滑", en: "The frog is pulled back to the goal heading and side step like a spring (0.5 s) while planted, at most this fast: the slide it allows" },
    },
  ],
  create: (scene, settings) => new FootPlant(scene, settings),
};
