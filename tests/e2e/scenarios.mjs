// What a visitor does and what must happen. Each scenario gets a fresh page (see run.mjs) and the context T:
// T.check(group, name, status, detail), T.out, T.cache, T.clips, T.flag(name), T.shared (cross-scenario baselines).
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diffFraction, decodePng, lumaStats } from "./lib/image.mjs";
import { probeRecording, extractFrame, audioLevel, clipFrames } from "./lib/media.mjs";
import { followScore, histogram, meanHistogram, splitLayout } from "./lib/follow.mjs";
import { mb } from "./lib/deploy.mjs";
import {
  sleep, MODES, waitReady, shot, toPx, locateFrog, frogRegion, findControl, findMode, describe, appState, enterMode,
  uploadVideo, poseRange, sampleBones, measureFrames, counts, since, mouseThrow, touchThrow,
} from "./lib/app.mjs";

// Targets. This machine is far faster than "an ordinary laptop", so the frame rate here must be near the display's.
const FPS_MIN = 50;
const WORK_P95_WARN_MS = 8; // half a 60 fps frame: a slower laptop needs the other half
const PHYSICS_P95_MAX_MS = 4; // the brief's physics budget
const DIFF_MIN = 0.01; // a reaction changes at least 1% of the frog's region…
const DIFF_OVER_IDLE = 3; // …and at least 3× what idling (breathing, blinking) changes
const POSE_MIN_DEG = 15;
const TRACK_TIMEOUT_MS = 45000;
const ANALYSIS_TIMEOUT_MS = 90000;
const FOLLOW_MIN = 0.5; // arm-raise correlation with the person
const SYNC_MAX_S = 0.25;
const SOAK_MS = 65000; // MediaPipe posts its usage log every 60 s
const REST_DRIFT_MAX_M = 0.03;
const ARM_BONES = ["hand_L", "hand_R", "upperarm_L", "upperarm_R", "forearm_L", "forearm_R", "chest", "hips"];
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (f) => `${f.fps.toFixed(0)} fps, main-thread work p50 ${f.workP50.toFixed(1)} ms / p95 ${f.workP95.toFixed(1)} ms, ${f.longTasks} long tasks` + (f.physicsP95 != null ? `, physics p50 ${f.physicsP50.toFixed(2)} ms / p95 ${f.physicsP95.toFixed(2)} ms` : "");

/* ---------------------------------------------------------------- shared verdicts ------------------------------ */

/** Is the app up at all? Reports MISSING (not FAIL) for parts that are not there yet. */
async function boot(T, group, page, log) {
  log.step = "boot";
  const ready = await waitReady(page);
  if (!ready.canvas) {
    T.check(group, "app shows a 3D canvas", "MISSING", `no canvas after ${Math.round(ready.ms / 1000)} s (src/main.ts not wired yet?)`);
    await shot(page, T.out, `${group}-boot`);
    return null;
  }
  if (ready.store && ready.timedOut) {
    T.check(group, "app finishes loading", "FAIL", `store.loading still active after ${Math.round(ready.ms / 1000)} s: "${ready.loading?.message}"`);
    await shot(page, T.out, `${group}-boot`);
    return null;
  }
  // src/main.ts exposes the hook when its boot has finished: errors and no hook mean the app never started.
  if (!ready.hook && log.errors.length) {
    T.check(group, "app starts", "FAIL", `${log.errors[0]}; the page says "${ready.text.replace(/\s+/g, " ").slice(0, 120)}"`);
    await shot(page, T.out, `${group}-boot`);
    return null;
  }
  return ready;
}

/** The frog is on screen: with the hook its own pixels cover the canvas centre; without, the centre is not the
 *  background seen at the canvas border. */
async function frogVisible(T, group, page, name) {
  const frog = await locateFrog(page, T.out, name);
  if (frog.centreCoverage != null) {
    T.check(group, "frog visible at the canvas centre", frog.centreCoverage >= 0.5 ? "PASS" : "FAIL",
      `frog covers ${pct(frog.centreCoverage)} of the centre, ${pct(frog.areaFraction)} of the canvas; ${pct(frog.yellow)} of its box is 奶蛙-yellow (${frog.how}); ${name}.png`);
  } else {
    T.check(group, "frog visible at the canvas centre", frog.centreForeground >= 0.5 ? "PASS" : "FAIL",
      `${pct(frog.centreForeground)} of the centre differs from the background; yellow ${pct(frog.yellow)} (${frog.how}); ${name}.png`);
  }
  return frog;
}

/** How much a still frog changes on its own between two frames (breathing, blinking, idle sway). */
async function idleChange(page, frog) {
  const a = await shot(page);
  await sleep(400);
  const b = await shot(page);
  const ex = (await page.evaluate(() => window.__e2e.overlayRects())).map((r) => toPx(a, r));
  return { region: diffFraction(a, b, toPx(a, frogRegion(frog)), ex), canvas: diffFraction(a, b, toPx(a, frog.rect), ex) };
}

function verdictPicture(T, group, what, diff, idle, file) {
  const need = Math.max(DIFF_MIN, DIFF_OVER_IDLE * idle);
  T.check(group, `${what} changes the picture`, diff >= need ? "PASS" : "FAIL", `${pct(diff)} of pixels changed (idle ${pct(idle)}, needs ${pct(need)}); ${file}`);
}

/** A gesture did what it should in the simulation (the event, with the hook), played a sound if sound is on, and
 *  drew no comic effects (the page is a simulation, not a game). */
async function verdictEffects(T, group, page, what, d, hooks, wantEvents) {
  const soundOn = (await appState(page))?.sound;
  const parts = [`${d.sounds} sound(s) with sound ${soundOn == null ? "?" : soundOn ? "on" : "off"}`];
  let ok = !soundOn || d.sounds > 0;
  if (hooks?.sim) {
    parts.push(`events [${d.events.join(", ") || "none"}]`);
    ok = ok && d.events.some((k) => wantEvents.includes(k));
  } else parts.push("simulation events not visible without the test hook");
  if (d.fx.length) {
    ok = false;
    parts.push(`comic effects drawn: ${d.fx.join(", ")}`);
  }
  T.check(group, `${what} reaches the simulation`, ok ? "PASS" : "FAIL", parts.join(", ") + (ok ? "" : ` (want ${hooks?.sim ? `one of ${wantEvents.join("/")}` : "a reaction"}${soundOn ? ", a sound" : ""}, no comic effects)`));
}

