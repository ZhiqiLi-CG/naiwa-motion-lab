import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { LandmarkFrame, PersonFrame, Recording } from "./api";
import { DEFAULT_RETARGETER, registerBuiltins } from "./blocks";
import { createRetargetPipeline } from "./core";
import { PROCEDURAL_DANCES } from "./dances";
import { limbPenetration } from "./metrics";
import { OneEuro } from "./oneEuro";
import { idlePose, mirrorPose, SIDES, type BodyPose } from "./pose";
import { bindRig, jointPositions } from "./rig";
import { buildTestFrog } from "./testFrog";
import { frameAt } from "./track";

registerBuiltins();
const frog = buildTestFrog();
const b = bindRig(frog.rig);
const pipeline = (recording: Recording | null = null) => createRetargetPipeline(b, { id: DEFAULT_RETARGETER, settings: {} }, recording);
const { scene } = pipeline();
const solve = (_b: unknown, goal: BodyPose) => pipeline().pose(goal, 0);
/** The old Retargeter's signature over the pipeline's goal stage. */
class Retargeter {
  private p;
  constructor(recording: Recording = {}) {
    this.p = pipeline(recording);
  }
  pose(frame: LandmarkFrame, aspect: number, dt: number, mirror: boolean) {
    return this.p.goal({ ...frame, aspect }, dt, mirror);
  }
}
const smoothFrames = (frames: LandmarkFrame[], fps: number): PersonFrame[] => pipeline().recorded(frames.map((f) => ({ ...f, aspect: 1 })), fps);
const angle = (a: THREE.Quaternion, c: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(c))));

describe("rig binding", () => {
  it("fits the body from the Body mesh", () => {
    expect(b.bodySource).toBe("mesh");
    expect(b.bands.length).toBeGreaterThan(10);
  });

  it("solves the rig's own rest directions to its rest rotations", () => {
    const p = idlePose();
    for (const s of SIDES) {
      p.arm[s] = { upper: b.arm[s].dirUpper.clone(), fore: b.arm[s].dirFore.clone(), palm: null, belly: null, overhead: 0, fingers: [0, 0, 0, 0, 0] };
      p.leg[s] = { thigh: b.leg[s].dirThigh.clone(), shin: b.leg[s].dirShin.clone(), toe: 0 };
    }
    const f = solve(b, p);
    for (const [name, bone] of frog.rig.bones) if (name !== "root") expect(angle(f.bones[name]!, bone.quaternion)).toBeLessThan(1e-3);
    expect(Math.abs(f.rootOffset!.y)).toBeLessThan(1e-6);
  });
});

describe("procedural dances", () => {
  for (const d of PROCEDURAL_DANCES) {
    it(`${d.id}: limbs stay out of the belly, feet on the floor, the loop is seamless`, () => {
      let worst = 0;
      for (let t = 0; t < d.duration; t += 0.05) {
        const pose = d.pose(t);
        const f = solve(b, pose);
        worst = Math.max(worst, limbPenetration(b, scene.constraints, scene.solver.solve(pose)));
        const P = jointPositions(b, { ...f, rootYaw: 0 });
        const lowest = Math.min(P.get("foot_L")!.y, P.get("foot_R")!.y);
        expect(lowest).toBeCloseTo(b.restFootY + pose.lift, 4);
        for (const q of Object.values(f.bones)) expect(Number.isFinite(q!.w)).toBe(true);
      }
      expect(worst).toBeLessThan(0.01);
      const a = jointPositions(b, solve(b, d.pose(0)));
      const z = jointPositions(b, solve(b, d.pose(d.duration - 1e-4)));
      for (const [n, p] of a) expect(p.distanceTo(z.get(n)!)).toBeLessThan(0.02);
    });
  }

  it("mirroring swaps the frog's sides", () => {
    const pose = PROCEDURAL_DANCES.find((d) => d.id === "wave")!.pose(0.3);
    const A = jointPositions(b, solve(b, pose));
    const B = jointPositions(b, solve(b, mirrorPose(pose)));
    for (const [n, p] of A) {
      const other = n.endsWith("_L") ? n.replace("_L", "_R") : n.endsWith("_R") ? n.replace("_R", "_L") : n;
      const q = B.get(other as typeof n)!;
      expect(Math.hypot(p.x + q.x, p.y - q.y, p.z - q.z)).toBeLessThan(1e-3);
    }
  });
});

/** A person facing the camera in MediaPipe's world frame (x to the image right, y down, z away), meters. */
function person(over: Partial<Record<number, [number, number, number]>> = {}, shiftImageY = 0): LandmarkFrame {
  const P: Record<number, [number, number, number]> = {
    0: [0, -0.62, -0.1], 2: [0.03, -0.66, -0.08], 5: [-0.03, -0.66, -0.08], 7: [0.07, -0.64, 0], 8: [-0.07, -0.64, 0],
    11: [0.18, -0.45, 0], 12: [-0.18, -0.45, 0], 13: [0.22, -0.2, 0], 14: [-0.22, -0.2, 0], 15: [0.24, 0.03, 0], 16: [-0.24, 0.03, 0],
    23: [0.1, 0, 0], 24: [-0.1, 0, 0], 25: [0.1, 0.42, 0], 26: [-0.1, 0.42, 0], 27: [0.1, 0.82, 0], 28: [-0.1, 0.82, 0],
    29: [0.1, 0.86, 0.05], 30: [-0.1, 0.86, 0.05], 31: [0.1, 0.88, -0.1], 32: [-0.1, 0.88, -0.1],
    ...over,
  };
  const world: number[][] = [];
  const image: number[][] = [];
  for (let i = 0; i < 33; i++) {
    const p = P[i] ?? P[0];
    world.push([p[0], p[1], p[2], 1]);
    image.push([0.5 + p[0] * 0.45, 0.5 + p[1] * 0.45 + shiftImageY, p[2], 1]);
  }
  return { world, image };
}

