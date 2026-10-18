/**
 * The smallest custom block (docs/simulator-api.md): an output block that smooths the flesh solver's surface with a
 * few rounds of Laplacian smoothing, to take the facets off a coarse cage. Swap it in by slot, or register a simulator
 * that uses it with the built-in blocks for the other slots.
 */
import type { BlockDefinition, OutputBlock, Scene, Settings, SimPart } from "../api";
import { registerBlock, registerSimulator } from "../api";

/** Each vertex's neighbours along the surface's edges. */
function neighbours(part: SimPart): number[][] {
  const out: Set<number>[] = Array.from({ length: part.positions.length / 3 }, () => new Set());
  const I = part.indices;
  for (let t = 0; t < I.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      out[I[t + k]].add(I[t + ((k + 1) % 3)]);
      out[I[t + k]].add(I[t + ((k + 2) % 3)]);
    }
  }
  return out.map((s) => [...s]);
}

class SmoothSurface implements OutputBlock {
  private rings = new Map<SimPart, number[][]>();
  private buffers = new Map<SimPart, [Float32Array, Float32Array]>();

  constructor(private scene: Scene, private s: Readonly<Settings>) {
    for (const part of scene.parts) {
      this.rings.set(part, neighbours(part));
      this.buffers.set(part, [new Float32Array(part.positions.length), new Float32Array(part.positions.length)]);
    }
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  read(part: SimPart): Float32Array {
    const source = this.scene.flesh.surface?.(part) ?? part.positions;
    const ring = this.rings.get(part)!, [a, b] = this.buffers.get(part)!;
    const w = this.s.weight as number;
    let from = a, to = b;
    from.set(source);
    for (let round = 0; round < (this.s.rounds as number); round++) {
      for (let v = 0; v < ring.length; v++) {
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          for (const n of ring[v]) sum += from[n * 3 + k];
          to[v * 3 + k] = from[v * 3 + k] + w * (sum / ring[v].length - from[v * 3 + k]);
        }
      }
      [from, to] = [to, from];
    }
    return from;
  }
}

export const smoothSurface: BlockDefinition<"output"> = {
  id: "smooth-surface",
  slot: "output",
  name: { zh: "平滑表面", en: "Smoothed surface" },
  summary: { zh: "对求解器的表面做几轮拉普拉斯平滑。", en: "A few rounds of Laplacian smoothing over the solver's surface." },
  device: "cpu",
  parameters: [
    { key: "rounds", kind: "number", default: 2, min: 0, max: 6, step: 1, label: { zh: "轮数", en: "Rounds" } },
    { key: "weight", kind: "number", default: 0.5, min: 0, max: 1, step: 0.05, label: { zh: "强度", en: "Weight" } },
  ],
  create: (scene, settings) => new SmoothSurface(scene, settings),
};

export function registerSmoothExample(): () => void {
  const removeBlock = registerBlock(smoothSurface);
  const removeSimulator = registerSimulator({
    id: "cpu-constraints-smooth",
    name: { zh: "CPU 约束求解（平滑表面）", en: "CPU constraint solver (smoothed surface)" },
    summary: { zh: "内置的 CPU 示例，输出换成平滑表面。", en: "The built-in CPU example with a smoothed surface." },
    blocks: {
      skeleton: "rapier-skeleton", flesh: "rapier-soft-body", target: "bone-carried-target", coupling: "bone-attachments",
      interaction: "flesh-push", output: "smooth-surface", metrics: "quality-metrics",
    },
  });
  return () => {
    removeSimulator();
    removeBlock();
  };
}