/** The frog moves: bone rotations sampled over `ms` (hook), or frame differences in its region. */
async function poseMoves(T, group, page, frog, ms, file, idleDeg = 0) {
  const bones = [], shots = [];
  for (let i = 0; i * 250 < ms; i++) {
    bones.push(await sampleBones(page));
    if (i % 3 === 0) shots.push(await shot(page, T.out, i === 3 ? file : null));
    await sleep(250);
  }
  if (bones[0]) {
    const p = poseRange(bones);
    const need = Math.max(POSE_MIN_DEG, 2 * idleDeg);
    return { ok: p.degrees >= need, detail: `largest bone rotation over ${(ms / 1000).toFixed(1)} s: ${p.degrees.toFixed(0)}° (${p.bone}); needs ${need.toFixed(0)}°; ${file}.png` };
  }
  const ex = (await page.evaluate(() => window.__e2e.overlayRects())).map((r) => toPx(shots[0], r));
  const reg = toPx(shots[0], frogRegion(frog));
  let d = 0;
  for (let i = 1; i < shots.length; i++) d = Math.max(d, diffFraction(shots[0], shots[i], reg, ex));
  const need = Math.max(DIFF_MIN, DIFF_OVER_IDLE * (T.shared.idle?.region ?? 0));
  return { ok: d >= need, detail: `${pct(d)} of the frog's region changed (needs ${pct(need)}; bones need the test hook); ${file}.png` };
}

async function idlePoseDeg(page) {
  const s = [];
  for (let i = 0; i < 6; i++) { s.push(await sampleBones(page)); await sleep(250); }
  return s[0] ? poseRange(s).degrees : 0;
}

async function frameRate(T, group, page, what = "frame rate") {
  const f = await measureFrames(page, 3000);
  const st = await appState(page);
  T.check(group, what, f.fps >= FPS_MIN ? (f.workP95 > WORK_P95_WARN_MS ? "WARN" : "PASS") : "FAIL",
    fmt(f) + (st?.motion?.fps ? `; detector ${Math.round(st.motion.fps)} fps` : "") + (f.workP95 > WORK_P95_WARN_MS ? ` (p95 work over ${WORK_P95_WARN_MS} ms leaves a laptop little room)` : ""));
  return f;
}

/** Record with the app's own controls; returns the probed file, or null after reporting why. */
async function recordClip(T, group, page, log, seconds, during) {
  log.step = "start recording";
  const rec = await findControl(page, { re: "录制|录像|录屏", skip: "停止|结束|画面" });
  if (!rec) {
    T.check(group, "start recording", "MISSING", "no visible control labelled 录制/录像/录屏");
    return null;
  }
  const recInfo = await describe(rec);
  await rec.click();
  await sleep(400);
  const st = await appState(page);
  if (st) T.check(group, "start recording", st.recording.active ? "PASS" : "FAIL", `pressed "${recInfo.text}"; store.recording.active = ${st.recording.active}`);
  const t0 = Date.now();
  if (during) await during();
  await sleep(Math.max(0, seconds * 1000 - (Date.now() - t0)));
  log.step = "stop recording";
  const stop = (await findControl(page, { re: "停止|结束|完成" })) ?? (await findControl(page, { re: "录制|录像|录屏", skip: "画面" }));
  if (!stop) {
    T.check(group, "stop recording", "FAIL", "no control to stop the recording (停止/结束/完成, or the record button again)");
    return null;
  }
  const stopInfo = await describe(stop);
  await stop.click();
  log.step = "wait for the recording";
  let blob = null;
  for (let i = 0; i < 60 && !blob; i++) {
    await sleep(250);
    blob = await page.evaluate(() => window.__e2e.lastVideoBlob());
  }
  await shot(page, T.out, `${group}-after-recording`);
  if (!blob) {
    T.check(group, "recording produces a file", "FAIL", `pressed "${stopInfo.text}"; no video Blob was handed out (URL.createObjectURL) within 15 s`);
    return null;
  }
  const ext = /mp4/.test(blob.type) ? "mp4" : /webm/.test(blob.type) ? "webm" : "bin";
  const file = join(T.out, `${group}-recording.${ext}`);
  writeFileSync(file, Buffer.from(blob.data, "base64"));
  const p = probeRecording(file);
  const playable = p.codec && p.frames >= 20 && p.duration >= seconds * 0.6 && !p.errors.length;
  T.check(group, "recording is a playable video", playable ? "PASS" : "FAIL",
    `${blob.type}, ${mb(blob.size)}: ${p.format}/${p.codec} ${p.width}×${p.height}, ${p.frames} frames over ${p.duration.toFixed(1)} s (recorded ${seconds} s), audio ${p.audio ?? "none"}` + (p.errors.length ? `; decode errors: ${p.errors.join(" | ")}` : "") + `; ${group}-recording.${ext}`);
  const last = (await appState(page))?.lastRecording;
  if (last) {
    const nameExt = last.fileName?.split(".").pop();
    T.check(group, "recording's file name matches its type", nameExt && last.mimeType.includes(nameExt) ? "PASS" : "FAIL", `${last.fileName} for ${last.mimeType}`);
  }
  if (!p.frames) return null;
  const png = extractFrame(file, Math.max(0, p.duration / 2), join(T.out, `${group}-recording-frame.png`));
  return { file, probe: p, frame: decodePng(readFileSync(png)), frameFile: `${group}-recording-frame.png` };
}

/** Pause, resume, single step or speed through the UI's own controls when it has them, else through the store and
 *  commands; returns how. */
