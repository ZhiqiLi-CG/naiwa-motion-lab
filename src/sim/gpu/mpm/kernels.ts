/**
 * MLS-MPM (Hu et al. 2018, "A moving least squares material point method") for the flesh, on the CPU. The WebGPU
 * backend runs the same kernels in WGSL (shaders.ts), on the same memory layout (layout.ts).
 *
 * One substep:
 *   p2g   free particles scatter mass and APIC momentum, with their neo-Hookean + viscous stress folded in; attached
 *         particles (riding a rigid body) scatter their mass and the body's velocity separately
 *   grid  velocity = momentum / mass + gravity; where attached mass dominates, the node moves with the bodies and the
 *         impulse that takes goes back to them; then contacts: floor, limbs' flesh (capsules) and balls
 *   g2p   free particles gather velocity and C (≈ ∇v), update F = (I + dt C) F and move; attached ones gather the
 *         impulse they gave the free flesh, and move with their body
 *
 * Units: masses in particle masses (the backends convert impulses to kg·m/s), lengths in metres, stress in Pa.
 */
import { EMBED_K } from "./embedding";
import { B, E, EDIT, G, K, KIND_SPHERE, NODE_IN, NODE_OUT, P, S, ACC } from "./layout";

export interface CpuArrays {
  pf: Float32Array;
  pi: Int32Array;
  /** MAX_SUBSTEPS × S.WORDS (ints through stepsI). */
  steps: Float32Array;
  stepsI: Int32Array;
  grids: Float32Array;
  gridsI: Int32Array;
  bodies: Float32Array;
  colliders: Float32Array;
  edits: Float32Array;
  editsI: Int32Array;
  /** Shared: each node's new velocity and bone impulse (NODE_OUT words). */
  gridOut: Float32Array;
  restWords: Float32Array;
  vertexRest: Float32Array;
  embedIndex: Uint32Array;
  embedWeight: Float32Array;
}

/* Quadratic B-spline weights of a particle at grid coordinate g (in cells): base node and three weights per axis. */
const wx = new Float64Array(3), wy = new Float64Array(3), wz = new Float64Array(3);
function weights(g: number, w: Float64Array, n: number): number {
  const base = Math.min(n - 3, Math.max(0, Math.floor(g - 0.5)));
  const f = g - base;
  w[0] = 0.5 * (1.5 - f) ** 2;
  w[1] = 0.75 - (f - 1) ** 2;
  w[2] = 0.5 * (f - 0.5) ** 2;
  return base;
}

/** Position of an attached particle at time t ∈ [0, 1] of the frame (its body's start and end poses, interpolated
 *  linearly: the particle moves at constant velocity through the frame). */
function riding(a: CpuArrays, o: number, t: number, out: Float64Array) {
  const bo = a.pi[o + P.INFO + 1] * B.STRIDE, bf = a.bodies, lx = a.pf[o + P.LOC], ly = a.pf[o + P.LOC + 1], lz = a.pf[o + P.LOC + 2];
  for (let k = 0; k < 3; k++) {
    const x0 = bf[bo + k] * lx + bf[bo + 4 + k] * ly + bf[bo + 8 + k] * lz + bf[bo + 12 + k];
    const m1 = bo + B.M1;
    const x1 = bf[m1 + k] * lx + bf[m1 + 4 + k] * ly + bf[m1 + 8 + k] * lz + bf[m1 + 12 + k];
    out[k] = x0 + (x1 - x0) * t;
    out[3 + k] = x1 - x0;
  }
}
const ride = new Float64Array(6);

