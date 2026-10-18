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
  uploadVideo, poseRange, sampleBones, measureFrames, counts, since, mouseThrow, touchThrow, press, selected,
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
const PENETRATION_TOL_M = 0.01; // limb flesh deeper than this inside the Body counts as passing through it
const HEAD_RMS_MAX_M = 0.01; // the head's shape change once its motion is taken out
const HEAD_MAX_M = 0.025;
const ARM_BONES = ["hand_L", "hand_R", "upperarm_L", "upperarm_R", "forearm_L", "forearm_R", "chest", "hips"];
const DENT_MIN_M = 0.01; // a poke dents the surface at least this much
const STAND_MIN = 0.9; // standing: the head at least this fraction of its rest height…
const STAND_AFTER_MS = 6000; // …this long after a switch or a disturbance
const FREE_DRIFT_MAX_M = 0.05; // left alone for 10 s, the hips move at most this far
const FOOT_SLIDE_MAX = 0.05; // m/s: how fast a standing foot (heel or toe on the floor) may slide with planted feet
const TONGUE_GAP_MAX_M = 0.03; // every tongue vertex within a few cm of the Body surface
const SIMULATORS_BUILTIN = ["cpu-constraints", "gpu-mpm"];
const SIMULATORS_LIBRARY = ["mass-spring", "pbd", "xpbd", "shape-matching", "projective-dynamics", "implicit-fem", "fem-tethers"];
const RETARGETERS = ["direction-copy", "planted-feet", "kalman-planted", "savgol-planted", "ccd-ik", "fabrik-ik", "dls-ik", "constrained-opt"];
const DEFAULT_RETARGETER = "planted-feet";
const GOUXIONG = "gouxiong"; // 狗熊哆嗦毛
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

/** The frog is on screen: with the hook its own pixels cover its projected centre, it is in the canvas and the
 *  panels do not cover it (the stage frames it in the part of the window they leave free); without the hook, the
 *  centre is not the background seen at the canvas border. */
async function frogVisible(T, group, page, name) {
  const frog = await locateFrog(page, T.out, name);
  if (frog.centreCoverage != null) {
    const b = frog.bbox;
    const panels = await page.evaluate(() => window.__e2e.panelRects());
    const overlap = (r) => Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x)) * Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
    const covered = b ? panels.reduce((s, r) => s + overlap(r), 0) / (b.w * b.h) : 0;
    const inCanvas = b && b.x >= frog.rect.x - 1 && b.y >= frog.rect.y - 1 && b.x + b.w <= frog.rect.x + frog.rect.w + 1 && b.y + b.h <= frog.rect.y + frog.rect.h + 1;
    T.check(group, "frog visible, framed beside the panels", frog.centreCoverage >= 0.5 && inCanvas && covered <= 0.05 ? "PASS" : "FAIL",
      `frog covers ${pct(frog.centreCoverage)} of the box at its projected centre, ${pct(frog.areaFraction)} of the canvas, ${inCanvas ? "wholly in the canvas" : "cut by the canvas edge"}, ${pct(covered)} of it under ${panels.length} panel(s); ${pct(frog.yellow)} of its box is 奶蛙-yellow (${frog.how}); ${name}.png`);
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

/** A gesture shows: enough pixels change, or (with the hook) the simulated surface dents by DENT_MIN_M or more —
 *  a poke on firm flesh is a small picture change but a clear dent. */
function verdictPicture(T, group, what, diff, idle, file, dent = null) {
  const need = Math.max(DIFF_MIN, DIFF_OVER_IDLE * idle);
  const ok = diff >= need || (dent != null && dent >= DENT_MIN_M);
  T.check(group, `${what} changes the picture`, ok ? "PASS" : "FAIL", `${pct(diff)} of pixels changed (idle ${pct(idle)}, needs ${pct(need)})` +
    (dent != null ? `; the surface moved up to ${(dent * 100).toFixed(1)} cm (needs ${DENT_MIN_M * 100} cm, or the pixels)` : "") + `; ${file}`);
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

/** Interpenetration over a few frames: per limb region the most vertices inside the Body (deeper than the
 *  tolerance) and the deepest; the head's largest shape change. Null without the hook's sim and spec. */
async function sampleInterpenetration(page, frames, everyMs) {
  const agg = { per: {}, head: { rms: 0, p95: 0, max: 0 }, frames: 0, metrics: null };
  for (let i = 0; i < frames; i++) {
    const r = await page.evaluate((tol) => window.__e2e.penetration(tol), PENETRATION_TOL_M);
    if (!r) return null;
    agg.frames++;
    if (r.nonFinite) {
      agg.nonFinite ??= {};
      for (const [k, v] of Object.entries(r.nonFinite)) if (v) agg.nonFinite[k] = Math.max(agg.nonFinite[k] ?? 0, v);
      await sleep(everyMs);
      continue;
    }
    // The simulation's own quality numbers, worst over the frames (docs/soft-binding.md).
    const m = await page.evaluate(() => window.__e2e.simMetrics());
    if (m) {
      agg.metrics ??= {};
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === "number") agg.metrics[k] = k === "volume" ? v : Math.max(agg.metrics[k] ?? -Infinity, v);
        else if (v && typeof v === "object") for (const [part, x] of Object.entries(v)) {
          const key = `${k}.${part}`;
          const prev = agg.metrics[key];
          agg.metrics[key] = prev == null ? x : Math.abs(x - 1) > Math.abs(prev - 1) ? x : prev; // the volume furthest from rest
        }
      }
    }
    for (const [k, v] of Object.entries(r.per)) {
      const a = (agg.per[k] ??= { vertices: v.vertices, inside: 0, maxDepth: 0 });
      a.inside = Math.max(a.inside, v.deep);
      a.maxDepth = Math.max(a.maxDepth, v.maxDepth);
    }
    if (r.head) for (const k of ["rms", "p95", "max"]) agg.head[k] = Math.max(agg.head[k], r.head[k]);
    await sleep(everyMs);
  }
  return agg;
}
const nonFiniteText = (agg) => Object.entries(agg.nonFinite).map(([k, v]) => `${k} ${v}`).join(", ");
/** One line for a table: limbs inside the body and the head's shape, or the NaN parts. */
function penSummary(pen) {
  if (!pen) return "";
  if (pen.nonFinite) return `; NON-FINITE vertices (${nonFiniteText(pen)})`;
  const per = Object.values(pen.per);
  if (!per.length) return "";
  return `; limbs inside the body ${Math.max(...per.map((v) => v.inside))} vertices (deepest ${(Math.max(...per.map((v) => v.maxDepth)) * 100).toFixed(1)} cm), head rms ${(pen.head.rms * 100).toFixed(1)} cm`;
}