async function transport(page, what, speed) {
  const specs = {
    pause: { re: "^(暂停|Pause)$|暂停|Pause", skip: "继续|Resume|已暂停|Paused" },
    resume: { re: "^(继续|Resume)$|继续|Resume" },
    step: { re: "^(单步|Step)$|单步", skip: "步进" },
    speed: { re: `^${speed}\\s*[×x]?$|^${speed}\\s*[×x]` },
  };
  const el = await findControl(page, specs[what]);
  if (el) {
    const d = await describe(el);
    await el.click();
    await sleep(250);
    return `UI "${d.text}"`;
  }
  if (what === "speed") {
    const sel = await page.evaluate((v) => {
      for (const s of document.querySelectorAll("select")) {
        const o = [...s.options].find((x) => parseFloat(x.value) === v);
        if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true; }
      }
      return false;
    }, speed);
    if (sel) { await sleep(250); return "UI speed select"; }
  }
  await page.evaluate((w, v) => {
    const n = window.__naiwa;
    const pb = n.store.get().playback;
    if (w === "step") n.commands.stepSim();
    else n.store.set({ playback: { ...pb, ...(w === "pause" ? { paused: true } : w === "resume" ? { paused: false } : { timeScale: v }) } });
  }, what, speed ?? 1);
  await sleep(250);
  return what === "step" ? "commands.stepSim() (no UI step control found)" : `store.playback (no UI ${what} control found)`;
}

const snap = (page, name) => page.evaluate((n) => window.__e2e.snap(n), name);
const delta = (page, a, b) => page.evaluate((x, y) => window.__e2e.delta(x, y), a, b);
const surfaceSpeed = (page, ms) => page.evaluate((m) => window.__e2e.surfaceSpeed(m), ms);

/** Pause freezes the frog (and the uploaded video), a single step advances one frame, slow motion slows the frog
 *  and the motion; `video` adds the checks on the playing video. */
async function playbackChecks(T, group, page, log, video) {
  log.step = "playback: 1×";
  const run = await surfaceSpeed(page, 2000);
  const perFrame = (run.speed * 2) / Math.max(1, run.frames);
  log.step = "playback: pause";
  const how = await transport(page, "pause");
  await snap(page, "p0");
  const v0 = video ? await page.evaluate(() => window.__e2e.music()) : null;
  await sleep(1000);
  await snap(page, "p1");
  const v1 = video ? await page.evaluate(() => window.__e2e.music()) : null;
  const still = await delta(page, "p0", "p1");
  const pb = (await appState(page)).playback;
  const videoStill = !video || (v1.paused || Math.abs(v1.t - v0.t) < 0.05);
  T.check(group, "pause freezes the frog" + (video ? " and the video" : " and the motion"), pb.paused && still < 1e-5 && videoStill ? "PASS" : "FAIL",
    `via ${how}: store.playback.paused = ${pb.paused}; surface moved ${(still * 1000).toFixed(3)} mm in 1 s (running: ${(run.speed * 1000).toFixed(0)} mm/s)` + (video ? `; video ${v1.paused ? "paused" : `still playing (${v0.t.toFixed(2)} → ${v1.t.toFixed(2)} s)`}` : ""));
  if (!video) {
    log.step = "playback: single step";
    await snap(page, "s0");
    const howStep = await transport(page, "step");
    await sleep(300);
    await snap(page, "s1");
    await sleep(600);
    await snap(page, "s2");
    const one = await delta(page, "s0", "s1"), after = await delta(page, "s1", "s2");
    const ratio = one / perFrame;
    T.check(group, "single step advances one frame", one > 0 && ratio >= 0.2 && ratio <= 5 && after < 1e-5 ? "PASS" : "FAIL",
      `via ${howStep}: the step moved the surface ${(one * 1000).toFixed(3)} mm, ${ratio.toFixed(1)}× a running frame (${(perFrame * 1000).toFixed(3)} mm; allowed 0.2–5×), then ${(after * 1000).toFixed(3)} mm while still paused`);
  }
  log.step = "playback: slow motion";
  const howResume = await transport(page, "resume");
  const howSpeed = await transport(page, "speed", 0.25);
  await sleep(600);
  const vs0 = video ? await page.evaluate(() => window.__e2e.music()) : null;
  const slow = await surfaceSpeed(page, 2000);
  const vs1 = video ? await page.evaluate(() => window.__e2e.music()) : null;
  const pb2 = (await appState(page)).playback;
  const r = slow.speed / run.speed;
  const videoRate = video ? (vs1.t - vs0.t) / 2 : null;
  const videoOk = !video || (vs1.rate > 0.2 && vs1.rate < 0.3 && videoRate > 0.15 && videoRate < 0.35);
  T.check(group, "slow motion slows the frog" + (video ? " and the video" : " and the motion"), !pb2.paused && pb2.timeScale === 0.25 && r >= 0.12 && r <= 0.45 && videoOk ? "PASS" : "FAIL",
    `via ${howResume}, ${howSpeed}: timeScale ${pb2.timeScale}; surface ${(slow.speed * 1000).toFixed(0)} mm/s vs ${(run.speed * 1000).toFixed(0)} mm/s at 1× (×${r.toFixed(2)}, want 0.12–0.45)` +
      (video ? `; video playbackRate ${vs1.rate}, advanced ${(vs1.t - vs0.t).toFixed(2)} s in 2 s` : ""));
  await transport(page, "speed", 1);
}

/* ---------------------------------------------------------------- scenarios ------------------------------------ */

