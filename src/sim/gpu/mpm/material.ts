/**
 * The flesh as a material: compressible neo-Hookean elasticity (rotation-invariant: a bone turning does not by itself
 * strain anything) plus Kelvin–Voigt viscosity, with physical parameters. The page's sliders scale them:
 *
 *   softness slider      Young's modulus × 10^(0.85 − softness)    (1 at the app's default 0.85)
 *   softness per region  × 4^(0.55 − region softness)              (the belly softest, hands and feet firmest)
 *   bounciness slider    viscosity × 4^(0.65 − bounciness)
 *   belly size           the Body's rest volume (its rest shape scaled; the mass stays)
 */
import { FLESH_REGIONS, type PhysicsParams } from "../../../contracts";
import { REGION_SOFTNESS } from "../../parts";
import { MAX_SUBSTEPS } from "./layout";

export interface MaterialSettings {
  /** Young's modulus (Pa). */
  youngModulus: number;
  poissonRatio: number;
  /** kg/m³. */
  density: number;
  /** Pa·s. */
  viscosity: number;
  /** At least this many substeps per 1/60 s step. */
  minSubsteps: number;
}

export function lame(E: number, nu: number): { mu: number; lambda: number } {
  return { mu: E / (2 * (1 + nu)), lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)) };
}

/** The softness slider's factor on Young's modulus. */
export const stiffnessScale = (p: PhysicsParams) => Math.pow(10, 0.85 - clamp01(p.softness));
export const viscosityScale = (p: PhysicsParams) => Math.pow(4, 0.65 - clamp01(p.bounciness));

/** Stiffness factor per region (FLESH_REGIONS order; 8 slots, the last unused). */
export function regionFactors(p: PhysicsParams): Float32Array {
  const out = new Float32Array(8).fill(1);
  FLESH_REGIONS.forEach((r, k) => (out[k] = Math.pow(4, 0.55 - clamp01(p.regionSoftness?.[r] ?? REGION_SOFTNESS[r]))));
  return out;
}

/**
 * Substeps for one step of frameDt: explicit MPM is stable while elastic waves and particles cross less than a
 * fraction of a cell per substep (CFL), and viscosity diffuses less than a cell.
 *
 * @param waveFactor largest stiffness factor of any particle (slider × region)
 * @param maxSpeed fastest particle (m/s)
 */
export function substepsFor(m: MaterialSettings, dx: number, frameDt: number, waveFactor: number, etaFactor: number, maxSpeed: number): number {
  const { mu, lambda } = lame(m.youngModulus * waveFactor, m.poissonRatio);
  const wave = Math.sqrt((lambda + 2 * mu) / m.density);
  const cfl = 0.45 * dx / (wave + maxSpeed);
  const diffusion = (0.2 * m.density * dx * dx) / Math.max(1e-6, m.viscosity * etaFactor);
  const n = Math.ceil(frameDt / Math.min(cfl, diffusion));
  return Math.min(MAX_SUBSTEPS, Math.max(m.minSubsteps, n));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
