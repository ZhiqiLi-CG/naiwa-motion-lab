import { expect, it } from "vitest";
import type { PersonFrame } from "../../motion/api";
import { createRetargetPipeline } from "../../motion/core";
import { measureFilter } from "./bench";
import { loadTrack } from "./rigs";
import { polyWeights } from "./savitzkyGolay";
import { setup } from "./testSupport";

const frame = (x: number): PersonFrame => ({
  world: Array.from({ length: 33 }, () => [x, 0, 0, 1]),
  image: Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]),
  aspect: 1,
});

it("the weights reproduce any polynomial up to their degree, also off-centre", () => {
  const tau = [-0.2, -0.1, 0, 0.1, 0.2, 0.3];
  const f = (t: number) => 1 + 2 * t - 3 * t * t + 4 * t * t * t;
  for (const shift of [0, 0.15, -0.2]) {
    const w = polyWeights(tau.map((t) => t - shift), 3);
    expect(w.reduce((s, wj, j) => s + wj * f(tau[j]), 0)).toBeCloseTo(f(shift), 10);
  }
  // Degree 0 is the moving average.
  for (const wj of polyWeights([-1, 0, 1, 2], 0)) expect(wj).toBeCloseTo(0.25, 12);
});

it("a recording keeps a cubic move exactly, ends included; the camera keeps a ramp without lag", async () => {
  const b = await setup();
  const x = (i: number) => 0.3 * (i / 30) ** 3 - 0.2 * (i / 30);
  const p = createRetargetPipeline(b, { id: "savgol-planted", settings: { order: 3 } });
  const out = p.recorded(Array.from({ length: 40 }, (_, i) => frame(x(i))), 30);
  out.forEach((f, i) => expect(f.world[5][0]).toBeCloseTo(x(i), 9));
  const live = createRetargetPipeline(b, { id: "savgol-planted", settings: {} });
  for (let i = 0; i < 20; i++) expect(live.scene.filter.live(frame(0.5 * (i / 30)), i / 30).world[0][0]).toBeCloseTo(0.5 * (i / 30), 9);
});

it("on noisy dance landmarks: recorded closer to the clean track than the noise", async () => {
  const b = await setup();
  const r = measureFilter(b, { id: "savgol-planted" }, loadTrack("naenae"));
  expect(r.rmseRecorded).toBeLessThan(11.5);
  expect(r.liveMs).toBeLessThan(1);
});