/** The frog, the frame rate, a tap on the belly, a drag-and-throw. */
export async function play(T, page, log) {
  const ready = await boot(T, "play", page, log);
  T.check("play", "test hook window.__naiwa", ready?.hooks?.hook ? "PASS" : "INFO",
    ready?.hooks?.hook ? Object.entries(ready.hooks).filter(([k]) => k !== "hook").map(([k, v]) => `${k}${v ? "" : " (absent)"}`).join(", ") : "absent: checks use the DOM and pixels only (see the top of run.mjs)");
  if (!ready) return;
  log.step = "frog visible";
  const frog = await frogVisible(T, "play", page, "play-start");
  log.step = "frame rate";
  const hips0 = (await sampleBones(page))?.hips;
  const f = await frameRate(T, "play", page);
  const hips1 = (await sampleBones(page))?.hips;
  if (hips0 && hips1) {
    const d = Math.hypot(hips1[12] - hips0[12], hips1[13] - hips0[13], hips1[14] - hips0[14]);
    T.check("play", "frog stays put at rest", d <= REST_DRIFT_MAX_M ? "PASS" : "FAIL", `untouched, its hips moved ${(d * 100).toFixed(1)} cm in 3 s (allowed ${REST_DRIFT_MAX_M * 100} cm)`);
  }
  if (f.physicsP95 != null) T.check("play", "physics time per frame", f.physicsP95 <= PHYSICS_P95_MAX_MS ? "PASS" : "FAIL", `sim.step p95 ${f.physicsP95.toFixed(2)} ms (budget ${PHYSICS_P95_MAX_MS} ms), ${f.physicsSteps} steps in 3 s`);
  const idle = await idleChange(page, frog);
  T.shared.idle = idle;

  log.step = "tap belly";
  const region = toPx(frog.img, frogRegion(frog));
  const c0 = await counts(page);
  const before = await shot(page);
  await page.mouse.click(frog.target.x, frog.target.y);
  await sleep(150);
  const t1 = await shot(page, T.out, "play-tap");
  await sleep(300);
  const t2 = await shot(page);
  await sleep(500);
  verdictPicture(T, "play", "tap on the belly", Math.max(diffFraction(before, t1, region), diffFraction(before, t2, region)), idle.region, "play-tap.png");
  await verdictEffects(T, "play", page, "tap on the belly", since(c0, await counts(page)), ready.hooks, ["poke", "slap", "squish"]);
  const hit = await page.evaluate(() => window.__e2e.events.find((e) => e.kind === "poke" || e.kind === "slap")?.region ?? null);
  if (ready.hooks.sim && hit && hit !== "belly") T.check("play", "tap at the frog's centre hits the belly", "WARN", `hit region "${hit}" at ${Math.round(frog.target.x)},${Math.round(frog.target.y)}`);

  log.step = "drag and throw";
  await sleep(1500);
  const c1 = await counts(page);
  const b2 = await shot(page);
  await mouseThrow(page, frog.target, { x: frog.target.x + 140, y: frog.target.y - 280 });
  await sleep(450);
  const th = await shot(page, T.out, "play-throw");
  for (let i = 0; i < 28 && !(await counts(page)).events.slice(c1.events.length).includes("land"); i++) await sleep(250);
  await sleep(1500);
  const thr = since(c1, await counts(page));
  const after = await locateFrog(page, T.out, "play-after-throw");
  const ex = (await page.evaluate(() => window.__e2e.overlayRects())).map((r) => toPx(b2, r));
  verdictPicture(T, "play", "drag and throw", diffFraction(b2, th, toPx(b2, frog.rect), ex), idle.canvas, "play-throw.png, play-after-throw.png");
  await verdictEffects(T, "play", page, "drag and throw", thr, ready.hooks, ["grab", "release"]);
  if (ready.hooks.sim) {
    const want = ["grab", "release", "land"].filter((k) => !thr.events.includes(k));
    T.check("play", "throw: grab, release, land", want.length ? "FAIL" : "PASS", `events within 8 s [${thr.events.join(", ")}]` + (want.length ? `; missing ${want.join(", ")}` : ""));
    const where = await page.evaluate(() => window.__e2e.frogPoint()?.world);
    const inView = after.areaFraction != null ? after.areaFraction > 0.01 : null;
    T.check("play", "after a throw the frog is in view again", inView ? "PASS" : "FAIL",
      `${after.areaFraction != null ? `frog covers ${pct(after.areaFraction)} of the canvas` : "?"}; frog centre at (${where?.map((v) => v.toFixed(1)).join(", ")}) m; play-after-throw.png`);
  }

  log.step = "reset";
  const reset = await findControl(page, { re: "^(复位|重置|Reset)$|复位|Reset" });
  if (!reset) T.check("play", "reset puts the frog back", "MISSING", "no visible 复位 / Reset control");
  else {
    await reset.click();
    await sleep(1500);
    const hips = (await sampleBones(page))?.hips;
    const d = hips ? Math.hypot(hips[12], hips[14]) : null;
    T.check("play", "reset puts the frog back", d == null || d < 0.15 ? "PASS" : "FAIL", d == null ? "pressed; pose not visible without the hook" : `hips ${(d * 100).toFixed(0)} cm from home after 复位`);
  }
  const home = await locateFrog(page, T.out, null);

  log.step = "readouts";
  const st = await appState(page);
  if (st?.stats && "stepMs" in st.stats) {
    const { stepMs, particles, cells, volumeRatio, fps } = st.stats;
    T.check("play", "simulation readouts", particles > 0 && cells > 0 && fps > 0 ? (stepMs <= PHYSICS_P95_MAX_MS ? "PASS" : "FAIL") : "FAIL",
      `step ${stepMs} ms (budget ${PHYSICS_P95_MAX_MS} ms), ${particles} particles, ${cells} cells, volume ×${volumeRatio}, ${fps} fps`);
    T.check("play", "soft body keeps its volume", Math.abs(volumeRatio - 1) <= 0.1 ? "PASS" : "FAIL", `volume ratio ${volumeRatio} at rest after a reset (allowed 0.9–1.1)`);
  }

  log.step = "ball tool";
  const ball = await findControl(page, { re: "探测球|丢球|^球$|Ball|Probe", skip: "下球雨|Rain" });
  if (!ball) T.check("play", "ball tool", "MISSING", "no visible ball tool control");
  else {
    await ball.click();
    await sleep(300);
    const b0 = await counts(page);
    await page.mouse.click(home.target.x, home.target.y);
    await sleep(1200);
    const d = since(b0, await counts(page));
    const balls = await page.evaluate(() => window.__naiwa?.sim?.readBalls().length / 4);
    T.check("play", "ball tool drops a ball on the frog", (balls ?? 1) > 0 && (!ready.hooks.sim || d.events.includes("ball")) && !d.fx.length ? "PASS" : "FAIL",
      `${balls ?? "?"} ball(s) in the simulation, events [${d.events.join(", ")}]${d.fx.length ? `, comic effects ${d.fx.join(", ")}` : ""}`);
    const hand = await findControl(page, { re: "^(戳 / 拖动|手|Poke / drag|Hand)$|戳|Poke" });
    if (hand) await hand.click();
  }

  log.step = "sound";
  if ((await appState(page))?.sound === false) T.check("play", "sound off by default", "PASS", "store.sound = false on a first visit");
  else if (st) T.check("play", "sound off by default", "FAIL", `store.sound = ${st.sound} on a first visit`);
  const sound = await findControl(page, { re: "声音|Sound" });
  if (!sound) T.check("play", "sound can be turned on", "MISSING", "no visible sound control");
  else {
    await sound.click();
    await sleep(300);
    const s0 = await counts(page);
    await page.mouse.click(home.target.x, home.target.y);
    await sleep(800);
    const d = since(s0, await counts(page));
    const on = (await appState(page))?.sound;
    T.check("play", "sound can be turned on", d.sounds > 0 && on !== false ? "PASS" : "FAIL", `after pressing "${(await describe(sound)).text}": store.sound = ${on}, a poke started ${d.sounds} sound(s)`);
  }
}

