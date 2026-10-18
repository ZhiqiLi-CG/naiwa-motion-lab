/**
 * Collision block for particle solvers that do not resolve contacts themselves: the floor, the bones and the balls as
 * signed distance fields, tested against each free particle after the flesh's step.
 *
 *   floor   the plane y = 0
 *   bones   a part's own bones' hard cores (the flesh cannot sink into its skeleton), and the other parts' limb
 *           contact capsules (a hand pressing on the belly: limb against Body)
 *   balls   spheres, two-way with the ball's mass
 *
 * A particle closer than its margin is moved out along the field's gradient, its velocity into the shape removed (a
 * little restitution) and its sliding slowed by Coulomb friction. The impulse it took goes back to the bone or ball
 * (applied at the contact), so a hand pressing on the belly feels the belly push back.
 */
import * as THREE from "three";
import type { BlockDefinition, CollisionBlock, ParticleView, Scene, Settings, SimBall, SimBone, SimPart } from "../../sim/api";
import { isSimParticles, type SimParticles } from "./flesh";

interface Capsule {
  bone: SimBone;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
  contact: boolean;
}

/** Fraction of a shallow overlap undone per step. */
const BAUMGARTE = 0.3;

class SdfContacts implements CollisionBlock {
  private shapes = new Map<SimPart, Capsule[]>();
  /** Each particle's distance from each capsule at rest (particle-major): a particle that starts closer than the
   *  margin (the lattice reaches past the surface) is only kept from going deeper, so contact and elasticity do not
   *  fight at rest. */
  private restDistance = new Map<SimPart, Float32Array>();
  private restSurface = new Map<SimPart, Float32Array>();
  private friction: number;
  private restitution = 0;
  private margin = 0;
  private limbContact = true;
  /** This step's margin of the part being tested, and the step. */
  private marginNow = 0;
  private dt = 1 / 60;

  constructor(scene: Scene, settings: Readonly<Settings>) {
    this.friction = scene.floorFriction;
    this.setSettings(settings);
    const bones = [...scene.skeleton.bones.values()];
    for (const part of scene.parts) {
      const own = new Set(part.bones);
      const list: Capsule[] = [];
      for (const bone of bones) {
        for (const s of bone.shapes) {
          if (s.kind !== "capsule") continue;
          const mine = own.has(bone);
          if ((s.role === "core" && mine) || (s.role === "contact" && !mine)) {
            list.push({ bone, a: s.a.clone(), b: s.b.clone(), radius: s.radius, contact: s.role === "contact" });
          }
        }
      }
      this.shapes.set(part, list);
      const rest = scene.flesh.particles(part).rest, n = rest.length / 3;
      const dist = new Float32Array(n * list.length), seg = new THREE.Line3(), p = new THREE.Vector3(), c = new THREE.Vector3();
      list.forEach((cap, k) => {
        const m = cap.bone.restInverse.clone().invert();
        seg.set(cap.a.clone().applyMatrix4(m), cap.b.clone().applyMatrix4(m));
        for (let i = 0; i < n; i++) dist[i * list.length + k] = seg.closestPointToPoint(p.fromArray(rest, i * 3), true, c).distanceTo(p);
      });
      this.restDistance.set(part, dist);
      // The rendered surface's distance from each limb capsule at rest (vertex-major), likewise.
      const contacts = list.filter((cap) => cap.contact), V = part.positions, nv = V.length / 3;
      const surf = new Float32Array(nv * contacts.length);
      contacts.forEach((cap, k) => {
        const m = cap.bone.restInverse.clone().invert();
        seg.set(cap.a.clone().applyMatrix4(m), cap.b.clone().applyMatrix4(m));
        for (let v = 0; v < nv; v++) surf[v * contacts.length + k] = seg.closestPointToPoint(p.fromArray(V, v * 3), true, c).distanceTo(p);
      });
      this.restSurface.set(part, surf);
    }
  }

  setSettings(s: Readonly<Settings>) {
    this.restitution = Number(s.restitution ?? 0.1);
    this.margin = Number(s.contactMargin ?? 0.5);
    this.limbContact = Boolean(s.limbContact ?? true);
  }

