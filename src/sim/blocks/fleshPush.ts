/**
 * Interaction block: the user's hands on the flesh. A push changes the free flesh's velocity around a point with a
 * smooth falloff (no single-particle spikes); a pinch attaches the nearest free particles to a kinematic body that
 * follows the pointer, speed-limited so nothing is pulled through the floor or torn apart within one step.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { BlockDefinition, FleshGrab, InteractionBlock, ParticleView, Scene, SimPart } from "../api";

/** m/s: the fastest a pinch drags the flesh. */
const MAX_PINCH_SPEED = 12;

interface Pinch {
  hand: RAPIER.RigidBody;
  view: ParticleView;
  particles: number[];
  target: THREE.Vector3;
}

class FleshPush implements InteractionBlock {
  private pinches = new Set<Pinch>();

  constructor(private scene: Scene) {}

  push(part: SimPart, point: THREE.Vector3, dv: THREE.Vector3, radius: number) {
    const view = this.scene.flesh.particles(part);
    const P = view.positions();
    for (let i = 0; i < view.count; i++) {
      if (view.attachedTo(i)) continue;
      const d = Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) / radius;
      if (d >= 1) continue;
      const m = view.mass(i) * (1 - d * d) ** 2;
      view.applyImpulse(i, dv.x * m, dv.y * m, dv.z * m);
    }
  }

  grab(part: SimPart, point: THREE.Vector3): FleshGrab {
    const view = this.scene.flesh.particles(part);
    const particles = nearestFree(view, point, part.limb ? 0.05 : 0.08);
    const hand = this.scene.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(point.x, point.y, point.z),
    );
    for (const i of particles) view.attach(i, hand);
    const pinch: Pinch = { hand, view, particles, target: point.clone() };
    this.pinches.add(pinch);
    return {
      move: (target) => pinch.target.copy(target),
      release: () => this.release(pinch),
    };
  }

  private release(pinch: Pinch) {
    if (!this.pinches.delete(pinch)) return;
    for (const i of pinch.particles) pinch.view.detach(i);
    this.scene.world.removeRigidBody(pinch.hand);
  }

  beforeStep(scene: Scene) {
    for (const { hand, target } of this.pinches) {
      const t = hand.translation();
      const step = target.clone().sub(t);
      step.clampLength(0, MAX_PINCH_SPEED * scene.dt);
      hand.setNextKinematicTranslation({ x: t.x + step.x, y: t.y + step.y, z: t.z + step.z });
    }
  }

  reset() {
    for (const p of [...this.pinches]) this.release(p);
  }

  dispose() {
    this.pinches.clear();
  }
}

/** Free particles nearest to a point: at least three, all within radius, at most eight. */
function nearestFree(view: ParticleView, point: THREE.Vector3, radius: number): number[] {
  const P = view.positions();
  const near: { i: number; d: number }[] = [];
  for (let i = 0; i < view.count; i++) {
    if (!view.attachedTo(i)) near.push({ i, d: Math.hypot(P[i * 3] - point.x, P[i * 3 + 1] - point.y, P[i * 3 + 2] - point.z) });
  }
  return near.sort((a, b) => a.d - b.d).filter((n, k) => k < 3 || n.d < radius).slice(0, 8).map((n) => n.i);
}

export const fleshPush: BlockDefinition<"interaction"> = {
  id: "flesh-push",
  slot: "interaction",
  name: { zh: "戳与捏", en: "Push and pinch" },
  summary: {
    zh: "戳：在一点周围平滑地改变自由肉的速度；捏：最近的几个自由粒子挂到跟随指针的运动学刚体上。",
    en: "Push: change the free flesh's velocity around a point with a smooth falloff. Pinch: the nearest free particles ride on a kinematic body that follows the pointer.",
  },
  device: "cpu",
  parameters: [],
  create: (scene) => new FleshPush(scene),
};