/** Each of the four modes can be entered from the UI. */
export async function modes(T, page, log) {
  if (!(await boot(T, "modes", page, log))) return;
  for (const mode of ["dance", "camera", "video", "play"]) {
    log.step = `enter ${mode}`;
    const r = await enterMode(page, mode);
    if (!r.found) {
      T.check("modes", `enter ${mode} (${MODES[mode]})`, "MISSING", `no visible control labelled "${MODES[mode]}" or [data-mode=${mode}]`);
      continue;
    }
    await sleep(1200);
    await shot(page, T.out, `mode-${mode}`);
    const st = await appState(page);
    const ok = st ? st.mode === mode : r.selected;
    T.check("modes", `enter ${mode} (${MODES[mode]})`, ok === true ? "PASS" : "FAIL",
      ok == null ? `pressed "${r.info.text}" but cannot tell whether the mode changed: give mode controls aria-pressed (or add the test hook)`
        : `pressed "${r.info.text}"; ${st ? `store.mode = ${st.mode}` : `control selected = ${r.selected}`}${r.selected === false ? " but the control does not show as selected" : ""}; mode-${mode}.png`);
  }
}

/** Every preset dance in the library plays. */
export async function dances(T, page, log) {
  const ready = await boot(T, "dances", page, log);
  if (!ready) return;
  const frog = await locateFrog(page, T.out, null);
  const idleDeg = await idlePoseDeg(page);
  log.step = "enter dance";
  const r = await enterMode(page, "dance");
  if (!r.found) return T.check("dances", "enter dance mode", "MISSING", `no control labelled "${MODES.dance}"`);
  let list = [];
  for (let i = 0; i < 40 && !list.length; i++) {
    list = ((await appState(page))?.dances ?? []).filter((d) => d.origin !== "mine");
    if (!list.length) await sleep(250);
  }
  if (!ready.hooks.store) return T.check("dances", "every preset dance plays", "MISSING", "the dance list needs the test hook (store.dances)");
  T.check("dances", "dance list", list.length ? "PASS" : "FAIL", list.length ? list.map((d) => `${d.name} (${d.origin ?? "?"}, ${d.duration.toFixed(1)} s)`).join(", ") : "store.dances is empty 10 s after entering 舞蹈库");
  let first = true;
  for (const d of list) {
    log.step = `dance ${d.id}`;
    const el = await findControl(page, { label: d.name, skip: "删除" });
    if (!el) {
      T.check("dances", `${d.name} plays`, "FAIL", `no visible control named "${d.name}" in 舞蹈库`);
      continue;
    }
    await el.click();
    await sleep(700);
    const st = await appState(page);
    const m = await poseMoves(T, "dances", page, frog, Math.max(2500, d.duration * 1000 * 1.2), `dance-${d.id}`, idleDeg);
    T.check("dances", `${d.name} plays`, st.dance === d.id && m.ok ? "PASS" : "FAIL", `store.dance = ${st.dance}, motion ${st.motion.state}; ${m.detail}`);
    if (first) await frameRate(T, "dances", page, "frame rate while dancing");
    first = false;
  }
}

/** Camera mode with the fake webcam playing the portrait dance clip. */
export async function camera(T, page, log) {
  const ready = await boot(T, "camera", page, log);
  if (!ready) return;
  const frog = await locateFrog(page, T.out, null);
  const idleDeg = await idlePoseDeg(page);
  log.step = "enter camera";
  const r = await enterMode(page, "camera");
  if (!r.found) return T.check("camera", "enter camera mode", "MISSING", `no control labelled "${MODES.camera}"`);
  const start = await findControl(page, { re: "打开摄像头|开启摄像头|开摄像头|启动摄像头" });
  if (start) await start.click();
  const t0 = Date.now();
  if (ready.hooks.store) {
    log.step = "wait for tracking";
    const states = [];
    let tracking = false;
    while (Date.now() - t0 < TRACK_TIMEOUT_MS) {
      const m = (await appState(page))?.motion;
      const key = `${m?.state}${m?.message ? ` "${m.message}"` : ""}`;
      if (states.at(-1)?.key !== key) states.push({ key, at: ((Date.now() - t0) / 1000).toFixed(1) });
      if (m?.state === "tracking") { tracking = true; break; }
      if (m?.state === "error") break;
      await sleep(300);
    }
    T.check("camera", "reaches tracking", tracking ? "PASS" : "FAIL", (start ? `pressed "${(await describe(start).catch(() => ({ text: "?" }))).text}"; ` : "no start button; ") + states.map((s) => `${s.at}s ${s.key}`).join(" → "));
  } else {
    await sleep(8000);
    T.check("camera", "reaches tracking", "MISSING", "motion state not visible without the test hook (store)");
  }
  const vids = await page.evaluate(() => window.__e2e.videos());
  const v = vids.find((x) => x.stream);
  T.check("camera", "preview shows the camera", v && v.ready >= 2 && !v.paused && v.w > 0 ? (v.shown ? "PASS" : "WARN") : "FAIL",
    v ? `${v.w}×${v.h}, readyState ${v.ready}, ${v.paused ? "paused" : "playing"}, ${v.shown ? `shown at ${Math.round(v.rect.w)}×${Math.round(v.rect.h)}` : "not shown"}` : `no <video> with the camera stream (${vids.length} video elements)`);
  log.step = "pose follows";
  const m = await poseMoves(T, "camera", page, frog, 3000, "camera-pose", idleDeg);
  T.check("camera", "frog's pose follows the camera", m.ok ? "PASS" : "FAIL", m.detail);
  await frameRate(T, "camera", page, "frame rate while tracking");
  if (!T.flag("quick")) {
    log.step = "camera soak (MediaPipe log interval)";
    await sleep(Math.max(0, SOAK_MS - (Date.now() - t0)));
    const ms = (await appState(page))?.motion;
    if (ms) T.check("camera", "still tracking after a minute", ms.state === "tracking" ? "PASS" : "FAIL", `state ${ms.state}${ms.message ? ` "${ms.message}"` : ""}`);
  }
  log.step = "back to play";
  const back = await enterMode(page, "play");
  await sleep(2500);
  const live = await page.evaluate(() => window.__e2e.liveCameraTracks());
  if (back.found) T.check("camera", "camera released after leaving the mode", live === 0 ? "PASS" : "FAIL", `${live} live camera track(s) after switching to ${MODES.play}`);
}

