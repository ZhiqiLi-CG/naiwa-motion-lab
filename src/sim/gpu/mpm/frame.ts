/**
 * The page's side of a frame: the rigid bodies particles ride on (their poses at the frame's start and end), the
 * contact shapes the flesh meets (limbs' flesh capsules, balls), the particle edits the blocks asked for since the
 * last step, and the uniforms per substep; then, when a frame's results come back, the impulses the flesh gave the
 * bones and balls.
 */
import type RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { Scene, SimBall, SimBone, SimPart } from "../../api";
import type { FrameInput } from "./backend";
import { B, E, EDIT, K, KIND_CAPSULE, KIND_SPHERE, MAX_BODIES, MAX_COLLIDERS, S, type FrameOutput } from "./layout";

interface Slot {
  body: RAPIER.RigidBody;
  /** Attached particles riding it. */
  count: number;
  /** Its pose at the end of the last frame. */
  end: Float32Array | null;
  /** Frames left before a released slot may be reused (results still in flight name it). */
  cooling: number;
}

interface Edit {
  flags: number;
  pos: [number, number, number];
  vel: [number, number, number];
  body: number;
}

/** What a contact shape's impulse goes to. */
type Target = { bone: SimBone } | { ball: SimBall };

/** Results can arrive a few frames late (the GPU's staging ring): slots stay reserved that long after release. */
const COOLING = 6;
const pose = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), ONE = new THREE.Vector3(1, 1, 1);

export class FrameBuilder {
  private slots: (Slot | null)[] = new Array(MAX_BODIES).fill(null);
  private slotOf = new Map<number, number>();
  private edits = new Map<number, Edit>();
  private dv = new THREE.Vector3();
  private targets: Target[] = [];
  private ballContact = new Set<SimBall>();

  constructor(private parts: readonly SimPart[]) {}

  /* Edits (coalesced per particle, applied in the order detach, position, velocity, attach) --------------------- */

  private edit(i: number): Edit {
    let e = this.edits.get(i);
    if (!e) this.edits.set(i, (e = { flags: 0, pos: [0, 0, 0], vel: [0, 0, 0], body: 0 }));
    return e;
  }
  setPosition(i: number, x: number, y: number, z: number) {
    const e = this.edit(i);
    e.flags |= EDIT.SET_POS;
    e.pos = [x, y, z];
  }
  setVelocity(i: number, x: number, y: number, z: number) {
    const e = this.edit(i);
    e.flags = (e.flags | EDIT.SET_VEL) & ~EDIT.ADD_VEL;
    e.vel = [x, y, z];
  }
  addVelocity(i: number, x: number, y: number, z: number) {
    const e = this.edit(i);
    if (!(e.flags & EDIT.SET_VEL)) e.flags |= EDIT.ADD_VEL;
    e.vel = [e.vel[0] + x, e.vel[1] + y, e.vel[2] + z];
  }
  attach(i: number, body: RAPIER.RigidBody, splats: boolean) {
    const e = this.edit(i);
    e.flags |= EDIT.ATTACH;
    e.body = this.slotFor(body) | (splats ? 1 << 16 : 0);
    this.slots[e.body & 0xffff]!.count++;
  }
  /** `wasAttached`: the particle rode a body at the start of this frame (else a pending attach is just dropped). */
  detach(i: number, body: RAPIER.RigidBody, wasAttached: boolean) {
    const e = this.edit(i);
    if (e.flags & EDIT.ATTACH) e.flags &= ~EDIT.ATTACH;
    if (wasAttached) e.flags |= EDIT.DETACH;
    const s = this.slotOf.get(body.handle);
    if (s !== undefined) this.release(s);
  }
  /** Particles with an attach pending this frame. */
  pendingAttaches(): number[] {
    return [...this.edits].filter(([, e]) => e.flags & EDIT.ATTACH).map(([i]) => i);
  }
  setSplat(i: number, splats: boolean) {
    const e = this.edits.get(i);
    if (e) e.body = (e.body & 0xffff) | (splats ? 1 << 16 : 0);
  }
  throwAll(dv: THREE.Vector3) {
    this.dv.add(dv);
  }