/** Apply the frame's coalesced edits (single-threaded, before the substeps). */
export function applyEdits(a: CpuArrays, count: number) {
  const { pf, pi, edits, editsI, bodies } = a;
  for (let e = 0; e < count; e++) {
    const eo = e * E.STRIDE, flags = editsI[eo + E.FLAGS], o = editsI[eo + E.INDEX] * P.STRIDE;
    if (flags & EDIT.DETACH && pi[o + P.INFO + 1] >= 0) {
      // It keeps the velocity and F it had riding the body (g2p keeps both current); its affine motion restarts.
      pi[o + P.INFO + 1] = -1;
      pi[o + P.INFO + 2] = 0;
      for (let k = 0; k < 12; k++) pf[o + P.C + k] = 0;
    }
    if (flags & EDIT.SET_POS) for (let k = 0; k < 3; k++) pf[o + P.X + k] = edits[eo + E.POS + k];
    if (flags & EDIT.SET_VEL) for (let k = 0; k < 3; k++) pf[o + P.V + k] = edits[eo + E.VEL + k];
    else if (flags & EDIT.ADD_VEL && pi[o + P.INFO + 1] < 0) for (let k = 0; k < 3; k++) pf[o + P.V + k] += edits[eo + E.VEL + k];
    if (flags & EDIT.ATTACH) {
      const body = editsI[eo + E.BODY] & 0xffff, splat = editsI[eo + E.BODY] >>> 16;
      const bo = body * B.STRIDE;
      // Local frame of the body at the frame's start: local = Rᵀ (x − t), FL = Rᵀ F.
      const dx = pf[o] - bodies[bo + 12], dy = pf[o + 1] - bodies[bo + 13], dz = pf[o + 2] - bodies[bo + 14];
      for (let r = 0; r < 3; r++) {
        const c = bo + 4 * r; // column r of R is row r of Rᵀ
        pf[o + P.LOC + r] = bodies[c] * dx + bodies[c + 1] * dy + bodies[c + 2] * dz;
        for (let col = 0; col < 3; col++) {
          const f = o + P.F + 4 * col;
          pf[o + P.FL + 4 * col + r] = bodies[c] * pf[f] + bodies[c + 1] * pf[f + 1] + bodies[c + 2] * pf[f + 2];
        }
      }
      pi[o + P.INFO + 1] = body;
      pi[o + P.INFO + 2] = splat;
    }
  }
}

/** A throw: every free particle gains dv. */
export function addVelocity(a: CpuArrays, order: Int32Array, from: number, to: number, dv: ArrayLike<number>) {
  for (let k = from; k < to; k++) {
    const o = order[k] * P.STRIDE;
    if (a.pi[o + P.INFO + 1] >= 0) continue;
    a.pf[o + P.V] += dv[0];
    a.pf[o + P.V + 1] += dv[1];
    a.pf[o + P.V + 2] += dv[2];
  }
}

/**
 * Scatter particles order[from..to) into this worker's private grid `gin`. Returns the touched node range
 * (lo, hi inclusive) in `range`.
 */
export function p2g(a: CpuArrays, s: number, order: Int32Array, from: number, to: number, gin: Float32Array, range: Int32Array) {
  const { pf, pi, steps, grids, gridsI } = a;
  const so = s * S.WORDS, dt = steps[so + S.DT], t0 = steps[so + S.T0], frameDt = steps[so + S.FRAME_DT];
  let lo = 0x7fffffff, hi = -1;
  for (let k = from; k < to; k++) {
    const o = order[k] * P.STRIDE, g = pi[o + P.INFO];
    if (g < 0) continue;
    const go = g * G.STRIDE, dx = grids[go + G.DX], inv = 1 / dx, n = gridsI[go + G.NX], off = gridsI[go + G.OFFSET];
    const attached = pi[o + P.INFO + 1] >= 0;
    if (attached && pi[o + P.INFO + 2] === 0) continue;
    let x: number, y: number, z: number, vx: number, vy: number, vz: number;
    // Affine part of the momentum each node receives: A (x_node − x_p), A = C − dt·(4/dx²)·(V₀/m)·τ.
    let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
    if (attached) {
      riding(a, o, t0, ride);
      x = ride[0]; y = ride[1]; z = ride[2];
      vx = ride[3] / frameDt; vy = ride[4] / frameDt; vz = ride[5] / frameDt;
    } else {
      x = pf[o]; y = pf[o + 1]; z = pf[o + 2];
      vx = pf[o + P.V]; vy = pf[o + P.V + 1]; vz = pf[o + P.V + 2];
      const tau = kirchhoff(a, o, go, steps[so + S.REGION + pi[o + P.INFO + 3]]);
      const q = -dt * 4 * inv * inv * grids[go + G.INV_RHO];
      const c = o + P.C;
      // C[r][c] lives at P.C + 4c + r (column-major).
      a00 = pf[c] + q * tau[0]; a01 = pf[c + 4] + q * tau[1]; a02 = pf[c + 8] + q * tau[2];
      a10 = pf[c + 1] + q * tau[3]; a11 = pf[c + 5] + q * tau[4]; a12 = pf[c + 9] + q * tau[5];
      a20 = pf[c + 2] + q * tau[6]; a21 = pf[c + 6] + q * tau[7]; a22 = pf[c + 10] + q * tau[8];
    }
    const gx = (x - grids[go]) * inv, gy = (y - grids[go + 1]) * inv, gz = (z - grids[go + 2]) * inv;
    const bx = weights(gx, wx, n), by = weights(gy, wy, n), bz = weights(gz, wz, n);
    for (let i = 0; i < 3; i++) {
      const dxp = (bx + i - gx) * dx;
      for (let j = 0; j < 3; j++) {
        const dyp = (by + j - gy) * dx, wij = wx[i] * wy[j];
        const row = off + ((bx + i) * n + by + j) * n + bz;
        for (let l = 0; l < 3; l++) {
          const dzp = (bz + l - gz) * dx, w = wij * wz[l], node = row + l, ni = node * NODE_IN;
          if (node < lo) lo = node;
          if (node > hi) hi = node;
          if (attached) {
            gin[ni + 4] += w;
            gin[ni + 5] += w * vx;
            gin[ni + 6] += w * vy;
            gin[ni + 7] += w * vz;
          } else {
            gin[ni] += w;
            gin[ni + 1] += w * (vx + a00 * dxp + a01 * dyp + a02 * dzp);
            gin[ni + 2] += w * (vy + a10 * dxp + a11 * dyp + a12 * dzp);
            gin[ni + 3] += w * (vz + a20 * dxp + a21 * dyp + a22 * dzp);
          }
        }
      }
    }
  }
  range[0] = lo;
  range[1] = hi;
}

