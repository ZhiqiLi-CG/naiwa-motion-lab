/**
 * Coherence on synthetic moving-camera footage: preset dance tracks (public/dances, looped to about 10 s) seen through
 * a known camera (a pan with a tilt and a zoom, then a cut to another framing and camera angle that pans again), with
 * the camera estimate drifting like a real one and detector noise on the landmarks. The algorithm must recover the
 * person's own motion: their hips in the picture, their heading, and what the frog does with them (side steps, hops,
 * turning), compared with the same dance seen by a still camera.
 */
import { describe, expect, it } from "vitest";
import { createRetargetPipeline } from "../../../motion/core";
import { recordingOf, TrackPlayer, type Track } from "../../../motion/track";
import { loadTrack, testRig } from "../rigs";
import { setup } from "../testSupport";
import { AUTO, coherence, compare, DEFAULTS } from "./index";
import { fixFlips, findOutliers, replaceOutliers } from "./outliers";
import { copyFrames, heading, hip, PAIRS, present, rotateWorld, typicalTorso, TORSO_M, wrap, type Frame } from "./frames";

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648 - 0.5);

/** A dance looped to at least `seconds`. */
function looped(id: string, seconds: number): Track {
  const t = loadTrack(id);
  const frames = [];
  while (frames.length < seconds * t.fps) frames.push(...copyFrames(t.frames));
  return { ...t, frames, duration: frames.length / t.fps };
}

interface Scenario {
  raw: Track;
  cut: number;
  turn: number;
}

/** The truth seen through a moving camera with a cut, the camera estimate drifting, detector noise. */
function film(truth: Track, seed = 1): Scenario {
  const n = truth.frames.length, cut = Math.round(n * 0.55);
  const rnd = rng(seed);
  const turn = (40 * Math.PI) / 180;
  // Within shot A: pan left 25 % of the picture, tilt, zoom in 25 %. Shot B: framed smaller and off-centre, the camera
  // turned 40° round the person, then panning right.
  const camA = (k: number) => ({ s: 1 + (0.25 * k) / cut, tx: -0.25 * (k / cut) + 0.03 * Math.sin(k / 9), ty: 0.04 * Math.sin(k / 23) });
  const camB = (k: number) => ({ s: 1 + 0.05 * Math.sin((k - cut) / 30), tx: (0.15 * (k - cut)) / (n - cut), ty: 0 });
  const frameB = { s: 0.7, tx: 0.15, ty: -0.05 };
  let driftX = 0, driftY = 0, driftS = 0;
  const camera: { shift: [number, number]; scale: number }[] = [];
  const frames = truth.frames.map((f, k) => {
    const g = { world: f.world.map((p) => [p[0] + rnd() * 0.02, p[1] + rnd() * 0.02, p[2] + rnd() * 0.02, p[3]]), image: f.image.map((p) => [p[0] + rnd() * 0.008, p[1] + rnd() * 0.008, p[2], p[3]]) };
    const inB = k >= cut;
    const c = inB ? camB(k) : camA(k);
    // The camera estimate: the truth plus a random walk (about 0.1 % of the picture per frame), restarted at the cut.
    if (k === cut) driftX = driftY = driftS = 0;
    if (k !== 0 && k !== cut) (driftX += rnd() * 0.002), (driftY += rnd() * 0.002), (driftS += rnd() * 0.002);
    camera.push({ shift: [c.tx + driftX, c.ty + driftY], scale: c.s * (1 + driftS) });
    for (const p of g.image) {
      let x = p[0], y = p[1];
      if (inB) (x = frameB.s * (x - 0.5) + 0.5 + frameB.tx), (y = frameB.s * (y - 0.5) + 0.5 + frameB.ty);
      p[0] = c.s * (x - 0.5) + 0.5 + c.tx;
      p[1] = c.s * (y - 0.5) + 0.5 + c.ty;
      p[2] *= c.s * (inB ? frameB.s : 1);
    }
    if (inB) rotateWorld(g, -turn);
    return g;
  });
  return { raw: { ...truth, frames, camera, cuts: [cut] }, cut, turn };
}

/** RMS distance of the hips from the truth after the best constant offset (cm, torso = TORSO_M), and the RMS heading
 *  error after the best constant (degrees). */
