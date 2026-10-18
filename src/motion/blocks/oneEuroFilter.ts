/**
 * Filter block: the One Euro filter (Casiez et al. 2012), an adaptive low-pass whose cutoff rises with speed, so a
 * still person loses the detector's jitter and a fast move keeps its timing.
 *
 * Live (the camera) it runs causally. A recorded video is smoothed with frames before and after: the filter runs
 * forwards and backwards and the two are averaged, which cancels most of the lag (zero-phase); gaps where nobody was
 * seen are bridged by interpolation when shorter than half a second.
 */
import type { BlockDefinition, FilterBlock, Landmarks, PersonFrame, Settings } from "../api";
import { OneEuro } from "../oneEuro";

/** Picture coordinates (a fraction of the picture) move on another scale than metres: their beta is this much larger
 *  for the same effect (tuned by eye). */
const IMAGE_BETA = { live: 4 / 3, recorded: 1.5 };
/** Longest gap of a recording bridged by interpolation (s). */
const MAX_GAP = 0.5;

const flat = (l: Landmarks) => Float64Array.from(l.flatMap((p) => p.slice(0, 3)));
const unflat = (v: Float64Array, like: Landmarks) => like.map((p, i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2], p[3]]);
const lerp = (a: Landmarks, b: Landmarks, w: number) => a.map((p, i) => p.map((x, k) => x + (b[i][k] - x) * w));

class OneEuroFilter implements FilterBlock {
  private world: OneEuro;
  private image: OneEuro;

  constructor(private s: Readonly<Settings>) {
    this.world = new OneEuro(0, 0);
    this.image = new OneEuro(0, 0);
    this.setSettings(s);
  }

  setSettings(s: Readonly<Settings>) {
    this.s = s;
    this.world.minCutoff = this.image.minCutoff = s.cutoff as number;
    this.world.beta = s.beta as number;
    this.image.beta = (s.beta as number) * IMAGE_BETA.live;
  }

  reset() {
    this.world.reset();
    this.image.reset();
  }

  live(frame: PersonFrame, t: number): PersonFrame {
    if (!frame.world.length) return frame;
    const w = flat(frame.world), im = flat(frame.image);
    this.world.filter(w, t);
    this.image.filter(im, t);
    return { world: unflat(w, frame.world), image: unflat(im, frame.image), aspect: frame.aspect };
  }

  recorded(frames: PersonFrame[], fps: number): PersonFrame[] {
    const out = frames.map((f) => ({ world: f.world.map((p) => [...p]), image: f.image.map((p) => [...p]), aspect: f.aspect }));
    const present = out.map((f) => f.world.length >= 33);
    for (let i = 0; i < out.length; i++) {
      if (present[i]) continue;
      let j = i;
      while (j < out.length && !present[j]) j++;
      if (i > 0 && j < out.length && (j - i) / fps <= MAX_GAP) {
        for (let k = i; k < j; k++) {
          const w = (k - i + 1) / (j - i + 1);
          out[k] = { world: lerp(out[i - 1].world, out[j].world, w), image: lerp(out[i - 1].image, out[j].image, w), aspect: out[k].aspect };
          present[k] = true;
        }
      }
      i = j;
    }
    // One pass in one direction; a gap restarts the filter.
    const run = (order: number[], key: "world" | "image", f: OneEuro) => {
      const res = new Map<number, Float64Array>();
      let last = -2;
      for (const i of order) {
        if (!present[i]) continue;
        if (Math.abs(i - last) > 1) f.reset();
        last = i;
        const v = flat(out[i][key]);
        f.filter(v, i / fps);
        res.set(i, v);
      }
      return res;
    };
    const cutoff = this.s.videoCutoff as number, beta = this.s.videoBeta as number;
    const idx = out.map((_, i) => i);
    for (const [key, b] of [["world", beta], ["image", beta * IMAGE_BETA.recorded]] as const) {
      const fw = run(idx, key, new OneEuro(cutoff, b));
      const bw = run([...idx].reverse(), key, new OneEuro(cutoff, b));
      for (const [i, a] of fw) {
        const c = bw.get(i)!;
        out[i][key] = out[i][key].map((p, k) => [(a[k * 3] + c[k * 3]) / 2, (a[k * 3 + 1] + c[k * 3 + 1]) / 2, (a[k * 3 + 2] + c[k * 3 + 2]) / 2, p[3]]);
      }
    }
    return out;
  }
}

export const oneEuroFilter: BlockDefinition<"filter"> = {
  id: "one-euro",
  slot: "filter",
  name: { zh: "One Euro 滤波", en: "One Euro filter" },
  summary: {
    zh: "随速度自适应的低通滤波：静止时去抖，快动作不拖后。摄像头实时单向滤波；上传的视频前后双向滤波再平均（零相位），并补上半秒以内的空缺。",
    en: "Adaptive low-pass whose cutoff rises with speed: still poses lose their jitter, fast moves keep their timing. Causal for the camera; recorded videos are filtered forwards and backwards and averaged (zero phase), gaps under half a second bridged.",
  },
  parameters: [
    {
      key: "cutoff", kind: "number", default: 1.5, min: 0.1, max: 10, step: 0.1, unit: "Hz",
      label: { zh: "摄像头 · 最低截止频率", en: "Camera · min cutoff" },
      help: { zh: "静止时的截止频率：越低越稳，越高越跟手", en: "Cutoff when still: lower is steadier, higher follows closer" },
    },
    {
      key: "beta", kind: "number", default: 3, min: 0, max: 20, step: 0.1, unit: "1/m",
      label: { zh: "摄像头 · 速度系数 β", en: "Camera · speed coefficient β" },
      help: { zh: "截止频率随速度（m/s）上升的快慢：越大快动作越不拖后", en: "How fast the cutoff rises with speed (m/s): higher lags less on fast moves" },
    },
    {
      key: "videoCutoff", kind: "number", default: 1.2, min: 0.1, max: 10, step: 0.1, unit: "Hz",
      label: { zh: "视频 · 最低截止频率", en: "Video · min cutoff" },
      help: { zh: "分析上传视频时使用（下次分析生效）", en: "Used when an uploaded video is analysed (applies to the next one)" },
    },
    {
      key: "videoBeta", kind: "number", default: 4, min: 0, max: 20, step: 0.1, unit: "1/m",
      label: { zh: "视频 · 速度系数 β", en: "Video · speed coefficient β" },
    },
  ],
  create: (_scene, settings) => new OneEuroFilter(settings),
};
