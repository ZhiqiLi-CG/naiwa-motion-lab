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

/** Young's modulus (Pa): 60 kPa at softness 0 down to 6 kPa (8.5 kPa at the app's default 0.85). Most of the Body's
 *  flesh is free (it hangs on the few particles riding on the bones), so it must carry its own weight: its sag is
 *  about ρ g H / E, 4 % for 20 cm of flesh at the default. */
export function youngModulus(p: PhysicsParams): number {
  return 60000 * Math.pow(0.1, clamp01(p.softness));
}

/** Lamé parameters of (E, ν). */
export function lame(E: number, nu: number): { mu: number; lambda: number } {
  return { mu: E / (2 * (1 + nu)), lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)) };
}

/** Natural frequency (Hz) the softness slider stands for, and the damping ratio of the bounciness slider. */
export function spring(p: PhysicsParams): { f: number; zeta: number } {
  return { f: lerpLog(14, 3, clamp01(p.softness)), zeta: lerpLog(0.9, 0.06, clamp01(p.bounciness)) };
}

/** Rate (1/s) at which the free flesh's velocity relative to its target decays: damping ratio ζ at the slider's
 *  frequency (mass-proportional damping in the bones' frame, so moving the frog is not damped, only its jiggle). */
export function dampingRate(p: PhysicsParams): number {
  const { f, zeta } = spring(p);
  return 2 * zeta * 2 * Math.PI * f;
}

/** Stiffness factor of each region (index into FLESH_REGIONS): the softest region 1, the firmest up to 4 times. */
export function regionStiffness(p: PhysicsParams): Float64Array {
  return Float64Array.from(FLESH_REGIONS, (r) => lerpLog(4, 1, clamp01(p.regionSoftness?.[r] ?? REGION_SOFTNESS[r])));
}
