/**
 * A test session made without the app: the character's own skeleton (read from the GLB) driven by a short dance with
 * little hops, a few pokes, a ball and some faces, recorded through SessionRecorder exactly as the app would.
 */
import * as THREE from "three";
import type { BoneName, ExpressionWeights } from "../contracts";
import type { SessionFile } from "./format";
import { SessionRecorder } from "./recorder";

export interface RestBone {
  name: BoneName;
  parent: BoneName | null;
  /** Rest transform relative to the parent bone (world for the root). */
  local: THREE.Matrix4;
}

/** The skin's joints of a GLB with their rest transforms (parents before children). */
export function restSkeletonFromGlb(glb: ArrayBuffer): RestBone[] {
  const view = new DataView(glb);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as {
    nodes: { name: string; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
    skins: { joints: number[] }[];
  };
  const joints = json.skins[0].joints;
  const parentOf = new Map<number, number>();
  json.nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const out: RestBone[] = [];
  const visit = (j: number) => {
    const n = json.nodes[j];
    const p = parentOf.get(j);
    out.push({
      name: n.name as BoneName,
      parent: p !== undefined && joints.includes(p) ? (json.nodes[p].name as BoneName) : null,
      local: new THREE.Matrix4().compose(
        new THREE.Vector3(...((n.translation ?? [0, 0, 0]) as [number, number, number])),
        new THREE.Quaternion(...((n.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])),
        new THREE.Vector3(...((n.scale ?? [1, 1, 1]) as [number, number, number])),
      ),
    });
    n.children?.filter((c) => joints.includes(c)).forEach(visit);
  };
  joints.filter((j) => !joints.includes(parentOf.get(j) ?? -1)).forEach(visit);
  return out;
}

const FPS = 60;
const DURATION = 8;
const smooth = (a: number, b: number, t: number) => {
  const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
/** 1 inside [a, b] with soft edges of length e. */
const window = (a: number, b: number, e: number, t: number) => smooth(a - e, a, t) * (1 - smooth(b, b + e, t));

/** Rotations about axes as seen in the rest pose (world axes), per bone, at time t. */
function danceRotations(t: number): Partial<Record<BoneName, THREE.Quaternion>> {
  const dance = window(1, 5, 0.4, t), hold = window(5.2, 6.8, 0.4, t);
  const q = (axis: [number, number, number], angle: number) =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), angle);
  const wave = Math.sin(2 * Math.PI * 1.0 * t);
  const out: Partial<Record<BoneName, THREE.Quaternion>> = {
    root: q([0, 1, 0], 0.25 * dance * Math.sin(2 * Math.PI * 0.5 * t)),
    spine: q([0, 0, 1], 0.12 * dance * wave).multiply(q([1, 0, 0], 0.25 * hold)),
    head: q([0, 0, 1], -0.15 * dance * wave).multiply(q([1, 0, 0], -0.2 * hold + 0.08 * Math.sin(2 * Math.PI * 2 * t) * dance)),
  };
  for (const [side, s] of [["L", 1], ["R", -1]] as const) {
    const up = dance * (0.9 + 0.6 * s * wave);
    // Raise sideways (about the forward axis), and for the hold swing forward and in towards the belly.
    out[`upperarm_${side}`] = q([0, 0, 1], s * up).multiply(q([1, 0, 0], -0.9 * hold)).multiply(q([0, 1, 0], s * -0.6 * hold));
    out[`forearm_${side}`] = q([1, 0, 0], -1.0 * hold - 0.5 * dance * (1 + s * wave) * 0.5);
    out[`thigh_${side}`] = q([1, 0, 0], -0.15 * dance * Math.max(0, s * wave));
    out[`shin_${side}`] = q([1, 0, 0], 0.3 * dance * Math.max(0, s * wave));
  }
  return out;
}

/** Little hops during the dance: parabolas twice a second; and the sway of the root. */
function rootOffset(t: number): THREE.Vector3 {
  const dance = window(1.2, 4.8, 0.3, t);
  const phase = (t * 2) % 1;
  const hop = phase < 0.45 ? 4 * (phase / 0.45) * (1 - phase / 0.45) : 0;
  return new THREE.Vector3(0.04 * dance * Math.sin(2 * Math.PI * 0.5 * t), 0.07 * dance * hop, 0);
}

