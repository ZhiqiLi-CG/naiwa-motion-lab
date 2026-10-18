/**
 * BDF2, the second-order backward differentiation formula, for the implicit solvers:
 *
 *   x₁ = 4/3 x₀ − 1/3 x₋₁ + ⅔ h v₁,   v₁ = 4/3 v₀ − 1/3 v₋₁ + ⅔ h a₁,   a₁ = g + f(x₁)/m
 *
 * Why not backward Euler: it shrinks a jiggle of angular frequency ω by 1/√(1 + (hω)²) every step — a 4 Hz wobble at
 * h = 1/60 loses 8 % per step and is gone in 0.2 s, faster ones sooner. BDF2 loses only about (hω)⁴/8 per step at low
 * frequencies (0.4 % at 4 Hz: the wobble lasts seconds, so the bounciness slider decides how long), and is still
 * L-stable: the stiff, lattice-scale modes and the errors of an inexact solve are damped away, so it stays robust at
 * the firmest setting where an energy-conserving rule (Newmark's trapezoidal rule) blows up through the explicit
 * flesh–bone coupling.
 *
 * For the solver it is backward Euler's minimisation with the step h' = ⅔h: x₁ minimises ½|x − s|²_M / h'² + Ψ(x),
 * s = 4/3 x₀ − 1/3 x₋₁ + h' (4/3 v₀ − 1/3 v₋₁) + h'² g. The first step after a reset (no history) is backward Euler.
 * What other blocks do between steps (a poke changes velocities, a contact moves particles) is applied to the history
 * too, so that a poke of dv is a poke of dv and not of 4/3 dv.
 */
import type { Piece } from "./flesh";

export class Bdf2 {
  /** Positions and velocities one step back, and those at the start of this step. */
  private xPrev: Float64Array;
  private vPrev: Float64Array;
  private x0: Float64Array;
  private v0: Float64Array;
  /** Where the last solve left positions and velocities (to see what other blocks changed since). */
  private xEnd: Float64Array;
  private vEnd: Float64Array;
  private started = false;

  constructor(n: number) {
    this.xPrev = new Float64Array(n * 3);
    this.vPrev = new Float64Array(n * 3);
    this.x0 = new Float64Array(n * 3);
    this.v0 = new Float64Array(n * 3);
    this.xEnd = new Float64Array(n * 3);
    this.vEnd = new Float64Array(n * 3);
  }

  /** The step of the solver's inertia term (⅔h, or h on the first step) and its inertial target s (free particles). */
  target(piece: Piece, h: number, g: readonly [number, number, number], s: Float64Array): number {
    const { x: X, v: V, fixed } = piece;
    this.x0.set(X);
    this.v0.set(V);
    if (!this.started) {
      for (let i = 0; i < piece.count; i++) {
        if (fixed[i]) continue;
        for (let k = 0; k < 3; k++) s[i * 3 + k] = X[i * 3 + k] + h * V[i * 3 + k] + h * h * g[k];
      }
      return h;
    }
    const he = (2 * h) / 3, xp = this.xPrev, vp = this.vPrev;
    for (let i = 0; i < piece.count; i++) {
      if (fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        xp[j] += X[j] - this.xEnd[j];
        vp[j] += V[j] - this.vEnd[j];
        s[j] = (4 * X[j] - xp[j]) / 3 + he * ((4 * V[j] - vp[j]) / 3) + he * he * g[k];
      }
    }
    return he;
  }

  /** After the solve: the velocity from the new positions, and the history moved one step on. */
  finish(piece: Piece, h: number) {
    const { x: X, v: V, fixed } = piece, x0 = this.x0, xp = this.xPrev;
    for (let i = 0; i < piece.count; i++) {
      if (fixed[i]) continue;
      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        V[j] = this.started ? (X[j] - (4 * x0[j] - xp[j]) / 3) / ((2 * h) / 3) : (X[j] - x0[j]) / h;
      }
    }
    this.xPrev.set(x0);
    this.vPrev.set(this.v0);
    this.xEnd.set(X);
    this.vEnd.set(V);
    this.started = true;
  }

  /** Particles were attached or detached, or the flesh was moved by hand: start again with one backward Euler step. */
  reset() {
    this.started = false;
  }
}
