/**
 * The idle stance the frog takes when no motion drives it: standing at rest, breathing, a slow slight sway, the
 * head turned a little towards what it looks at, and a small lean back when startled.
 */
import * as THREE from "three";
import type { BoneName } from "../contracts";
import type { LifeOutput } from "./life";
import { forwardKinematics, worldDeltaToLocal, type RestSkeleton } from "./rig";

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _head = new THREE.Vector3();

/** Rotation about world axes: x leans forward, y turns to its left, z rolls. */
function euler(x: number, y: number, z: number, out: THREE.Quaternion): THREE.Quaternion {
  out.setFromAxisAngle(Y, y);
  if (x) out.multiply(_q2.setFromAxisAngle(X, x));
  if (z) out.multiply(_q2.setFromAxisAngle(Z, z));
  return out;
}

export class Stance {
  private local = new Map<BoneName, THREE.Quaternion>();

  constructor(private skel: RestSkeleton) {
    for (const b of skel.list) this.local.set(b.name, b.localQuat.clone());
  }

  /** World matrices of the idle stance at time t; look: where the head turns (world). */
  compute(t: number, life: LifeOutput, look: THREE.Vector3, out: Map<BoneName, THREE.Matrix4>): void {
    const s = this.skel, L = this.local;
    for (const b of s.list) L.get(b.name)!.copy(b.localQuat);
    const set = (name: BoneName, x: number, y: number, z: number) => {
      const b = s.byName.get(name);
      if (b) worldDeltaToLocal(b, euler(x, y, z, _q), L.get(name)!);
    };
    const tau = 2 * Math.PI;
    const br = life.breath;
    // It is mostly body: the head turns only part of the way, and not far.
    _head.setFromMatrixPosition(s.byName.get("head")!.restWorld);
    _v.copy(look).sub(_head);
    const yaw = THREE.MathUtils.clamp(Math.atan2(_v.x, _v.z), -1.2, 1.2) * 0.3;
    const pitch = THREE.MathUtils.clamp(-Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -0.6, 0.6) * 0.25;
    const sway = Math.sin(t * tau * 0.21);

    set("hips", 0, 0.02 * Math.sin(t * tau * 0.11), 0.012 * sway);
    set("spine", 0.01 * br - 0.03 * life.startle, 0, -0.008 * sway);
    set("chest", -0.014 * br - 0.04 * life.startle, 0, 0);
    set("head", pitch + 0.02 * life.startle, yaw, 0.015 * Math.sin(t * tau * 0.17));
    for (const side of ["L", "R"] as const) {
      const sg = side === "L" ? 1 : -1;
      // Arms rise and fall a touch with each breath.
      set(`upperarm_${side}`, -0.03 * Math.sin(t * tau * 0.21 + sg), 0, sg * (0.02 * br + 0.08 * life.startle));
    }
    forwardKinematics(s, (n) => L.get(n), undefined, 0, out);
  }
}
