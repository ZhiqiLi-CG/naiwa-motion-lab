/**
 * The GPU example simulator: the frog's flesh by MLS-MPM, on WebGPU where there is a usable GPU and on CPU workers
 * where not (same algorithm, two backends). Start-up:
 *
 *   await probeDevices();        // once, before listing simulators (available() / backend() read its result)
 *   registerGpuSimulators();     // the blocks and the "gpu-mpm" assembly
 */
import { registerBlock, registerSimulator } from "../registry";
import { boneTarget } from "../blocks/boneTarget";
import { fleshPush } from "../blocks/fleshPush";
import { fleshSurface } from "../blocks/fleshSurface";
import { rigidSkeleton } from "../blocks/skeleton";
import { mpmMetrics } from "./metrics";
import { mpmFlesh } from "./mpmFlesh";
import { softLimbs } from "./softLimbs";

export { probeDevices, deviceProbe, forceBackend, chooseBackend, backendLabel, type DeviceProbe, type BackendKind } from "./device";
export { MpmFlesh, mpmFlesh } from "./mpmFlesh";
export { mpmMetrics } from "./metrics";
export { softLimbs } from "./softLimbs";

/** Register the MPM blocks and the "gpu-mpm" simulator. Returns a function that removes them again. */
export function registerGpuSimulators(): () => void {
  const undo = [
    registerBlock(mpmFlesh, "builtin"),
    registerBlock(mpmMetrics, "builtin"),
    registerBlock(softLimbs, "builtin"),
    registerSimulator({
      id: "gpu-mpm",
      name: { zh: "GPU 物质点法（MPM）", en: "GPU material point method (MPM)" },
      summary: {
        zh: "刚体骨骼 + MLS-MPM 软体：neo-Hookean 粒子在背景网格上求解，骨头上的肉双向耦合，接触在网格上处理。WebGPU 计算着色器；没有可用 GPU 时同一算法在 CPU 上并行。",
        en: "Rigid skeleton + MLS-MPM flesh: neo-Hookean particles solved on a background grid, the flesh on the bones coupled two-way, contacts on the grid. WebGPU compute shaders; the same algorithm on parallel CPU workers where there is no usable GPU.",
      },
      blocks: {
        skeleton: rigidSkeleton.id, flesh: mpmFlesh.id, target: boneTarget.id, coupling: softLimbs.id,
        interaction: fleshPush.id, output: fleshSurface.id, metrics: mpmMetrics.id,
      },
    }, "builtin"),
  ];
  return () => undo.forEach((u) => u());
}
