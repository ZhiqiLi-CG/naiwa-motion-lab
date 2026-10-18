import * as THREE from "three";
import { expect, it } from "vitest";
import { createRetargetPipeline } from "../../motion/core";
import { bentLeg, idlePose } from "../../motion/pose";
import { jointPositions } from "../../motion/rig";
import { measureRetargeter } from "./bench";
import { loadTrack } from "./rigs";
import { setup } from "./testSupport";

const planted = { id: "planted-feet", settings: { homing: 0 } };

it("a foot standing alone stays put while the frog turns about it", async () => {
  const b = await setup();
  const p = createRetargetPipeline(b, planted);
  const feet: THREE.Vector3[] = [];
  for (let i = 0; i <= 30; i++) {
    const g = idlePose();
    g.leg.L = bentLeg("L", 1.0, 0.5);
    g.yaw = i * 0.03;
    feet.push(jointPositions(b, p.pose(g, 1 / 60)).get("foot_R")!);
  }
  for (const f of feet) expect(Math.hypot(f.x - feet[0].x, f.z - feet[0].z)).toBeLessThan(1e-6);
});

it("with both feet down a turn twists the upper body; lifting a foot hands the turn back to the root", async () => {
  const b = await setup();
  const p = createRetargetPipeline(b, planted);
  const g = idlePose();
  p.pose(g, 1 / 60);
  g.yaw = 0.5;
  const frame = p.pose(g, 1 / 60);
  expect(frame.rootYaw).toBeCloseTo(0, 6);
  const P = jointPositions(b, frame);
  const shoulders = P.get("upperarm_L")!.clone().sub(P.get("upperarm_R")!);
  expect(Math.atan2(-shoulders.z, shoulders.x)).toBeCloseTo(0.5, 2);
  // Beyond the twist limit the root has to turn (the feet slide).
  g.yaw = 1.5;
  expect(p.pose(g, 1 / 60).rootYaw).toBeCloseTo(1.5 - 0.8, 6);
  g.leg.L = bentLeg("L", 1.0, 0.5);
  let yaw = 0;
  for (let i = 0; i < 120; i++) yaw = p.pose(g, 1 / 60).rootYaw!;
  expect(yaw).toBeCloseTo(1.5, 3);
});

it("cuts the foot slide of the dances", async () => {
  const b = await setup();
  for (const [d, most] of [["gouxiong", 0.15], ["naenae", 0.75], ["kemusan", 0.75]] as const) {
    const before = measureRetargeter(b, { id: "direction-copy" }, loadTrack(d)).footSlide;
    const after = measureRetargeter(b, { id: "planted-feet" }, loadTrack(d)).footSlide;
    expect(after).toBeLessThan(before * most);
  }
}, 30000);
