/** Output block: the rendered surface is the one the flesh solver tracks itself (Rapier embeds it in its cells). */
import type { BlockDefinition, OutputBlock, Scene, SimPart } from "../api";

export const fleshSurface: BlockDefinition<"output"> = {
  id: "flesh-surface",
  slot: "output",
  name: { zh: "嵌入表面", en: "Embedded surface" },
  summary: {
    zh: "显示软体求解器自己跟踪的表面（嵌在单元里随单元变形）。",
    en: "Shows the surface the flesh solver tracks itself (embedded in its cells, deforming with them).",
  },
  device: "cpu",
  parameters: [],
  create: (scene: Scene): OutputBlock => {
    const flesh = scene.flesh;
    if (!flesh.surface) throw new Error("sim: the flesh block tracks no surface; pick another output block");
    const surface = flesh.surface.bind(flesh);
    return { read: (part: SimPart) => surface(part) };
  },
};