function verdictInterpenetration(T, group, what, agg) {
  if (!agg) return T.check(group, `${what}: no limb inside the body`, "MISSING", "needs the test hook (sim.readBody/readLimbs, character.spec)");
  if (agg.nonFinite) T.check(group, `${what}: positions stay finite`, "FAIL", `non-finite (NaN) vertices: ${nonFiniteText(agg)}`);
  if (agg.nonFinite && !Object.keys(agg.per).length) return;
  const parts = Object.entries(agg.per).map(([k, v]) => `${k} ${v.inside}/${v.vertices} vertices${v.inside ? ` up to ${(v.maxDepth * 100).toFixed(1)} cm deep` : ""}`);
  const through = Object.values(agg.per).some((v) => v.inside > 0);
  T.check(group, `${what}: no limb inside the body`, through ? "FAIL" : "PASS", `worst of ${agg.frames} frames: ${parts.join(", ")} (vertices outside the Body in the rest pose that are now more than ${PENETRATION_TOL_M * 100} cm inside it)`);
  if (agg.metrics) {
    const m = agg.metrics;
    const fmtM = Object.entries(m).map(([k, v]) => `${k} ${/volume/.test(k) ? `×${v.toFixed(3)}` : /Cells/.test(k) ? v : k === "jitter" ? `${(v * 1000).toFixed(1)} mm/s` : `${(v * 100).toFixed(1)} cm`}`).join(", ");
    T.check(group, `${what}: simulation quality metrics`, (m.invertedCells ?? 0) > 0 ? "FAIL" : "INFO", `worst of ${agg.frames} frames: ${fmtM}${(m.invertedCells ?? 0) > 0 ? " (cells turned inside out)" : ""}`);
  }
  const h = agg.head;
  T.check(group, `${what}: the head keeps its shape`, h.rms <= HEAD_RMS_MAX_M && h.max <= HEAD_MAX_M ? "PASS" : "FAIL",
    `head vertices off their rest shape after the best rigid fit: rms ${(h.rms * 100).toFixed(1)} cm, p95 ${(h.p95 * 100).toFixed(1)} cm, max ${(h.max * 100).toFixed(1)} cm (allowed rms ${HEAD_RMS_MAX_M * 100}, max ${HEAD_MAX_M * 100} cm)`);
}

/** The page is cross-origin isolated (COOP same-origin + COEP require-corp), so SharedArrayBuffer exists for the
 *  simulators' CPU-parallel fallback. */
async function isolation(T, group, page) {
  const iso = await page.evaluate(() => ({ coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === "function", workers: navigator.hardwareConcurrency }));
  T.check(group, "cross-origin isolated", iso.coi && iso.sab ? "PASS" : "FAIL", `crossOriginIsolated = ${iso.coi}, SharedArrayBuffer ${iso.sab ? "present" : "absent"}, ${iso.workers} hardware threads`);
  return iso;
}

/** The head's height against its rest height, and the hips' ground position (null without the hook). */
const stance = (page) => page.evaluate(() => window.__e2e.stance());
const standText = (s) => s ? `head ${s.head.toFixed(2)} m (${pct(s.head / s.rest)} of its rest ${s.rest.toFixed(2)} m)` : "no pose (hook)";
const stands = (s) => !!s && s.finite && s.head >= STAND_MIN * s.rest;

/** Open (true) or close the Lab with the top bar's 实验室 / Lab button; returns whether it is open after. */
async function setLab(page, open) {
  const isOpen = () => page.evaluate(() => document.getElementById("ui")?.dataset.lab === "open");
  if ((await isOpen()) === open) return open;
  const btn = await page.$("[data-lab-toggle]");
  if (btn && (await btn.isVisible())) await press(btn);
  else await page.keyboard.press("l");
  await sleep(400);
  return isOpen();
}

/** Pick a simulator or retargeter by pressing its row in the Lab (section "sim" or "retarget"), as a visitor does. */
async function pickPlugin(page, section, id, name) {
  const row = await page.evaluateHandle((sec, n) => {
    const lists = [...document.querySelectorAll("#ui .nw-sims")];
    // the simulator section comes first in the Lab, the retargeter second
    const list = lists[sec === "sim" ? 0 : 1];
    return [...(list?.querySelectorAll(".nw-sim") ?? [])].find((b) => b.querySelector(".nw-sim-name")?.textContent === n) ?? null;
  }, section, name);
  const el = row.asElement();
  if (!el) return null;
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await press(el);
  return el;
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
  await press(rec);
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
  await press(stop);
  log.step = "wait for the recording";
  let blob = null;
  for (let i = 0; i < 60 && !blob; i++) {
    await sleep(250);
    if (st && !(await appState(page)).lastRecording) continue; // the hook's store says when it is done
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
    await press(el);
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
  const advanced = video ? (vs1.t >= vs0.t ? vs1.t - vs0.t : vs1.t + vs0.duration - vs0.t) : null; // it may loop meanwhile
  const videoRate = video ? advanced / 2 : null;
  const videoOk = !video || (vs1.rate > 0.2 && vs1.rate < 0.3 && videoRate > 0.15 && videoRate < 0.35);
  T.check(group, "slow motion slows the frog" + (video ? " and the video" : " and the motion"), !pb2.paused && pb2.timeScale === 0.25 && r >= 0.12 && r <= 0.45 && videoOk ? "PASS" : "FAIL",
    `via ${howResume}, ${howSpeed}: timeScale ${pb2.timeScale}; surface ${(slow.speed * 1000).toFixed(0)} mm/s vs ${(run.speed * 1000).toFixed(0)} mm/s at 1× (×${r.toFixed(2)}, want 0.12–0.45)` +
      (video ? `; video playbackRate ${vs1.rate}, advanced ${advanced.toFixed(2)} s in 2 s` : ""));
  await transport(page, "speed", 1);
}

/** Enter a mode for a scenario that tests what the mode does (not the control): through the UI, else the store. */
async function enter(T, group, page, mode) {
  const r = await enterMode(page, mode, null, true);
  if (r.via) T.check(group, `enter ${mode} mode`, "INFO", `no visible control labelled "${MODES[mode]}" or [data-mode=${mode}]: switched through store.mode (= ${r.storeMode}); the modes scenario reports the control`);
  return r.found || r.storeMode === mode;
}

/* ---------------------------------------------------------------- scenarios ------------------------------------ */

/** The frog, the frame rate, a tap on the belly, a drag-and-throw. */
export async function play(T, page, log) {
  const ready = await boot(T, "play", page, log);
  T.check("play", "test hook window.__naiwa", ready?.hooks?.hook ? "PASS" : "INFO",
    ready?.hooks?.hook ? Object.entries(ready.hooks).filter(([k]) => k !== "hook").map(([k, v]) => `${k}${v ? "" : " (absent)"}`).join(", ") : "absent: checks use the DOM and pixels only (see the top of run.mjs)");
  if (!ready) return;
  await isolation(T, "play", page);
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
  const dentP = ready.hooks.sim ? page.evaluate(() => window.__e2e.peakDisp(800)) : null;
  await page.mouse.click(frog.target.x, frog.target.y);
  await sleep(150);
  const t1 = await shot(page, T.out, "play-tap");
  await sleep(300);
  const t2 = await shot(page);
  await sleep(500);
  verdictPicture(T, "play", "tap on the belly", Math.max(diffFraction(before, t1, region), diffFraction(before, t2, region)), idle.region, "play-tap.png", await dentP);
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
    await press(reset);
    await sleep(1500);
    const hips = (await sampleBones(page))?.hips;
    const d = hips ? Math.hypot(hips[12], hips[14]) : null;
    T.check("play", "reset puts the frog back", d == null || d < 0.15 ? "PASS" : "FAIL", d == null ? "pressed; pose not visible without the hook" : `hips ${(d * 100).toFixed(0)} cm from home after 复位`);
  }
  const home = await locateFrog(page, T.out, null);
  if (ready.hooks.sim) verdictInterpenetration(T, "play", "standing", await sampleInterpenetration(page, 4, 300));

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
    await press(ball);
    await sleep(300);
    const b0 = await counts(page);
    await page.mouse.click(home.target.x, home.target.y);
    await sleep(1200);
    const d = since(b0, await counts(page));
    const balls = await page.evaluate(() => window.__naiwa?.sim?.readBalls().length / 4);
    T.check("play", "ball tool drops a ball on the frog", (balls ?? 1) > 0 && (!ready.hooks.sim || d.events.includes("ball")) && !d.fx.length ? "PASS" : "FAIL",
      `${balls ?? "?"} ball(s) in the simulation, events [${d.events.join(", ")}]${d.fx.length ? `, comic effects ${d.fx.join(", ")}` : ""}`);
    const hand = await findControl(page, { re: "^(戳 / 拖动|手|Poke / drag|Hand)$|戳|Poke" });
    if (hand) await press(hand);
  }

  log.step = "sound";
  if ((await appState(page))?.sound === false) T.check("play", "sound off by default", "PASS", "store.sound = false on a first visit");
  else if (st) T.check("play", "sound off by default", "FAIL", `store.sound = ${st.sound} on a first visit`);
  const sound = await findControl(page, { re: "声音|Sound" });
  if (!sound) T.check("play", "sound can be turned on", "MISSING", "no visible sound control");
  else {
    await press(sound);
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
  if (!(await enter(T, "dances", page, "dance"))) return T.check("dances", "enter dance mode", "MISSING", `no control labelled "${MODES.dance}"`);
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
    const el = (await findControl(page, { label: d.name, skip: "删除|Delete" })) ?? (d.nameEn ? await findControl(page, { label: d.nameEn, skip: "删除|Delete" }) : null);
    if (el) await press(el);
    else await page.evaluate((id) => window.__naiwa.store.set({ dance: id }), d.id);
    await sleep(700);
    const st = await appState(page);
    const m = await poseMoves(T, "dances", page, frog, Math.max(2500, d.duration * 1000 * 1.2), `dance-${d.id}`, idleDeg);
    T.check("dances", `${d.name} plays`, st.dance === d.id && m.ok ? "PASS" : "FAIL", `${el ? "picked in 舞蹈库" : "no visible control with its name: picked through store.dance"}; store.dance = ${st.dance}, motion ${st.motion.state}; ${m.detail}`);
    verdictInterpenetration(T, "dances", d.name, await sampleInterpenetration(page, 8, Math.max(150, (d.duration * 1000) / 8)));
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
  if (!(await enter(T, "camera", page, "camera"))) return T.check("camera", "enter camera mode", "MISSING", `no control labelled "${MODES.camera}"`);
  const start = await findControl(page, { re: "打开摄像头|开启摄像头|开摄像头|启动摄像头|Turn on the camera|Start camera" });
  if (start) await press(start);
  else if (ready.hooks.hook) await page.evaluate(() => window.__naiwa.commands.startCamera?.());
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
    T.check("camera", "reaches tracking", tracking ? "PASS" : "FAIL", (start ? `pressed "${(await describe(start).catch(() => ({ text: "?" }))).text}"; ` : "no start button: commands.startCamera(); ") + states.map((s) => `${s.at}s ${s.key}`).join(" → "));
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
  const back = await enterMode(page, "play", null, true);
  await sleep(2500);
  const live = await page.evaluate(() => window.__e2e.liveCameraTracks());
  if (back.found || back.storeMode === "play") T.check("camera", "camera released after leaving the mode", live === 0 ? "PASS" : "FAIL", `${live} live camera track(s) after switching to ${MODES.play}`);
}

