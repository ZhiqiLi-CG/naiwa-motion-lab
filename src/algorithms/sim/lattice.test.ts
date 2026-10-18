import { describe, expect, it } from "vitest";
import { TriMesh } from "../../sim/geometry";
import { createTestRigSpec } from "../../sim/testRig";
import { cellForParticles, embeddedSurface, tetVolume, tetrahedralise } from "./lattice";
import { BlockSparse, EnvelopeCholesky, extractRotation, m3, mul3, quatToM3 } from "./linalg";

describe("lattice", () => {
  const { positions: P, indices: I } = createTestRigSpec().body;
  const volume = new TriMesh(P, I).volume();

  it("aims at the particle count", () => {
    const mesh = tetrahedralise(P, I, cellForParticles(P, I, volume, 300));
    expect(Math.abs(mesh.nodes.length / 3 - 300)).toBeLessThan(30);
  });

  it("fills the surface with positive, conforming cells that cover its volume", () => {
    const mesh = tetrahedralise(P, I, cellForParticles(P, I, volume, 400));
    const T = mesh.tets;
    let total = 0;
    for (let t = 0; t < T.length; t += 4) {
      const v = tetVolume(mesh.nodes, T[t], T[t + 1], T[t + 2], T[t + 3]);
      expect(v).toBeGreaterThan(0);
      total += v;
    }
    // The lattice reaches past the surface: more volume than inside it, but not wildly more.
    expect(total).toBeGreaterThan(volume);
    expect(total).toBeLessThan(2.5 * volume);
    // Conforming: every interior triangle is shared by exactly two cells, so the boundary is closed.
    const faces = new Map<string, number>();
    for (let t = 0; t < T.length; t += 4) {
      for (const [a, b, c] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]) {
        const key = [T[t + a], T[t + b], T[t + c]].sort((x, y) => x - y).join(",");
        faces.set(key, (faces.get(key) ?? 0) + 1);
      }
    }
    expect([...faces.values()].every((n) => n <= 2)).toBe(true);
  });

  it("embeds the surface: at rest the embedded vertices are the surface", () => {
    const mesh = tetrahedralise(P, I, cellForParticles(P, I, volume, 250));
    const out = embeddedSurface(mesh, mesh.nodes, new Float32Array(P.length));
    let worst = 0;
    for (let i = 0; i < P.length; i++) worst = Math.max(worst, Math.abs(out[i] - P[i]));
    expect(worst).toBeLessThan(1e-5);
    for (let v = 0; v < P.length / 3; v++) {
      const w = mesh.embedWeight.subarray(v * 4, v * 4 + 4);
      expect(Math.min(...w)).toBeGreaterThan(-1e-4);
    }
  });
});

describe("linear algebra", () => {
  it("finds the rotation of a rotated stretch", () => {
    const q = [0.2, -0.4, 0.3, 0.8], n = Math.hypot(...q);
    const R = quatToM3(q.map((x) => x / n), m3());
    const S = new Float64Array([1.3, 0.1, 0, 0.1, 0.8, 0.05, 0, 0.05, 1.1]);
    const A = mul3(R, S, m3());
    const got = extractRotation(A, new Float64Array([0, 0, 0, 1]), m3(), 30);
    for (let k = 0; k < 9; k++) expect(got[k]).toBeCloseTo(R[k], 5);
  });

  /** A 1D Laplacian plus mass: tridiagonal SPD. */
  const chain = (n: number) => Array.from({ length: n }, (_, i) => [i - 1, i + 1].filter((j) => j >= 0 && j < n));

  it("solves with the envelope Cholesky factor", () => {
    const n = 40, nb = chain(n), chol = new EnvelopeCholesky(n, nb);
    for (let i = 0; i < n; i++) {
      chol.add(i, i, 3);
      for (const j of nb[i]) if (j < i) chol.add(i, j, -1);
    }
    chol.factor();
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const b = Float64Array.from({ length: n }, (_, i) => 3 * x[i] - (x[i - 1] ?? 0) - (x[i + 1] ?? 0));
    chol.solve(b);
    for (let i = 0; i < n; i++) expect(b[i]).toBeCloseTo(x[i], 9);
  });

  it("solves a block system by conjugate gradients", () => {
    const n = 30, A = new BlockSparse(n, chain(n).flatMap((js, i) => js.map((j) => [i, j] as [number, number])));
    for (let i = 0; i < n; i++) {
      A.addDiagonal(i, 3);
      for (const j of chain(n)[i]) {
        const s = A.slot(i, j) * 9;
        A.values[s] = A.values[s + 4] = A.values[s + 8] = -1;
      }
    }
    const x = Float64Array.from({ length: n * 3 }, (_, i) => Math.cos(i));
    const b = new Float64Array(n * 3);
    A.multiply(x, b);
    const got = new Float64Array(n * 3);
    A.solve(b, got, 200, 1e-12);
    for (let i = 0; i < n * 3; i++) expect(got[i]).toBeCloseTo(x[i], 6);
  });
});
