import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CameraRig, FOV, fitDistance } from "./cameraRig";

const run = (rig: CameraRig, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) rig.update(1 / 60);
};

function makeRig(aspect = 16 / 9) {
  const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.05, 100);
  const rig = new CameraRig(cam);
  rig.setFocus(new THREE.Vector3(0, 0.5, 0));
  rig.snap();
  rig.update(1 / 60);
  return { cam, rig };
}

describe("CameraRig", () => {
  it("frames the whole frog by default, a little from above", () => {
    const { cam, rig } = makeRig();
    expect(cam.position.y).toBeGreaterThan(rig.target.y);
    cam.updateMatrixWorld();
    // Head (1.0 m) and feet (0) are inside the view.
    for (const y of [0, 1.0]) {
      const p = new THREE.Vector3(0, y, 0).project(cam);
      expect(Math.abs(p.y)).toBeLessThan(0.95);
    }
  });

  it("portrait screens step back so the frog's width fits", () => {
    expect(fitDistance(390 / 844)).toBeGreaterThan(fitDistance(16 / 9));
  });

  it("never goes under the floor, however far it is dragged down or shaken", () => {
    const { cam, rig } = makeRig();
    rig.setFocus(new THREE.Vector3(0, -3, 0)); // a bogus focus below the floor is clamped too
    for (let i = 0; i < 200; i++) {
      rig.orbitBy(0.05, -0.2);
      rig.shake(1);
      rig.update(1 / 60);
      expect(cam.position.y).toBeGreaterThan(0.05);
    }
  });

  it("follows a thrown frog smoothly and settles on it", () => {
    const { rig } = makeRig();
    rig.setFocus(new THREE.Vector3(4, 0.5, -2));
    rig.update(1 / 60);
    expect(rig.target.x).toBeLessThan(0.5); // no jump
    run(rig, 3);
    expect(rig.target.distanceTo(new THREE.Vector3(4, 0.5, -2))).toBeLessThan(0.01);
  });

  it("clamps zoom and keeps spinning briefly after a flick", () => {
    const { cam, rig } = makeRig();
    for (let i = 0; i < 50; i++) rig.zoomBy(0.5);
    run(rig, 2);
    const near = cam.position.distanceTo(rig.target);
    expect(near).toBeGreaterThan(1.2);
    const yaw0 = rig.yaw;
    rig.fling(3, 0);
    run(rig, 0.5);
    const yaw1 = rig.yaw;
    run(rig, 3);
    expect(yaw1).toBeGreaterThan(yaw0 + 0.3);
    expect(rig.yaw - yaw1).toBeLessThan(yaw1 - yaw0 + 0.5);
  });
});