/** Video mode: upload a real dance clip, analysis to 100%, synced playback with its music, the frog follows the
 *  person; portrait also saves the motion as 我的舞蹈 and dances it, landscape records 真人 vs 奶蛙 side by side. */
export async function video(T, page, log, which) {
  const clip = T.clips[which];
  const g = `video-${which}`;
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  log.step = "enter video";
  const r = await enterMode(page, "video");
  if (!r.found) return T.check(g, "enter video mode", "MISSING", `no control labelled "${MODES.video}"`);
  log.step = "upload";
  const how = await uploadVideo(page, clip.file);
  T.check(g, `upload a ${which} clip`, how ? "PASS" : "MISSING", how ? `${clip.name} (${clip.width}×${clip.height}, ${clip.duration.toFixed(1)} s${clip.audio ? ", with music" : ""}) via ${how}` : "video mode shows no file input or upload control");
  if (!how) return;
  if (!ready.hooks.store) return T.check(g, "analysis and playback", "MISSING", "needs the test hook (store.motion)");

  log.step = "analysis";
  const t0 = Date.now();
  const prog = [], states = [];
  let playing = false, st = null, mus = null;
  while (Date.now() - t0 < ANALYSIS_TIMEOUT_MS) {
    st = await appState(page);
    const m = st.motion;
    if (m.progress != null && prog.at(-1)?.[1] !== m.progress) prog.push([(Date.now() - t0) / 1000, m.progress]);
    const key = `${m.state}${m.message ? ` "${m.message}"` : ""}`;
    if (states.at(-1)?.key !== key) states.push({ key, at: ((Date.now() - t0) / 1000).toFixed(1) });
    mus = await page.evaluate(() => window.__e2e.music());
    if (m.state === "error") break;
    if ((m.state === "tracking" || m.state === "ready") && mus && !mus.paused && mus.t > 0.3) { playing = true; break; }
    await sleep(200);
  }
  const maxP = prog.length ? Math.max(...prog.map((p) => p[1])) : null;
  const back = prog.some((p, i) => i > 0 && p[1] < prog[i - 1][1] - 1e-6);
  const done = prog.find((p) => p[1] >= 0.999);
  T.check(g, "analysis progress reaches 1", maxP != null && maxP >= 0.999 && !back ? "PASS" : "FAIL",
    prog.length ? `${prog.length} updates, ${prog.slice(0, 3).map((p) => p[1].toFixed(2)).join(", ")} … ${maxP.toFixed(2)}${back ? ", goes backwards" : ""}; 100% after ${done ? done[0].toFixed(1) : "—"} s for a ${clip.duration.toFixed(1)} s clip` : "store.motion.progress never set");
  T.check(g, "plays after the analysis", playing ? "PASS" : "FAIL", states.map((s) => `${s.at}s ${s.key}`).join(" → ") + (mus ? `; video ${mus.paused ? "paused" : "playing"} at ${mus.t.toFixed(1)} s` : "; no uploaded <video> ready"));
  if (!playing) return;
  if (clip.audio) {
    T.check(g, "the video's music plays", mus.routed || (!mus.muted && mus.volume > 0) ? "PASS" : "FAIL",
      `${mus.routed ? "routed through the sound mix" : "not routed through Web Audio"}, ${mus.muted ? "muted" : "unmuted"}, volume ${mus.volume}`);
  }

  log.step = "follow the person";
  await page.evaluate((n) => window.__e2e.startSampler(n), ARM_BONES);
  await sleep(clip.duration * 2000 + 800);
  await shot(page, T.out, `${g}-pose`);
  const samples = await page.evaluate(() => window.__e2e.stopSampler());
  const fs = followScore(clip.pose, samples);
  if (fs.error) T.check(g, "frog's pose follows the person", "FAIL", fs.error);
  else {
    T.check(g, "frog's pose follows the person", fs.corr >= FOLLOW_MIN ? "PASS" : "FAIL",
      `arm-raise correlation with the person ${fs.corr.toFixed(2)} (needs ${FOLLOW_MIN}; the other arm mapping gives ${fs.otherMapping.toFixed(2)}), ${fs.samples} samples over ${fs.loops} loop(s); ${g}-pose.png`);
    T.check(g, "motion in sync with the video", fs.corr >= FOLLOW_MIN && Math.abs(fs.lag) <= SYNC_MAX_S ? "PASS" : "FAIL",
      `best match ${fs.lag >= 0 ? "lags" : "leads"} the video by ${Math.abs(fs.lag).toFixed(2)} s (allowed ${SYNC_MAX_S} s)`);
    const mirrored = mus.shown ? mus.mirrored : st.mirror;
    if (fs.corr >= FOLLOW_MIN) T.check(g, "arms on the same screen side as the person's", fs.swap === mirrored ? "PASS" : "FAIL",
      `frog's ${fs.swap ? "left answers the person's right" : "left answers the person's left"}; preview ${mus.shown ? (mus.mirrored ? "mirrored" : "not mirrored") : `hidden, store.mirror = ${st.mirror}`}`);
  }
  await frameRate(T, g, page, "frame rate while playing");
  if (which === "portrait") await playbackChecks(T, g, page, log, true);

  if (which === "portrait") await saveDance(T, g, page, log);
  else await sideBySide(T, g, page, log, clip);
}

