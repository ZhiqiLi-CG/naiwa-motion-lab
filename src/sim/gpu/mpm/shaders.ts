/**
 * The MLS-MPM kernels in WGSL, line for line the CPU kernels of kernels.ts (read those for the explanations). The
 * differences are the GPU's: scattering adds into the grid with integer atomics in fixed point (WGSL has no float
 * atomics), and the grid step clears the scattered sums it has read, ready for the next substep.
 */
import { EMBED_K } from "./embedding";
import { ACC, ACC_SCALE, EDIT, GRID_SCALE, KIND_SPHERE, MAX_BODIES, MAX_COLLIDERS, MAX_GRIDS } from "./layout";

export const WORKGROUP = 64;

/** Bindings: group 0 uniforms, group 1 storage. */
export const BIND = {
  step: 0, grids: 1, bodies: 2, colliders: 3,
  particles: 0, gridIn: 1, gridOut: 2, acc: 3, edits: 4, restWords: 5, embedIndex: 6, embedWeight: 7, vertexRest: 8, out: 9,
} as const;

/** Storage bindings the kernels only read. */
export const READ_ONLY: readonly number[] = [BIND.edits, BIND.restWords, BIND.embedIndex, BIND.embedWeight, BIND.vertexRest];

/** The bindings each kernel reads or writes (its layout holds exactly these: at most 8 storage buffers a stage). */
export const KERNELS = {
  applyEdits: { g0: [BIND.step, BIND.bodies], g1: [BIND.particles, BIND.edits] },
  addVelocity: { g0: [BIND.step], g1: [BIND.particles] },
  p2g: { g0: [BIND.step, BIND.grids, BIND.bodies], g1: [BIND.particles, BIND.gridIn] },
  gridUpdate: { g0: [BIND.step], g1: [BIND.gridIn, BIND.gridOut] },
  g2p: { g0: [BIND.step, BIND.grids, BIND.bodies, BIND.colliders], g1: [BIND.particles, BIND.gridOut, BIND.acc] },
  reduceReactions: { g0: [BIND.step], g1: [BIND.particles, BIND.acc] },
  pack: { g0: [BIND.step], g1: [BIND.particles, BIND.out] },
  embedSurface: { g0: [BIND.step], g1: [BIND.particles, BIND.restWords, BIND.embedIndex, BIND.embedWeight, BIND.vertexRest, BIND.out] },
} as const;
export type KernelName = keyof typeof KERNELS;

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