/** Video mode: upload a real dance clip, analysis to 100%, synced playback with its music, the frog follows the
 *  person; portrait also saves the motion as 我的舞蹈 and dances it, landscape records 真人 vs 奶蛙 side by side. */
export async function video(T, page, log, which) {
  const clip = T.clips[which];
  const g = `video-${which}`;
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  log.step = "enter video";
  if (!(await enter(T, g, page, "video"))) return T.check(g, "enter video mode", "MISSING", `no control labelled "${MODES.video}"`);
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
  await sleep(500);
  T.check(g, "analysed motion can be kept (store.canSaveDance)", (await appState(page)).canSaveDance ? "PASS" : "FAIL", `store.canSaveDance = ${(await appState(page)).canSaveDance} once the video plays`);
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
    T.check(g, "motion in sync with the video", fs.corr >= 0.3 && Math.abs(fs.lag) <= SYNC_MAX_S ? "PASS" : "FAIL",
      `best match ${fs.lag >= 0 ? "lags" : "leads"} the video by ${Math.abs(fs.lag).toFixed(2)} s (allowed ${SYNC_MAX_S} s)`);
    const mirrored = mus.shown ? mus.mirrored : st.mirror;
    if (fs.corr >= FOLLOW_MIN) T.check(g, "arms on the same screen side as the person's", fs.swap === mirrored ? "PASS" : "FAIL",
      `frog's ${fs.swap ? "left answers the person's right" : "left answers the person's left"}; preview ${mus.shown ? (mus.mirrored ? "mirrored" : "not mirrored") : `hidden, store.mirror = ${st.mirror}`}`);
  }
  await frameRate(T, g, page, "frame rate while playing");
  if (which === "portrait") {
    await setLab(page, true);
    await playbackChecks(T, g, page, log, true);
    await setLab(page, false);
  }

  if (which === "portrait") await saveDance(T, g, page, log);
  else await sideBySide(T, g, page, log, clip);
}

async function saveDance(T, g, page, log) {
  log.step = "save as 我的舞蹈";
  const st = await appState(page);
  const keep = await findControl(page, { re: "保存为我的动作|存为我的|Save as my motion" });
  if (!keep) return T.check(g, "save as 我的动作", "FAIL", `no visible 保存为我的动作 control (store.canSaveDance = ${st.canSaveDance})`);
  await press(keep);
  await sleep(400);
  const name = `测试舞${Date.now() % 1000}`;
  const input = (await page.$$("input[type=text], input:not([type])")).at(-1);
  if (input && (await input.isVisible())) {
    await input.click({ clickCount: 3 });
    await input.type(name);
  }
  const ok = await findControl(page, { re: "存好|确定|保存", skip: "存为" });
  if (ok) await press(ok);
  else await page.keyboard.press("Enter");
  let mine = null;
  for (let i = 0; i < 40 && !mine; i++) {
    await sleep(250);
    mine = (await appState(page)).dances.find((d) => d.origin === "mine" && d.name === name) ?? null;
  }
  T.check(g, "save as 我的舞蹈", mine ? "PASS" : "FAIL", mine ? `"${name}" is in the dance list (${mine.duration.toFixed(1)} s)` : `no dance named "${name}" with origin "mine" in store.dances after saving (canSaveDance = ${st.canSaveDance})`);
  if (!mine) return;
  log.step = "dance 我的舞蹈";
  await enterMode(page, "dance", null, true);
  // the new dance is at the end of a list longer than its panel: scroll to it as a person would
  await page.evaluate((n) => [...document.querySelectorAll("#ui .nw-row")].find((r) => r.textContent.includes(n))?.scrollIntoView({ block: "center" }), name);
  await sleep(300);
  const el = await findControl(page, { label: name, skip: "删除" });
  if (!el) return T.check(g, "我的舞蹈 plays in 舞蹈库", "FAIL", `no control named "${name}" in 舞蹈库`);
  await press(el);
  await sleep(700);
  const frog = await locateFrog(page, T.out, null);
  const m = await poseMoves(T, g, page, frog, 3000, `${g}-mine`);
  T.check(g, "我的舞蹈 plays in 舞蹈库", m.ok ? "PASS" : "FAIL", m.detail);
}

