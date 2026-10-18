import * as THREE from "three";
import { expect, it } from "vitest";
import { createRetargetPipeline } from "../../motion/core";
import { measureRetargeter } from "./bench";
import { loadTrack } from "./rigs";
import { reachGoal, setup } from "./testSupport";

it("keeps the person's directions where they are free, and moves an arm through the belly out of it", async () => {
  const b = await setup();
  // Started from the person's directions (hint 1): the free optimum is exactly them.
  const p = createRetargetPipeline(b, { id: "direction-copy", settings: { optHint: 1 }, blocks: { solver: "penalty-opt" } });
  const goal = reachGoal();
  let frog = p.scene.solver.solve(goal);
  const dir = (a: string, c: string) => frog.joints.get(c as never)!.clone().sub(frog.joints.get(a as never)!).normalize();
  const chest = () => frog.rotations.get("chest")!;
  expect(dir("upperarm_L", "forearm_L").angleTo(goal.arm.L.upper.clone().applyQuaternion(chest()))).toBeLessThan(1e-3);

  // The left forearm pointing straight across the belly: the optimum is the nearest direction outside it.
  goal.arm.L.upper = new THREE.Vector3(0.3, -1, 0.2).normalize();
  goal.arm.L.fore = new THREE.Vector3(-1, 0, 0.3).normalize();
  p.reset();
  frog = p.scene.solver.solve(goal);
  const body = p.scene.constraints;
  body.setTorso(frog);
  const a = b.arm.L, el = frog.joints.get("forearm_L")!, f = dir("forearm_L", "hand_L");
  for (const sm of a.foreS) {
    const c = body.check(sm, el.clone().addScaledVector(f, sm.len));
    expect(c.clearance).toBeGreaterThan(c.needed - 0.002);
  }
  expect(f.angleTo(goal.arm.L.fore.clone().applyQuaternion(chest()))).toBeLessThan(Math.PI / 2);
});

it("on dances: as faithful as the built-in projection or more, limbs out of the body, within a loose time guard (the budget is checked by bench.test.ts on its own)", async () => {
  const b = await setup();
  for (const d of ["naenae", "kemusan"]) {
    const opt = measureRetargeter(b, { id: "direction-copy", blocks: { solver: "penalty-opt" } }, loadTrack(d));
    const base = measureRetargeter(b, { id: "direction-copy" }, loadTrack(d));
    expect(opt.fidelity).toBeLessThan(base.fidelity + 0.5);
    expect(opt.penetration).toBeLessThan(0.003);
    expect(opt.solveMs).toBeLessThan(5);
  }
}, 30000);
