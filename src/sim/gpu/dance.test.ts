/**
 * The real frog dancing 狗熊哆嗦毛 on gpu-mpm (CPU backend, one thread), with the page's motion switches: free, a
 * poke on the arm, the dance, back to free. The forearms whip round at 15 rad/s; the flesh must stay finite and whole.
 * Minutes on one thread: MPM_FROG=1 npx vitest run src/sim/gpu/dance.test.ts
 */
import fs from "node:fs";
import * as THREE from "three";
import { expect, it } from "vitest";
import type { BoneName, MotionSource, PhysicsParams } from "../../contracts";
import { parseModel } from "../../character/asset";
import { createCharacter } from "../../character/character";
import { DEFAULT_RETARGETER, registerBuiltins as registerMotion } from "../../motion/blocks";
import { createRetargetPipeline } from "../../motion/core";
import { bindRig } from "../../motion/rig";
import { trackSource } from "../../motion/sources";
import type { Track } from "../../motion/track";
import { createFrogSim, initPhysics } from "..";
import { untextured } from "../testModel";
import { forceBackend, MpmFlesh, probeDevices, registerGpuSimulators } from ".";

const PARAMS: PhysicsParams = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };

it.skipIf(!process.env.MPM_FROG)("comes through 狗熊哆嗦毛 and back to free mode", async () => {
  await initPhysics();
  await probeDevices();
  forceBackend("cpu-inline");
  registerGpuSimulators();
  registerMotion();
  const ch = createCharacter(await parseModel(untextured(fs.readFileSync("public/models/naiwa.glb")), "m"), "glb", "m");
  const sim = createFrogSim(ch.spec, PARAMS, { id: "gpu-mpm", settings: { gridCell: 5 } });
  await sim.ready;
  sim.setMode("free");
  const flesh = sim.scene.flesh as MpmFlesh;
  const binding = bindRig(ch.rig), targets = new Map<BoneName, THREE.Matrix4>(), limbs = new Map<string, Float32Array>();
  let source: MotionSource | null = null, fastest = 0;
  const run = (seconds: number) => {
    for (let k = 0; k < seconds * 60; k++) {
      ch.targetsFromPose(source ? source.update(0, 1 / 60) : null, targets);
      sim.setTargets(targets);
      sim.step(1 / 60);
      sim.readLimbs(limbs);
      for (const a of [sim.readBody(), ...limbs.values()]) expect(a.every(Number.isFinite)).toBe(true);
      const V = flesh.output?.velocities;
      if (V) for (let i = 0; i < V.length; i += 4) fastest = Math.max(fastest, Math.hypot(V[i], V[i + 1], V[i + 2]));
    }
  };
  run(1);
  const ray = new THREE.Ray(new THREE.Vector3(-1, 0.5, 0.02), new THREE.Vector3(1, 0, 0));
  sim.poke(sim.raycast(ray)!, 0.7, ray.direction);
  run(1);
  const id = "gouxiong", info = (JSON.parse(fs.readFileSync("public/dances/index.json", "utf8")) as { id: string; duration: number }[]).find((t) => t.id === id)!;
  const track = JSON.parse(fs.readFileSync(`public/dances/${id}.json`, "utf8")) as Track;
  sim.setMode("driven");
  source = trackSource(Promise.resolve(track), info.duration, (rec) => {
    const p = createRetargetPipeline(binding, { id: DEFAULT_RETARGETER, settings: {} }, rec);
    return () => p;
  }, () => {});
  await Promise.resolve();
  sim.transition();
  run(3);
  source = null;
  sim.setMode("free");
  run(3);
  console.log("dance ↔ free:", { fastest, resets: flesh.timing.resets, stats: sim.stats().volume });
  expect(fastest).toBeLessThanOrEqual(30.01);
  sim.dispose();
}, 900000);
