/**
 * Eyes and mouth riding on the soft head: each is pinned to a patch of the simulated Body surface (a "rivet"), so
 * when the flesh wobbles they move and tilt with it instead of floating off or sinking in. The eyes also look around.
 */
import * as THREE from "three";

export interface Rivet {
  /** Drives the attached geometry; its world matrix is identity at rest. */
  bone: THREE.Bone;
  /** Welded Body vertices of the patch and their weights (sum 1). */
  verts: Uint32Array;
  weights: Float32Array;
  /** Patch triangles (welded indices), for the patch normal. */
  tris: Uint32Array;
  c0: THREE.Vector3;
  n0: THREE.Vector3;
  /** Tilt with the patch normal (eyes) or only turn with the head (mouth, so it stays in line with the lips). */
  tilt: boolean;
}

/** A rivet at anchor: the Body vertices within radius, weighted towards the anchor. */
export function makeRivet(
  name: string,
  anchor: THREE.Vector3,
  radius: number,
  positions: Float32Array,
  indices: Uint32Array,
  tilt: boolean,
): Rivet {
  const verts: number[] = [];
  const w: number[] = [];
  const p = new THREE.Vector3();
  let best = 0, bestD = Infinity;
  for (let j = 0; j < positions.length / 3; j++) {
    const d = p.fromArray(positions, 3 * j).distanceTo(anchor);
    if (d < bestD) (bestD = d), (best = j);
    if (d < radius) {
      verts.push(j);
      w.push(Math.exp(-((d / (0.5 * radius)) ** 2)));
    }
  }
  if (verts.length < 3) {
    // The anchor is farther from the skin than radius: use the nearest vertex's neighbourhood instead.
    return makeRivet(name, p.fromArray(positions, 3 * best).clone(), radius, positions, indices, tilt);
  }
  const inPatch = new Set(verts);
  const tris: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (inPatch.has(indices[t]) && inPatch.has(indices[t + 1]) && inPatch.has(indices[t + 2])) {
      tris.push(indices[t], indices[t + 1], indices[t + 2]);
    }
  }
  const sum = w.reduce((a, b) => a + b, 0);
  const bone = new THREE.Bone();
  bone.name = name;
  bone.matrixAutoUpdate = false;
  bone.matrixWorldAutoUpdate = false;
  const rivet: Rivet = {
    bone,
    verts: Uint32Array.from(verts),
    weights: Float32Array.from(w, (x) => x / sum),
    tris: Uint32Array.from(tris),
    c0: new THREE.Vector3(),
    n0: new THREE.Vector3(),
    tilt,
  };
  patchFrame(rivet, positions, rivet.c0, rivet.n0);
  return rivet;
}

function patchFrame(r: Rivet, pos: Float32Array, c: THREE.Vector3, n: THREE.Vector3): void {
  c.set(0, 0, 0);
  for (let k = 0; k < r.verts.length; k++) {
    const i = 3 * r.verts[k], w = r.weights[k];
    c.x += pos[i] * w; c.y += pos[i + 1] * w; c.z += pos[i + 2] * w;
  }
  n.set(0, 0, 0);
  const t = r.tris;
  for (let k = 0; k < t.length; k += 3) {
    const a = 3 * t[k], b = 3 * t[k + 1], d = 3 * t[k + 2];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
    n.x += uy * vz - uz * vy; n.y += uz * vx - ux * vz; n.z += ux * vy - uy * vx;
  }
  n.normalize();
}

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _n0 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** Place the rivet on the deformed surface; headTurn is the head bone's rotation relative to rest. */
export function updateRivet(r: Rivet, pos: Float32Array, headTurn: THREE.Quaternion): void {
  patchFrame(r, pos, _c, _n);
  _q.copy(headTurn);
  if (r.tilt && r.tris.length) {
    _n0.copy(r.n0).applyQuaternion(headTurn);
    _qa.setFromUnitVectors(_n0, _n);
    _q.premultiply(_qa);
  }
  // world = T(c) · R · T(−c0)
  const m = r.bone.matrixWorld;
  m.makeRotationFromQuaternion(_q);
  _m.makeTranslation(-r.c0.x, -r.c0.y, -r.c0.z);
  m.multiply(_m);
  m.elements[12] += _c.x;
  m.elements[13] += _c.y;
  m.elements[14] += _c.z;
}

