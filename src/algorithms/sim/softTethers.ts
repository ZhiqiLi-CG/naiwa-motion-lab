/**
 * Coupling block: the flesh right around a bone rides on it (the bone and the tissue against it); every other particle is
 * tied to where its bone would carry it (the target block) by a damped spring whose strength falls off smoothly with
 * its depth in the flesh — stiff next to the core, nearly free at the surface — instead of a fixed share of the
 * flesh riding hard and the rest being free. There is no on/off seam between carried and free flesh
 * (docs/soft-binding.md).
 *
 * Each tether is solved implicitly for the pair (particle, bone) with the pair's reduced mass, the bone's mass shared
 * among the particles tied to it, so it is stable however stiff; the particle gets the impulse and its bone the
 * opposite one at the same point (two-way: momentum is exchanged, not created).
 */
import type RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { BlockDefinition, CouplingBlock, Scene, Settings, SimBone, SimPart } from "../../sim/api";
import { nearestBone, particleAttributes } from "../../sim/parts";
import { isSimParticles } from "./flesh";
import { lerpLog } from "./material";

interface Tethers {
  bone: SimBone[];
  /** How much firmer than the belly each particle's flesh is (1.5 − softness): firm flesh is held further out. */
  firm: Float32Array;
  /** Depth of each particle in its bone's flesh: 0 at the bone, 1 at the typical surface. */
  depth: Float32Array;
  /** Angular frequency (rad/s) of each tether. */
  omega: Float64Array;
  /** Particles tied loosely (depth > ½): the jiggle is measured on them. */
  loose: number[];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

class SoftTethers implements CouplingBlock {
  private tethers = new Map<SimPart, Tethers>();
  private near = 20;
  private far = 0.5;
  private reach = 1.2;
  private zeta = 0.7;

  constructor(private scene: Scene, settings: Readonly<Settings>) {
    const p = new THREE.Vector3();
    for (const part of scene.parts) {
      const view = scene.flesh.particles(part);
      const thick = thickness(part);
      const bone: SimBone[] = [], depth = new Float32Array(view.count);
      const core = Number(settings.tetherCore ?? 0.6);
      const firm = Float32Array.from(particleAttributes(part, view.rest).softness, (x) => 1.5 - x);
      for (let i = 0; i < view.count; i++) {
        const nb = nearestBone(part, p.fromArray(view.rest, i * 3));
        bone.push(nb.bone);
        depth[i] = nb.distance / Math.max(1e-3, thick.get(nb.bone) ?? 0.1);
        // A limb is only a lattice step or two thick: it rides whole on its bones (as with the built-in coupling).
        if (part.limb || depth[i] < core * firm[i]) view.attach(i, nb.bone.body);
      }
      this.tethers.set(part, { bone, firm, depth, omega: new Float64Array(view.count), loose: [] });
    }
    this.setSettings(settings);
  }

  setSettings(s: Readonly<Settings>) {
    this.near = Number(s.tetherNear ?? 20);
    this.far = Number(s.tetherFar ?? 0.5);
    this.reach = Number(s.tetherReach ?? 1.2);
    this.zeta = Number(s.tetherDamping ?? 0.7);
    for (const t of this.tethers.values()) {
      t.loose = [];
      for (let i = 0; i < t.depth.length; i++) {
        const u = smoothstep(0, this.reach * t.firm[i], t.depth[i]);
        t.omega[i] = 2 * Math.PI * lerpLog(this.near, this.far, u);
        if (u > 0.5) t.loose.push(i);
      }
    }
  }