/** Kirchhoff stress τ = J σ of the particle (row-major 3×3): compressible neo-Hookean, μ (F Fᵀ − I) + λ ln J · I,
 *  on F scaled to the rest volume, plus Kelvin–Voigt viscosity η J (C + Cᵀ). */
const tau = new Float64Array(9);
function kirchhoff(a: CpuArrays, o: number, go: number, factor: number): Float64Array {
  const { pf, grids } = a;
  const s = grids[go + G.REST_SCALE], mu = grids[go + G.MU] * factor, lambda = grids[go + G.LAMBDA] * factor;
  const f = o + P.F;
  // F[r][c] = pf[f + 4c + r]
  const f00 = s * pf[f], f10 = s * pf[f + 1], f20 = s * pf[f + 2];
  const f01 = s * pf[f + 4], f11 = s * pf[f + 5], f21 = s * pf[f + 6];
  const f02 = s * pf[f + 8], f12 = s * pf[f + 9], f22 = s * pf[f + 10];
  const J = f00 * (f11 * f22 - f12 * f21) - f01 * (f10 * f22 - f12 * f20) + f02 * (f10 * f21 - f11 * f20);
  // Below J = 0.1 the log barrier is held at its value there: a crushed particle pushes back hard, but finitely.
  const p = lambda * Math.log(Math.max(J, 0.1));
  const b00 = f00 * f00 + f01 * f01 + f02 * f02, b01 = f00 * f10 + f01 * f11 + f02 * f12, b02 = f00 * f20 + f01 * f21 + f02 * f22;
  const b11 = f10 * f10 + f11 * f11 + f12 * f12, b12 = f10 * f20 + f11 * f21 + f12 * f22, b22 = f20 * f20 + f21 * f21 + f22 * f22;
  const eta = grids[go + G.ETA] * Math.max(J, 0), c = o + P.C;
  const c00 = pf[c], c10 = pf[c + 1], c20 = pf[c + 2], c01 = pf[c + 4], c11 = pf[c + 5], c21 = pf[c + 6], c02 = pf[c + 8], c12 = pf[c + 9], c22 = pf[c + 10];
  tau[0] = mu * (b00 - 1) + p + 2 * eta * c00;
  tau[4] = mu * (b11 - 1) + p + 2 * eta * c11;
  tau[8] = mu * (b22 - 1) + p + 2 * eta * c22;
  tau[1] = tau[3] = mu * b01 + eta * (c01 + c10);
  tau[2] = tau[6] = mu * b02 + eta * (c02 + c20);
  tau[5] = tau[7] = mu * b12 + eta * (c12 + c21);
  return tau;
}

