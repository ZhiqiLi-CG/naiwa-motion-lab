/**
 * The physics sliders (PhysicsParams) as material constants every solver of the library shares, so that the same
 * slider means the same flesh whatever the algorithm: Young's modulus and Poisson ratio, density, a damping rate, and
 * how much firmer each region is.
 */
import { FLESH_REGIONS, type PhysicsParams } from "../../contracts";
import { REGION_SOFTNESS } from "../../sim/parts";

/** kg/m³: a 1 m frog of about 15 kg, as the built-in Rapier flesh. */
export const DENSITY = 190;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerpLog = (a: number, b: number, t: number) => a * Math.pow(b / a, t);

/** Young's modulus (Pa): 30 kPa at softness 0 (rubber-firm) down to 1 kPa (a loose jelly), 1.7 kPa at the app's
 *  default 0.85. The belly then wobbles at a few hertz (its frequency goes as √E); the price of soft flesh is sag:
 *  about ρ g H / E of the free flesh's height H, a few centimetres here, as much as the built-in Rapier flesh. */
export function youngModulus(p: PhysicsParams): number {
  return lerpLog(30000, 1000, clamp01(p.softness));
}

/** Young's modulus at the app's default softness (0.85), for solvers whose stiffness is relative to it. */
export const DEFAULT_YOUNG = lerpLog(30000, 1000, 0.85);

/** Lamé parameters of (E, ν). */
export function lame(E: number, nu: number): { mu: number; lambda: number } {
  return { mu: E / (2 * (1 + nu)), lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)) };
}

/** Natural frequency (Hz) the softness slider stands for, and the damping ratio of the bounciness slider. */
export function spring(p: PhysicsParams): { f: number; zeta: number } {
  return { f: lerpLog(14, 3, clamp01(p.softness)), zeta: lerpLog(0.9, 0.06, clamp01(p.bounciness)) };
}

/** Time (s) in which the jiggle dies down to 1/e, from the bounciness slider: 0.12 s (dead, like dough) at 0 to
 *  3 s (a jelly that keeps wobbling) at 1; 1 s at the app's default 0.65. */
export function jiggleDecay(p: PhysicsParams): number {
  return lerpLog(0.12, 3, clamp01(p.bounciness));
}

/** Rate (1/s) at which the free flesh's velocity relative to its target decays: mass-proportional (Rayleigh) damping
 *  in the bones' frame, so moving the frog is not damped, only its jiggle. An oscillation's amplitude then decays at
 *  half this rate, whatever its frequency: rate = 2 / decay time. */
export function dampingRate(p: PhysicsParams): number {
  return 2 / jiggleDecay(p);
}

/** Stiffness factor of each region (index into FLESH_REGIONS): the softest region 1, the firmest up to 4 times. */
export function regionStiffness(p: PhysicsParams): Float64Array {
  return Float64Array.from(FLESH_REGIONS, (r) => lerpLog(4, 1, clamp01(p.regionSoftness?.[r] ?? REGION_SOFTNESS[r])));
}
