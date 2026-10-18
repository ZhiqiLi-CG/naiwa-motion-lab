import { expect, it } from "vitest";
import type { PersonFrame } from "../../motion/api";
import { createRetargetPipeline } from "../../motion/core";
import { measureFilter } from "./bench";
import { loadTrack } from "./rigs";
import { setup } from "./testSupport";

/** Every landmark moving at 0.5 m/s along x, seen with ±2 cm of uniform noise (σ 11.5 mm) at 30 fps. */
function moving(n: number, seed = 3): { clean: number[]; frames: PersonFrame[] } {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648 - 0.5);
  const clean = Array.from({ length: n }, (_, i) => 0.5 * (i / 30));
  const frames = clean.map((x) => ({
    world: Array.from({ length: 33 }, () => [x + rnd() * 0.04, 0, 0, 1]),
    image: Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]),
    aspect: 1,
  }));
  return { clean, frames };
}
const rmse = (out: PersonFrame[], clean: number[], from = 0) => {
  let sq = 0, n = 0;
  for (let i = from; i < out.length; i++) for (const p of out[i].world) (sq += (p[0] - clean[i]) ** 2), n++;
  return Math.sqrt(sq / n);
};

it("with a model that fits (little acceleration) it tracks a steady motion without lag, the RTS smoother better still", async () => {
  const b = await setup();
  const { clean, frames } = moving(90);
  const p = createRetargetPipeline(b, { id: "kalman-planted", settings: { accel: 2 } });
  const live = frames.map((f, i) => p.scene.filter.live(f, i / 30));
  const raw = rmse(frames, clean, 30), causal = rmse(live, clean, 30), smooth = rmse(p.recorded(frames, 30), clean, 30);
  expect(causal).toBeLessThan(raw * 0.8);
  expect(smooth).toBeLessThan(causal * 0.8);
});

it("bridges a short gap in a recording with the model's prediction", async () => {
  const b = await setup();
  const { clean, frames } = moving(60);
  for (let i = 25; i < 32; i++) frames[i] = { world: [], image: [], aspect: 1 };
  const out = createRetargetPipeline(b, { id: "kalman-planted", settings: {} }).recorded(frames, 30);
  for (let i = 25; i < 32; i++) {
    expect(out[i].world.length).toBe(33);
    expect(Math.abs(out[i].world[0][0] - clean[i])).toBeLessThan(0.03);
  }
});

it("on noisy dance landmarks: closer to the clean track than the noise, recorded closer than live", async () => {
  const b = await setup();
  const r = measureFilter(b, { id: "kalman-planted" }, loadTrack("naenae"));
  expect(r.rmseRecorded).toBeLessThan(11.5);
  expect(r.rmseRecorded).toBeLessThan(r.rmseLive);
  expect(r.liveMs).toBeLessThan(1);
});