/**
 * The grid step for nodes [from, to). `gin` holds their scattered sums (NODE_IN words per node, node `base` first:
 * the workers' private grids summed). Writes gridOut.
 */
export function gridUpdate(a: CpuArrays, s: number, from: number, to: number, gin: Float32Array, base: number) {
  const { steps, stepsI, gridsI, gridOut } = a;
  const so = s * S.WORDS, dt = steps[so + S.DT];
  const gvx = steps[so + S.GRAVITY] * dt, gvy = steps[so + S.GRAVITY + 1] * dt, gvz = steps[so + S.GRAVITY + 2] * dt;
  const nGrids = stepsI[so + S.COUNTS + 3];
  let g = 0;
  for (let node = from; node < to; node++) {
    const out = node * NODE_OUT, ni = (node - base) * NODE_IN;
    const m = gin[ni];
    if (!(m > 1e-9)) {
      for (let k = 0; k < NODE_OUT; k++) gridOut[out + k] = 0;
      continue;
    }
    while (g + 1 < nGrids && node >= gridsI[(g + 1) * G.STRIDE + G.OFFSET]) g++;
    while (g > 0 && node < gridsI[g * G.STRIDE + G.OFFSET]) g--;
    let vx = gin[ni + 1] / m + gvx, vy = gin[ni + 2] / m + gvy, vz = gin[ni + 3] / m + gvz;
    // Bones: where attached mass makes up half the node or more it moves with them; the impulse that takes is theirs.
    let jx = 0, jy = 0, jz = 0;
    const ma = gin[ni + 4];
    if (ma > 1e-9) {
      const bind = Math.min(1, (2 * ma) / (ma + m));
      const ux = vx + bind * (gin[ni + 5] / ma - vx), uy = vy + bind * (gin[ni + 6] / ma - vy), uz = vz + bind * (gin[ni + 7] / ma - vz);
      jx = (m * (vx - ux)) / ma; jy = (m * (vy - uy)) / ma; jz = (m * (vz - uz)) / ma;
      vx = ux; vy = uy; vz = uz;
    }
    gridOut[out] = vx; gridOut[out + 1] = vy; gridOut[out + 2] = vz; gridOut[out + 3] = 1;
    gridOut[out + 4] = jx; gridOut[out + 5] = jy; gridOut[out + 6] = jz; gridOut[out + 7] = 0;
  }
}

/** Velocity v against a surface with normal n moving at vc: the part into it removed, friction μ on the rest.
 *  Result in `hit`; false when v was not moving into it. */
const hit = new Float64Array(3);
function collide(vx: number, vy: number, vz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, mu: number): boolean {
  let rx = vx - cx, ry = vy - cy, rz = vz - cz;
  const vn = rx * nx + ry * ny + rz * nz;
  if (vn >= 0) return false;
  rx -= vn * nx; ry -= vn * ny; rz -= vn * nz;
  const t = Math.hypot(rx, ry, rz);
  const keep = t <= -mu * vn ? 0 : 1 + (mu * vn) / t;
  hit[0] = cx + rx * keep; hit[1] = cy + ry * keep; hit[2] = cz + rz * keep;
  return true;
}

/** The contacts of free particle o (velocity at P.V, position at the substep's start) over this substep: velocity
 *  into a surface removed, friction along it, the impulse (particle masses · m/s) to what it touched. */
