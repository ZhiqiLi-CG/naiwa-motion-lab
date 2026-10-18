/**
 * The camera estimator on synthetic frames: a textured background seen through a known pan and zoom, a "person" (a
 * differently textured box moving on its own) masked out, and a cut to another scene.
 */
import { describe, expect, it } from "vitest";
import { accumulate, CameraEstimator, type Box, type CameraStep } from "./cameraMotion";

/** A smooth random texture over the plane (picture fractions), 0..255. */
function texture(seed: number): (u: number, v: number) => number {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
  const waves = Array.from({ length: 24 }, () => {
    const f = 3 + rnd() * 22, a = rnd() * Math.PI * 2;
    return { kx: f * Math.cos(a) * 2 * Math.PI, ky: f * Math.sin(a) * 2 * Math.PI, ph: rnd() * 6.3, amp: 0.4 + rnd() };
  });
  const sum = waves.reduce((x, w) => x + w.amp, 0);
  return (u, v) => 128 + (110 / sum) * waves.reduce((x, w) => x + w.amp * Math.sin(w.kx * u + w.ky * v + w.ph), 0);
}

interface Cam {
  s: number;
  tx: number;
  ty: number;
}

/** A frame w × h: the background through camera c (shot-relative), a person box at `person` with its own texture. */
function render(w: number, h: number, bg: (u: number, v: number) => number, c: Cam, person: Box, fg: (u: number, v: number) => number, noise: number, seed: number) {
  const out = new Float32Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648 - 0.5);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) / w, py = (y + 0.5) / h;
      const inPerson = px > person.x0 && px < person.x1 && py > person.y0 && py < person.y1;
      const u = (px - 0.5 - c.tx) / c.s + 0.5, v = (py - 0.5 - c.ty) / c.s + 0.5;
      out[y * w + x] = Math.max(0, Math.min(255, (inPerson ? fg(px * 3, py * 3) : bg(u * 1.3, v * (1.3 * h) / w)) + noise * rnd()));
    }
  return out;
}

const W = 160, H = 90;

function run(frames: number, cam: (k: number) => Cam, cutAt = -1) {
  const est = new CameraEstimator();
  const bgA = texture(3), bgB = texture(11), fg = texture(7);
  const steps: CameraStep[] = [];
  let ms = 0;
  for (let k = 0; k < frames; k++) {
    // The person sways across the middle (moving against the camera, so a fit that used them would be wrong).
    const px = 0.4 + 0.1 * Math.sin(k * 0.3), person = { x0: px, x1: px + 0.18, y0: 0.15, y1: 0.95 };
    const shot = cutAt >= 0 && k >= cutAt;
    const img = render(W, H, shot ? bgB : bgA, cam(k), person, fg, 4, k + 1);
    const pad = { x0: person.x0 - 0.03, x1: person.x1 + 0.03, y0: person.y0 - 0.03, y1: person.y1 + 0.03 };
    const t0 = performance.now();
    steps.push(est.push(img, W, H, [pad]));
    ms += performance.now() - t0;
  }
  return { steps, ms: ms / frames };
}

describe("camera estimator", () => {
  it("reads a still camera as still", () => {
    const { steps } = run(20, () => ({ s: 1, tx: 0, ty: 0 }));
    const { camera, cuts } = accumulate(steps);
    expect(cuts).toEqual([]);
    const last = camera[camera.length - 1];
    expect(Math.abs(last.shift[0]) + Math.abs(last.shift[1])).toBeLessThan(0.004);
    expect(Math.abs(last.scale - 1)).toBeLessThan(0.004);
  });

  it("recovers a pan with a zoom, ignoring the person", () => {
    // Pans left then up by up to 4 % of the picture per frame, zooming in by 1.5 % per frame.
    const cam = (k: number) => ({ s: 1.015 ** k, tx: -0.02 * k - 0.0006 * k * k, ty: 0.01 * Math.sin(k * 0.2) * k / 4 });
    const N = 30;
    const { steps, ms } = run(N, cam);
    const { camera, cuts } = accumulate(steps);
    expect(cuts).toEqual([]);
    let err = 0, errS = 0;
    for (let k = 0; k < N; k++) {
      const c = cam(k);
      err = Math.max(err, Math.hypot(camera[k].shift[0] - c.tx, camera[k].shift[1] - c.ty));
      errS = Math.max(errS, Math.abs(Math.log(camera[k].scale / c.s)));
    }
    console.log(`camera estimator: pan + zoom over ${N} frames, worst shift error ${(err * 100).toFixed(2)} % of the picture, zoom ${(errS * 100).toFixed(2)} %; ${ms.toFixed(2)} ms per ${W}×${H} frame`);
    expect(steps.filter((s) => s.ok).length).toBe(N);
    expect(err).toBeLessThan(0.01);
    expect(errS).toBeLessThan(0.01);
  });

  it("finds a cut to another scene and restarts the shot there", () => {
    const cam = (k: number) => (k < 12 ? { s: 1, tx: -0.01 * k, ty: 0 } : { s: 1, tx: -0.01 * (k - 12), ty: 0 });
    const { steps } = run(24, cam, 12);
    const { camera, cuts } = accumulate(steps);
    expect(cuts).toEqual([12]);
    expect(camera[12].shift).toEqual([0, 0]);
    expect(Math.abs(camera[23].shift[0] + 0.11)).toBeLessThan(0.006);
  });
});