async function sideBySide(T, g, page, log, clip) {
  log.step = "side-by-side layout";
  const lay = await findControl(page, { re: "真人\\s*vs\\s*奶蛙|并排|左右" });
  if (!lay) return T.check(g, "真人 vs 奶蛙 recording", "MISSING", "no visible control for the side-by-side layout (真人 vs 奶蛙)");
  await press(lay);
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
  await shot(page, T.out, "phone-first-view");
  // on a phone the panels are tabs of a bottom sheet: open 动作 as a person would
  log.step = "open the 动作 sheet";
  const tab = await page.$("#ui .nw-tab[data-tab=motion]");
  if (tab && (await tab.isVisible())) {
    await press(tab);
    await sleep(600);
  }
  await shot(page, T.out, "phone-motion-sheet");
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
  // close the sheet again (tapping the open tab) to have the viewport to touch
  if (tab && (await page.evaluate(() => document.getElementById("ui")?.dataset.sheet === "open"))) {
    await press(tab);
    await sleep(600);
  }
  const frog = await frogVisible(T, "phone", page, "phone-start");

  log.step = "touch tap";
  const idle = await idleChange(page, frog);
  const region = toPx(frog.img, frogRegion(frog));
  const c0 = await counts(page);
  const before = await shot(page);
  const dentP = ready.hooks.sim ? page.evaluate(() => window.__e2e.peakDisp(800)) : null;
  await page.touchscreen.tap(frog.target.x, frog.target.y);
  await sleep(150);
  const t1 = await shot(page, T.out, "phone-tap");
  await sleep(300);
  const t2 = await shot(page);
  await sleep(500);
  verdictPicture(T, "phone", "touch tap", Math.max(diffFraction(before, t1, region), diffFraction(before, t2, region)), idle.region, "phone-tap.png", await dentP);
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
        await press(toggle);
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
      await enterMode(page, mode, null, true);
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
  await enterMode(page, "play", null, true);
}

/** Pause, single step and slow motion on a preset dance (driven: the frog moves all the time). */
export async function playback(T, page, log) {
  const ready = await boot(T, "playback", page, log);
  if (!ready) return;
  if (!ready.hooks.store || !ready.hooks.sim) return T.check("playback", "pause, step, slow motion", "MISSING", "needs the test hook (store, sim)");
  log.step = "enter dance";
  if (!(await enter(T, "playback", page, "dance"))) return T.check("playback", "enter dance mode", "MISSING", `no control labelled "${MODES.dance}"`);
  await sleep(1500);
  // pause, step and the speeds are Lab controls
  await setLab(page, true);
  await playbackChecks(T, "playback", page, log, false);
  await shot(page, T.out, "playback");
}

/** Wait for the dance list, then pick a dance in 预设动作 by pressing its row (else through the store). */
async function pickDance(page, id) {
  let d = null;
  for (let i = 0; i < 40 && !d; i++) {
    d = ((await appState(page))?.dances ?? []).find((x) => x.id === id) ?? null;
    if (!d) await sleep(250);
  }
  if (!d) return { found: false, how: `no dance "${id}" in store.dances` };
  if ((await appState(page)).mode !== "dance") await enterMode(page, "dance", null, true);
  const el = await findControl(page, { label: d.name, skip: "删除|Delete" });
  if (el) await press(el);
  else await page.evaluate((i) => window.__naiwa.store.set({ mode: "dance", dance: i }), id);
  await sleep(600);
  return { found: true, name: d.name, how: el ? `picked "${d.name}" in ${MODES.dance}` : `store.dance = ${id} (no visible row)` };
}

const textOf = (t) => (t == null ? "" : typeof t === "string" ? t : t.zh ?? t.en ?? "");

/** The simulators the Lab lists, with what each row shows (its backend line). */
async function listedPlugins(page, section) {
  return page.evaluate((sec) => {
    const s = window.__naiwa.store.get();
    const infos = sec === "sim" ? s.simulators : s.retargeters;
    const list = [...document.querySelectorAll("#ui .nw-sims")][sec === "sim" ? 0 : 1];
    const rows = [...(list?.querySelectorAll(".nw-sim") ?? [])].map((b) => ({
      name: b.querySelector(".nw-sim-name")?.textContent ?? "",
      backend: b.querySelector(".nw-sim-backend")?.textContent ?? null,
      why: b.querySelector(".nw-sim-why")?.textContent ?? null,
      checked: b.getAttribute("aria-checked") === "true",
      disabled: b.disabled,
    }));
    const t = (x) => (x == null ? null : typeof x === "string" ? x : x.zh);
    return infos.map((x) => ({ id: x.id, name: t(x.name), device: x.device, origin: x.origin, backend: t(x.backend), unavailable: t(x.unavailable), row: rows.find((r) => r.name === t(x.name)) ?? null }));
  }, section);
}

/** Every simulator the Lab offers: pressing its row rebuilds the simulation; each must run without errors, have the
 *  frog standing (head ≥ 90% of its rest height) 6 s after the switch, dent when poked, dance, and its physics time
 *  and frame rate are recorded. `opts.only` limits the list and `opts.backend` is the backend line gpu-mpm must show
 *  (WebGPU here; the CPU-parallel fallback in a browser without WebGPU). */