function contacts(a: CpuArrays, s: number, o: number, g: number, radius: number, acc: Float64Array) {
  const { pf, steps, stepsI, colliders } = a;
  const so = s * S.WORDS, dt = steps[so + S.DT], t1 = steps[so + S.T1], frameDt = steps[so + S.FRAME_DT];
  let vx = pf[o + P.V], vy = pf[o + P.V + 1], vz = pf[o + P.V + 2];
  // Where it would end the substep: the test point.
  const x = pf[o] + dt * vx, y = pf[o + 1] + dt * vy, z = pf[o + 2] + dt * vz;
  if (y < radius && vy < 0) {
    collide(vx, vy, vz, 0, 0, 0, 0, 1, 0, steps[so + S.FLOOR_FRICTION]);
    vx = hit[0]; vy = hit[1]; vz = hit[2];
    acc[ACC.FLOOR + g] += 1;
  }
  const n = stepsI[so + S.COUNTS + 2];
  for (let c = 0; c < n; c++) {
    const co = c * K.STRIDE;
    if (!((colliders[co + K.MASK] >> g) & 1)) continue;
    const ax = colliders[co] + (colliders[co + K.A1] - colliders[co]) * t1, ay = colliders[co + 1] + (colliders[co + K.A1 + 1] - colliders[co + 1]) * t1;
    const az = colliders[co + 2] + (colliders[co + K.A1 + 2] - colliders[co + 2]) * t1;
    const bx = colliders[co + K.B0] + (colliders[co + K.B1] - colliders[co + K.B0]) * t1, by = colliders[co + K.B0 + 1] + (colliders[co + K.B1 + 1] - colliders[co + K.B0 + 1]) * t1;
    const bz = colliders[co + K.B0 + 2] + (colliders[co + K.B1 + 2] - colliders[co + K.B0 + 2]) * t1;
    let u = 0;
    if (colliders[co + K.KIND] !== KIND_SPHERE) {
      const ex = bx - ax, ey = by - ay, ez = bz - az, ee = ex * ex + ey * ey + ez * ez;
      u = ee > 1e-12 ? Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / ee)) : 0;
    }
    const px = x - (ax + (bx - ax) * u), py = y - (ay + (by - ay) * u), pz = z - (az + (bz - az) * u);
    const d = Math.hypot(px, py, pz);
    if (d >= colliders[co + K.R] + radius || d < 1e-9) continue;
    // The shape's velocity there: its ends move straight through the frame.
    const cvx = ((colliders[co + K.A1] - colliders[co]) * (1 - u) + (colliders[co + K.B1] - colliders[co + K.B0]) * u) / frameDt;
    const cvy = ((colliders[co + K.A1 + 1] - colliders[co + 1]) * (1 - u) + (colliders[co + K.B1 + 1] - colliders[co + K.B0 + 1]) * u) / frameDt;
    const cvz = ((colliders[co + K.A1 + 2] - colliders[co + 2]) * (1 - u) + (colliders[co + K.B1 + 2] - colliders[co + K.B0 + 2]) * u) / frameDt;
    if (!collide(vx, vy, vz, cvx, cvy, cvz, px / d, py / d, pz / d, colliders[co + K.FRICTION])) continue;
    const ix = vx - hit[0], iy = vy - hit[1], iz = vz - hit[2], ao = ACC.COLLIDER + c * 8;
    acc[ao] += ix; acc[ao + 1] += iy; acc[ao + 2] += iz;
    acc[ao + 3] += y * iz - z * iy; acc[ao + 4] += z * ix - x * iz; acc[ao + 5] += x * iy - y * ix;
    acc[ao + 6] += 1;
    vx = hit[0]; vy = hit[1]; vz = hit[2];
  }
  pf[o + P.V] = vx; pf[o + P.V + 1] = vy; pf[o + P.V + 2] = vz;
}

