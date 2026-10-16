import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { parseSession, SessionPlayer, SessionRecorder } from "./index";
import { makeTestSession, restSkeletonFromGlb } from "./testSession";
import { pack, unpack } from "./pack";

describe("session", () => {
  it("packs and unpacks typed arrays", () => {
    const v = [0.5, -1.25, 3];
    expect(Array.from(unpack(pack("f32", [3], v)))).toEqual(v);
    const q = unpack(pack("i16", [3], v, 3 / 32767));
    q.forEach((x, i) => expect(x).toBeCloseTo(v[i], 3));
  });

  it("records frames and plays them back", () => {
    const rec = new SessionRecorder();
    rec.start(1000, { params: { softness: 0.5, bounciness: 0.5, gravity: 1, bellySize: 1, stubbornness: 0.5 }, mode: "driven", theme: "light" });
    const cam = new THREE.PerspectiveCamera(35, 1.5, 0.1, 50);
    for (let f = 0; f < 10; f++) {
      const t = 1000 + f * (1000 / 60);
      const hips = new THREE.Matrix4().compose(new THREE.Vector3(0, 0.31 + 0.01 * f, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.1 * f), new THREE.Vector3(1, 1, 1));
      cam.position.set(0, 1, 2 + 0.01 * f);
      cam.updateMatrixWorld();
      rec.frame(t, { bones: new Map([["root", new THREE.Matrix4()], ["hips", hips]]), camera: cam, balls: new Float32Array(f > 5 ? [0, 0.5, 0.3, 0.1] : []), expressions: { laugh: f / 9 } });
    }
    rec.event(1100, { kind: "poke", point: new THREE.Vector3(0, 0.5, 0.2), strength: 0.7, region: "belly" }, new THREE.Vector3(0, 0, -2));
    const file = parseSession(JSON.stringify(rec.stop()));
    expect(file.frameCount).toBe(10);
    expect(file.bones).toEqual(["root", "hips"]);
    expect(file.events[0].dir).toEqual([0, 0, -1]);
    const play = new SessionPlayer(file);
    const s = play.sample(9 / 60);
    const p = new THREE.Vector3().setFromMatrixPosition(s.bones.get("hips")!);
    expect(p.y).toBeCloseTo(0.4, 3);
    expect(s.expressions.laugh).toBeCloseTo(1, 2);
    expect(s.balls.length).toBe(4);
    expect(s.camera.position.z).toBeCloseTo(2.09, 3);
  });

  it("makes the test session from the character GLB", () => {
    const glb = readFileSync("public/models/naiwa.glb");
    const file = makeTestSession(restSkeletonFromGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength)));
    expect(file.frameCount).toBe(481);
    expect(file.bones).toContain("hand_L");
    expect(JSON.stringify(file).length).toBeLessThan(400_000);
  });
});
