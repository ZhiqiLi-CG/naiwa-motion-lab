/**
 * Constraints block: the frog's body as the solver must respect it.
 *
 * Clearance: the body is a stack of elliptic cylinders fitted to the Body mesh (rig.ts), each carried by a torso bone;
 * a point's clearance is its horizontal distance outside the most penetrating slice. A limb point keeps its flesh
 * thickness plus a margin (the slices only approximate the skinned body). Points buried at rest (the limb roots: the
 * shoulders sit deep in the body, the thighs under the belly) may stay as deep against the torso below the shoulders,
 * never against the neck and head; points that only touch the body at rest (an elbow on the belly) may do so near
 * their rest spot only, needing their full thickness once moved 2–8 cm away.
 *
 * Joint limits: how far the chest and head turn from rest, how far the elbows and knees bend, and the legs never cross
 * (knees and ankles keep at least half their rest distance from the middle).
 */
import * as THREE from "three";
import type { BoneName } from "../../contracts";
import type { BlockDefinition, ConstraintsBlock, LimbSample, Scene, Settings, Side, Torso } from "../api";
import { sideSign } from "../pose";
import { clearance, fromRest, toRest, type Band, type Binding } from "../rig";

type V3 = THREE.Vector3;
const smoothstep = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

class FrogBody implements ConstraintsBlock {
  private D: ReadonlyMap<BoneName, THREE.Quaternion> = new Map();
  private P: ReadonlyMap<BoneName, V3> = new Map();
  private readonly b: Binding;

  constructor(scene: Scene, private s: Readonly<Settings>) {
    this.b = scene.rig;
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  setTorso(torso: Torso) {
    this.D = torso.rotations;
    this.P = torso.joints;
  }

  clearance(p: V3): number {
    return clearance(this.b, this.D, p, this.P).c;
  }

  thickness(sm: LimbSample): number {
    return sm.radius + (this.s.margin as number);
  }

  check(sm: LimbSample, p: V3) {
    const { c, band } = clearance(this.b, this.D, p, this.P);
    const thick = this.thickness(sm);
    let needed = thick;
    if (sm.restClear < thick && band && band.y0 < this.b.neckY) {
      if (sm.restClear < 0) needed = sm.restClear;
      else {
        const moved = toRest(this.b, this.D, this.P, sm.frame, p).distanceTo(sm.rest);
        needed = sm.restClear + (thick - sm.restClear) * smoothstep((moved - 0.02) / 0.06);
      }
    }
    return { clearance: c, needed };
  }

  /** Moved horizontally in its slice's frame, radially out of the ellipse. */
  pushOut(p: V3, margin: number, side: Side): V3 | null {
    const { c, band, q } = clearance(this.b, this.D, p, this.P);
    if (!band || c >= margin) return null;
    let dx = q.x - band.cx, dz = q.z - band.cz;
    let r = Math.hypot(dx, dz);
    if (r < 1e-6) (dx = sideSign(side)), (dz = 0), (r = 1);
    const reff = 1 / Math.hypot(dx / r / band.rx, dz / r / band.rz);
    const k = (reff + margin) / r;
    return fromRest(this.b, this.D, this.P, band.bone, new THREE.Vector3(band.cx + dx * k, q.y, band.cz + dz * k));
  }

  bellySpot(height: number, around: number, side: Side) {
    const b = this.b;
    const rest = (n: BoneName) => b.rest.get(n)!.pos;
    const y = rest("hips").y + (rest("chest").y - rest("hips").y) * height;
    const band = bandAt(b, y);
    const sg = sideSign(side), sn = Math.sin(around), cs = Math.cos(around);
    const qy = Math.min(Math.max(y, band.y0), band.y1);
    const R = this.D.get(band.bone)!;
    return {
      point: fromRest(b, this.D, this.P, band.bone, new THREE.Vector3(band.cx + sg * band.rx * sn, qy, band.cz + band.rz * cs)),
      normal: new THREE.Vector3((sg * sn) / band.rx, 0, cs / band.rz).normalize().applyQuaternion(R),
      tangent: new THREE.Vector3(-sg * band.rx * cs, 0, band.rz * sn).normalize().applyQuaternion(R),
      down: new THREE.Vector3(0, -1, 0).applyQuaternion(R),
    };
  }

  limit(joint: "chest" | "head" | "elbow" | "knee"): number {
    return this.s[`${joint}Limit`] as number;
  }

  spread(joint: "knee" | "ankle", side: Side): number {
    const l = this.b.leg[side];
    return 0.5 * (joint === "knee" ? l.kneeX : l.ankleX);
  }
}

/** The slice whose middle is nearest to height y. */
function bandAt(b: Binding, y: number): Band {
  let best = b.bands[0];
  for (const band of b.bands) if (Math.abs((band.y0 + band.y1) / 2 - y) < Math.abs((best.y0 + best.y1) / 2 - y)) best = band;
  return best;
}

export const frogBody: BlockDefinition<"constraints"> = {
  id: "frog-body",
  slot: "constraints",
  name: { zh: "奶蛙身体：避让与关节限制", en: "Frog body: clearance and joint limits" },
  summary: {
    zh: "身体是一摞按 Body 网格拟合的椭圆柱；四肢上的采样点要离表面至少一个肉的厚度（加安全余量），肢体根部和静止时贴着肚子的点例外。胸、头的转动和肘、膝的弯曲有上限，两腿不交叉。",
    en: "The body is a stack of elliptic cylinders fitted to the Body mesh; sample points on the limbs keep their flesh thickness (plus a margin) off its surface, except the limb roots and points resting on the belly. The chest and head turn, the elbows and knees bend, within limits; the legs never cross.",
  },
  parameters: [
    {
      key: "margin", kind: "number", default: 0.01, min: 0, max: 0.05, step: 0.001, unit: "m",
      label: { zh: "避让余量", en: "Clearance margin" },
      help: { zh: "肢体的肉和身体表面之间多留的距离（椭圆柱只是近似蒙皮后的身体）", en: "Extra room between a limb's flesh and the body (the cylinders only approximate the skinned body)" },
    },
    {
      key: "chestLimit", kind: "number", default: 1.1, min: 0, max: 1.6, step: 0.05, unit: "rad",
      label: { zh: "胸部最大转动", en: "Chest rotation limit" },
    },
    {
      key: "headLimit", kind: "number", default: 0.7, min: 0, max: 1.6, step: 0.05, unit: "rad",
      label: { zh: "头部最大转动", en: "Head rotation limit" },
      help: { zh: "相对胸部", en: "Relative to the chest" },
    },
    {
      key: "elbowLimit", kind: "number", default: 2.6, min: 0.5, max: 3.14, step: 0.05, unit: "rad",
      label: { zh: "肘部最大弯曲", en: "Elbow bend limit" },
      help: { zh: "上臂和前臂方向之间的最大夹角（0 = 伸直）", en: "Largest angle between the upper arm and forearm (0 = straight)" },
    },
    {
      key: "kneeLimit", kind: "number", default: 2.6, min: 0.5, max: 3.14, step: 0.05, unit: "rad",
      label: { zh: "膝部最大弯曲", en: "Knee bend limit" },
      help: { zh: "大腿和小腿方向之间的最大夹角（0 = 伸直）", en: "Largest angle between the thigh and shin (0 = straight)" },
    },
  ],
  create: (scene, settings) => new FrogBody(scene, settings),
};