/** Gather particles order[from..to) from the grid and move them. */
export function g2p(a: CpuArrays, s: number, order: Int32Array, from: number, to: number, acc: Float64Array) {
  const { pf, pi, steps, grids, gridsI, gridOut, bodies } = a;
  const so = s * S.WORDS, dt = steps[so + S.DT], t0 = steps[so + S.T0], t1 = steps[so + S.T1], frameDt = steps[so + S.FRAME_DT];
  for (let k = from; k < to; k++) {
    const o = order[k] * P.STRIDE, g = pi[o + P.INFO], body = pi[o + P.INFO + 1];
    if (body >= 0) {
      if (g >= 0 && pi[o + P.INFO + 2] !== 0) {
        // The impulse this particle's share of each node gave the free flesh (same weights as its scatter).
        riding(a, o, t0, ride);
        const go = g * G.STRIDE, inv = 1 / grids[go + G.DX], n = gridsI[go + G.NX], off = gridsI[go + G.OFFSET];
        const bx = weights((ride[0] - grids[go]) * inv, wx, n), by = weights((ride[1] - grids[go + 1]) * inv, wy, n);
        const bz = weights((ride[2] - grids[go + 2]) * inv, wz, n);
        let rx = 0, ry = 0, rz = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let l = 0; l < 3; l++) {
          const w = wx[i] * wy[j] * wz[l], no = (off + ((bx + i) * n + by + j) * n + bz + l) * NODE_OUT;
          rx += w * gridOut[no + 4]; ry += w * gridOut[no + 5]; rz += w * gridOut[no + 6];
        }
        pf[o + P.REACT] += rx; pf[o + P.REACT + 1] += ry; pf[o + P.REACT + 2] += rz;
      }
      riding(a, o, t1, ride);
      pf[o] = ride[0]; pf[o + 1] = ride[1]; pf[o + 2] = ride[2];
      pf[o + P.V] = ride[3] / frameDt; pf[o + P.V + 1] = ride[4] / frameDt; pf[o + P.V + 2] = ride[5] / frameDt;
      // F = R₁ FL (the body's rotation at the frame's end), J = det FL.
      const m1 = body * B.STRIDE + B.M1;
      for (let col = 0; col < 3; col++) {
        const l = o + P.FL + 4 * col;
        for (let r = 0; r < 3; r++) pf[o + P.F + 4 * col + r] = bodies[m1 + r] * pf[l] + bodies[m1 + 4 + r] * pf[l + 1] + bodies[m1 + 8 + r] * pf[l + 2];
      }
      pf[o + 3] = det3(pf, o + P.FL);
      continue;
    }
    if (g < 0) continue;
    const go = g * G.STRIDE, dx = grids[go + G.DX], inv = 1 / dx, n = gridsI[go + G.NX], off = gridsI[go + G.OFFSET];
    const gx = (pf[o] - grids[go]) * inv, gy = (pf[o + 1] - grids[go + 1]) * inv, gz = (pf[o + 2] - grids[go + 2]) * inv;
    const bx = weights(gx, wx, n), by = weights(gy, wy, n), bz = weights(gz, wz, n);
    let vx = 0, vy = 0, vz = 0;
    let b00 = 0, b01 = 0, b02 = 0, b10 = 0, b11 = 0, b12 = 0, b20 = 0, b21 = 0, b22 = 0;
    for (let i = 0; i < 3; i++) {
      const dxp = (bx + i - gx) * dx;
      for (let j = 0; j < 3; j++) {
        const dyp = (by + j - gy) * dx, wij = wx[i] * wy[j], row = off + ((bx + i) * n + by + j) * n + bz;
        for (let l = 0; l < 3; l++) {
          const dzp = (bz + l - gz) * dx, w = wij * wz[l], no = (row + l) * NODE_OUT;
          const ux = w * gridOut[no], uy = w * gridOut[no + 1], uz = w * gridOut[no + 2];
          vx += ux; vy += uy; vz += uz;
          b00 += ux * dxp; b01 += ux * dyp; b02 += ux * dzp;
          b10 += uy * dxp; b11 += uy * dyp; b12 += uy * dzp;
          b20 += uz * dxp; b21 += uz * dyp; b22 += uz * dzp;
        }
      }
    }
    pf[o + P.V] = vx; pf[o + P.V + 1] = vy; pf[o + P.V + 2] = vz;
    // C = B · 4/dx² (for quadratic B-splines), stored column-major.
    const q = 4 * inv * inv, c = o + P.C;
    pf[c] = b00 * q; pf[c + 1] = b10 * q; pf[c + 2] = b20 * q;
    pf[c + 4] = b01 * q; pf[c + 5] = b11 * q; pf[c + 6] = b21 * q;
    pf[c + 8] = b02 * q; pf[c + 9] = b12 * q; pf[c + 10] = b22 * q;
    // F ← (I + dt C) F, column by column.
    const f = o + P.F;
    for (let col = 0; col < 3; col++) {
      const x0 = pf[f + 4 * col], x1 = pf[f + 4 * col + 1], x2 = pf[f + 4 * col + 2];
      pf[f + 4 * col] = x0 + dt * (pf[c] * x0 + pf[c + 4] * x1 + pf[c + 8] * x2);
      pf[f + 4 * col + 1] = x1 + dt * (pf[c + 1] * x0 + pf[c + 5] * x1 + pf[c + 9] * x2);
      pf[f + 4 * col + 2] = x2 + dt * (pf[c + 2] * x0 + pf[c + 6] * x1 + pf[c + 10] * x2);
    }
    // Contacts, particle by particle (a node reaches a cell past the flesh, so contacts on the grid would touch
    // early): the floor, other parts' flesh capsules, balls. A particle is a sphere of half its spacing, dx/4.
    contacts(a, s, o, g, dx / 4, acc);
    vx = pf[o + P.V]; vy = pf[o + P.V + 1]; vz = pf[o + P.V + 2];
    // Kept inside the grid's interior (the stencil must fit): only a part stretched past its grid's margin is held.
    const lo0 = 1.5 * dx, hi0 = (n - 1.5) * dx;
    pf[o] = grids[go] + clamp(pf[o] + dt * vx - grids[go], lo0, hi0);
    pf[o + 1] = grids[go + 1] + clamp(pf[o + 1] + dt * vy - grids[go + 1], lo0, hi0);
    pf[o + 2] = grids[go + 2] + clamp(pf[o + 2] + dt * vz - grids[go + 2], lo0, hi0);
    pf[o + 3] = det3(pf, f);
  }
}