  afterStep(scene: Scene) {
    const poses = new Map<SimBone, THREE.Matrix4>();
    const pose = (b: SimBone) => poses.get(b) ?? poses.set(b, b.pose(new THREE.Matrix4())).get(b)!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), seg = new THREE.Line3(), p = new THREE.Vector3(), c = new THREE.Vector3();
    const balls = scene.balls();
    for (const part of scene.parts) {
      const view = scene.flesh.particles(part);
      const X = view.positions();
      const V = isSimParticles(view) ? view.velocities() : null;
      const margin = isSimParticles(view) ? this.margin * view.radius : 0.01;
      this.marginNow = margin;
      this.dt = scene.dt;
      // World capsules of this part, once per step.
      const caps = (this.shapes.get(part) ?? []).map((s) => {
        const m = pose(s.bone);
        return { ...s, a: a.copy(s.a).applyMatrix4(m).clone(), b: b.copy(s.b).applyMatrix4(m).clone() };
      });
      const restDistance = this.restDistance.get(part)!, nc = caps.length;
      let onFloor = false;
      for (let i = 0; i < view.count; i++) {
        if (view.attachedTo(i)) continue;
        p.fromArray(X, i * 3);
        // Floor.
        if (p.y < margin) {
          this.contact(view, V, i, p, 0, 1, 0, margin - p.y, null);
          onFloor = true;
        }
        for (let k = 0; k < nc; k++) {
          const cap = caps[k];
          const rest = restDistance[i * nc + k];
          // A particle that starts inside a shape (flesh around the bone, or the lattice reaching past the surface)
          // belongs to it: the coupling holds it there.
          if ((cap.contact && !this.limbContact) || rest < cap.radius) continue;
          seg.set(cap.a, cap.b).closestPointToPoint(p, true, c);
          const d = p.distanceTo(c), depth = Math.min(cap.radius + margin, rest) - d;
          if (depth <= 0 || d < 1e-9) continue;
          this.contact(view, V, i, p, (p.x - c.x) / d, (p.y - c.y) / d, (p.z - c.z) / d, depth, cap.bone.body);
        }
        for (const ball of balls) {
          const t = ball.body.translation();
          const d = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z), depth = ball.radius + margin - d;
          if (depth <= 0 || d < 1e-9) continue;
          this.ballContact(scene, part, view, V, i, p, ball, (p.x - t.x) / d, (p.y - t.y) / d, (p.z - t.z) / d, depth);
        }
      }
      if (onFloor) scene.reportContact({ part, with: "floor" });
      if (this.limbContact && isSimParticles(view)) this.surfaceContacts(view, caps.filter((c) => c.contact), this.restSurface.get(part)!);
    }
  }

  /**
   * Limb against Body at the rendered surface's resolution: the particles are a lattice step apart, so a hand can sit
   * between them; each surface vertex inside a limb's contact capsule moves the particles of its cell out (by their
   * barycentric weights, so the vertex lands on the capsule), and the cell's speed into the capsule goes to the limb.
   * Corrections to a particle from several vertices are averaged.
   */
  private surfaceContacts(view: SimParticles, caps: { bone: SimBone; a: THREE.Vector3; b: THREE.Vector3; radius: number }[], rest: Float32Array) {
    const { tets: T, embedTet: ET, embedWeight: EW } = view.mesh;
    const X = view.positions(), V = view.velocities(), n = view.count;
    const dx = this.scratch(n * 3), dv = this.scratch(n * 3, 1), count = this.scratch(n, 2);
    const seg = new THREE.Line3(), p = new THREE.Vector3(), c = new THREE.Vector3(), box = new THREE.Box3();
    // The surface once for all capsules, and its bounds to skip the capsules nowhere near it.
    const S = view.surface(), bounds = new THREE.Box3();
    for (let v = 0; v < S.length; v += 3) bounds.expandByPoint(p.fromArray(S, v));
    const nc = caps.length;
    caps.forEach((cap, ci) => {
      box.setFromPoints([cap.a, cap.b]).expandByScalar(cap.radius);
      if (!box.intersectsBox(bounds)) return;
      seg.set(cap.a, cap.b);
      const limb = cap.bone.body;
      dx.fill(0); dv.fill(0); count.fill(0);
      let touched = false;
      for (let v = 0; v < S.length / 3; v++) {
        p.fromArray(S, v * 3);
        if (!box.containsPoint(p)) continue;
        seg.closestPointToPoint(p, true, c);
        // A vertex that starts inside the capsule (an arm resting on the side) is only kept from going deeper.
        const d = p.distanceTo(c), depth = Math.min(cap.radius, rest[v * nc + ci]) - d;
        if (depth <= 0 || d < 1e-9) continue;
        const nx = (p.x - c.x) / d, ny = (p.y - c.y) / d, nz = (p.z - c.z) / d;
        const t = ET[v] * 4;
        let ww = 0, vx = 0, vy = 0, vz = 0;
        for (let j = 0; j < 4; j++) {
          const k = T[t + j], w = EW[v * 4 + j];
          vx += w * V[k * 3]; vy += w * V[k * 3 + 1]; vz += w * V[k * 3 + 2];
          if (!view.attachedTo(k)) ww += w * w;
        }
        if (ww < 1e-6) continue;
        const lv = limb.velocityAtPoint({ x: c.x, y: c.y, z: c.z });
        const vn = Math.min(0, (vx - lv.x) * nx + (vy - lv.y) * ny + (vz - lv.z) * nz);
        // Move the cell's free particles by their weights so that the vertex lands on the capsule.
        for (let j = 0; j < 4; j++) {
          const k = T[t + j], w = EW[v * 4 + j];
          if (view.attachedTo(k) || w <= 0) continue;
          const sc = w / ww;
          dx[k * 3] += sc * depth * nx; dx[k * 3 + 1] += sc * depth * ny; dx[k * 3 + 2] += sc * depth * nz;
          dv[k * 3] -= sc * vn * nx; dv[k * 3 + 1] -= sc * vn * ny; dv[k * 3 + 2] -= sc * vn * nz;
          count[k]++;
          touched = true;
        }
      }
      if (!touched) return;
      let jx = 0, jy = 0, jz = 0;
      for (let k = 0; k < n; k++) {
        if (!count[k]) continue;
        const q = 1 / count[k], m = view.mass(k);
        view.setPosition(k, X[k * 3] + dx[k * 3] * q, X[k * 3 + 1] + dx[k * 3 + 1] * q, X[k * 3 + 2] + dx[k * 3 + 2] * q);
        view.setVelocity(k, V[k * 3] + dv[k * 3] * q, V[k * 3 + 1] + dv[k * 3 + 1] * q, V[k * 3 + 2] + dv[k * 3 + 2] * q);
        jx -= m * dv[k * 3] * q; jy -= m * dv[k * 3 + 1] * q; jz -= m * dv[k * 3 + 2] * q;
      }
      // The limb takes the opposite of the momentum the flesh gained.
      if (limb.isDynamic() && !limb.isSleeping()) {
        const mid = cap.a.clone().add(cap.b).multiplyScalar(0.5);
        limb.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, { x: mid.x, y: mid.y, z: mid.z }, false);
      }
    });
  }

  private buffers: Float64Array[] = [];
  /** A reusable scratch array (slot k) of at least n numbers. */
  private scratch(n: number, k = 0): Float64Array {
    if (!this.buffers[k] || this.buffers[k].length < n) this.buffers[k] = new Float64Array(n);
    return this.buffers[k].subarray(0, n);
  }

  /** Move particle i out by depth along n; remove its velocity into the shape (relative to the shape's), slow its
   *  sliding; the impulse it took goes to the body (when dynamic). */
  private contact(
    view: ParticleView, V: Float32Array | null, i: number, p: THREE.Vector3,
    nx: number, ny: number, nz: number, depth: number, body: SimBone["body"] | null,
  ) {
    // Deeper than the margin is undone at once; within it, a separating speed pushes the particle out over a few steps
    // (Baumgarte), so that a stiff solver is not kicked by a jump every step while flesh rests on a bone.
    const jump = V ? Math.max(0, depth - this.marginNow) : depth;
    if (jump > 0) {
      view.setPosition(i, p.x + nx * jump, p.y + ny * jump, p.z + nz * jump);
      p.set(p.x + nx * jump, p.y + ny * jump, p.z + nz * jump);
    }
    if (!V) return;
    const separate = (BAUMGARTE * Math.min(depth, this.marginNow)) / this.dt;
    let bvx = 0, bvy = 0, bvz = 0;
    if (body) {
      const bv = body.velocityAtPoint({ x: p.x, y: p.y, z: p.z });
      bvx = bv.x; bvy = bv.y; bvz = bv.z;
    }
    const rx = V[i * 3] - bvx, ry = V[i * 3 + 1] - bvy, rz = V[i * 3 + 2] - bvz;
    const vn = rx * nx + ry * ny + rz * nz;
    if (vn >= separate) return;
    const dvn = Math.max(separate, -this.restitution * vn) - vn;
    // Coulomb: the sliding speed drops by at most μ times the normal change.
    const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz, vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const slow = vt > 1e-9 ? Math.min(vt, this.friction * dvn) / vt : 0;
    const dvx = dvn * nx - tx * slow, dvy = dvn * ny - ty * slow, dvz = dvn * nz - tz * slow;
    view.setVelocity(i, V[i * 3] + dvx, V[i * 3 + 1] + dvy, V[i * 3 + 2] + dvz);
    // A sleeping body is not woken by flesh resting on it (Rapier would keep adding the impulse to its velocity).
    if (body?.isDynamic() && !body.isSleeping()) {
      const m = view.mass(i);
      body.applyImpulseAtPoint({ x: -m * dvx, y: -m * dvy, z: -m * dvz }, { x: p.x, y: p.y, z: p.z }, false);
    }
  }

  /** A ball: the particle moves out, and the two exchange the normal impulse of an inelastic contact by their masses. */
  private ballContact(
    scene: Scene, part: SimPart, view: ParticleView, V: Float32Array | null, i: number,
    p: THREE.Vector3, ball: SimBall, nx: number, ny: number, nz: number, depth: number,
  ) {
    view.setPosition(i, p.x + nx * depth, p.y + ny * depth, p.z + nz * depth);
    if (!V) return;
    const bv = ball.body.linvel();
    const vn = (V[i * 3] - bv.x) * nx + (V[i * 3 + 1] - bv.y) * ny + (V[i * 3 + 2] - bv.z) * nz;
    if (vn >= 0) return;
    const m = view.mass(i), M = ball.body.mass();
    const j = (-(1 + this.restitution) * vn) / (1 / m + 1 / M);
    view.setVelocity(i, V[i * 3] + (j / m) * nx, V[i * 3 + 1] + (j / m) * ny, V[i * 3 + 2] + (j / m) * nz);
    ball.body.applyImpulse({ x: -j * nx, y: -j * ny, z: -j * nz }, true);
    if (-vn > 0.5) scene.reportContact({ part, with: "ball", ball });
  }
}

