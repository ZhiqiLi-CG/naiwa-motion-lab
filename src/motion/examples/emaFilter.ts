/**
 * The smallest custom block (docs/motion-api.md): an exponential moving average in place of the One Euro filter.
 * Register it, then a retargeter that uses it with the built-in blocks for the other slots.
 */
import type { BlockDefinition, FilterBlock, Landmarks, PersonFrame, Settings } from "../api";
import { registerRetargetBlock, registerRetargeter } from "../api";

class EmaFilter implements FilterBlock {
  private last: { world: Landmarks; image: Landmarks } | null = null;

  constructor(private s: Readonly<Settings>) {}

  setSettings(s: Readonly<Settings>) {
    this.s = s;
  }

  reset() {
    this.last = null;
  }

  live(frame: PersonFrame): PersonFrame {
    if (!frame.world.length) return frame;
    const a = this.s.alpha as number;
    const mix = (now: Landmarks, before: Landmarks | undefined) =>
      now.map((p, i) => (before ? [0, 1, 2].map((k) => before[i][k] + a * (p[k] - before[i][k])).concat(p[3]) : [...p]));
    this.last = { world: mix(frame.world, this.last?.world), image: mix(frame.image, this.last?.image) };
    return { ...this.last, aspect: frame.aspect };
  }

  recorded(frames: PersonFrame[]): PersonFrame[] {
    this.reset();
    return frames.map((f) => this.live(f));
  }
}

export const emaFilter: BlockDefinition<"filter"> = {
  id: "ema-filter",
  slot: "filter",
  name: { zh: "指数滑动平均", en: "Exponential moving average" },
  summary: { zh: "每帧向新的关键点靠近 alpha。", en: "Each frame moves alpha of the way to the new landmarks." },
  parameters: [{ key: "alpha", kind: "number", default: 0.3, min: 0.05, max: 1, step: 0.05, label: { zh: "alpha", en: "alpha" } }],
  create: (_scene, settings) => new EmaFilter(settings),
};

export function registerEmaExample(): () => void {
  const removeBlock = registerRetargetBlock(emaFilter);
  const removeRetargeter = registerRetargeter({
    id: "ema-direction-copy",
    name: { zh: "方向拷贝（EMA 滤波）", en: "Direction copy (EMA filter)" },
    summary: { zh: "默认的 retarget，换成指数滑动平均滤波。", en: "The default retargeter with an EMA filter." },
    blocks: {
      filter: "ema-filter", constraints: "frog-body", goal: "person-directions", solver: "projected-directions", output: "planted-rotations",
    },
  });
  return () => {
    removeRetargeter();
    removeBlock();
  };
}