/** Each attached particle's impulse this frame goes to its body: impulse and moment about the origin. */
export function reduceReactions(a: CpuArrays, order: Int32Array, from: number, to: number, acc: Float64Array) {
  const { pf, pi } = a;
  for (let k = from; k < to; k++) {
    const o = order[k] * P.STRIDE, body = pi[o + P.INFO + 1];
    if (body < 0) continue;
    const rx = pf[o + P.REACT], ry = pf[o + P.REACT + 1], rz = pf[o + P.REACT + 2];
    if (rx === 0 && ry === 0 && rz === 0) continue;
    const x = pf[o], y = pf[o + 1], z = pf[o + 2], bo = ACC.BODY + body * 8;
    acc[bo] += rx; acc[bo + 1] += ry; acc[bo + 2] += rz;
    acc[bo + 3] += y * rz - z * ry; acc[bo + 4] += z * rx - x * rz; acc[bo + 5] += x * ry - y * rx;
    pf[o + P.REACT] = pf[o + P.REACT + 1] = pf[o + P.REACT + 2] = 0;
  }
}

/** Copy particles order[from..to) to the output: positions (x, y, z, J), velocities. */
export function pack(a: CpuArrays, order: Int32Array, from: number, to: number, positions: Float32Array, velocities: Float32Array) {
  const { pf } = a;
  for (let k = from; k < to; k++) {
    const i = order[k], o = i * P.STRIDE;
    for (let c = 0; c < 4; c++) positions[i * 4 + c] = pf[o + c];
    velocities[i * 4] = pf[o + P.V]; velocities[i * 4 + 1] = pf[o + P.V + 1]; velocities[i * 4 + 2] = pf[o + P.V + 2]; velocities[i * 4 + 3] = 0;
  }
}

/** The embedded surface for vertices [from, to): x = Σ w_p (x_p + F_p (X − X_p)). */
export function embedSurface(a: CpuArrays, from: number, to: number, surface: Float32Array) {
  const { pf, restWords, vertexRest, embedIndex, embedWeight } = a;
  for (let v = from; v < to; v++) {
    let x = 0, y = 0, z = 0;
    const X = vertexRest[v * 4], Y = vertexRest[v * 4 + 1], Z = vertexRest[v * 4 + 2];
    for (let k = 0; k < EMBED_K; k++) {
      const w = embedWeight[v * EMBED_K + k];
      if (w === 0) continue;
      const p = embedIndex[v * EMBED_K + k], o = p * P.STRIDE, f = o + P.F;
      const dx = X - restWords[p * 4], dy = Y - restWords[p * 4 + 1], dz = Z - restWords[p * 4 + 2];
      x += w * (pf[o] + pf[f] * dx + pf[f + 4] * dy + pf[f + 8] * dz);
      y += w * (pf[o + 1] + pf[f + 1] * dx + pf[f + 5] * dy + pf[f + 9] * dz);
      z += w * (pf[o + 2] + pf[f + 2] * dx + pf[f + 6] * dy + pf[f + 10] * dz);
    }
    surface[v * 4] = x; surface[v * 4 + 1] = y; surface[v * 4 + 2] = z; surface[v * 4 + 3] = 1;
  }
}

function det3(m: Float32Array, o: number): number {
  return m[o] * (m[o + 5] * m[o + 10] - m[o + 9] * m[o + 6]) - m[o + 4] * (m[o + 1] * m[o + 10] - m[o + 9] * m[o + 2])
    + m[o + 8] * (m[o + 1] * m[o + 6] - m[o + 5] * m[o + 2]);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
