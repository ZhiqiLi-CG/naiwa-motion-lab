/** Simulation module: a small core over replaceable blocks (api.ts), with the built-in CPU example registered. */
import RAPIER from "@dimforge/rapier3d-compat";
import { registerBuiltins } from "./blocks";

export * from "./api";
export { SIM_DT, type SimStats } from "./core";

let ready: Promise<void> | null = null;
/** Load Rapier's WebAssembly and register the built-in blocks (once). */
export function initPhysics(): Promise<void> {
  return (ready ??= RAPIER.init().then(registerBuiltins));
}