function errors(got: Frame[], truth: Frame[], aspect: number) {
  const T = typicalTorso(truth, aspect);
  const d: [number, number][] = [], h: number[] = [];
  got.forEach((f, k) => {
    if (!present(f)) return;
    const a = hip(f, aspect), b = hip(truth[k], aspect);
    d.push([a[0] - b[0], a[1] - b[1]]);
    h.push(wrap(heading(f) - heading(truth[k])));
  });
  const mx = d.reduce((s, x) => s + x[0], 0) / d.length, my = d.reduce((s, x) => s + x[1], 0) / d.length;
  const mh = Math.atan2(h.reduce((s, x) => s + Math.sin(x), 0), h.reduce((s, x) => s + Math.cos(x), 0));
  return {
    hips: (Math.sqrt(d.reduce((s, x) => s + (x[0] - mx) ** 2 + (x[1] - my) ** 2, 0) / d.length) / T) * TORSO_M * 100,
    heading: (Math.sqrt(h.reduce((s, x) => s + wrap(x - mh) ** 2, 0) / h.length) * 180) / Math.PI,
  };
}

/** What the frog does with a track: side step, hop height and heading per frame (the goal block). */
function frog(track: Track) {
  const rig = testRig();
  const p = createRetargetPipeline(rig, { id: "direction-copy", settings: {} }, recordingOf(track));
  const player = new TrackPlayer(track, () => p);
  const out: { shift: number; lift: number; yaw: number }[] = [];
  for (let k = 0; k < track.frames.length; k++) {
    const g = player.goal(k / track.fps, 1 / track.fps, false);
    out.push(g ? { shift: g.shift, lift: g.lift, yaw: g.yaw } : { shift: NaN, lift: NaN, yaw: NaN });
  }
  return out;
}

function frogError(a: ReturnType<typeof frog>, b: ReturnType<typeof frog>) {
  let s = 0, l = 0, y = 0, n = 0;
  const dy: number[] = [];
  a.forEach((x, k) => Number.isFinite(x.yaw) && Number.isFinite(b[k].yaw) && dy.push(x.yaw - b[k].yaw));
  const my = dy.reduce((p, q) => p + q, 0) / Math.max(1, dy.length);
  a.forEach((x, k) => {
    const z = b[k];
    if (!Number.isFinite(x.shift) || !Number.isFinite(z.shift)) return;
    s += (x.shift - z.shift) ** 2;
    l += (x.lift - z.lift) ** 2;
    y += (x.yaw - z.yaw - my) ** 2;
    n++;
  });
  return { shift: Math.sqrt(s / n) * 100, lift: Math.sqrt(l / n) * 100, yaw: (Math.sqrt(y / n) * 180) / Math.PI };
}

const f1 = (x: number) => x.toFixed(1);