export const SHADER = /* wgsl */ `
struct Step {
  dt: f32, t0: f32, t1: f32, frameDt: f32,
  gravity: vec4f,          // xyz, w: floor friction
  counts: vec4u,           // particles, nodes, colliders, grids
  dv: vec4f,               // a throw; w: edits (or vertices for the surface)
  region: array<vec4f, 2>, // stiffness factor per region
}
struct Grid { origin: vec4f, dims: vec4u, mat: vec4f, extra: vec4f }
struct Body { m0: mat4x4f, m1: mat4x4f }
struct Collider { a0: vec4f, b0: vec4f, a1: vec4f, b1: vec4f }
struct Particle {
  x: vec4f, v: vec4f, C: mat3x3f, F: mat3x3f, FL: mat3x3f, local: vec4f, react: vec4f,
  info: vec4i, // grid, body, splats, region
}
struct Edit { index: i32, flags: i32, body: i32, pad: i32, pos: vec4f, vel: vec4f }

@group(0) @binding(${BIND.step}) var<uniform> step: Step;
@group(0) @binding(${BIND.grids}) var<uniform> grids: array<Grid, ${MAX_GRIDS}>;
@group(0) @binding(${BIND.bodies}) var<uniform> bodies: array<Body, ${MAX_BODIES}>;
@group(0) @binding(${BIND.colliders}) var<uniform> colliders: array<Collider, ${MAX_COLLIDERS}>;

@group(1) @binding(${BIND.particles}) var<storage, read_write> particles: array<Particle>;
@group(1) @binding(${BIND.gridIn}) var<storage, read_write> gridIn: array<atomic<i32>>;
@group(1) @binding(${BIND.gridOut}) var<storage, read_write> gridOut: array<vec4f>;
@group(1) @binding(${BIND.acc}) var<storage, read_write> acc: array<atomic<i32>>;
@group(1) @binding(${BIND.edits}) var<storage, read> edits: array<Edit>;
@group(1) @binding(${BIND.restWords}) var<storage, read> restWords: array<vec4f>;
@group(1) @binding(${BIND.embedIndex}) var<storage, read> embedIndex: array<u32>;
@group(1) @binding(${BIND.embedWeight}) var<storage, read> embedWeight: array<f32>;
@group(1) @binding(${BIND.vertexRest}) var<storage, read> vertexRest: array<vec4f>;
@group(1) @binding(${BIND.out}) var<storage, read_write> out: array<vec4f>;

const GRID_SCALE = ${f(GRID_SCALE)};
const ACC_SCALE = ${f(ACC_SCALE)};
const I3 = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);

fn regionFactor(r: i32) -> f32 { return step.region[r / 4][r % 4]; }

struct Ride { x: vec3f, v: vec3f }
fn riding(local: vec3f, body: i32, t: f32) -> Ride {
  let b = bodies[body];
  let l = vec4f(local, 1.0);
  let x0 = (b.m0 * l).xyz;
  let x1 = (b.m1 * l).xyz;
  return Ride(mix(x0, x1, t), (x1 - x0) / step.frameDt);
}

struct Stencil { base: vec3i, f: vec3f, w: array<vec3f, 3> }
fn stencil(x: vec3f, g: Grid) -> Stencil {
  let n = i32(g.dims.x);
  let gp = (x - g.origin.xyz) / g.origin.w;
  let base = clamp(vec3i(floor(gp - 0.5)), vec3i(0), vec3i(n - 3));
  let f = gp - vec3f(base);
  return Stencil(base, f, array<vec3f, 3>(0.5 * (1.5 - f) * (1.5 - f), 0.75 - (f - 1.0) * (f - 1.0), 0.5 * (f - 0.5) * (f - 0.5)));
}
fn nodeOf(g: Grid, c: vec3i) -> i32 { let n = i32(g.dims.x); return i32(g.dims.w) + (c.x * n + c.y) * n + c.z; }
fn addFixed(i: i32, v: f32, scale: f32) { atomicAdd(&gridIn[i], i32(round(v * scale))); }
fn addAcc(i: u32, v: f32) { atomicAdd(&acc[i], i32(round(v * ACC_SCALE))); }

fn kirchhoff(F0: mat3x3f, C: mat3x3f, g: Grid, factor: f32) -> mat3x3f {
  let F = F0 * g.extra.x;
  let J = determinant(F);
  let pressure = g.mat.y * factor * log(max(J, 0.1));
  let eta = g.mat.w * max(J, 0.0);
  return (F * transpose(F) - I3) * (g.mat.x * factor) + I3 * pressure + (C + transpose(C)) * eta;
}

@compute @workgroup_size(${WORKGROUP})
fn applyEdits(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= step.dv.w) { return; }
  let e = edits[id.x];
  var p = particles[e.index];
  if ((e.flags & ${EDIT.DETACH}) != 0 && p.info.y >= 0) {
    p.info.y = -1;
    p.info.z = 0;
    p.C = mat3x3f();
  }
  if ((e.flags & ${EDIT.SET_POS}) != 0) { p.x = vec4f(e.pos.xyz, p.x.w); }
  if ((e.flags & ${EDIT.SET_VEL}) != 0) { p.v = vec4f(e.vel.xyz, p.v.w); }
  else if ((e.flags & ${EDIT.ADD_VEL}) != 0 && p.info.y < 0) { p.v = vec4f(p.v.xyz + e.vel.xyz, p.v.w); }
  if ((e.flags & ${EDIT.ATTACH}) != 0) {
    let b = bodies[e.body & 0xffff];
    let R = mat3x3f(b.m0[0].xyz, b.m0[1].xyz, b.m0[2].xyz);
    p.local = vec4f(transpose(R) * (p.x.xyz - b.m0[3].xyz), 0.0);
    p.FL = transpose(R) * p.F;
    p.info.y = e.body & 0xffff;
    p.info.z = e.body >> 16u;
  }
  particles[e.index] = p;
}

@compute @workgroup_size(${WORKGROUP})
fn addVelocity(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= step.counts.x || particles[id.x].info.y >= 0) { return; }
  particles[id.x].v = vec4f(particles[id.x].v.xyz + step.dv.xyz, 0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn p2g(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= step.counts.x) { return; }
  // Fields one by one: copying the whole 224-byte particle would triple the memory traffic.
  let info = particles[id.x].info;
  if (info.x < 0) { return; }
  let attached = info.y >= 0;
  if (attached && info.z == 0) { return; }
  let g = grids[info.x];
  let dx = g.origin.w;
  var x: vec3f;
  var v: vec3f;
  var A = mat3x3f();
  if (attached) {
    let r = riding(particles[id.x].local.xyz, info.y, step.t0);
    x = r.x;
    v = r.v;
  } else {
    x = particles[id.x].x.xyz;
    v = particles[id.x].v.xyz;
    let C = particles[id.x].C;
    A = C + kirchhoff(particles[id.x].F, C, g, regionFactor(info.w)) * (-step.dt * 4.0 / (dx * dx) * g.mat.z);
  }
  var s = stencil(x, g);
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let w = s.w[a].x * s.w[b].y * s.w[c].z;
        let o = nodeOf(g, s.base + vec3i(a, b, c)) * 8;
        if (attached) {
          addFixed(o + 4, w, GRID_SCALE);
          addFixed(o + 5, w * v.x, GRID_SCALE);
          addFixed(o + 6, w * v.y, GRID_SCALE);
          addFixed(o + 7, w * v.z, GRID_SCALE);
        } else {
          let mv = w * (v + A * ((vec3f(f32(a), f32(b), f32(c)) - s.f) * dx));
          addFixed(o, w, GRID_SCALE);
          addFixed(o + 1, mv.x, GRID_SCALE);
          addFixed(o + 2, mv.y, GRID_SCALE);
          addFixed(o + 3, mv.z, GRID_SCALE);
        }
      }
    }
  }
}

fn collide(v: vec3f, vc: vec3f, n: vec3f, mu: f32) -> vec3f {
  let rel = v - vc;
  let vn = dot(rel, n);
  var t = rel - vn * n;
  let tl = length(t);
  if (tl <= -mu * vn) { t = vec3f(0.0); } else { t = t * (1.0 + mu * vn / tl); }
  return vc + t;
}


@compute @workgroup_size(${WORKGROUP})
fn gridUpdate(@builtin(global_invocation_id) id: vec3u) {
  let node = i32(id.x);
  if (id.x >= step.counts.y) { return; }
  let o = node * 8;
  // Read the sums and clear them for the next substep (plain stores: nothing else touches the node now). Most of
  // a grid is empty margin, left at zero.
  var sums: array<f32, 8>;
  let m = f32(atomicLoad(&gridIn[o])) / GRID_SCALE;
  let ma0 = atomicLoad(&gridIn[o + 4]);
  if (m != 0.0 || ma0 != 0) {
    for (var k = 0; k < 8; k++) {
      sums[k] = f32(atomicLoad(&gridIn[o + k])) / GRID_SCALE;
      atomicStore(&gridIn[o + k], 0);
    }
  }
  if (!(m > 1e-6)) {
    gridOut[node * 2] = vec4f(0.0);
    gridOut[node * 2 + 1] = vec4f(0.0);
    return;
  }
  var v = vec3f(sums[1], sums[2], sums[3]) / m + step.gravity.xyz * step.dt;
  var jn = vec3f(0.0);
  let ma = sums[4];
  if (ma > 1e-6) {
    let bind = min(1.0, 2.0 * ma / (ma + m));
    let u = v + bind * (vec3f(sums[5], sums[6], sums[7]) / ma - v);
    jn = m * (v - u) / ma;
    v = u;
  }
  gridOut[node * 2] = vec4f(v, 1.0);
  gridOut[node * 2 + 1] = vec4f(jn, 0.0);
}

// Contacts of a free particle (radius: half its spacing) over this substep, at where it would end it.
fn contacts(x0: vec3f, v0: vec3f, gi: u32, radius: f32) -> vec3f {
  var v = v0;
  let x = x0 + step.dt * v0;
  if (x.y < radius && v.y < 0.0) {
    v = collide(v, vec3f(0.0), vec3f(0.0, 1.0, 0.0), step.gravity.w);
    atomicAdd(&acc[${ACC.FLOOR}u + gi], 1);
  }
  for (var c = 0u; c < step.counts.z; c++) {
    let k = colliders[c];
    if (((u32(k.a1.w) >> gi) & 1u) == 0u) { continue; }
    let a = mix(k.a0.xyz, k.a1.xyz, step.t1);
    let b = mix(k.b0.xyz, k.b1.xyz, step.t1);
    var u = 0.0;
    if (k.b0.w != ${f(KIND_SPHERE)}) {
      let e = b - a;
      let ee = dot(e, e);
      if (ee > 1e-12) { u = clamp(dot(x - a, e) / ee, 0.0, 1.0); }
    }
    let d3 = x - mix(a, b, u);
    let d = length(d3);
    if (d >= k.a0.w + radius || d < 1e-9) { continue; }
    let cv = mix(k.a1.xyz - k.a0.xyz, k.b1.xyz - k.b0.xyz, u) / step.frameDt;
    let nrm = d3 / d;
    if (dot(v - cv, nrm) >= 0.0) { continue; }
    let after = collide(v, cv, nrm, k.b1.w);
    let imp = v - after;
    let mo = cross(x, imp);
    let ao = ${ACC.COLLIDER}u + c * 8u;
    addAcc(ao, imp.x); addAcc(ao + 1u, imp.y); addAcc(ao + 2u, imp.z);
    addAcc(ao + 3u, mo.x); addAcc(ao + 4u, mo.y); addAcc(ao + 5u, mo.z);
    atomicAdd(&acc[ao + 6u], 1);
    v = after;
  }
  return v;
}

@compute @workgroup_size(${WORKGROUP})
fn g2p(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= step.counts.x) { return; }
  let i = id.x;
  let info = particles[i].info;
  if (info.y >= 0) {
    let local = particles[i].local.xyz;
    if (info.x >= 0 && info.z != 0) {
      let g = grids[info.x];
      var s = stencil(riding(local, info.y, step.t0).x, g);
      var r = vec3f(0.0);
      for (var a = 0; a < 3; a++) {
        for (var b = 0; b < 3; b++) {
          for (var c = 0; c < 3; c++) {
            r += s.w[a].x * s.w[b].y * s.w[c].z * gridOut[nodeOf(g, s.base + vec3i(a, b, c)) * 2 + 1].xyz;
          }
        }
      }
      particles[i].react = vec4f(particles[i].react.xyz + r, 0.0);
    }
    // Position and velocity follow the body; F only matters at the frame's end (the surface).
    let ride = riding(local, info.y, step.t1);
    let FL = particles[i].FL;
    particles[i].x = vec4f(ride.x, determinant(FL));
    particles[i].v = vec4f(ride.v, 0.0);
    if (step.t1 >= 1.0) {
      let m1 = bodies[info.y].m1;
      particles[i].F = mat3x3f(m1[0].xyz, m1[1].xyz, m1[2].xyz) * FL;
    }
    return;
  }
  if (info.x < 0) { return; }
  let g = grids[info.x];
  let dx = g.origin.w;
  let x = particles[i].x.xyz;
  var s = stencil(x, g);
  var v = vec3f(0.0);
  var B = mat3x3f();
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let w = s.w[a].x * s.w[b].y * s.w[c].z;
        let u = w * gridOut[nodeOf(g, s.base + vec3i(a, b, c)) * 2].xyz;
        let d = (vec3f(f32(a), f32(b), f32(c)) - s.f) * dx;
        v += u;
        B += mat3x3f(u * d.x, u * d.y, u * d.z);
      }
    }
  }
  let C = B * (4.0 / (dx * dx));
  let F = (I3 + C * step.dt) * particles[i].F;
  v = contacts(x, v, u32(info.x), dx / 4.0);
  let lo = g.origin.xyz + 1.5 * dx;
  let hi = g.origin.xyz + (f32(g.dims.x) - 1.5) * dx;
  particles[i].C = C;
  particles[i].F = F;
  particles[i].x = vec4f(clamp(x + step.dt * v, lo, hi), determinant(F));
  particles[i].v = vec4f(v, 0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn reduceReactions(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= step.counts.x) { return; }
  let body = particles[id.x].info.y;
  if (body < 0) { return; }
  let r = particles[id.x].react.xyz;
  if (all(r == vec3f(0.0))) { return; }
  let mo = cross(particles[id.x].x.xyz, r);
  let o = ${ACC.BODY}u + u32(body) * 8u;
  addAcc(o, r.x); addAcc(o + 1u, r.y); addAcc(o + 2u, r.z);
  addAcc(o + 3u, mo.x); addAcc(o + 4u, mo.y); addAcc(o + 5u, mo.z);
  particles[id.x].react = vec4f(0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn pack(@builtin(global_invocation_id) id: vec3u) {
  let n = step.counts.x;
  if (id.x >= n) { return; }
  out[id.x] = particles[id.x].x;
  out[n + id.x] = vec4f(particles[id.x].v.xyz, 0.0);
}

@compute @workgroup_size(${WORKGROUP})
fn embedSurface(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= step.dv.w) { return; }
  let X = vertexRest[id.x].xyz;
  var x = vec3f(0.0);
  for (var k = 0u; k < ${EMBED_K}u; k++) {
    let w = embedWeight[id.x * ${EMBED_K}u + k];
    if (w == 0.0) { continue; }
    let i = embedIndex[id.x * ${EMBED_K}u + k];
    x += w * (particles[i].x.xyz + particles[i].F * (X - restWords[i].xyz));
  }
  out[2u * step.counts.x + id.x] = vec4f(x, 1.0);
}
`;
