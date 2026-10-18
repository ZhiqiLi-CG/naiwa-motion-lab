import { describe, expect, it } from "vitest";
import type { Scene, SimPart } from "../api";
import { CpuBackend } from "./mpm/cpu/cpuBackend";
import { principal } from "./mpm/carriedMass";
import { FrameBuilder } from "./mpm/frame";
import { lame } from "./mpm/material";
import { MpmModel } from "./mpm/model";
import { fillVolume } from "./mpm/sampling";

/** A closed axis-aligned box mesh (outward triangles). */
function box(lo: [number, number, number], hi: [number, number, number]): { positions: Float32Array; indices: Uint32Array } {
  const p: number[] = [];
  for (let k = 0; k < 8; k++) p.push(k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d);
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

function part(lo: [number, number, number], hi: [number, number, number]): SimPart {
  const m = box(lo, hi);
  return { name: "body", limb: false, ...m, softness: new Float32Array(8).fill(0.5), regions: new Uint8Array(8).fill(1), bones: [] };
}

/** The scene a flesh block sees, reduced to what the frame builder reads (no bones, no balls). */
function scene(parts: SimPart[], gravity = -9.81): Scene {
  return {
    world: { gravity: { x: 0, y: gravity, z: 0 } }, dt: 1 / 60, floorFriction: 0.9, parts,
    skeleton: { bones: new Map() }, balls: () => [], reportContact: () => {},
  } as unknown as Scene;
}

/** Run a jelly block on the CPU backend (one thread) for some frames; returns the model and the last output. */
async function simulate(lo: [number, number, number], hi: [number, number, number], frames: number, opts: { gravity?: number; velocity?: [number, number, number]; E?: number } = {}) {
  const p = part(lo, hi);
  const sc = scene([p], opts.gravity ?? -9.81);
  const model = new MpmModel([p], 0.04, 200);
  const backend = await CpuBackend.create(model, 0);
  backend.setState(model.initialState());
  const frame = new FrameBuilder([p]);
  if (opts.velocity) for (let i = 0; i < model.particles; i++) frame.setVelocity(i, ...opts.velocity);
  const { mu, lambda } = lame(opts.E ?? 4000, 0.3);
  let out = null;
  const centre = new Float32Array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
  for (let f = 0; f < frames; f++) {
    const grids = model.gridTable(centre, () => ({ mu, lambda, eta: 2, restScale: 1 }));
    backend.submit(frame.build(sc, 10, grids, new Float32Array(8).fill(1), model.nodes, model.particles));
    out = backend.collect()!;
    // Follow the block with its grid.
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < model.particles; i++) {
      x += out.positions[i * 4];
      y += out.positions[i * 4 + 1];
      z += out.positions[i * 4 + 2];
    }
    centre.set([x / model.particles, y / model.particles, z / model.particles]);
  }
  backend.dispose();
  return { model, out: out!, centre };
}

describe("MPM building blocks", () => {
  it("fills a box with 2×2×2 particles per cell", () => {
    const { positions, indices } = box([0, 0, 0], [0.2, 0.1, 0.1]);
    const P = fillVolume(positions, indices, 0.01);
    expect(P.length / 3).toBe(20 * 10 * 10);
  });

  it("finds principal axes of an inertia tensor", () => {
    // diag(1, 2, 3) turned 30° about z.
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const R = [c, -s, 0, s, c, 0, 0, 0, 1], D = [1, 2, 3];
    const A = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) for (let k = 0; k < 3; k++) A[r * 3 + q] += R[r * 3 + k] * D[k] * R[q * 3 + k];
    const { values } = principal(A);
    expect([...values].sort()).toEqual([expect.closeTo(1, 6), expect.closeTo(2, 6), expect.closeTo(3, 6)]);
  });
});

describe("MLS-MPM on the CPU backend", () => {
  it("drops a jelly block onto the floor, where it comes to rest keeping its volume", async () => {
    const { model, out } = await simulate([-0.1, 0.1, -0.1], [0.1, 0.3, 0.1], 120);
    let minY = Infinity, J = 0, speed = 0;
    for (let i = 0; i < model.particles; i++) {
      minY = Math.min(minY, out.positions[i * 4 + 1]);
      J += out.positions[i * 4 + 3] / model.particles;
      speed = Math.max(speed, Math.hypot(out.velocities[i * 4], out.velocities[i * 4 + 1], out.velocities[i * 4 + 2]));
    }
    console.log("block on the floor:", { minY, J, speed });
    expect(out.floorContacts[0]).toBeGreaterThan(0);
    expect(minY).toBeGreaterThan(-0.03);
    expect(minY).toBeLessThan(0.03);
    expect(Math.abs(J - 1)).toBeLessThan(0.05);
    expect(speed).toBeLessThan(0.15);
  }, 60000);

  it("conserves momentum in free flight (no gravity, no floor)", async () => {
    const { model, out } = await simulate([-0.1, 1, -0.1], [0.1, 1.2, 0.1], 30, { gravity: 0, velocity: [0.5, 0.2, -0.3] });
    const p = [0, 0, 0];
    for (let i = 0; i < model.particles; i++) for (let k = 0; k < 3; k++) p[k] += out.velocities[i * 4 + k] / model.particles;
    expect(p[0]).toBeCloseTo(0.5, 4);
    expect(p[1]).toBeCloseTo(0.2, 4);
    expect(p[2]).toBeCloseTo(-0.3, 4);
  }, 60000);
});