export const sdfContacts: BlockDefinition<"collision"> = {
  id: "sdf-contacts",
  slot: "collision",
  name: { zh: "SDF 接触", en: "SDF contacts" },
  summary: {
    zh: "地面、骨头（自身的硬骨、其它部分的四肢接触胶囊）和球作为有向距离场，逐个自由粒子推出、去掉法向速度、库仑摩擦；反冲量还给骨头和球。",
    en: "The floor, the bones (a part's own hard cores, the other parts' limb contact capsules) and the balls as signed distance fields: each free particle is pushed out, loses its velocity into the shape, slides with Coulomb friction; the impulse goes back to the bone or ball.",
  },
  device: "cpu",
  parameters: [
    {
      key: "contactMargin", kind: "number", default: 0.5, min: 0, max: 1.5, step: 0.1,
      label: { zh: "接触余量", en: "Contact margin" },
      help: { zh: "粒子离形状多近算接触，以半个格距为单位。", en: "How close a particle may come to a shape, in half lattice steps." },
    },
    { key: "restitution", kind: "number", default: 0.1, min: 0, max: 0.8, step: 0.05, label: { zh: "弹性", en: "Restitution" } },
    {
      key: "limbContact", kind: "boolean", default: true,
      label: { zh: "四肢与身体接触", en: "Limbs against the Body" },
      help: { zh: "关掉后手会穿进肚子。", en: "Off: hands pass into the belly." },
    },
  ],
  create: (scene, settings) => new SdfContacts(scene, settings),
};