/** One eye: its rivet, the gaze bone that turns the iris and pupil, and its rest geometry. */
export interface Eye {
  rivet: Rivet;
  gaze: THREE.Bone;
  /** Rest centre and outward looking direction. */
  center: THREE.Vector3;
  forward: THREE.Vector3;
  /** Current gaze rotation (rest frame). */
  turn: THREE.Quaternion;
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3×3 matrix (Jacobi rotations). */
function smallestAxis(a: number[][]): { axis: THREE.Vector3; ratio: number } {
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const m = a.map((r) => r.slice());
  for (let sweep = 0; sweep < 20; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(m[p][q]) < 1e-14) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const mkp = m[k][p], mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq;
        m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p][k], mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk;
        m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const ev = [m[0][0], m[1][1], m[2][2]];
  const order = [0, 1, 2].sort((x, y) => ev[x] - ev[y]);
  const i = order[0];
  return { axis: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize(), ratio: ev[i] / Math.max(ev[order[1]], 1e-12) };
}

/**
 * Build one eye from its rest vertices (world): the centre is the middle of its bounds; it looks along its flattest
 * axis (cartoon eyes are discs), or along the skin normal when it is round. Returns per-vertex gaze weights: the
 * middle of the eye (iris and pupil) turns, the rim stays put.
 */
export function makeEye(
  rivet: Rivet,
  name: string,
  points: Float32Array,
  verts: number[],
  headCenter: THREE.Vector3,
): { eye: Eye; gazeWeight: Map<number, number> } {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const i of verts) box.expandByPoint(p.fromArray(points, 3 * i));
  const center = box.getCenter(new THREE.Vector3());
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const i of verts) {
    p.fromArray(points, 3 * i).sub(center);
    const a = [p.x, p.y, p.z];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += a[r] * a[c];
  }
  const { axis, ratio } = smallestAxis(cov);
  const forward = ratio < 0.7 ? axis : rivet.n0.clone();
  if (forward.dot(p.copy(center).sub(headCenter)) < 0) forward.negate();
  let reach = 0;
  const lateral = new Float32Array(verts.length);
  verts.forEach((i, k) => {
    p.fromArray(points, 3 * i).sub(center);
    p.addScaledVector(forward, -p.dot(forward));
    lateral[k] = p.length();
    reach = Math.max(reach, lateral[k]);
  });
  const gazeWeight = new Map<number, number>();
  verts.forEach((i, k) => {
    const x = (lateral[k] / reach - 0.5) / 0.32;
    const s = Math.min(1, Math.max(0, x));
    gazeWeight.set(i, 1 - s * s * (3 - 2 * s));
  });
  const gaze = new THREE.Bone();
  gaze.name = name;
  gaze.matrixAutoUpdate = false;
  gaze.matrixWorldAutoUpdate = false;
  return { eye: { rivet, gaze, center, forward, turn: new THREE.Quaternion() }, gazeWeight };
}

const _dir = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _goal = new THREE.Quaternion();
const _ctr = new THREE.Vector3();
const _piv = new THREE.Matrix4();

/** Furthest the iris turns from straight ahead (radians). */
export const GAZE_LIMIT = 0.42;

/**
 * Turn the eye towards target (world) plus an extra offset (yaw/pitch around the eye's own axes, radians), easing
 * by rate (1/s). The rivet must already be on the surface for this frame.
 */
export function aimEye(
  eye: Eye,
  target: THREE.Vector3,
  extraYaw: number,
  extraPitch: number,
  rate: number,
  dt: number,
): void {
  const rw = eye.rivet.bone.matrixWorld;
  _rot.setFromRotationMatrix(rw);
  _ctr.copy(eye.center).applyMatrix4(rw);
  // Target direction in the eye's rest frame.
  _dir.copy(target).sub(_ctr).applyQuaternion(_rot.invert()).normalize();
  const angle = eye.forward.angleTo(_dir);
  if (angle > GAZE_LIMIT) {
    // Look as far as the eye can towards it.
    _goal.setFromUnitVectors(eye.forward, _dir);
    _goal.slerp(new THREE.Quaternion(), 1 - GAZE_LIMIT / angle);
  } else _goal.setFromUnitVectors(eye.forward, _dir);
  if (extraYaw || extraPitch) {
    const side = _ctr.set(0, 1, 0).cross(eye.forward).normalize();
    _rot.setFromAxisAngle(side, -extraPitch);
    _goal.premultiply(_rot);
    _rot.setFromAxisAngle(_dir.set(0, 1, 0), extraYaw);
    _goal.premultiply(_rot);
  }
  eye.turn.slerp(_goal, 1 - Math.exp(-rate * dt));
  // gaze world = rivet · T(c) · turn · T(−c)
  const g = eye.gaze.matrixWorld;
  g.makeTranslation(eye.center.x, eye.center.y, eye.center.z);
  g.multiply(_piv.makeRotationFromQuaternion(eye.turn));
  g.multiply(_piv.makeTranslation(-eye.center.x, -eye.center.y, -eye.center.z));
  g.premultiply(rw);
}
