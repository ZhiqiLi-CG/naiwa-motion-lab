/** What the library's tests share: registration, the frog (naiwa.glb, as the measurements in docs/learn use), and the
 *  checks every solver block must pass. */
import * as THREE from "three";
import { expect } from "vitest";
import type { Goal } from "../../motion/api";
import { registerBuiltins } from "../../motion/blocks";
import { createRetargetPipeline } from "../../motion/core";
import { idlePose, SIDES } from "../../motion/pose";
import { registerMotionLibrary } from "./index";
import { measureRetargeter } from "./bench";
import { glbRig, loadTrack } from "./rigs";

export async function setup() {
  registerBuiltins();
  registerMotionLibrary();
  return glbRig();
}

/** Arms held out forwards, elbows bent up: clear of the body, every wrist target reachable. */
export function reachGoal(): Goal {
  const g = idlePose();
  for (const s of SIDES) {
    const x = s === "L" ? 0.5 : -0.5;
    g.arm[s] = { ...g.arm[s], upper: new THREE.Vector3(x, 0, 0.8).normalize(), fore: new THREE.Vector3(x * 0.4, 0.3, 1).normalize(), belly: null, overhead: 0 };
  }
  return g;
}

/**
 * An IK solver block: from the rest pose (hint 0, nothing before) it brings the wrists onto the targets the goal's
 * directions give, and on dances it keeps the limbs out of the body within a loose time guard (tests run in parallel; bench.test.ts times the budget).
 */
export async function checkSolver(id: string, prefix: string) {
  const b = await setup();
  const goal = reachGoal();
  const p = createRetargetPipeline(b, { id: "direction-copy", settings: { [`${prefix}Hint`]: 0, [`${prefix}Iterations`]: 50 }, blocks: { solver: id } });
  const frog = p.scene.solver.solve(goal);
  const chest = frog.rotations.get("chest")!;
  for (const s of SIDES) {
    const a = b.arm[s];
    const target = frog.joints.get(`upperarm_${s}`)!.clone()
      .addScaledVector(goal.arm[s].upper.clone().applyQuaternion(chest), a.upper)
      .addScaledVector(goal.arm[s].fore.clone().applyQuaternion(chest), a.fore);
    expect(frog.joints.get(`hand_${s}`)!.distanceTo(target)).toBeLessThan(0.005);
  }
  for (const d of ["naenae", "kemusan"]) {
    const r = measureRetargeter(b, { id: "direction-copy", blocks: { solver: id } }, loadTrack(d));
    expect(r.penetration).toBeLessThan(0.003);
    expect(r.fidelity).toBeLessThan(25);
    expect(r.solveMs).toBeLessThan(5);
  }
}