function expressions(t: number): ExpressionWeights {
  const pulse = (c: number, w: number) => Math.exp(-(((t - c) / w) ** 2));
  return {
    blink: Math.max(pulse(0.8, 0.05), pulse(3.1, 0.05), pulse(7.6, 0.05)),
    laugh: window(5.2, 6.8, 0.25, t),
    tongue: window(7.0, 7.5, 0.15, t),
    surprise: Math.max(pulse(1.6, 0.15), pulse(2.8, 0.15)),
  };
}

/** A ball thrown from the camera side at the belly: in at 3.5 s, hits at 3.8 s, bounces back and falls. */
function ball(t: number): Float32Array {
  if (t < 3.5 || t > 5.0) return new Float32Array(0);
  const hit = new THREE.Vector3(0.05, 0.5, 0.33), start = new THREE.Vector3(0.6, 0.9, 2.2);
  const p = new THREE.Vector3();
  if (t < 3.8) p.lerpVectors(start, hit, (t - 3.5) / 0.3);
  else {
    const s = t - 3.8;
    p.set(hit.x + 0.5 * s, Math.max(0.08, hit.y + 1.5 * s - 4.9 * s * s), hit.z + 1.6 * s);
  }
  return new Float32Array([p.x, p.y, p.z, 0.08]);
}

const POKES: { t: number; local: [number, number, number]; strength: number }[] = [
  { t: 1.6, local: [0.0, 0.47, 0.235], strength: 0.8 },
  { t: 2.8, local: [-0.15, 0.42, 0.18], strength: 0.6 },
  { t: 6.9, local: [0.06, 0.4, 0.225], strength: 1.0 },
];

export function makeTestSession(skeleton: RestBone[]): SessionFile {
  const rec = new SessionRecorder();
  rec.start(0, {
    params: { softness: 0.7, bounciness: 0.7, gravity: 1, bellySize: 1, stubbornness: 0.8 },
    mode: "driven",
    theme: "light",
  });
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 50);
  const restWorld = new Map<BoneName, THREE.Matrix4>();
  for (const b of skeleton) {
    restWorld.set(b.name, b.parent ? restWorld.get(b.parent)!.clone().multiply(b.local) : b.local.clone());
  }
  const world = new Map<BoneName, THREE.Matrix4>();
  const restQ = new THREE.Quaternion(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  let poke = 0;
  for (let f = 0; f <= DURATION * FPS; f++) {
    const t = f / FPS;
    const rot = danceRotations(t);
    for (const b of skeleton) {
      // Turn the bone about a rest-pose axis: conjugate the world-axis rotation into the bone's rest frame.
      let local = b.local;
      const r = rot[b.name];
      if (r) {
        restWorld.get(b.name)!.decompose(tmp, restQ, tmp2);
        const d = restQ.clone().invert().multiply(r).multiply(restQ);
        local = b.local.clone().multiply(new THREE.Matrix4().makeRotationFromQuaternion(d));
      }
      const m = b.parent ? world.get(b.parent)!.clone().multiply(local) : local.clone();
      if (!b.parent) m.premultiply(new THREE.Matrix4().makeTranslation(rootOffset(t)));
      world.set(b.name, m);
    }
    const yaw = 0.25 * Math.sin((2 * Math.PI * t) / DURATION);
    camera.position.set(2.3 * Math.sin(yaw), 0.95, 2.3 * Math.cos(yaw));
    camera.lookAt(0, 0.5, 0);
    camera.updateMatrixWorld();
    while (poke < POKES.length && POKES[poke].t <= t) {
      const p = POKES[poke++];
      const point = new THREE.Vector3(...p.local).applyMatrix4(world.get("hips")!.clone().multiply(restWorld.get("hips")!.clone().invert()));
      const dir = new THREE.Vector3().subVectors(camera.position, point).normalize().negate();
      rec.event(t * 1000, { kind: "poke", point, strength: p.strength, region: "belly" }, dir);
    }
    if (Math.abs(t - 3.8) < 0.5 / FPS) {
      rec.event(t * 1000, { kind: "ball", point: new THREE.Vector3(0.05, 0.5, 0.25), strength: 0.7, region: "belly" },
        new THREE.Vector3(-0.2, -0.15, -1));
    }
    rec.frame(t * 1000, { bones: world, camera, balls: ball(t), expressions: expressions(t) });
  }
  return rec.stop();
}
