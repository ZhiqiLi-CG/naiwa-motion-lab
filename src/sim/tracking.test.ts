/** Hand tracking on the real frog: the simulated arms against their pose targets. */
import fs from "node:fs";
import * as THREE from "three";
import { expect, it } from "vitest";
import type { BoneName, PhysicsParams } from "../contracts";
import { parseModel } from "../character/asset";
import { createCharacter } from "../character/character";
import { DEFAULT_RETARGETER, registerBuiltins as registerMotion } from "../motion/blocks";
import { createRetargetPipeline } from "../motion/core";
import { bindRig } from "../motion/rig";
import { recordingOf, TrackPlayer, type Track } from "../motion/track";
import { createFrogSim, initPhysics } from ".";
import { untextured } from "./testModel";

const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
const corr = (a: number[], b: number[]) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};
/** The frog's hands follow the motion: the hand's height above the shoulder (what the e2e correlates with the person)
 *  on the simulated bones against the pose targets, through the dance tracks. */
it.skipIf(!fs.existsSync("public/models/naiwa.glb"))("the hands follow their targets on the dance tracks", async () => {
  await initPhysics(); registerMotion();
  const ch = createCharacter(await parseModel(untextured(fs.readFileSync("public/models/naiwa.glb")), "m"), "glb", "m");
  const want: Record<string, number> = { naenae: 0.9, gouxiong: 0.85, kemusan: 0.98 };
  for (const id of Object.keys(want)) {
    const track = JSON.parse(fs.readFileSync(`public/dances/${id}.json`, "utf8")) as Track;
    const sim = createFrogSim(ch.spec, PARAMS, { id: "cpu-constraints", settings: {} });
    await sim.ready; sim.setMode("driven");
    const p = createRetargetPipeline(bindRig(ch.rig), { id: DEFAULT_RETARGETER, settings: {} }, recordingOf(track));
    const player = new TrackPlayer(track, () => p);
    const T = new Map<BoneName, THREE.Matrix4>(), B = new Map<BoneName, THREE.Matrix4>();
    const tgt: number[] = [], sim_: number[] = [], gap: number[] = [];
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let k = 0; k < 600; k++) {
      const goal = player.goal((k / 60) % track.duration, 1 / 60, false);
      ch.targetsFromPose(goal && p.pose(goal, 1 / 60), T);
      sim.setTargets(T); sim.step(1 / 60); sim.readBones(B);
      if (k < 60) continue;
      for (const side of ["L", "R"]) {
        v.setFromMatrixPosition(T.get(`hand_${side}` as BoneName)!); w.setFromMatrixPosition(B.get(`hand_${side}` as BoneName)!);
        const su = new THREE.Vector3().setFromMatrixPosition(T.get(`upperarm_${side}` as BoneName)!).y, ss = new THREE.Vector3().setFromMatrixPosition(B.get(`upperarm_${side}` as BoneName)!).y;
        if (side === "R") { tgt.push(v.y - su); sim_.push(w.y - ss); }
        gap.push(v.distanceTo(w));
      }
    }
    let best = 0, lag = 0;
    for (let l = 0; l <= 12; l++) { const c = corr(tgt.slice(0, tgt.length - l), sim_.slice(l)); if (c > best) { best = c; lag = l; } }
    const g = gap.sort((a, b) => a - b);
    console.log(`TRACK ${id}: wrist-height corr ${corr(tgt, sim_).toFixed(3)} (best ${best.toFixed(3)} at lag ${lag} frames), hand gap median ${(g[g.length >> 1] * 100).toFixed(1)} cm p95 ${(g[Math.floor(g.length * 0.95)] * 100).toFixed(1)} cm, sim height range ${(Math.max(...sim_) - Math.min(...sim_)).toFixed(2)} vs target ${(Math.max(...tgt) - Math.min(...tgt)).toFixed(2)} m`);
    expect(corr(tgt, sim_)).toBeGreaterThan(want[id]);
    expect(g[g.length >> 1]).toBeLessThan(0.05);
    sim.dispose();
  }
}, 600000);