async function saveDance(T, g, page, log) {
  log.step = "save as 我的舞蹈";
  const st = await appState(page);
  const keep = await findControl(page, { re: "存为我的舞蹈|存为|保存这支" });
  if (!keep) return T.check(g, "save as 我的舞蹈", st.canSaveDance ? "FAIL" : "FAIL", `no visible 存为我的舞蹈 control (store.canSaveDance = ${st.canSaveDance})`);
  await keep.click();
  await sleep(400);
  const name = `测试舞${Date.now() % 1000}`;
  const input = (await page.$$("input[type=text], input:not([type])")).at(-1);
  if (input && (await input.isVisible())) {
    await input.click({ clickCount: 3 });
    await input.type(name);
  }
  const ok = await findControl(page, { re: "存好|确定|保存", skip: "存为" });
  if (ok) await ok.click();
  else await page.keyboard.press("Enter");
  let mine = null;
  for (let i = 0; i < 40 && !mine; i++) {
    await sleep(250);
    mine = (await appState(page)).dances.find((d) => d.origin === "mine" && d.name === name) ?? null;
  }
  T.check(g, "save as 我的舞蹈", mine ? "PASS" : "FAIL", mine ? `"${name}" is in the dance list (${mine.duration.toFixed(1)} s)` : `no dance named "${name}" with origin "mine" in store.dances after saving (canSaveDance = ${st.canSaveDance})`);
  if (!mine) return;
  log.step = "dance 我的舞蹈";
  await enterMode(page, "dance");
  const el = await findControl(page, { label: name, skip: "删除" });
  if (!el) return T.check(g, "我的舞蹈 plays in 舞蹈库", "FAIL", `no control named "${name}" in 舞蹈库`);
  await el.click();
  await sleep(700);
  const frog = await locateFrog(page, T.out, null);
  const m = await poseMoves(T, g, page, frog, 3000, `${g}-mine`);
  T.check(g, "我的舞蹈 plays in 舞蹈库", m.ok ? "PASS" : "FAIL", m.detail);
}

async function sideBySide(T, g, page, log, clip) {
  log.step = "side-by-side layout";
  const lay = await findControl(page, { re: "真人\\s*vs\\s*奶蛙|并排|左右" });
  if (!lay) return T.check(g, "真人 vs 奶蛙 recording", "MISSING", "no visible control for the side-by-side layout (真人 vs 奶蛙)");
  await lay.click();
  await sleep(300);
  const st = await appState(page);
  T.check(g, "choose 真人 vs 奶蛙 layout", st.recordLayout === "side-by-side" ? "PASS" : "FAIL", `store.recordLayout = ${st.recordLayout}`);
  const stage = await shot(page);
  const frog = await locateFrog(page, T.out, null);
  const stageRef = histogram(stage, toPx(stage, frogRegion(frog)));
  const rec = await recordClip(T, g, page, log, 5);
  if (!rec) return;
  const level = audioLevel(rec.file);
  T.check(g, "side-by-side recording has the music", rec.probe.audio && level != null && level > -45 ? "PASS" : "FAIL",
    rec.probe.audio ? `audio ${rec.probe.audio}, mean loudness ${level?.toFixed(1)} dB (the clip's music is about −10 dB; needs > −45 dB)` : "the recording has no audio track");
  const refs = clipFrames(clip.file, [1, 3, 5, 7].map((s) => Math.min(s, clip.duration - 0.2)), T.cache, `${clip.name}-ref`).map((f) => histogram(decodePng(readFileSync(f)), { x: 0, y: 0, w: 1e9, h: 1e9 }));
  const s = splitLayout(rec.frame, meanHistogram(refs), stageRef);
  T.check(g, "side-by-side recording shows the person and the frog", s.margin > 0.05 ? "PASS" : "FAIL",
    `${rec.probe.width}×${rec.probe.height}, ${s.split} (${s.order}): the video half matches the clip ${s.videoHalf.video.toFixed(2)} vs the stage ${s.videoHalf.stage.toFixed(2)}, the frog half matches the stage ${s.stageHalf.stage.toFixed(2)} vs the clip ${s.stageHalf.video.toFixed(2)}; ${rec.frameFile}`);
}

/** A frog-only recording from play mode. */
export async function record(T, page, log) {
  const ready = await boot(T, "record", page, log);
  if (!ready) return;
  const frog = await locateFrog(page, T.out, null);
  const rec = await recordClip(T, "record", page, log, 3, async () => {
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(frog.target.x + (i - 1) * 20, frog.target.y);
      await sleep(800);
    }
  });
  if (!rec) return;
  const l = lumaStats(rec.frame);
  T.check("record", "recording shows the scene", l.std >= 8 ? "PASS" : "FAIL", `middle frame luma mean ${l.mean.toFixed(0)}, spread ${l.std.toFixed(1)}; ${rec.frameFile}`);
}

