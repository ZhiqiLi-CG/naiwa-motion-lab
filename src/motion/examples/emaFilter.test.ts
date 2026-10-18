import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { listRetargeters } from "../api";
import { registerBuiltins } from "../blocks";
import { createRetargetPipeline } from "../core";
import { bindRig } from "../rig";
import { buildTestFrog } from "../testFrog";
import type { Track } from "../track";
import { registerEmaExample } from "./emaFilter";

it("the docs' example block runs as a retargeter", () => {
  registerBuiltins();
  const remove = registerEmaExample();
  expect(listRetargeters().map((r) => r.id)).toContain("ema-direction-copy");
  const rig = bindRig(buildTestFrog().rig);
  const pipeline = createRetargetPipeline(rig, { id: "ema-direction-copy", settings: { alpha: 0.5 } });
  const track = JSON.parse(readFileSync("public/dances/naenae.json", "utf8")) as Track;
  let poses = 0;
  track.frames.slice(0, 30).forEach((f, k) => {
    const goal = pipeline.live({ ...f, aspect: 16 / 9 }, k / track.fps, 1 / track.fps, false);
    if (goal && pipeline.pose(goal, 1 / track.fps).bones.head) poses++;
  });
  expect(poses).toBe(30);
  remove();
  expect(listRetargeters().map((r) => r.id)).not.toContain("ema-direction-copy");
});
