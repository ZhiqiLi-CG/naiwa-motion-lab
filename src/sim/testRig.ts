/**
 * A stand-in RigSpec for tests and the dev page until the character module hands over the real one: the contract
 * skeleton and a closed pear-shaped Body, with the proportions of the Blender build (assets-src/naiwa/build_naiwa.py)
 * converted to glTF space (+Y up, facing +Z).
 */
import * as THREE from "three";
import type { BoneName, RigBone, RigSpec } from "../contracts";

/** [height, half-width, half-depth, depth centre (+ forward)] of the body, bottom to top. */
const PROFILE: [number, number, number, number][] = [
  [0.245, 0, 0, -0.005], [0.265, 0.1, 0.09, -0.005], [0.3, 0.175, 0.155, -0.006], [0.365, 0.23, 0.208, -0.008],
  [0.445, 0.255, 0.232, -0.004], [0.525, 0.246, 0.226, -0.006], [0.605, 0.218, 0.198, -0.012],
  [0.685, 0.18, 0.162, -0.012], [0.755, 0.145, 0.128, -0.002], [0.805, 0.127, 0.106, 0.03],
  [0.855, 0.116, 0.096, 0.062], [0.905, 0.111, 0.089, 0.077], [0.95, 0.096, 0.075, 0.08], [0.98, 0.064, 0.05, 0.08],
  [1, 0, 0, 0.08],
];

/** Cubic Hermite through the profile rows (Catmull-Rom slopes), as the Blender build does. */
function profile(y: number): [number, number, number] {
  const n = PROFILE.length;
  y = Math.min(Math.max(y, PROFILE[0][0]), PROFILE[n - 1][0]);
  let k = 0;
  while (k < n - 2 && PROFILE[k + 1][0] < y) k++;
  const a = PROFILE[k], b = PROFILE[k + 1], prev = PROFILE[Math.max(0, k - 1)], next = PROFILE[Math.min(n - 1, k + 2)];
  const h = b[0] - a[0], t = (y - a[0]) / h;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 1; c <= 3; c++) {
    const da = (b[c] - prev[c]) / (b[0] - prev[0]), db = (next[c] - a[c]) / (next[0] - a[0]);
    out[c - 1] =
      (2 * t ** 3 - 3 * t * t + 1) * a[c] + (t ** 3 - 2 * t * t + t) * h * da +
      (-2 * t ** 3 + 3 * t * t) * b[c] + (t ** 3 - t * t) * h * db;
  }
  return out;
}

const smooth = (v: number) => {
  const t = Math.min(Math.max(v, 0), 1);
  return t * t * (3 - 2 * t);
};

/** Bone heads and tails in glTF space. */
const BONES: [BoneName, BoneName | null, [number, number, number], [number, number, number]][] = [
  ["root", null, [0, 0, 0], [0, 0.1, 0]],
  ["hips", "root", [0, 0.31, 0], [0, 0.49, 0]],
  ["spine", "hips", [0, 0.49, 0], [0, 0.67, 0]],
  ["chest", "spine", [0, 0.67, 0], [0, 0.8, 0.035]],
  ["head", "chest", [0, 0.8, 0.035], [0, 0.97, 0.08]],
];
for (const [s, side] of [[1, "L"], [-1, "R"]] as const) {
  BONES.push(
    [`upperarm_${side}`, "chest", [s * 0.135, 0.726, -0.005], [s * 0.285, 0.565, 0.008]],
    [`forearm_${side}`, `upperarm_${side}`, [s * 0.285, 0.565, 0.008], [s * 0.335, 0.435, 0.04]],
    [`hand_${side}`, `forearm_${side}`, [s * 0.335, 0.435, 0.04], [s * 0.35, 0.39, 0.05]],
    [`thigh_${side}`, "hips", [s * 0.111, 0.318, -0.008], [s * 0.126, 0.185, -0.012]],
    [`shin_${side}`, `thigh_${side}`, [s * 0.126, 0.185, -0.012], [s * 0.142, 0.055, -0.004]],
    [`foot_${side}`, `shin_${side}`, [s * 0.142, 0.055, -0.004], [s * 0.148, 0.025, 0.103]],
  );
}
const RADII: Partial<Record<BoneName, number>> = {
  hips: 0.2, spine: 0.2, chest: 0.15, head: 0.1, upperarm_L: 0.06, upperarm_R: 0.06, forearm_L: 0.05,
  forearm_R: 0.05, hand_L: 0.04, hand_R: 0.04, thigh_L: 0.07, thigh_R: 0.07, shin_L: 0.05, shin_R: 0.05,
  foot_L: 0.04, foot_R: 0.04,
};

/** Bone frame like Blender's: +Y along the bone, roll chosen so +Z points as close to forward (+Z) as it can. */
function boneMatrix(head: THREE.Vector3, tail: THREE.Vector3): THREE.Matrix4 {
  const y = tail.clone().sub(head).normalize();
  const ref = Math.abs(y.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(y, ref).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(head);
}

export interface TestRigOptions {
  /** Points around each ring of the body. */
  segments?: number;
  /** Rings between the bottom and the top pole. */
  rings?: number;
}

export function createTestRigSpec(opts: TestRigOptions = {}): RigSpec {
  const segments = opts.segments ?? 48;
  const rings = opts.rings ?? 36;
  const bones: RigBone[] = BONES.map(([name, parent, h, t]) => {
    const head = new THREE.Vector3(...h), tail = new THREE.Vector3(...t);
    return { name, parent, restWorld: boneMatrix(head, tail), tail, radius: RADII[name] ?? 0.05 };
  });

  const y0 = PROFILE[0][0], y1 = PROFILE[PROFILE.length - 1][0];
  const positions: number[] = [], softness: number[] = [], indices: number[] = [];
  const pole = (y: number) => {
    positions.push(0, y, profile(y)[2]);
    softness.push(0.2);
    return positions.length / 3 - 1;
  };
  const bottom = pole(y0);
  for (let r = 1; r < rings; r++) {
    // Denser rings near the poles, where the profile turns fastest.
    const y = y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos((Math.PI * r) / rings));
    const [rx, rz, cz] = profile(y);
    for (let j = 0; j < segments; j++) {
      const theta = (2 * Math.PI * j) / segments;
      const x = rx * Math.sin(theta), z = cz + rz * Math.cos(theta);
      positions.push(x, y, z);
      // The cream belly patch is the softest flesh.
      const patch = Math.hypot(x / 0.207, (y - 0.479) / 0.211);
      const blend = (1 - smooth((patch - 0.97) / 0.045)) * smooth((Math.cos(theta) - 0.25) / 0.28);
      softness.push(0.2 + 0.8 * blend);
    }
  }
  const top = pole(y1);
  const ring = (r: number, j: number) => 1 + (r - 1) * segments + (j % segments);
  for (let j = 0; j < segments; j++) {
    // Counter-clockwise seen from outside (theta runs from +Z towards +X).
    indices.push(bottom, ring(1, j + 1), ring(1, j));
    for (let r = 1; r < rings - 1; r++) {
      indices.push(ring(r, j), ring(r, j + 1), ring(r + 1, j + 1), ring(r, j), ring(r + 1, j + 1), ring(r + 1, j));
    }
    indices.push(top, ring(rings - 1, j), ring(rings - 1, j + 1));
  }
  return {
    bones,
    body: {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      softness: new Float32Array(softness),
    },
  };
}
