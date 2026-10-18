import * as THREE from "three";
import { expect, it } from "vitest";
import { createRetargetPipeline } from "../../motion/core";
import { bentLeg, idlePose } from "../../motion/pose";
import { bindRig, jointPositions } from "../../motion/rig";
import { measureContact, measureRetargeter } from "./bench";
import { glbCharacter, loadTrack, toeOffsets } from "./rigs";
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

it("with a foot down a turn twists the upper body; in the air the turn goes back to the root", async () => {
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
  g.lift = 0.1;
  let yaw = 0;
  for (let i = 0; i < 120; i++) yaw = p.pose(g, 1 / 60).rootYaw!;
  expect(yaw).toBeCloseTo(1.5, 3);
});

it("keeps heel and toe still while down, measured as the page's e2e does", async () => {
  await setup();
  const c = await glbCharacter();
  const b = bindRig(c.rig), toes = toeOffsets(c);
  for (const d of ["gouxiong", "naenae", "kemusan", "penguin"]) {
    const before = measureContact(b, toes, { id: "direction-copy" }, loadTrack(d)).speed;
    const after = measureContact(b, toes, { id: "planted-feet" }, loadTrack(d)).speed;
    expect(after).toBeLessThan(d === "naenae" ? 0.035 : 0.01);
    expect(after).toBeLessThan(before);
  }
}, 30000);

it("cuts the foot slide of the dances", async () => {
  const b = await setup();
  for (const [d, most] of [["gouxiong", 0.15], ["naenae", 0.75], ["kemusan", 0.75]] as const) {
    const before = measureRetargeter(b, { id: "direction-copy" }, loadTrack(d)).footSlide;
    const after = measureRetargeter(b, { id: "planted-feet" }, loadTrack(d)).footSlide;
    expect(after).toBeLessThan(before * most);
  }
}, 30000);