export async function simulators(T, page, log, opts = {}) {
  const g = opts.group ?? "simulators";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  if (!ready.hooks.store || !ready.hooks.sim) return T.check(g, "every simulator", "MISSING", "needs the test hook (store.simulators, sim)");
  if (opts.webgpu !== undefined) {
    const gpu = await page.evaluate(async () => {
      if (!navigator.gpu) return "navigator.gpu absent";
      const a = await navigator.gpu.requestAdapter().catch(() => null);
      return a ? `adapter ${a.info?.vendor ?? "?"} ${a.info?.architecture ?? ""}` : "no adapter";
    });
    T.check(g, opts.webgpu ? "WebGPU available" : "browser without WebGPU", /adapter /.test(gpu) === opts.webgpu ? "PASS" : "FAIL", gpu);
    await isolation(T, g, page);
  }
  log.step = "open the Lab";
  const open = await setLab(page, true);
  if (!open) T.check(g, "Lab opens", "FAIL", "the 实验室 button did not open the Lab (#ui data-lab)");
  const listed = await listedPlugins(page, "sim");
  if (!opts.only) {
    const want = [...SIMULATORS_BUILTIN, ...SIMULATORS_LIBRARY];
    const absent = want.filter((id) => !listed.some((x) => x.id === id));
    const noRow = listed.filter((x) => !x.row).map((x) => x.id);
    T.check(g, "simulators listed in the Lab", !absent.length && !noRow.length ? "PASS" : "FAIL",
      `${listed.length}: ${listed.map((x) => `${x.id} (${x.device}${x.unavailable ? `, unavailable: ${x.unavailable}` : ""})`).join(", ")}` +
        (absent.length ? `; missing ${absent.join(", ")}` : "") + (noRow.length ? `; no row in the Lab for ${noRow.join(", ")}` : ""));
    const def = (await appState(page)).simulator;
    T.check(g, "default simulator", def.id === "cpu-constraints" ? "PASS" : "FAIL", `store.simulator.id = ${def.id}`);
  }
  const mpm = listed.find((x) => x.id === "gpu-mpm");
  if (opts.backend) {
    const shown = mpm?.row?.backend ?? null;
    T.check(g, "gpu-mpm shows its backend", mpm && !mpm.unavailable && shown && opts.backend.test(shown) ? "PASS" : "FAIL",
      mpm ? `row shows "${shown ?? "(no backend line)"}"${mpm.row?.why ? `, "${mpm.row.why}"` : ""}; SimulatorInfo.backend = ${mpm.backend}; want ${opts.backend}` : "gpu-mpm is not registered");
  }
  await shot(page, T.out, `${g}-lab`);
  const restY = (await stance(page))?.rest;
  // gpu-mpm last: a simulation that goes non-finite can leave the view broken for the next ones (reported below)
  const ids = (opts.only ?? ["cpu-constraints", ...SIMULATORS_LIBRARY, "gpu-mpm"]).filter((id) => listed.some((x) => x.id === id));
  const rows = [];
  for (const id of ids) try {
    const info = listed.find((x) => x.id === id);
    log.step = `simulator ${id}`;
    const errors0 = log.errors.length;
    await page.evaluate(() => { window.__e2e.prevSim = window.__naiwa.sim; });
    // pressing the row of the simulator already in use keeps it (and its settings): no rebuild expected then
    const already = (await appState(page)).simulator.id === id;
    const el = await pickPlugin(page, "sim", id, info.name);
    if (!el) await page.evaluate((i) => window.__naiwa.store.set({ simulator: { id: i, settings: {} } }), id);
    await sleep(500);
    await page.evaluate(() => {
      const n = window.__naiwa;
      if (n.store.get().mode !== "play") n.store.set({ mode: "play" });
      n.commands.resetFrog();
    });
    const t0 = Date.now();
    const st0 = await appState(page);
    const fresh = already || (await page.evaluate(() => !!window.__naiwa.sim && window.__naiwa.sim !== window.__e2e.prevSim));
    await page.evaluate(() => window.__e2e.attachHooks());
    await sleep(Math.max(0, STAND_AFTER_MS - (Date.now() - t0)));
    const s = await stance(page);
    await shot(page, T.out, `sim-${id}`);
    const f = await measureFrames(page, 2000);
    // poke the belly: the flesh must dent and come back finite
    const frog = await locateFrog(page, T.out, null);
    const dentP = page.evaluate(() => window.__e2e.peakDisp(800));
    if (frog?.target) await page.mouse.click(frog.target.x, frog.target.y);
    const dent = await dentP;
    await page.evaluate(() => window.__naiwa.store.set({ mode: "dance", dance: "gouxiong" }));
    await sleep(800);
    const m = await poseMoves(T, g, page, frog, 2500, `sim-${id}-dance`);
    const penDance = await sampleInterpenetration(page, 3, 200);
    // and back to free mode: still finite and standing
    await page.evaluate(() => window.__naiwa.store.set({ mode: "play" }));
    await sleep(2000);
    const penFree = await sampleInterpenetration(page, 2, 300);
    const pen = penDance?.nonFinite ? penDance : penFree?.nonFinite ? { ...penFree, nonFinite: Object.fromEntries(Object.entries(penFree.nonFinite).map(([k, v]) => [`${k} (after the dance, free)`, v])) } : penDance;
    const st = await appState(page);
    const errs = log.errors.slice(errors0);
    const standing = stands(s);
    const view = await page.evaluate(() => { const c = window.__naiwa.stage.camera; return [...c.position.toArray(), ...c.quaternion.toArray()].every(Number.isFinite); });
    const ok = !errs.length && fresh && st.simulator.id === id && standing && dent >= DENT_MIN_M && Number.isFinite(dent) && m.ok && !pen?.nonFinite && view;
    const physics = f.physicsP95 ?? st.stats.stepMs;
    rows.push({ id, particles: st.stats.particles, cells: st.stats.cells, stepMs: st.stats.stepMs, physicsP95: f.physicsP95, fps: Math.round(f.fps), head: s ? s.head / s.rest : null, backend: info.backend });
    const penText = penSummary(pen);
    T.check(g, id, ok ? (physics > PHYSICS_P95_MAX_MS ? "WARN" : "PASS") : "FAIL",
      `${errs.length ? `errors: ${errs.slice(0, 2).join(" | ")}; ` : ""}${el ? "picked in the Lab" : "no row: store.simulator"}${fresh ? "" : ", the simulation was NOT rebuilt"}${view ? "" : ", the camera went NON-FINITE (black view)"}${info.backend ? ` (${info.backend})` : ""}; ` +
        `after ${STAND_AFTER_MS / 1000} s ${standing ? "stands" : "does NOT stand"}: ${standText(s)}; poke dents ${(dent * 100).toFixed(1)} cm; dances: ${m.detail}; ` +
        `${st.stats.particles} particles, ${st.stats.cells} cells, step ${st.stats.stepMs} ms (sim.step p95 ${f.physicsP95?.toFixed(2) ?? "?"} ms, budget ${PHYSICS_P95_MAX_MS}), ${Math.round(f.fps)} fps, volume ×${st.stats.volumeRatio}${penText}; sim-${id}.png`);
    if (pen?.nonFinite || !view) {
      // judge the next simulator on a fresh page
      await page.reload({ waitUntil: "load" });
      await waitReady(page);
      await setLab(page, true);
    }
  } catch (e) {
    // One broken simulator must not hide the others: report it and go on from a fresh page.
    T.check(g, id, "FAIL", `the checks broke at "${log.step}": ${e.message.split("\n")[0]}; page errors: ${log.errors.slice(-2).join(" | ") || "none"}`);
    await shot(page, T.out, `sim-${id}-broken`).catch(() => {});
    rows.push({ id, particles: null, cells: null, stepMs: null, physicsP95: null, fps: null, head: null });
    await page.reload({ waitUntil: "load" });
    await waitReady(page);
    await setLab(page, true);
  }
  T.shared[`${g}Table`] = rows;
  T.check(g, "physics time and frame rate per simulator", "INFO", rows.map((r) => `${r.id} ${r.stepMs} ms (p95 ${r.physicsP95?.toFixed(2) ?? "?"}) ${r.fps} fps, ${r.particles} p / ${r.cells} c, head ${r.head == null ? "?" : pct(r.head)}`).join("; ") + (restY ? `; head rest height ${restY.toFixed(2)} m` : ""));
  if (!opts.only) await page.evaluate(() => window.__naiwa.store.set({ simulator: { id: "cpu-constraints", settings: {} } }));
}

/** Every retargeter the Lab offers, on 狗熊哆嗦毛: picking its row switches the motion transfer; each must keep the
 *  frog dancing; the default (planted feet) must keep the standing feet from sliding. Foot slide is measured from
 *  the rendered feet (horizontal speed while a foot is within 2 cm of its lowest) and also read from the
 *  retargeter's own metrics. */