describe("motion coherence under a moving camera", () => {
  for (const id of ["kemusan", "penguin", "gouxiong"]) {
    it(`recovers ${id} from a panning, zooming camera with a cut`, async () => {
      await setup();
      const truth = looped(id, 10);
      const { raw, cut } = film(truth);
      const aspect = truth.aspect ?? 1;
      const auto = coherence(raw, AUTO);
      const full = coherence(raw, DEFAULTS);
      const eRaw = errors(raw.frames, truth.frames, aspect), eAuto = errors(auto.track.frames, truth.frames, aspect), eFull = errors(full.track.frames, truth.frames, aspect);
      const fTruth = frog(truth), fRaw = frogError(frog(raw), fTruth), fAuto = frogError(frog(auto.track), fTruth), fFull = frogError(frog(full.track), fTruth);
      const { before, after } = compare(raw, full);
      console.log(
        `${id} (${raw.frames.length} frames, cut at ${cut}; auto ${auto.report.ms.toFixed(0)} ms, full ${full.report.ms.toFixed(0)} ms)\n` +
          `  hips vs truth (cm): raw ${f1(eRaw.hips)}, auto ${f1(eAuto.hips)}, full ${f1(eFull.hips)}; heading (°): raw ${f1(eRaw.heading)}, auto ${f1(eAuto.heading)}, full ${f1(eFull.heading)}\n` +
          `  frog vs a still camera: side step (cm) raw ${f1(fRaw.shift)} / auto ${f1(fAuto.shift)} / full ${f1(fFull.shift)}; hop (cm) ${f1(fRaw.lift)} / ${f1(fAuto.lift)} / ${f1(fFull.lift)}; heading (°) ${f1(fRaw.yaw)} / ${f1(fAuto.yaw)} / ${f1(fFull.yaw)}\n` +
          `  landmarks before → after (full): jerk ${before.jerk.toFixed(0)} → ${after.jerk.toFixed(0)} m/s³, travel jerk ${before.travelJerk.toFixed(0)} → ${after.travelJerk.toFixed(0)} m/s³, ` +
          `foot slide ${f1(before.footSlide * 100)} → ${f1(after.footSlide * 100)} cm/s, speed at the cut ${f1(before.cutSpeed)} → ${f1(after.cutSpeed)} m/s, bone CV ${f1(before.boneCV)} → ${f1(after.boneCV)} %, ` +
          `fidelity ${f1(after.fidelity!)} cm (world) ${f1(after.fidelityPicture!)} cm (picture)`,
      );
      expect(auto.report.anchors.length).toBe(1);
      expect(eAuto.hips).toBeLessThan(eRaw.hips * 0.3);
      expect(eAuto.heading).toBeLessThan(eRaw.heading * 0.4);
      expect(fAuto.shift).toBeLessThan(fRaw.shift * 0.5);
      expect(fFull.shift).toBeLessThan(fRaw.shift * 0.5);
      expect(after.cutSpeed).toBeLessThan(before.cutSpeed * 0.2);
      expect(after.jerk).toBeLessThan(before.jerk * 0.5);
      expect(after.footSlide).toBeLessThan(before.footSlide * 0.5);
    }, 60000);
  }

  it("leaves a still camera's dance as it was (auto)", () => {
    const truth = looped("naenae", 6);
    const still = { ...truth, camera: truth.frames.map(() => ({ shift: [0.002, -0.001] as [number, number], scale: 1.001 })) };
    const r = coherence(still, AUTO);
    expect(r.report.movingShots).toBe(0);
    expect(errors(r.track.frames, truth.frames, truth.aspect ?? 1).hips).toBeLessThan(0.01);
  });

  it("finds a cut from the person's jump when the track has no camera information", () => {
    const truth = looped("kemusan", 8);
    const { raw, cut } = film(truth);
    const bare = { ...raw, camera: undefined, cuts: undefined };
    const r = coherence(bare, { ...DEFAULTS, camera: false });
    expect(r.report.foundCuts.some((c) => Math.abs(c - cut) <= 1)).toBe(true);
  });

  it("undoes swapped legs and replaces spikes", () => {
    const truth = looped("kemusan", 4);
    const frames = copyFrames(truth.frames);
    const legs = PAIRS.filter(([l]) => l >= 23);
    const swapped = [40, 41, 42, 77];
    for (const k of swapped) for (const [l, r] of legs) for (const kind of ["world", "image"] as const) [frames[k][kind][l], frames[k][kind][r]] = [frames[k][kind][r], frames[k][kind][l]];
    frames[60].world[15][0] += 0.4;
    frames[61].image[27][1] -= 0.15;
    const fixed = fixFlips(frames, [], truth.aspect ?? 1);
    const bad = findOutliers(frames, [], 0.3, 4);
    expect(bad[60].has(15)).toBe(true);
    expect(bad[61].has(27)).toBe(true);
    replaceOutliers(frames, bad, []);
    expect(fixed).toBeGreaterThanOrEqual(swapped.length);
    for (const k of swapped) expect(Math.abs(frames[k].image[25][0] - truth.frames[k].image[25][0])).toBeLessThan(0.01);
    expect(Math.abs(frames[60].world[15][0] - truth.frames[60].world[15][0])).toBeLessThan(0.08);
    expect(Math.abs(frames[61].image[27][1] - truth.frames[61].image[27][1])).toBeLessThan(0.03);
  });

  it("makes the loop seamless", () => {
    const t = loadTrack("kemusan");
    const cutShort = { ...t, frames: t.frames.slice(0, Math.round(t.frames.length * 0.8)) };
    const r = coherence(cutShort, { ...DEFAULTS, loop: 0.5, smooth: "none", pin: 0 });
    const f = r.track.frames, n = f.length;
    // The step from the last frame to the first is like any other step.
    const step = (a: Frame, b: Frame) => Math.hypot(...[13, 14, 15, 16, 25, 26].flatMap((i) => [0, 1, 2].map((c) => a.world[i][c] - b.world[i][c])));
    const typical = f.slice(1).map((x, k) => step(f[k], x)).sort((a, b) => a - b)[Math.floor(n * 0.9)];
    expect(step(f[n - 1], f[0])).toBeLessThan(typical);
    expect(step(cutShort.frames[n - 1], cutShort.frames[0])).toBeGreaterThan(typical);
  });
});