  /** After the flesh's step: each tether's implicit impulse, to the particle and (opposite) to its bone. */
  afterStep(scene: Scene) {
    const h = scene.dt;
    // Each awake dynamic bone's mass per kilogram of flesh tied to it (to share the bone among its tethers).
    const share = new Map<RAPIER.RigidBody, number>();
    for (const [part, t] of this.tethers) {
      const view = scene.flesh.particles(part);
      for (let i = 0; i < view.count; i++) {
        if (view.attachedTo(i)) continue;
        const b = t.bone[i].body;
        share.set(b, (share.get(b) ?? 0) + view.mass(i));
      }
    }
    for (const [b, m] of share) share.set(b, b.isDynamic() && !b.isSleeping() ? b.mass() / m : Infinity);
    const sums = new Map<RAPIER.RigidBody, Float64Array>();
    for (const [part, t] of this.tethers) {
      const view = scene.flesh.particles(part);
      const X = view.positions(), V = isSimParticles(view) ? view.velocities() : null;
      const T = scene.target.targets(part), TV = scene.target.targetVelocities(part);
      for (let i = 0; i < view.count; i++) {
        if (view.attachedTo(i)) continue;
        const body = t.bone[i].body, m = view.mass(i), w = t.omega[i];
        // The pair's reduced mass: the particle against its share of the bone.
        const M = m * share.get(body)!, dynamic = Number.isFinite(M);
        const mu = dynamic ? (m * M) / (m + M) : m;
        const k = m * w * w, c = 2 * this.zeta * m * w;
        const den = mu + h * c + h * h * k;
        const J = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          const d = T[i * 3 + a] - X[i * 3 + a], vr = (V ? V[i * 3 + a] : 0) - TV[i * 3 + a];
          J[a] = (mu * h * (k * d - (c + h * k) * vr)) / den;
        }
        view.applyImpulse(i, J[0], J[1], J[2]);
        if (!dynamic) continue;
        let s = sums.get(body);
        if (!s) {
          const o = body.translation();
          sums.set(body, (s = new Float64Array([0, 0, 0, 0, 0, 0, o.x, o.y, o.z])));
        }
        const rx = T[i * 3] - s[6], ry = T[i * 3 + 1] - s[7], rz = T[i * 3 + 2] - s[8];
        s[0] -= J[0]; s[1] -= J[1]; s[2] -= J[2];
        s[3] -= ry * J[2] - rz * J[1];
        s[4] -= rz * J[0] - rx * J[2];
        s[5] -= rx * J[1] - ry * J[0];
      }
    }
    for (const [b, s] of sums) {
      b.applyImpulseAtPoint({ x: s[0], y: s[1], z: s[2] }, { x: s[6], y: s[7], z: s[8] }, false);
      b.applyTorqueImpulse({ x: s[3], y: s[4], z: s[5] }, false);
    }
  }

  /** Mean distance of the loosely tied flesh from where its bones would carry it. */
  jiggle(part: SimPart): number {
    const t = this.tethers.get(part);
    if (!t?.loose.length) return 0;
    const P = this.scene.flesh.particles(part).positions(), T = this.scene.target.targets(part);
    let sum = 0;
    for (const i of t.loose) sum += Math.hypot(P[i * 3] - T[i * 3], P[i * 3 + 1] - T[i * 3 + 1], P[i * 3 + 2] - T[i * 3 + 2]);
    return sum / t.loose.length;
  }
}

/** How thick the flesh is around each bone of a part: the median distance of its surface vertices to the bone. */
function thickness(part: SimPart): Map<SimBone, number> {
  const d = new Map<SimBone, number[]>(part.bones.map((b) => [b, []]));
  const p = new THREE.Vector3();
  for (let v = 0; v < part.positions.length; v += 3) {
    const { bone, distance } = nearestBone(part, p.fromArray(part.positions, v));
    d.get(bone)!.push(distance);
  }
  return new Map([...d].map(([b, list]) => [b, list.sort((x, y) => x - y)[list.length >> 1] ?? 0]));
}

export const softTethers: BlockDefinition<"coupling"> = {
  id: "soft-tethers",
  slot: "coupling",
  name: { zh: "柔性系带", en: "Soft tethers" },
  summary: {
    zh: "每个粒子用带阻尼的弹簧系到骨头携带它的位置，强度随离骨头的距离平滑衰减（无硬边界）；隐式求解，反冲量还给骨头。",
    en: "Every particle is tied to where its bone would carry it by a damped spring whose strength falls off smoothly with the distance from the bone (no hard seam); solved implicitly, the reaction goes back to the bone.",
  },
  device: "cpu",
  parameters: [
    {
      key: "tetherCore", kind: "number", default: 0.6, min: 0, max: 1, step: 0.05, rebuild: true,
      label: { zh: "硬核深度", en: "Hard core" },
      help: { zh: "以肉厚为单位：比这更靠近骨头的肉直接挂在骨头上（骨头和紧贴它的组织）。", en: "In units of the flesh's thickness: flesh closer to the bone rides on it (the bone and the tissue against it)." },
    },
    { key: "tetherNear", kind: "number", default: 20, min: 2, max: 60, step: 1, unit: "Hz", label: { zh: "骨头旁的频率", en: "Frequency at the bone" } },
    { key: "tetherFar", kind: "number", default: 0.5, min: 0.05, max: 10, step: 0.05, unit: "Hz", label: { zh: "表面的频率", en: "Frequency at the surface" } },
    {
      key: "tetherReach", kind: "number", default: 1.2, min: 0.2, max: 2, step: 0.05,
      label: { zh: "衰减范围", en: "Falloff reach" },
      help: { zh: "强度从骨头到这个深度（以肉厚为单位）平滑降到表面值。", en: "Depth (in units of the flesh's thickness) over which the strength falls to the surface value." },
    },
    { key: "tetherDamping", kind: "number", default: 0.7, min: 0, max: 2, step: 0.05, label: { zh: "阻尼比", en: "Damping ratio" } },
  ],
  create: (scene, settings) => new SoftTethers(scene, settings),
};