export async function retargeters(T, page, log) {
  const g = "retargeters";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  if (!ready.hooks.store) return T.check(g, "every retargeter", "MISSING", "needs the test hook (store.retargeters)");
  log.step = "open the Lab";
  await setLab(page, true);
  const listed = await listedPlugins(page, "retarget");
  const absent = RETARGETERS.filter((id) => !listed.some((x) => x.id === id));
  T.check(g, "retargeters listed in the Lab", !absent.length && listed.every((x) => x.row) ? "PASS" : "FAIL",
    `${listed.length}: ${listed.map((x) => x.id).join(", ")}${absent.length ? `; missing ${absent.join(", ")}` : ""}`);
  const def = await page.evaluate(() => window.__naiwa.store.get().retargeter.id);
  const defRow = listed.find((x) => x.id === def)?.row;
  T.check(g, "default retargeter", def === DEFAULT_RETARGETER && defRow?.checked ? "PASS" : "FAIL", `store.retargeter.id = ${def}; its row ${defRow?.checked ? "is" : "is NOT"} shown as chosen`);
  log.step = "dance 狗熊哆嗦毛";
  const pick = await pickDance(page, GOUXIONG);
  if (!pick.found) return T.check(g, "狗熊哆嗦毛", "FAIL", pick.how);
  const frog = await locateFrog(page, T.out, null);
  const rows = [];
  for (const id of RETARGETERS.filter((x) => listed.some((y) => y.id === x))) {
    const info = listed.find((x) => x.id === id);
    log.step = `retargeter ${id}`;
    const errors0 = log.errors.length;
    const el = await pickPlugin(page, "retarget", id, info.name);
    if (!el) await page.evaluate((i) => window.__naiwa.store.set({ retargeter: { id: i, settings: {} } }), id);
    await sleep(1500);
    const slide = await page.evaluate(() => window.__e2e.footSlide(3000));
    const own = await page.evaluate(() => window.__naiwa.motion.metrics?.() ?? null);
    const m = await poseMoves(T, g, page, frog, 2000, `retarget-${id}`);
    const st = await page.evaluate(() => window.__naiwa.store.get().retargeter.id);
    const errs = log.errors.slice(errors0);
    const ok = !errs.length && st === id && m.ok && slide;
    rows.push({ id, slide: slide?.speed, own });
    const ownText = own ? `its own metrics: foot slide ${(own.footSlide * 100).toFixed(1)} cm/s, direction error ${own.fidelity.toFixed(1)}°, jerk ${own.jerk.toFixed(0)} m/s³, limb penetration ${(own.penetration * 1000).toFixed(1)} mm` : "no metrics";
    const slideText = slide ? `standing feet slide ${(slide.speed * 100).toFixed(1)} cm/s (feet down ${pct(slide.standing)} of the time)` : "no feet";
    if (id === DEFAULT_RETARGETER) {
      T.check(g, `${id} (default): feet stay planted`, ok && slide.speed <= FOOT_SLIDE_MAX ? "PASS" : "FAIL", `${slideText}, allowed ${FOOT_SLIDE_MAX * 100} cm/s; ${ownText}; ${m.detail}`);
    } else {
      T.check(g, id, ok ? "PASS" : "FAIL", `${errs.length ? `errors: ${errs.slice(0, 2).join(" | ")}; ` : ""}${el ? "picked in the Lab" : "store.retargeter"}, store says ${st}; ${slideText}; ${ownText}; ${m.detail}`);
    }
  }
  const base = rows.find((r) => r.id === "direction-copy"), planted = rows.find((r) => r.id === DEFAULT_RETARGETER);
  if (base?.slide != null && planted?.slide != null) {
    T.check(g, "planting the feet reduces foot slide", planted.slide <= base.slide + 0.002 ? "PASS" : "WARN", `planted-feet ${(planted.slide * 100).toFixed(1)} cm/s vs direction-copy ${(base.slide * 100).toFixed(1)} cm/s on 狗熊哆嗦毛`);
  }
  await page.evaluate((d) => window.__naiwa.store.set({ retargeter: { id: d, settings: {} } }), DEFAULT_RETARGETER);
}

/** The first view: the Lab collapsed, the 手感 / Feel panel there; its chips, sliders, 慢动作, 月球重力 and 恢复默认
 *  write the same store state the Lab's exact knobs show. */
export async function feel(T, page, log) {
  const g = "feel";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  if (!ready.hooks.store) return T.check(g, "the Feel panel", "MISSING", "needs the test hook (store.params)");
  log.step = "first view";
  const view = await page.evaluate(() => {
    const ui = document.getElementById("ui");
    const vis = (el) => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0;
    const labOnly = [...document.querySelectorAll("#ui [data-lab-only]")].filter(vis).map((e) => e.className.split(" ")[0] || e.tagName);
    return {
      lab: ui?.dataset.lab,
      labOnly,
      sims: vis(document.querySelector("#ui .nw-sims")),
      feelSliders: [...document.querySelectorAll("#ui .nw-feel-slider input[type=range]")].filter(vis).map((i) => i.getAttribute("aria-label")),
      switches: [...document.querySelectorAll("#ui .nw-feel-toggles [role=switch]")].filter(vis).map((s) => s.getAttribute("aria-label")),
      chips: [...document.querySelectorAll("#ui .nw-feel-sliders")].length,
    };
  });
  await shot(page, T.out, "feel-first-view");
  T.check(g, "Lab collapsed by default", view.lab === "closed" && !view.labOnly.length && !view.sims ? "PASS" : "FAIL",
    `#ui data-lab = ${view.lab}; ${view.labOnly.length ? `Lab parts in view: ${view.labOnly.join(", ")}` : "no Lab part (simulator, parameters, readouts, playback) in view"}; feel-first-view.png`);
  T.check(g, "手感 panel shown with the Lab closed", view.feelSliders.length === 3 && view.switches.length === 2 ? "PASS" : "FAIL",
    `sliders [${view.feelSliders.join(", ")}], switches [${view.switches.join(", ")}]`);

  log.step = "sliders";
  const params = () => page.evaluate(() => ({ ...window.__naiwa.store.get().params, preset: window.__naiwa.store.get().preset, playback: window.__naiwa.store.get().playback }));
  // what each slider writes (src/ui/feel.ts FEEL_SLIDERS): firm = 1 − softness, settle = 1 − bounciness, belly 0.8…1.5
  const sliders = [
    { label: "软硬", param: "softness", at: 0.8, want: (x) => 1 - x },
    { label: "晃动", param: "bounciness", at: 0.75, want: (x) => 1 - x },
    { label: "肚子", param: "bellySize", at: 0.85, want: (x) => 0.8 + x * 0.7 },
  ];
  for (const s of sliders) {
    const input = await page.$(`#ui .nw-feel-slider input[aria-label="${s.label}"]`);
    if (!input) { T.check(g, `slider ${s.label}`, "FAIL", "not found"); continue; }
    const before = (await params())[s.param];
    const box = await input.boundingBox();
    // a person clicks the track at that point (the thumb jumps there and the input event fires)
    await page.mouse.click(box.x + box.width * s.at, box.y + box.height / 2);
    await sleep(300);
    const x = Number(await input.evaluate((e) => e.value));
    const after = (await params())[s.param];
    const ok = Math.abs(after - s.want(x)) < 0.011 && Math.abs(after - before) > 0.1;
    T.check(g, `slider ${s.label} drives store.params.${s.param}`, ok ? "PASS" : "FAIL", `clicked at ${pct(s.at)} of the track: slider ${x.toFixed(2)}, ${s.param} ${before} → ${after} (expected ${s.want(x).toFixed(3)})`);
  }
  // the Lab's exact knobs show the same state
  await setLab(page, true);
  const knobs = await page.evaluate(() => {
    const get = (id) => { const el = document.getElementById(id); return el ? Number(el.value) : null; };
    return { softness: get("nw-k-softness"), volume: get("nw-k-volume") };
  });
  const p1 = await params();
  T.check(g, "the Lab's knobs show the Feel panel's values", knobs.softness != null && Math.abs(knobs.softness - p1.softness) < 0.011 ? "PASS" : "FAIL",
    `Lab softness knob ${knobs.softness} vs store.params.softness ${p1.softness}`);
  await setLab(page, false);

  log.step = "material chip";
  const mochi = await findControl(page, { label: "麻薯" });
  if (mochi) {
    await press(mochi);
    await sleep(300);
    const p = await params();
    T.check(g, "material chip 麻薯", p.preset === "mochi" && p.softness === 0.95 && (await selected(mochi)) ? "PASS" : "FAIL", `preset ${p.preset}, softness ${p.softness}, bounciness ${p.bounciness}, chip pressed ${await selected(mochi)}`);
  } else T.check(g, "material chip 麻薯", "FAIL", "no visible 麻薯 chip");

  log.step = "slow motion";
  const slowSw = await page.$('#ui .nw-feel-toggles [role=switch][aria-label="慢动作"]');

  if (slowSw) {
    await press(slowSw);
    await sleep(400);
    const p = await params();
    T.check(g, "慢动作 slows the simulation", p.playback.timeScale === 0.25 && !p.playback.paused && (await selected(slowSw)) ? "PASS" : "FAIL",
      `store.playback ${JSON.stringify(p.playback)}, switch on ${await selected(slowSw)}`);
    await shot(page, T.out, "feel-slow");
  } else T.check(g, "慢动作 slows the simulation", "FAIL", "no 慢动作 switch");

  log.step = "moon gravity";
  const moonSw = await page.$('#ui .nw-feel-toggles [role=switch][aria-label="月球重力"]');
  if (moonSw) {
    await press(moonSw);
    await sleep(400);
    const p = await params();
    T.check(g, "月球重力 sets the Moon's gravity", Math.abs(p.gravity - 1 / 6) < 1e-3 && (await selected(moonSw)) ? "PASS" : "FAIL", `store.params.gravity ${p.gravity} (want ${(1 / 6).toFixed(4)}), switch on ${await selected(moonSw)}`);
  } else T.check(g, "月球重力 sets the Moon's gravity", "FAIL", "no 月球重力 switch");

  log.step = "back to default";
  const reset = await findControl(page, { label: "恢复默认" });
  if (reset) {
    await press(reset);
    await sleep(400);
    const p = await params();
    const disabled = await reset.evaluate((e) => e.disabled);
    const jelly = { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 };
    const same = Object.entries(jelly).every(([k, v]) => p[k] === v);
    T.check(g, "恢复默认 restores the defaults", p.preset === "jelly" && same && p.playback.timeScale === 1 && !p.playback.paused && disabled ? "PASS" : "FAIL",
      `preset ${p.preset}, ${Object.keys(jelly).map((k) => `${k} ${p[k]}`).join(", ")}, playback ${JSON.stringify(p.playback)}; the button is ${disabled ? "disabled" : "still enabled"} at the defaults`);
  } else T.check(g, "恢复默认 restores the defaults", "FAIL", "no visible 恢复默认 control");
  await shot(page, T.out, "feel-after");

}