describe("retargeting a person", () => {
  it("copies arm directions, left to left (or mirrored)", () => {
    const tpose = person({ 13: [0.45, -0.45, 0], 15: [0.7, -0.45, 0] });
    const p = new Retargeter().pose(tpose, 1, 1 / 30, false)!;
    expect(p.arm.L.upper.x).toBeGreaterThan(0.95);
    expect(p.arm.R.upper.y).toBeLessThan(-0.5);
    const m = new Retargeter().pose(tpose, 1, 1 / 30, true)!;
    expect(m.arm.R.upper.x).toBeLessThan(-0.95);
    const P = jointPositions(b, solve(b, p));
    expect(P.get("hand_L")!.x).toBeGreaterThan(P.get("upperarm_L")!.x + 0.25);
  });

  it("laughs when the hands hold the belly and the body bends over", () => {
    const r = new Retargeter();
    // Bent forward ~35°: the shoulders and head come towards the camera; the wrists on the belly in front.
    const bent = person({
      0: [0, -0.5, -0.45], 7: [0.07, -0.52, -0.35], 8: [-0.07, -0.52, -0.35], 2: [0.03, -0.55, -0.42], 5: [-0.03, -0.55, -0.42],
      11: [0.18, -0.37, -0.26], 12: [-0.18, -0.37, -0.26], 13: [0.24, -0.12, -0.3], 14: [-0.24, -0.12, -0.3],
      15: [0.1, -0.1, -0.22], 16: [-0.1, -0.1, -0.22],
    });
    let p: BodyPose | null = null;
    for (let i = 0; i < 20; i++) p = r.pose(bent, 1, 1 / 30, false);
    expect(p!.expressions.laugh).toBeGreaterThan(0.6);
    expect(p!.arm.L.belly!.weight).toBeGreaterThan(0.5);
  });

  it("hops when the feet leave their floor line", () => {
    const r = new Retargeter();
    for (let i = 0; i < 30; i++) r.pose(person(), 1, 1 / 30, false);
    const up = r.pose(person({}, -0.1), 1, 1 / 30, false)!;
    expect(up.lift).toBeGreaterThan(0.05);
  });

  it("steps sideways with the person, towards the frog's own left when the person moves to the image right", () => {
    const r = new Retargeter({ home: 0.5 });
    const step = (dx: number) => {
      const f = person();
      for (const p of f.image) p[0] += dx;
      return r.pose(f, 1, 1 / 30, false)!.shift;
    };
    expect(Math.abs(step(0))).toBeLessThan(1e-6);
    expect(step(0.1)).toBeGreaterThan(0.05);
    expect(new Retargeter({ home: 0.5 }).pose(person(), 1, 1 / 30, true)!.shift).toBeCloseTo(0, 6);
  });

  it("finds nobody in an empty frame", () => {
    expect(new Retargeter().pose({ world: [], image: [] }, 1, 1 / 30, false)).toBeNull();
  });
});

describe("tracks", () => {
  it("interpolates between frames and loops", () => {
    const a = person(), c = person({}, 0.1);
    const track = { id: "t", name: "t", fps: 10, duration: 0.2, source: { title: "", url: "", start: 0, end: 0.2 }, frames: [a, c] };
    expect(frameAt(track, 0.05).image[0][1]).toBeCloseTo((a.image[0][1] + c.image[0][1]) / 2, 6);
    expect(frameAt(track, 0.2).image[0][1]).toBeCloseTo(a.image[0][1], 6);
  });

  it("smooths without delaying a move", () => {
    const fps = 30;
    const frames = Array.from({ length: 90 }, (_, i) => person({}, 0.05 * Math.sin((2 * Math.PI * i) / 30) + (Math.random() - 0.5) * 0.01));
    const out = smoothFrames(frames, fps);
    const ys = out.map((f) => f.image[0][1]);
    const peak = ys.slice(30, 60).indexOf(Math.max(...ys.slice(30, 60))) + 30;
    expect(Math.abs(peak - 37.5)).toBeLessThanOrEqual(1.5); // the input peaks at i = 37.5
  });

  it("bridges short gaps and keeps long ones empty", () => {
    const frames = Array.from({ length: 60 }, () => person());
    for (const i of [10, 11]) frames[i] = { world: [], image: [] };
    for (let i = 30; i < 50; i++) frames[i] = { world: [], image: [] };
    const out = smoothFrames(frames, 30);
    expect(out[10].world.length).toBe(33);
    expect(out[40].world.length).toBe(0);
  });
});

describe("one euro filter", () => {
  it("leaves a still signal still", () => {
    const f = new OneEuro(1, 1);
    const v = [1, 2, 3];
    for (let i = 0; i < 10; i++) f.filter(v, i / 30);
    expect(v).toEqual([1, 2, 3]);
  });
});