  private slotFor(body: RAPIER.RigidBody): number {
    const s = this.slotOf.get(body.handle);
    if (s !== undefined) return s;
    const free = this.slots.findIndex((x) => x === null);
    if (free < 0) throw new Error(`sim/gpu: particles ride on more than ${MAX_BODIES} bodies`);
    this.slots[free] = { body, count: 0, end: null, cooling: 0 };
    this.slotOf.set(body.handle, free);
    return free;
  }

  private release(s: number) {
    const slot = this.slots[s]!;
    if (--slot.count > 0) return;
    // The body may be removed from the world right after (a pinch's hand): forget it now, keep the slot reserved.
    this.slotOf.delete(slot.body.handle);
    slot.cooling = COOLING;
  }

  /* The frame ------------------------------------------------------------------------------------------------ */

  build(scene: Scene, substeps: number, grids: ArrayBuffer, regions: Float32Array, nodes: number, particles: number): FrameInput {
    const bodies = new Float32Array(MAX_BODIES * B.STRIDE);
    this.slots.forEach((slot, k) => {
      if (!slot) return;
      if (slot.cooling > 0) {
        // Keep its last pose (edits this frame may still detach from it), then free the slot.
        if (slot.end) {
          bodies.set(slot.end, k * B.STRIDE + B.M0);
          bodies.set(slot.end, k * B.STRIDE + B.M1);
        }
        if (--slot.cooling === 0) this.slots[k] = null;
        return;
      }
      // The frame covers the step the bones just took: from where they were to where they are.
      const end = bodyPoses(slot.body, 0)[1];
      bodies.set(slot.end ?? end, k * B.STRIDE + B.M0);
      bodies.set(end, k * B.STRIDE + B.M1);
      slot.end = end;
    });
    const colliders = this.colliders(scene);
    const steps = new Float32Array(substeps * S.WORDS), stepsI = new Int32Array(steps.buffer);
    const g = scene.world.gravity, frameDt = scene.dt;
    for (let s = 0; s < substeps; s++) {
      const o = s * S.WORDS;
      steps.set([frameDt / substeps, s / substeps, (s + 1) / substeps, frameDt, g.x, g.y, g.z, scene.floorFriction], o);
      stepsI.set([particles, nodes, this.targets.length, this.parts.length], o + S.COUNTS);
      steps.set(regions, o + S.REGION);
    }
    steps.set([this.dv.x, this.dv.y, this.dv.z, this.edits.size], S.DV);
    this.dv.set(0, 0, 0);
    const editWords = new ArrayBuffer(this.edits.size * E.STRIDE * 4), ef = new Float32Array(editWords), ei = new Int32Array(editWords);
    let k = 0;
    for (const [i, e] of this.edits) {
      const o = k++ * E.STRIDE;
      ei.set([i, e.flags, e.body], o);
      ef.set(e.pos, o + E.POS);
      ef.set(e.vel, o + E.VEL);
    }
    const edits = this.edits.size;
    this.edits.clear();
    return { substeps, steps, grids, bodies, colliders, editWords, edits };
  }

  /** The contact shapes: each limb bone's flesh capsule meets the other parts' flesh, balls meet all of it. */
  private colliders(scene: Scene): Float32Array {
    const out = new Float32Array(MAX_COLLIDERS * K.STRIDE);
    this.targets = [];
    /** A shape with ends a, b at the start of the step and a1, b1 now. */
    const add = (a: THREE.Vector3, b: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, radius: number, kind: number, mask: number, friction: number, target: Target) => {
      if (this.targets.length >= MAX_COLLIDERS || !mask) return;
      out.set([a.x, a.y, a.z, radius, b.x, b.y, b.z, kind, a1.x, a1.y, a1.z, mask, b1.x, b1.y, b1.z, friction], this.targets.length * K.STRIDE);
      this.targets.push(target);
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), a1 = new THREE.Vector3(), b1 = new THREE.Vector3();
    const m0 = new THREE.Matrix4(), m1 = new THREE.Matrix4();
    for (const bone of scene.skeleton.bones.values()) {
      const [start, end] = bodyPoses(bone.body, scene.dt);
      m0.fromArray(start);
      m1.fromArray(end);
      bone.shapes.forEach((shape) => {
        if (shape.kind !== "capsule" || shape.role !== "contact") return;
        let mask = 0;
        this.parts.forEach((p, g) => (mask |= p.bones.includes(bone) ? 0 : 1 << g));
        add(a.copy(shape.a).applyMatrix4(m0), b.copy(shape.b).applyMatrix4(m0), a1.copy(shape.a).applyMatrix4(m1), b1.copy(shape.b).applyMatrix4(m1),
          shape.radius, KIND_CAPSULE, mask, 0.5, { bone });
      });
    }
    const all = (1 << this.parts.length) - 1;
    for (const ball of scene.balls()) {
      const t = ball.body.translation(), lv = ball.body.linvel();
      a1.set(t.x, t.y, t.z);
      a.set(t.x - lv.x * scene.dt, t.y - lv.y * scene.dt, t.z - lv.z * scene.dt);
      add(a, a, a1, a1, ball.radius, KIND_SPHERE, all, 0.5, { ball });
    }
    return out;
  }

