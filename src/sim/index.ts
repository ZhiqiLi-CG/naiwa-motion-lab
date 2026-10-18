/** Simulation module: a small core over replaceable blocks (api.ts), with the built-in CPU example and the GPU example
 *  (MPM on WebGPU, or CPU-parallel where there is no usable GPU) registered. */
import RAPIER from "@dimforge/rapier3d-compat";
import { registerBuiltins } from "./blocks";

export * from "./api";
export { SIM_DT, type SimStats } from "./core";

let ready: Promise<void> | null = null;
/** Load Rapier's WebAssembly, probe the GPU and CPU once, and register the built-in blocks (once). */
export function initPhysics(): Promise<void> {
  return (ready ??= (async () => {
    await RAPIER.init();
    registerBuiltins();
    // Loaded on demand: the GPU example's shaders and workers stay out of the main bundle.
    const { probeDevices, registerGpuSimulators } = await import("./gpu");
    await probeDevices();
    registerGpuSimulators();
  })());
}