/** Small screen with touch. */
export async function phone(T, page, log) {
  const ready = await boot(T, "phone", page, log);
  if (!ready) return;
  log.step = "layout";
  const lay = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight }));
  T.check("phone", "no sideways scrolling", lay.sw <= lay.iw + 1 ? "PASS" : "FAIL", `page ${lay.sw} px wide in a ${lay.iw} px screen`);
  const missing = [], outside = [];
  for (const mode of Object.keys(MODES)) {
    const el = await findMode(page, mode);
    if (!el) { missing.push(MODES[mode]); continue; }
    const d = await describe(el);
    if (d.rect.x < 0 || d.rect.y < 0 || d.rect.x + d.rect.w > lay.iw + 1 || d.rect.y + d.rect.h > lay.ih + 1) outside.push(`${MODES[mode]} at ${Math.round(d.rect.x)},${Math.round(d.rect.y)}`);
  }
  T.check("phone", "mode controls on screen", missing.length ? "MISSING" : outside.length ? "FAIL" : "PASS", missing.length ? `not found: ${missing.join(", ")}` : outside.length ? `off screen: ${outside.join(", ")}` : "all four within the screen");
  const small = (await page.evaluate(() => window.__e2e.controls())).filter((c) => c.rect.w < 32 || c.rect.h < 32);
  if (small.length) T.check("phone", "touch targets at least 32 px", "WARN", small.slice(0, 8).map((c) => `"${c.text || c.tag}" ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}`).join(", ") + (small.length > 8 ? ` … (${small.length})` : ""));
  const frog = await frogVisible(T, "phone", page, "phone-start");

  log.step = "touch tap";
  const idle = await idleChange(page, frog);
  const region = toPx(frog.img, frogRegion(frog));
  const c0 = await counts(page);
  const before = await shot(page);
  await page.touchscreen.tap(frog.target.x, frog.target.y);
  await sleep(150);
  const t1 = await shot(page, T.out, "phone-tap");
  await sleep(300);
  const t2 = await shot(page);
  await sleep(500);
  verdictPicture(T, "phone", "touch tap", Math.max(diffFraction(before, t1, region), diffFraction(before, t2, region)), idle.region, "phone-tap.png");
  await verdictEffects(T, "phone", page, "touch tap", since(c0, await counts(page)), ready.hooks, ["poke", "slap", "squish"]);

  log.step = "touch throw";
  await sleep(1500);
  const c1 = await counts(page);
  const b2 = await shot(page);
  await touchThrow(page, frog.target, { x: frog.target.x + 60, y: frog.target.y - 220 });
  await sleep(450);
  const th = await shot(page, T.out, "phone-throw");
  await sleep(2000);
  const ex = (await page.evaluate(() => window.__e2e.overlayRects())).map((r) => toPx(b2, r));
  verdictPicture(T, "phone", "touch drag and throw", diffFraction(b2, th, toPx(b2, frog.rect), ex), idle.canvas, "phone-throw.png");
  await verdictEffects(T, "phone", page, "touch drag and throw", since(c1, await counts(page)), ready.hooks, ["grab", "release"]);
  const vp = await page.evaluate(() => ({ y: scrollY, x: scrollX, scale: visualViewport?.scale ?? 1 }));
  T.check("phone", "dragging does not scroll or zoom the page", vp.x === 0 && vp.y === 0 && vp.scale === 1 ? "PASS" : "FAIL", `scroll ${vp.x},${vp.y}, zoom ${vp.scale}`);
}

/** Both languages: switch with the UI toggle (or store.lang), then every mode's panel shows only that language's
 *  text; on a phone nothing spills out of its box or the screen. */
export async function languages(T, page, log, group) {
  const ready = await boot(T, group, page, log);
  if (!ready) return;
  if (!ready.hooks.store) return T.check(group, "both languages", "MISSING", "needs the test hook (store.lang)");
  const phone = page.viewport().width < 600;
  for (const lang of ["zh", "en"]) {
    log.step = `switch to ${lang}`;
    let how = "already";
    if ((await page.evaluate(() => window.__naiwa.store.get().lang)) !== lang) {
      const toggle = await findControl(page, { re: lang === "en" ? "^(EN|En|English|英文|A文)$|English|Language|语言" : "^(中|中文|ZH|Zh)$|中文|语言|Language" });
      if (toggle) {
        const d = await describe(toggle);
        await toggle.click();
        await sleep(500);
        how = `UI toggle "${d.text}"`;
      }
      if ((await page.evaluate(() => window.__naiwa.store.get().lang)) !== lang) {
        if (toggle) T.check(group, `UI toggle switches to ${lang}`, "FAIL", `${how} left store.lang = ${await page.evaluate(() => window.__naiwa.store.get().lang)}`);
        await page.evaluate((l) => window.__naiwa.store.set({ lang: l }), lang);
        await sleep(500);
        how = toggle ? "store.lang (after the toggle failed)" : "store.lang (no UI toggle found)";
      }
    }
    const htmlLang = await page.evaluate(() => document.documentElement.lang);
    T.check(group, `switch to ${lang}`, htmlLang.startsWith(lang) ? "PASS" : "FAIL", `via ${how}; <html lang="${htmlLang}">`);
    const untranslated = new Map(), overflow = new Map();
    for (const mode of ["play", "camera", "video", "dance"]) {
      log.step = `${lang} ${mode}`;
      await enterMode(page, mode);
      await sleep(700);
      await shot(page, T.out, `${group}-${lang}-${mode}`);
      for (const u of await page.evaluate((l) => window.__e2e.textAudit(l), lang)) if (!untranslated.has(u.text)) untranslated.set(u.text, `${mode} ${u.where}`);
      if (phone) for (const o of await page.evaluate(() => window.__e2e.overflowAudit())) if (!overflow.has(o.el + o.kind)) overflow.set(o.el + o.kind, { ...o, mode });
    }
    const list = [...untranslated].map(([t, w]) => `"${t}" (${w})`);
    T.check(group, `no text left in the other language (${lang})`, list.length ? "FAIL" : "PASS",
      list.length ? `${list.length}: ${list.slice(0, 10).join(", ")}${list.length > 10 ? " …" : ""}` : `all four modes; ${group}-${lang}-*.png`);
    if (phone) {
      const all = [...overflow.values()];
      const spills = all.filter((o) => o.kind !== "cut off"), cut = all.filter((o) => o.kind === "cut off");
      T.check(group, `nothing overflows on the phone (${lang})`, spills.length ? "FAIL" : "PASS",
        spills.length ? spills.slice(0, 8).map((o) => `${o.kind}: ${o.el} ${o.detail} (${o.mode})`).join("; ") : `all four modes${cut.length ? `; ${cut.length} cut off with an ellipsis` : ""}`);
      if (cut.length) T.check(group, `text cut off on the phone (${lang})`, "WARN", cut.slice(0, 8).map((o) => `${o.el} ${o.detail} (${o.mode})`).join("; "));
      const lay = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (lay > 1) T.check(group, `no sideways scrolling (${lang})`, "FAIL", `page ${lay} px wider than the screen`);
    }
  }
  await enterMode(page, "play");
}

/** Pause, single step and slow motion on a preset dance (driven: the frog moves all the time). */
export async function playback(T, page, log) {
  const ready = await boot(T, "playback", page, log);
  if (!ready) return;
  if (!ready.hooks.store || !ready.hooks.sim) return T.check("playback", "pause, step, slow motion", "MISSING", "needs the test hook (store, sim)");
  log.step = "enter dance";
  const r = await enterMode(page, "dance");
  if (!r.found) return T.check("playback", "enter dance mode", "MISSING", `no control labelled "${MODES.dance}"`);
  await sleep(1500);
  await playbackChecks(T, "playback", page, log, false);
  await shot(page, T.out, "playback");
}