  /* Results ---------------------------------------------------------------------------------------------------- */

  /** Apply a frame's impulses to the bodies (flesh riding them) and to what the flesh touched; report contacts. */
  apply(out: FrameOutput, scene: Scene) {
    this.slots.forEach((slot, k) => {
      if (!slot || slot.cooling > 0 || !slot.body.isDynamic()) return;
      push(slot.body, out.bodyImpulse, k);
    });
    const touching = new Set<SimBall>();
    this.targets.forEach((t, c) => {
      if (!out.colliderContacts[c]) return;
      if ("bone" in t) {
        if (t.bone.body.isDynamic()) push(t.bone.body, out.colliderImpulse, c);
      } else {
        push(t.ball.body, out.colliderImpulse, c);
        touching.add(t.ball);
        if (!this.ballContact.has(t.ball)) scene.reportContact({ part: this.parts[0], with: "ball", ball: t.ball });
      }
    });
    this.ballContact = touching;
    this.parts.forEach((part, g) => out.floorContacts[g] && scene.reportContact({ part, with: "floor" }));
  }

  reset() {
    this.edits.clear();
    this.dv.set(0, 0, 0);
    for (const s of this.slots) if (s) s.end = null;
  }
}

/** A body's world pose dt before now, as its velocities say, and now (column-major 4×4 each). For a bone's contact
 *  shapes, where we keep no history: the velocities are those of the step just taken. */
function bodyPoses(body: RAPIER.RigidBody, dt: number): [Float32Array, Float32Array] {
  const t = body.translation(), r = body.rotation(), lv = body.linvel(), w = body.angvel(), c = body.worldCom();
  pose.compose(v.set(t.x, t.y, t.z), q.set(r.x, r.y, r.z, r.w), ONE);
  const now = Float32Array.from(pose.elements);
  // The origin's velocity is the centre of mass's plus ω × (origin − centre).
  const ox = t.x - c.x, oy = t.y - c.y, oz = t.z - c.z;
  v.set(t.x - (lv.x + w.y * oz - w.z * oy) * dt, t.y - (lv.y + w.z * ox - w.x * oz) * dt, t.z - (lv.z + w.x * oy - w.y * ox) * dt);
  const angle = -Math.hypot(w.x, w.y, w.z) * dt;
  if (angle > 1e-9) q.premultiply(spin.setFromAxisAngle(axis.set(w.x, w.y, w.z).normalize(), angle));
  pose.compose(v, q, ONE);
  return [Float32Array.from(pose.elements), now];
}
const spin = new THREE.Quaternion(), axis = new THREE.Vector3();

/** Impulse (and moment about the origin) k of `acc` onto a body: linear at its centre of mass, plus the torque. */
function push(body: RAPIER.RigidBody, acc: Float64Array, k: number) {
  const jx = acc[k * 6], jy = acc[k * 6 + 1], jz = acc[k * 6 + 2];
  if (jx === 0 && jy === 0 && jz === 0) return;
  const c = body.worldCom();
  body.applyImpulse({ x: jx, y: jy, z: jz }, true);
  body.applyTorqueImpulse({
    x: acc[k * 6 + 3] - (c.y * jz - c.z * jy), y: acc[k * 6 + 4] - (c.z * jx - c.x * jz), z: acc[k * 6 + 5] - (c.x * jy - c.y * jx),
  }, true);
}