/** The Lab behind its button: the code lab opens from 编辑代码; the local Lab's Codex entry points stay hidden when
 *  no Lab server answers (the page as the public site serves it). */
export async function lab(T, page, log) {
  const g = "lab";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  const codex = () => page.evaluate(() => {
    const vis = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0;
    const btns = [...document.querySelectorAll(".nw-codex-btn")].filter(vis).map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
    const notes = [...document.querySelectorAll(".nw-codex-note")].filter(vis).map((n) => n.textContent.trim());
    const text = document.body.innerText.match(/[^\n]*Codex[^\n]*/g) ?? [];
    return { btns, notes, text };
  });
  log.step = "Codex entry points with the Lab closed";
  const closed = await codex();
  log.step = "open the Lab";
  const open = await setLab(page, true);
  await sleep(600);
  await shot(page, T.out, "lab-open");
  T.check(g, "实验室 opens the Lab", open ? "PASS" : "FAIL", `#ui data-lab = ${open ? "open" : "closed"} after pressing 实验室; lab-open.png`);
  const opened = await codex();
  const all = [...closed.btns, ...opened.btns, ...closed.notes, ...opened.notes, ...closed.text, ...opened.text];
  T.check(g, "local Lab entry points hidden without a Lab server", all.length ? "FAIL" : "PASS",
    all.length ? `visible: ${[...new Set(all)].slice(0, 6).join(" | ")}` : `no 用 Codex 优化 button, note or "Codex" text with the Lab closed or open; the page asked the (absent) Lab server ${log.lab.length} time(s) (${[...new Set(log.lab.map((l) => l.replace(/^\[[^\]]*\] /, "").replace(/\?.*/, "")))].join(", ")})`);

  log.step = "code lab";
  for (const [i, kind] of [[0, "simulator"], [1, "retargeter"]]) {
    const edits = await page.$$("#ui .nw-section-actions button");
    const edit = (await Promise.all(edits.map(async (b) => ((await b.evaluate((e) => e.textContent.trim())) === "编辑代码" && (await b.isVisible()) ? b : null)))).filter(Boolean)[i];
    if (!edit) { T.check(g, `编辑代码 opens the code lab (${kind})`, "FAIL", `no visible 编辑代码 button #${i + 1} in the Lab`); continue; }
    await press(edit);
    let cl = null;
    for (let k = 0; k < 20; k++) {
      await sleep(250);
      cl = await page.evaluate(() => {
        const el = document.querySelector(".nw-cl");
        if (!el || el.hidden || !el.checkVisibility()) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), slots: [...el.querySelectorAll(".nw-cl-slots [role=tab]")].map((t) => t.textContent.trim()).slice(0, 10), editor: el.querySelector(".nw-cl-editor")?.textContent.length ?? 0, head: el.querySelector(".nw-cl-head")?.textContent.trim().slice(0, 80) };
      });
      if (cl && cl.editor > 50) break;
    }
    await shot(page, T.out, `lab-code-${kind}`);
    T.check(g, `编辑代码 opens the code lab (${kind})`, cl && cl.editor > 50 ? "PASS" : "FAIL",
      cl ? `${cl.w}×${cl.h} px, "${cl.head}", slots [${cl.slots.join(", ")}], ${cl.editor} characters of code shown; lab-code-${kind}.png` : "no .nw-cl dialog shown within 5 s");
    const after = await codex();
    if (after.btns.length) T.check(g, `no Codex entry in the code lab (${kind})`, "FAIL", after.btns.join(" | "));
    const close = await page.$(".nw-cl .nw-cl-close");
    if (close) await press(close);
    else await page.keyboard.press("Escape");
    await sleep(400);
    const hidden = await page.evaluate(() => { const el = document.querySelector(".nw-cl"); return !el || el.hidden || !el.checkVisibility(); });
    if (!hidden) T.check(g, `the code lab closes (${kind})`, "FAIL", "still shown after its close button");
  }
  log.step = "close the Lab";
  const shut = await setLab(page, false);
  const leftover = await page.evaluate(() => [...document.querySelectorAll("#ui [data-lab-only]")].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 0).length);
  T.check(g, "实验室 closes the Lab again", !shut && !leftover ? "PASS" : "FAIL", `data-lab ${shut ? "open" : "closed"}, ${leftover} Lab part(s) still in view`);
}

/** The tongue stays attached: with the tongue out (forced), every tongue vertex of MouthInside stays within a few cm
 *  of the rendered Body surface, at rest and while the head shakes in 狗熊哆嗦毛; a front and a side view. */
