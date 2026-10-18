/** The built-in blocks and the CPU example simulator assembled from them. */
import { registerBlock, registerSimulator } from "../registry";
import { boneAttach } from "./boneAttach";
import { boneTarget } from "./boneTarget";
import { fleshPush } from "./fleshPush";
import { fleshSurface } from "./fleshSurface";
import { qualityMetrics } from "./qualityMetrics";
import { rapierFlesh } from "./rapierFlesh";
import { rigidSkeleton } from "./skeleton";

export function registerBuiltins() {
  for (const def of [rigidSkeleton, rapierFlesh, boneTarget, boneAttach, fleshPush, fleshSurface, qualityMetrics]) {
    registerBlock(def, "builtin");
  }
  registerSimulator({
    id: "cpu-constraints",
    name: { zh: "CPU 约束求解", en: "CPU constraint solver" },
    summary: {
      zh: "刚体骨骼 + Rapier 体积软体，深层的肉挂在骨头上，PGS 约束求解；接触在同一次求解里处理。",
      en: "Rigid skeleton + Rapier volumetric soft bodies with the deep flesh riding on the bones, solved by PGS constraints; contacts in the same solve.",
    },
    blocks: {
      skeleton: rigidSkeleton.id, flesh: rapierFlesh.id, target: boneTarget.id, coupling: boneAttach.id,
      interaction: fleshPush.id, output: fleshSurface.id, metrics: qualityMetrics.id,
    },
  }, "builtin");
}
