/**
 * Flesh that rides on a bone becomes part of that rigid body: its mass and inertia are added to the body's, so Rapier
 * moves the bone and its flesh together, implicitly (joints and motors see the true load). Feeding the flesh's
 * inertia back as impulses a step late instead is the classic added-mass instability of partitioned coupling: it
 * diverges as soon as the flesh outweighs the bone, as it does around the hips.
 */
import type RAPIER from "@dimforge/rapier3d-compat";

interface Own {
  m0: number;
  c0: [number, number, number];
  I0: number[];
}

interface Carried {
  body: RAPIER.RigidBody;
  /** The body's own mass properties before any flesh (mass, centre of mass, inertia tensor about it), read at the
   *  first flush: Rapier computes them in the world's first step, before which mass() reads 0. */
  own: Own | null;
  /** Flesh on it, in its frame: Σm, Σm·x, Σm·x xᵀ (xx, yy, zz, xy, xz, yz). */
  m: number;
  first: [number, number, number];
  second: [number, number, number, number, number, number];
  dirty: boolean;
}

export class CarriedMass {
  private bodies = new Map<number, Carried>();

  /** Add (or with m < 0 remove) point mass m at x in the body's frame. */
  add(body: RAPIER.RigidBody, x: number, y: number, z: number, m: number) {
    if (!body.isDynamic()) return;
    let c = this.bodies.get(body.handle);
    if (!c) this.bodies.set(body.handle, (c = { body, own: null, m: 0, first: [0, 0, 0], second: [0, 0, 0, 0, 0, 0], dirty: false }));
    c.m += m;
    c.first[0] += m * x; c.first[1] += m * y; c.first[2] += m * z;
    const s = c.second;
    s[0] += m * x * x; s[1] += m * y * y; s[2] += m * z * z; s[3] += m * x * y; s[4] += m * x * z; s[5] += m * y * z;
    c.dirty = true;
  }

  /** Total flesh mass on a body (kg). */
  carried(body: RAPIER.RigidBody): number {
    return this.bodies.get(body.handle)?.m ?? 0;
  }

  /** Hand the changed bodies their new mass properties. */
  flush() {
    for (const c of this.bodies.values()) {
      if (!c.dirty) continue;
      c.dirty = false;
      const o = (c.own ??= own(c.body));
      const M = o.m0 + c.m;
      const com = [0, 1, 2].map((k) => (o.m0 * o.c0[k] + c.first[k]) / M) as [number, number, number];
      // Inertia about the new centre: the body's own (shifted) plus the flesh's point masses (from their moments).
      const I = o.I0.slice();
      shift(I, o.m0, o.c0[0] - com[0], o.c0[1] - com[1], o.c0[2] - com[2]);
      const [mx, my, mz] = c.first, s = c.second;
      // Second moments of the flesh about com: S' = S − com·firstᵀ − first·comᵀ + m·com·comᵀ.
      const sxx = s[0] - 2 * com[0] * mx + c.m * com[0] ** 2, syy = s[1] - 2 * com[1] * my + c.m * com[1] ** 2;
      const szz = s[2] - 2 * com[2] * mz + c.m * com[2] ** 2;
      const sxy = s[3] - com[0] * my - mx * com[1] + c.m * com[0] * com[1];
      const sxz = s[4] - com[0] * mz - mx * com[2] + c.m * com[0] * com[2];
      const syz = s[5] - com[1] * mz - my * com[2] + c.m * com[1] * com[2];
      // Point-mass inertia = tr(S') I − S'.
      I[0] += syy + szz; I[4] += sxx + szz; I[8] += sxx + syy;
      I[1] -= sxy; I[3] -= sxy; I[2] -= sxz; I[6] -= sxz; I[5] -= syz; I[7] -= syz;
      const { values, frame } = principal(I);
      c.body.setAdditionalMassProperties(M, { x: com[0], y: com[1], z: com[2] }, { x: values[0], y: values[1], z: values[2] }, frame, true);
    }
  }

  /** Give the bodies back their own mass properties. */
  restore() {
    for (const c of this.bodies.values()) {
      if (!c.own) continue;
      c.m = 0;
      c.first = [0, 0, 0];
      c.second = [0, 0, 0, 0, 0, 0];
      c.dirty = true;
    }
    this.flush();
    this.bodies.clear();
  }
}

function own(body: RAPIER.RigidBody): Own {
  const c = body.localCom(), p = body.principalInertia(), q = body.principalInertiaLocalFrame();
  const R = rotation(q);
  const I = new Array(9).fill(0);
  const d = [p.x, p.y, p.z];
  for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) for (let k = 0; k < 3; k++) I[r * 3 + s] += R[r * 3 + k] * d[k] * R[s * 3 + k];
  return { m0: body.mass(), c0: [c.x, c.y, c.z], I0: I };
}

/** Parallel axis: the inertia of mass m about a point d away from its centre. */
function shift(I: number[], m: number, dx: number, dy: number, dz: number) {
  const dd = dx * dx + dy * dy + dz * dz, d = [dx, dy, dz];
  for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) I[r * 3 + s] += m * ((r === s ? dd : 0) - d[r] * d[s]);
}

/** Row-major rotation matrix of a unit quaternion. */
function rotation(q: { x: number; y: number; z: number; w: number }): number[] {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** Principal moments and axes of a symmetric 3×3 (row-major) by Jacobi rotations; the axes as a quaternion. */
export function principal(A: number[]): { values: [number, number, number]; frame: { x: number; y: number; z: number; w: number } } {
  const a = A.slice(), V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[1] ** 2 + a[2] ** 2 + a[5] ** 2;
    if (off < 1e-24 * (a[0] ** 2 + a[4] ** 2 + a[8] ** 2 + 1e-30)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq;
        V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  // Columns of V are the axes; make it a proper rotation.
  const det = V[0] * (V[4] * V[8] - V[5] * V[7]) - V[1] * (V[3] * V[8] - V[5] * V[6]) + V[2] * (V[3] * V[7] - V[4] * V[6]);
  if (det < 0) for (let k = 0; k < 3; k++) V[k * 3 + 2] = -V[k * 3 + 2];
  return { values: [a[0], a[4], a[8]], frame: quaternion(V) };
}

function quaternion(m: number[]): { x: number; y: number; z: number; w: number } {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}