export async function tongue(T, page, log) {
  const g = "tongue";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  if (!ready.hooks.character) return T.check(g, "tongue stays attached", "MISSING", "needs the test hook (character)");
  log.step = "tongue out";
  const forced = await page.evaluate(() => {
    const c = window.__naiwa.character;
    if (!c?.setExpressions) return false;
    const orig = c.setExpressions.bind(c);
    c.setExpressions = (w) => orig({ ...(w ?? {}), tongue: 1, laugh: 0, surprise: 0 });
    return true;
  });
  if (!forced) return T.check(g, "tongue stays attached", "FAIL", "character.setExpressions not found");
  await sleep(1500);
  const sample = async (n, every) => {
    let worst = null;
    for (let i = 0; i < n; i++) {
      const r = await page.evaluate(() => window.__e2e.tongueGap());
      if (r && (!worst || r.max > worst.max)) worst = r;
      await sleep(every);
    }
    return worst;
  };
  const rest = await sample(4, 200);
  const frog = await locateFrog(page, T.out, "tongue-front");
  if (!rest?.vertices) return T.check(g, "tongue stays attached", "FAIL", "no tongue vertices (MouthInside coloured tongue-red) found");
  T.check(g, "tongue stays attached at rest", rest.max <= TONGUE_GAP_MAX_M ? "PASS" : "FAIL",
    `${rest.vertices} tongue vertices, farthest ${(rest.max * 100).toFixed(1)} cm from the Body surface (mean ${(rest.mean * 100).toFixed(1)} cm; allowed ${TONGUE_GAP_MAX_M * 100} cm); tongue-front.png`);
  // side view: drag the background (orbit), away from the frog
  log.step = "side view";
  const r = frog.rect;
  const y = r.y + r.h * 0.9;
  await page.mouse.move(r.x + r.w - 40, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(r.x + r.w - 40 - i * 18, y); await sleep(16); }
  await page.mouse.up();
  await sleep(800);
  await shot(page, T.out, "tongue-side");
  log.step = "dance with the tongue out";
  await pickDance(page, GOUXIONG);
  await sleep(500);
  const dancing = await sample(12, 250);
  await shot(page, T.out, "tongue-dance");
  T.check(g, "tongue stays attached while dancing (狗熊哆嗦毛)", dancing && dancing.max <= TONGUE_GAP_MAX_M ? "PASS" : "FAIL",
    dancing ? `worst of 12 frames: farthest tongue vertex ${(dancing.max * 100).toFixed(1)} cm from the Body (mean ${(dancing.mean * 100).toFixed(1)} cm; allowed ${TONGUE_GAP_MAX_M * 100} cm); tongue-side.png, tongue-dance.png` : "no measure");
}

/** Robustness in free mode and around it: left alone 10 s it stands where it is; a dance, a burst of pokes and a
 *  throw leave it standing again (upright recovery) with nothing non-finite. */
export async function robust(T, page, log) {
  const g = "robust";
  const ready = await boot(T, g, page, log);
  if (!ready) return;
  if (!ready.hooks.sim) return T.check(g, "robustness", "MISSING", "needs the test hook (sim, character)");
  log.step = "free 10 s";
  const s0 = await stance(page);
  let minHead = Infinity, drift = 0, finite = true;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await stance(page);
    finite &&= !!s?.finite;
    if (!s) continue;
    minHead = Math.min(minHead, s.head / s.rest);
    drift = Math.max(drift, Math.hypot(s.hips[0] - s0.hips[0], s.hips[2] - s0.hips[2]));
  }
  await shot(page, T.out, "robust-free");
  T.check(g, "free mode, 10 s untouched", finite && minHead >= STAND_MIN && drift <= FREE_DRIFT_MAX_M ? "PASS" : "FAIL",
    `head never below ${pct(minHead)} of its rest height (needs ${pct(STAND_MIN)}), hips drifted ${(drift * 100).toFixed(1)} cm (allowed ${FREE_DRIFT_MAX_M * 100} cm)${finite ? "" : ", NON-FINITE positions"}; robust-free.png`);

  log.step = "dance";
  await pickDance(page, "kemusan");
  let minDance = Infinity, maxRoot = 0;
  const d0 = await stance(page);
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const s = await stance(page);
    if (!s?.finite) { finite = false; continue; }
    minDance = Math.min(minDance, s.head / s.rest);
    maxRoot = Math.max(maxRoot, Math.hypot(s.hips[0] - d0.hips[0], s.hips[2] - d0.hips[2]));
  }
  await shot(page, T.out, "robust-dance");
  const pen = await sampleInterpenetration(page, 4, 250);
  T.check(g, "a dance (科目三, 8 s)", finite && !pen?.nonFinite && minDance >= 0.75 ? "PASS" : "FAIL", `head never below ${pct(minDance)} of its rest height while dancing (needs 75%), hips moved up to ${(maxRoot * 100).toFixed(0)} cm${penSummary(pen).replace(/^; /, ", ")}; robust-dance.png`);
  await enterMode(page, "play", null, true);
  await sleep(STAND_AFTER_MS);
  const afterDance = await stance(page);
  T.check(g, "stands after the dance", stands(afterDance) ? "PASS" : "FAIL", `${STAND_AFTER_MS / 1000} s back in ${MODES.play}: ${standText(afterDance)}`);

  log.step = "pokes";
  const frog = await locateFrog(page, T.out, null);
  const b = frog.bbox ?? { x: frog.target.x - 50, y: frog.target.y - 100, w: 100, h: 200 };
  // along the body's middle (head to belly), where a tap meets flesh rather than the gap beside an arm
  const spots = [[0.5, 0.15], [0.5, 0.55], [0.42, 0.45], [0.58, 0.45], [0.5, 0.35], [0.46, 0.6], [0.54, 0.25], [0.5, 0.5]];
  const c0 = await counts(page);
  const t0 = await page.evaluate(() => performance.now());
  for (const [u, v] of spots) {
    await page.mouse.click(b.x + b.w * u, b.y + b.h * v);
    await sleep(250);
  }
  const t1 = await page.evaluate(() => performance.now());
  const fs = await page.evaluate((a, z) => window.__e2e.frameStats(a, z), t0, t1);
  const pokes = since(c0, await counts(page)).events.filter((k) => k === "poke" || k === "slap").length;
  await sleep(STAND_AFTER_MS);
  const afterPokes = await stance(page);
  await shot(page, T.out, "robust-pokes");
  T.check(g, `${spots.length} quick pokes`, pokes >= spots.length / 2 && stands(afterPokes) ? "PASS" : "FAIL",
    `${pokes} poke events; physics during the pokes p95 ${fs.physicsP95?.toFixed(2) ?? "?"} ms, ${fs.fps.toFixed(0)} fps; ${STAND_AFTER_MS / 1000} s later: ${standText(afterPokes)}; robust-pokes.png`);

  log.step = "throw";
  const f2 = await locateFrog(page, T.out, null);
  const c1 = await counts(page);
  await mouseThrow(page, f2.target, { x: f2.target.x - 160, y: f2.target.y - 260 });
  for (let i = 0; i < 28 && !(await counts(page)).events.slice(c1.events.length).includes("land"); i++) await sleep(250);
  const ev = since(c1, await counts(page)).events;
  await sleep(STAND_AFTER_MS);
  const afterThrow = await stance(page);
  const seen = await locateFrog(page, T.out, "robust-throw");
  T.check(g, "a throw: it lands and stands up again", ev.includes("land") && stands(afterThrow) && (seen.areaFraction ?? 1) > 0.01 ? "PASS" : "FAIL",
    `events [${[...new Set(ev)].join(", ")}]; ${STAND_AFTER_MS / 1000} s after landing: ${standText(afterThrow)}, hips at (${afterThrow?.hips.map((x) => x.toFixed(2)).join(", ")}) m, frog covers ${pct(seen.areaFraction ?? 0)} of the canvas; robust-throw.png`);
}
