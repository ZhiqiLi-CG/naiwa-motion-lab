/**
 * Eyes and mouth riding on the soft head: each is pinned to a patch of the simulated Body surface (a "rivet") and
 * moves and turns as that patch does, its frame taken from the surface vertices themselves (not the head bone), so
 * however the flesh wobbles or sags they neither float off nor sink in. The eyes also look around.
 */
import * as THREE from "three";

export interface Rivet {
  /** Drives the attached geometry; its world matrix is identity at rest. */
  bone: THREE.Bone;
  /** Welded Body vertices of the patch, their weights (sum 1) and rest offsets from the patch centre. */
  verts: Uint32Array;
  weights: Float32Array;
  offsets: Float32Array;
  c0: THREE.Vector3;
  /** Outward normal of the patch at rest. */
  n0: THREE.Vector3;
  /** The patch's rotation from rest (kept between frames to start the next fit from). */
  turn: THREE.Quaternion;
  /**
   * Stretch with the patch too (the mouth inside, so it stays within the lips however the face squashes), else only
   * move and turn (the eyes keep their shape): the inverse of the patch's rest covariance, rigid along the normal.
   */
  stretch: { inv: THREE.Matrix3; eps: number } | null;
}

/** A rivet at anchor: the Body vertices within radius, weighted towards the anchor. */
export function makeRivet(
  name: string,
  anchor: THREE.Vector3,
  radius: number,
  positions: Float32Array,
  indices: Uint32Array,
  stretch: boolean,
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
  if (verts.length < 4) {
    // The anchor is farther from the skin than radius: use the nearest vertex's neighbourhood instead.
    return makeRivet(name, p.fromArray(positions, 3 * best).clone(), radius, positions, indices, stretch);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  const weights = Float32Array.from(w, (x) => x / sum);
  const c0 = new THREE.Vector3();
  verts.forEach((j, k) => c0.addScaledVector(p.fromArray(positions, 3 * j), weights[k]));
  const offsets = new Float32Array(3 * verts.length);
  verts.forEach((j, k) => offsets.set(p.fromArray(positions, 3 * j).sub(c0).toArray(), 3 * k));
  // Rest normal from the patch's own triangles.
  const inPatch = new Set(verts);
  const n0 = new THREE.Vector3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < indices.length; t += 3) {
    if (!inPatch.has(indices[t]) || !inPatch.has(indices[t + 1]) || !inPatch.has(indices[t + 2])) continue;
    a.fromArray(positions, 3 * indices[t]);
    b.fromArray(positions, 3 * indices[t + 1]).sub(a);
    c.fromArray(positions, 3 * indices[t + 2]).sub(a);
    n0.add(b.cross(c));
  }
  n0.normalize();
  let cov: Rivet["stretch"] = null;
  if (stretch) {
    // C = Σ w q qᵀ + ε n nᵀ: a patch of skin is nearly flat, so its thickness is taken as rigid.
    const e = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < verts.length; k++) {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e[3 * c + r] += weights[k] * offsets[3 * k + r] * offsets[3 * k + c];
    }
    const eps = (e[0] + e[4] + e[8]) / 3;
    const n = n0.toArray();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e[3 * c + r] += eps * n[r] * n[c];
    cov = { inv: new THREE.Matrix3().fromArray(e).invert(), eps };
  }
  const bone = new THREE.Bone();
  bone.name = name;
  bone.matrixAutoUpdate = false;
  bone.matrixWorldAutoUpdate = false;
  return { bone, verts: Uint32Array.from(verts), weights, offsets, c0, n0, turn: new THREE.Quaternion(), stretch: cov };
}

const _c = new THREE.Vector3();
const _r = new THREE.Matrix4();
const _w = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _a = new THREE.Matrix3();
/** Largest stretch of a stretching rivet away from its rotation (Frobenius norm of M − R). */
const MAX_STRETCH = 0.5;

/**
 * Place the rivet on the deformed surface: its centre at the patch's centre, its rotation the best rigid fit of the
 * patch's rest offsets to the current ones (Müller et al. 2016, started from last frame's).
 */
export function updateRivet(r: Rivet, pos: Float32Array): void {
  const { verts, weights, offsets } = r;
  _c.set(0, 0, 0);
  for (let k = 0; k < verts.length; k++) {
    const i = 3 * verts[k], w = weights[k];
    _c.x += pos[i] * w; _c.y += pos[i + 1] * w; _c.z += pos[i + 2] * w;
  }
  // A = Σ w (p − c) qᵀ, column-major: column j is Σ w (p − c) q_j.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < verts.length; k++) {
    const i = 3 * verts[k], w = weights[k];
    const px = pos[i] - _c.x, py = pos[i + 1] - _c.y, pz = pos[i + 2] - _c.z;
    for (let j = 0; j < 3; j++) {
      const q = w * offsets[3 * k + j];
      A[3 * j] += px * q; A[3 * j + 1] += py * q; A[3 * j + 2] += pz * q;
    }
  }
  const q = r.turn;
  for (let iter = 0; iter < 8; iter++) {
    const e = _r.makeRotationFromQuaternion(q).elements;
    let ox = 0, oy = 0, oz = 0, dot = 0;
    for (let j = 0; j < 3; j++) {
      const rx = e[4 * j], ry = e[4 * j + 1], rz = e[4 * j + 2];
      const ax = A[3 * j], ay = A[3 * j + 1], az = A[3 * j + 2];
      ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    _w.set(ox, oy, oz).multiplyScalar(1 / (Math.abs(dot) + 1e-12));
    const angle = _w.length();
    if (angle < 1e-7) break;
    q.premultiply(_dq.setFromAxisAngle(_w.divideScalar(angle), angle)).normalize();
  }
  // world = T(c) · M · T(−c0), M the rotation, or the least-squares stretch A·C⁻¹ with the normal kept rigid.
  const m = r.bone.matrixWorld;
  m.makeRotationFromQuaternion(q);
  if (r.stretch) {
    const e = m.elements, n = r.n0, eps = r.stretch.eps;
    const rn = [e[0] * n.x + e[4] * n.y + e[8] * n.z, e[1] * n.x + e[5] * n.y + e[9] * n.z, e[2] * n.x + e[6] * n.y + e[10] * n.z];
    const nn = [n.x, n.y, n.z];
    for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) A[3 * c + row] += eps * rn[row] * nn[c];
    _a.fromArray(A).multiply(r.stretch.inv);
    // Teeth do not stretch far: the stretch beyond the rotation is bounded (a blown-up patch cannot fling them off).
    const a = _a.elements;
    let d2 = 0;
    for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) d2 += (a[3 * c + row] - e[4 * c + row]) ** 2;
    const k = d2 > MAX_STRETCH ** 2 ? MAX_STRETCH / Math.sqrt(d2) : 1;
    for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) e[4 * c + row] += (a[3 * c + row] - e[4 * c + row]) * k;
  }
  m.multiply(_m.makeTranslation(-r.c0.x, -r.c0.y, -r.c0.z));
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
