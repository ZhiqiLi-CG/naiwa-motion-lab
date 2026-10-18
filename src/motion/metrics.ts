/**
 * Retargeting quality, measured on every shown frame and averaged over the last two seconds (RetargetMetrics):
 * fidelity (angle between the goal's limb directions and the frog's), smoothness (jerk of the end joints, from third
 * finite differences over uneven frame times), limbs inside the body (the constraints' own clearance check on the
 * limb sample points) and foot sliding (horizontal speed of a foot that stands on the floor in two frames running).
 */
import * as THREE from "three";
import type { BoneName, PoseFrame } from "../contracts";
import type { ConstraintsBlock, FrogPose, Goal, LimbSample, RetargetMetrics } from "./api";
import { SIDES } from "./pose";
import type { Binding } from "./rig";

const WINDOW = 2;
const TRACKED: BoneName[] = ["forearm_L", "forearm_R", "hand_L", "hand_R", "shin_L", "shin_R", "foot_L", "foot_R", "head"];
/** A foot this close to the floor (m) stands on it. */
const ON_FLOOR = 0.01;

interface Sample {
  dt: number;
  fidelity: number;
  penetration: number;
  /** null until three earlier frames are known. */
  jerk: number | null;
  /** null when no foot stood on the floor in this and the previous frame. */
  slide: number | null;
}

const dir = (P: ReadonlyMap<BoneName, THREE.Vector3>, a: BoneName, b: BoneName) => P.get(b)!.clone().sub(P.get(a)!).normalize();

/** How far the limbs sink into the body beyond what they may (m, 0 = clear); the constraints are set to this pose. */
export function limbPenetration(b: Binding, body: ConstraintsBlock, frog: FrogPose): number {
  body.setTorso(frog);
  const P = frog.joints;
  let worst = 0;
  const check = (from: BoneName, d: THREE.Vector3, list: LimbSample[]) => {
    for (const sm of list) {
      const c = body.check(sm, P.get(from)!.clone().addScaledVector(d, sm.len));
      worst = Math.max(worst, c.needed - c.clearance);
    }
  };
  for (const s of SIDES) {
    const a = b.arm[s], l = b.leg[s];
    check(`upperarm_${s}`, dir(P, `upperarm_${s}`, `forearm_${s}`), a.upperS);
    check(`forearm_${s}`, dir(P, `forearm_${s}`, `hand_${s}`), a.foreS);
    check(`hand_${s}`, a.finger.clone().applyQuaternion(frog.rotations.get(`hand_${s}`)!), a.handS);
    check(`thigh_${s}`, dir(P, `thigh_${s}`, `shin_${s}`), l.thighS);
    check(`shin_${s}`, dir(P, `shin_${s}`, `foot_${s}`), l.shinS);
  }
  return worst;
}

/** Mean angle (degrees) between the goal's limb directions and the solved ones. */
function fidelity(goal: Goal, frog: FrogPose): number {
  const P = frog.joints;
  const chest = frog.rotations.get("chest")!;
  let sum = 0;
  for (const s of SIDES) {
    const g = goal.arm[s], l = goal.leg[s];
    sum += g.upper.clone().applyQuaternion(chest).angleTo(dir(P, `upperarm_${s}`, `forearm_${s}`));
    sum += g.fore.clone().applyQuaternion(chest).angleTo(dir(P, `forearm_${s}`, `hand_${s}`));
    sum += l.thigh.clone().normalize().angleTo(dir(P, `thigh_${s}`, `shin_${s}`));
    sum += l.shin.clone().normalize().angleTo(dir(P, `shin_${s}`, `foot_${s}`));
  }
  return THREE.MathUtils.radToDeg(sum / 8);
}

export class MetricsWindow {
  private samples: Sample[] = [];
  /** World positions of the tracked joints in the last frames (newest last) and their frame times. */
  private history: { at: THREE.Vector3[]; dt: number }[] = [];

  constructor(private readonly b: Binding) {}

  reset(): void {
    this.samples = [];
    this.history = [];
  }

  add(goal: Goal, frog: FrogPose, frame: PoseFrame, dt: number, body: ConstraintsBlock): void {
    // Paused or single-stepped twice on the same instant: nothing moved, nothing to learn about smoothness.
    if (dt <= 1e-4) return;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), frame.rootYaw ?? 0);
    const offset = frame.rootOffset ?? new THREE.Vector3();
    const at = TRACKED.map((n) => frog.joints.get(n)!.clone().applyQuaternion(yaw).add(offset));
    this.history.push({ at, dt });
    if (this.history.length > 4) this.history.shift();

    let jerk: number | null = null;
    if (this.history.length === 4) {
      const [h0, h1, h2, h3] = this.history;
      let sum = 0;
      for (let i = 0; i < TRACKED.length; i++) {
        const v1 = h1.at[i].clone().sub(h0.at[i]).divideScalar(h1.dt);
        const v2 = h2.at[i].clone().sub(h1.at[i]).divideScalar(h2.dt);
        const v3 = h3.at[i].clone().sub(h2.at[i]).divideScalar(h3.dt);
        const a2 = v2.clone().sub(v1).divideScalar((h1.dt + h2.dt) / 2);
        const a3 = v3.clone().sub(v2).divideScalar((h2.dt + h3.dt) / 2);
        sum += a3.sub(a2).length() / ((h1.dt + 2 * h2.dt + h3.dt) / 4);
      }
      jerk = sum / TRACKED.length;
    }

    let slide: number | null = null;
    if (this.history.length >= 2) {
      const prev = this.history[this.history.length - 2].at;
      const speeds: number[] = [];
      for (const i of [TRACKED.indexOf("foot_L"), TRACKED.indexOf("foot_R")]) {
        if (at[i].y > this.b.restFootY + ON_FLOOR || prev[i].y > this.b.restFootY + ON_FLOOR) continue;
        speeds.push(Math.hypot(at[i].x - prev[i].x, at[i].z - prev[i].z) / dt);
      }
      if (speeds.length) slide = speeds.reduce((a, c) => a + c, 0) / speeds.length;
    }

    this.samples.push({ dt, fidelity: fidelity(goal, frog), penetration: Math.max(0, limbPenetration(this.b, body, frog)), jerk, slide });
    let span = this.samples.reduce((a, s) => a + s.dt, 0);
    while (span > WINDOW && this.samples.length > 1) span -= this.samples.shift()!.dt;
  }

  read(): RetargetMetrics | null {
    if (!this.samples.length) return null;
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
    return {
      fidelity: mean(this.samples.map((s) => s.fidelity)),
      jerk: mean(this.samples.flatMap((s) => (s.jerk === null ? [] : [s.jerk]))),
      penetration: Math.max(...this.samples.map((s) => s.penetration)),
      footSlide: mean(this.samples.flatMap((s) => (s.slide === null ? [] : [s.slide]))),
    };
  }
}
