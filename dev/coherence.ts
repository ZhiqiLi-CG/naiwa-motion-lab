/**
 * dev/coherence.html: video → motion under a moving camera, measured. A clip with a still camera (default the e2e
 * suite's CC BY waacking clip) is filmed again through a virtual camera — a canvas crop that pans, tilts and zooms,
 * then cuts to another framing and pans back — and recorded with MediaRecorder. Both clips are analysed like an
 * upload (the original; the filmed one, kept both without camera handling and with it), and compared:
 *
 * - the camera estimate against the virtual camera that made it (shift, zoom, the cut);
 * - what the frog does (side steps, hops, heading) against the original's, before and after;
 * - the landmark metrics of the full coherence algorithm (the Lab job's deterministic pass).
 *
 * URL: ?src=<video url> &seconds=<length filmed> &cut=<seconds of the cut>. Results: window.__coherence.
 * ?only=<video url> &camera=0|1: just analyse that video, the track in window.__coherence.track.
 * ?save=1: just film, the clip as base64 in window.__coherence.filmed (to upload it elsewhere).
 */
import { buildTestFrog } from "../src/motion/testFrog";
import { createMotion } from "../src/motion/index";
import { videoAnalysis } from "../src/motion/sources";
import { createRetargetPipeline } from "../src/motion/core";
import { bindRig } from "../src/motion/rig";
import { recordingOf, TrackPlayer, type Track } from "../src/motion/track";
import { coherence, compare, DEFAULTS } from "../src/algorithms/motion/coherence";

const params = new URLSearchParams(location.search);
const SRC = params.get("src") ?? "/tests/e2e/media/dance-waacking.mp4";
const SECONDS = Number(params.get("seconds") ?? 8);
const CUT = Number(params.get("cut") ?? 4);
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const status = (s: string) => ($("#status").textContent = s);
const results: Record<string, unknown> = {};
Object.assign(window, { __coherence: results });

/** The virtual camera at source time t: zoom and crop centre (fractions of the source). After the cut, another
 *  framing with another look (colour, contrast), as a second camera would give. */
function virtualCamera(t: number) {
  if (t < CUT) {
    const u = t / CUT;
    return { z: 1.2 + 0.25 * u, cx: 0.4 + 0.2 * u, cy: 0.5 + 0.03 * Math.sin(t * 1.7) };
  }
  const u = (t - CUT) / Math.max(0.1, SECONDS - CUT);
  return { z: 1.7, cx: 0.64 - 0.14 * u, cy: 0.42 };
}
/** The crop clamped inside the source (fractions): centre and size. */
function crop(t: number) {
  const { z, cx, cy } = virtualCamera(t);
  const w = 1 / z, h = 1 / z;
  return { w, h, cx: Math.min(1 - w / 2, Math.max(w / 2, cx)), cy: Math.min(1 - h / 2, Math.max(h / 2, cy)) };
}
/** The true camera at source time m against the first frame of its shot (DanceTrack.camera's terms). */
function trueCamera(m: number) {
  const a = crop(m < CUT ? 0 : CUT), c = crop(m);
  return { shift: [(a.cx - c.cx) / c.w, (a.cy - c.cy) / c.h] as [number, number], scale: a.w / c.w };
}

/** Film the source through the virtual camera: each new source frame drawn cropped into a canvas, recorded. Returns
 *  the clip and the source time of each moment of it. */
async function film(): Promise<{ file: File; sourceTime: (t: number) => number }> {
  const src = document.createElement("video");
  src.muted = true;
  src.playsInline = true;
  src.src = SRC;
  await new Promise<void>((res, rej) => ((src.onloadeddata = () => res()), (src.onerror = () => rej(src.error))));
  const W = 480, H = Math.round((480 * src.videoHeight) / src.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = "width:100%;height:100%;object-fit:contain";
  $("#film").append(canvas);
  const ctx = canvas.getContext("2d")!;
  const draw = (m: number) => {
    const c = crop(m);
    const sw = src.videoWidth, sh = src.videoHeight;
    ctx.filter = m < CUT ? "none" : "saturate(0.3) brightness(1.3) contrast(1.4)";
    ctx.drawImage(src, (c.cx - c.w / 2) * sw, (c.cy - c.h / 2) * sh, c.w * sw, c.h * sh, 0, 0, W, H);
  };
  draw(0);
  const stream = canvas.captureStream(30);
  const options = { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 5e6 };
  // The encoder drops the first seconds while it starts up (headless Chrome): warm it up on a throwaway recording.
  const warm = new MediaRecorder(stream, options);
  warm.start(100);
  await new Promise<void>((r) => {
    const t = performance.now();
    const tick = () => (draw(0), performance.now() - t > 3000 ? r() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  warm.stop();
  await new Promise((r) => (warm.onstop = r));
  const rec = new MediaRecorder(stream, options);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const pairs: [number, number][] = [];
  let t0 = 0;
  await new Promise<void>((resolve) => {
    const frame = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (!t0) {
        t0 = now;
        rec.start(100);
      }
      draw(meta.mediaTime);
      pairs.push([(now - t0) / 1000, meta.mediaTime]);
      if (meta.mediaTime >= SECONDS || src.ended) resolve();
      else src.requestVideoFrameCallback(frame);
    };
    src.requestVideoFrameCallback(frame);
    src.onended = () => resolve();
    void src.play();
  });
  rec.stop();
  src.pause();
  await new Promise((r) => (rec.onstop = r));
  const sourceTime = (t: number) => {
    let best = pairs[0];
    for (const p of pairs) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best[1] + Math.max(-0.05, Math.min(0.05, t - best[0]));
  };
  results.recorded = { frames: pairs.length, seconds: pairs[pairs.length - 1]?.[0], source: pairs[pairs.length - 1]?.[1] };
  return { file: new File(chunks, "filmed.webm", { type: "video/webm" }), sourceTime };
}

const motion = createMotion();
const frog = buildTestFrog();
motion.bind(frog.rig);
const rig = bindRig(frog.rig);

async function analyse(file: File | string, withCamera: boolean): Promise<Track> {
  videoAnalysis.camera = withCamera;
  const logs: string[] = [];
  const info = console.info;
  console.info = (...a: unknown[]) => (logs.push(a.join(" ")), info(...a));
  const s = await motion.startVideo(file, { mirror: false, preview: $("#preview") });
  console.info = info;
  const t = s.track()! as Track;
  s.dispose();
  if (withCamera && typeof file !== "string") results.steps = videoAnalysis.steps?.map((x) => [x.ok ? 1 : 0, +x.dx.toFixed(4), +x.dy.toFixed(4), +x.scale.toFixed(4), +x.residual.toFixed(2), x.inliers, x.blocks, +x.histogram.toFixed(2), x.cut ? 1 : 0]);
  results[`log ${typeof file === "string" ? "original" : withCamera ? "filmed+camera" : "filmed"}`] = logs;
  return t;
}

/** The frog's side step, hop and heading per frame. */
function frogSeries(track: Track) {
  const p = createRetargetPipeline(rig, { id: "direction-copy", settings: {} }, recordingOf(track));
  const player = new TrackPlayer(track, () => p);
  return track.frames.map((_, k) => {
    const g = player.goal(k / track.fps, 1 / track.fps, false);
    return g ? { shift: g.shift, lift: g.lift, yaw: g.yaw } : null;
  });
}
type Series = ReturnType<typeof frogSeries>;

/** RMS differences against the original's series (heading after its mean offset), the filmed frame k matched to the
 *  original by source time. */
function vsOriginal(s: Series, orig: Series, sourceTime: (t: number) => number) {
  const pairs: [NonNullable<Series[number]>, NonNullable<Series[number]>][] = [];
  s.forEach((x, k) => {
    const o = orig[Math.round(sourceTime(k / 30) * 30)];
    if (x && o) pairs.push([x, o]);
  });
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  // Headings are unwrapped differently along each series: compare them on the circle, after the mean offset.
  const my = Math.atan2(pairs.reduce((a, [x, o]) => a + Math.sin(x.yaw - o.yaw), 0), pairs.reduce((a, [x, o]) => a + Math.cos(x.yaw - o.yaw), 0));
  const rms = (f: (x: NonNullable<Series[number]>, o: NonNullable<Series[number]>) => number) => Math.sqrt(pairs.reduce((a, [x, o]) => a + f(x, o) ** 2, 0) / pairs.length);
  return {
    shiftCm: rms((x, o) => x.shift - o.shift) * 100,
    liftCm: rms((x, o) => x.lift - o.lift) * 100,
    yawDeg: (rms((x, o) => wrap(x.yaw - o.yaw - my)) * 180) / Math.PI,
  };
}

/** Play the filmed clip and note, per presented frame, its time and how much it changed (is it frozen?). */
async function probe(file: File) {
  const v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(file);
  await new Promise((r) => (v.onloadeddata = r));
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 24;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  let prev: Uint8ClampedArray | null = null;
  const out: number[][] = [];
  await new Promise<void>((resolve) => {
    const f = (_: number, m: VideoFrameCallbackMetadata) => {
      g.drawImage(v, 0, 0, 32, 24);
      const d = g.getImageData(0, 0, 32, 24).data;
      let s = 0;
      if (prev) for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i] - prev[i]);
      prev = d;
      out.push([+m.mediaTime.toFixed(3), +(s / 768).toFixed(1)]);
      if (v.ended) resolve();
      else v.requestVideoFrameCallback(f);
    };
    v.requestVideoFrameCallback(f);
    v.onended = () => resolve();
    void v.play();
  });
  results.probe = out;
}

/** Thumbnails of the filmed clip, to check what was recorded. */
async function filmstrip(file: File) {
  const v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(file);
  await new Promise((r) => (v.onloadeddata = r));
  const row = document.createElement("div");
  $("#out").append(row);
  for (const t of [0.3, 1.3, 2.3, 3.3, 4.3, 5.3, 6.3, 7.3]) {
    v.currentTime = t;
    await new Promise((r) => (v.onseeked = r));
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 120;
    c.getContext("2d")!.drawImage(v, 0, 0, 160, 120);
    c.title = String(t);
    row.append(c);
  }
}

function plot(title: string, lines: { label: string; color: string; ys: (number | null)[] }[], marks: number[] = []) {
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const c = document.createElement("canvas");
  c.className = "plot";
  $("#out").append(h3, c);
  const W = (c.width = c.clientWidth * 2), H = (c.height = 340);
  const g = c.getContext("2d")!;
  const all = lines.flatMap((l) => l.ys.filter((y): y is number => y !== null && Number.isFinite(y)));
  const lo = Math.min(...all), hi = Math.max(...all), n = Math.max(...lines.map((l) => l.ys.length));
  const X = (k: number) => 40 + ((W - 50) * k) / Math.max(1, n - 1), Y = (y: number) => H - 20 - ((H - 40) * (y - lo)) / Math.max(1e-9, hi - lo);
  g.font = "20px system-ui";
  g.fillStyle = "#8a90a0";
  g.fillText(hi.toFixed(2), 2, 22);
  g.fillText(lo.toFixed(2), 2, H - 22);
  g.strokeStyle = "#ff6b6b55";
  for (const m of marks) g.beginPath(), g.moveTo(X(m), 0), g.lineTo(X(m), H), g.stroke();
  lines.forEach((l, i) => {
    g.strokeStyle = l.color;
    g.lineWidth = 2.5;
    g.beginPath();
    let pen = false;
    l.ys.forEach((y, k) => {
      if (y === null || !Number.isFinite(y)) return void (pen = false);
      if (pen) g.lineTo(X(k), Y(y));
      else g.moveTo(X(k), Y(y)), (pen = true);
    });
    g.stroke();
    g.fillStyle = l.color;
    g.fillText(l.label, 60 + i * 190, 24);
  });
}

function table(title: string, head: string[], rows: (string | number)[][]) {
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const t = document.createElement("table");
  t.innerHTML = `<tr>${head.map((x) => `<th>${x}</th>`).join("")}</tr>` + rows.map((r) => `<tr>${r.map((x) => `<td>${typeof x === "number" ? x.toFixed(2) : x}</td>`).join("")}</tr>`).join("");
  $("#out").append(h3, t);
}

async function main() {
  status("filming through a virtual camera…");
  const { file, sourceTime } = await film();
  if (params.get("strip") === "1") await filmstrip(file);
  if (params.get("probe") === "1") await probe(file);
  status("analysing the original (still camera)…");
  const original = await analyse(SRC, true);
  // One analysis of the filmed clip gives both: its frames without the camera handling, and with it.
  status("analysing the filmed clip…");
  videoAnalysis.keepRaw = true;
  const auto = await analyse(file, true);
  videoAnalysis.keepRaw = false;
  const raw: Track = { ...auto, frames: videoAnalysis.raw!, camera: undefined, cuts: undefined, cameraUndone: undefined };
  status("measuring…");
  // The full pass as the Lab job runs it, without the loop blend (it changes the end on purpose, which the comparison
  // with the original would count as an error).
  const full = coherence(auto, { ...DEFAULTS, loop: 0 });

  // The estimate against the virtual camera.
  const est = auto.camera ?? [];
  // Per shot of the virtual camera (A: wide, much background; B: tight, the dancer fills most of the picture).
  const err = { A: { s: 0, z: 0, n: 0 }, B: { s: 0, z: 0, n: 0 } };
  est.forEach((c, k) => {
    const m = sourceTime(k / 30), t = trueCamera(m), e = err[m < CUT ? "A" : "B"];
    e.s += (c.shift[0] - t.shift[0]) ** 2 + (c.shift[1] - t.shift[1]) ** 2;
    e.z += Math.log(c.scale / t.scale) ** 2;
    e.n++;
  });
  const pct = (x: number, n: number) => Math.sqrt(x / Math.max(1, n)) * 100;
  const camera = {
    frames: est.length, shiftRmsPctA: pct(err.A.s, err.A.n), zoomRmsPctA: pct(err.A.z, err.A.n), shiftRmsPctB: pct(err.B.s, err.B.n), zoomRmsPctB: pct(err.B.z, err.B.n),
    cuts: auto.cuts ?? [], trueCut: est.findIndex((_, k) => sourceTime(k / 30) >= CUT),
    original: { cuts: original.cuts ?? [], peakShiftPct: Math.max(0, ...(original.camera ?? []).map((c) => Math.hypot(...c.shift) * 100)) },
  };
  const so = frogSeries(original), sr = frogSeries(raw), sa = frogSeries(auto), sf = frogSeries(full.track);
  const same = (t: number) => t;
  const frogs = { originalSelf: vsOriginal(so, so, same), raw: vsOriginal(sr, so, sourceTime), auto: vsOriginal(sa, so, sourceTime), full: vsOriginal(sf, so, sourceTime) };
  const { before, after } = compare(raw, full);
  Object.assign(results, { camera, frogs, metrics: { before, after }, report: full.report });

  table("camera estimate vs the virtual camera", ["", "value"], [
    ["frames", camera.frames], ["shot A (wide): shift RMS % of picture, zoom RMS %", `${camera.shiftRmsPctA.toFixed(2)}, ${camera.zoomRmsPctA.toFixed(2)}`],
    ["shot B (tight): shift RMS % of picture, zoom RMS %", `${camera.shiftRmsPctB.toFixed(2)}, ${camera.zoomRmsPctB.toFixed(2)}`],
    ["cuts found / true", `${JSON.stringify(camera.cuts)} / ${camera.trueCut}`],
    ["original (still): cuts, peak shift %", `${JSON.stringify(camera.original.cuts)}, ${camera.original.peakShiftPct.toFixed(2)}`],
  ]);
  table("the frog vs the still-camera original (RMS)", ["", "side step cm", "hop cm", "heading °"],
    Object.entries(frogs).map(([k, v]) => [k, v.shiftCm, v.liftCm, v.yawDeg]));
  table("landmarks: filmed without camera handling → full coherence", ["", "before", "after"],
    (Object.keys(after) as (keyof typeof after)[]).map((k) => [k, before[k] ?? 0, after[k] ?? 0]));
  plot("camera shift x: estimate (yellow) vs true (blue)", [
    { label: "estimate", color: "#ffd34d", ys: est.map((c) => c.shift[0]) },
    { label: "true", color: "#5aa9ff", ys: est.map((_, k) => trueCamera(sourceTime(k / 30)).shift[0]) },
  ], camera.cuts);
  plot("camera zoom: estimate vs true", [
    { label: "estimate", color: "#ffd34d", ys: est.map((c) => c.scale) },
    { label: "true", color: "#5aa9ff", ys: est.map((_, k) => trueCamera(sourceTime(k / 30)).scale) },
  ], camera.cuts);
  const orig = (s: Series, k: number) => s[Math.round(sourceTime(k / 30) * 30)];
  plot("frog side step (m): original (blue), filmed raw (red), auto (yellow), full (green)", [
    { label: "original", color: "#5aa9ff", ys: sr.map((_, k) => orig(so, k)?.shift ?? null) },
    { label: "raw", color: "#ff6b6b", ys: sr.map((x) => x?.shift ?? null) },
    { label: "auto", color: "#ffd34d", ys: sa.map((x) => x?.shift ?? null) },
    { label: "full", color: "#6be38a", ys: sf.map((x) => x?.shift ?? null) },
  ], camera.cuts);
  plot("frog hop (m)", [
    { label: "original", color: "#5aa9ff", ys: sr.map((_, k) => orig(so, k)?.lift ?? null) },
    { label: "raw", color: "#ff6b6b", ys: sr.map((x) => x?.lift ?? null) },
    { label: "auto", color: "#ffd34d", ys: sa.map((x) => x?.lift ?? null) },
    { label: "full", color: "#6be38a", ys: sf.map((x) => x?.lift ?? null) },
  ], camera.cuts);
  status("done");
  results.done = true;
}

async function only(url: string) {
  status(`analysing ${url}…`);
  videoAnalysis.keepRaw = true;
  results.track = await analyse(url, params.get("camera") !== "0");
  videoAnalysis.keepRaw = false;
  results.raw = { ...(results.track as Track), frames: videoAnalysis.raw, camera: undefined, cuts: undefined, cameraUndone: undefined };
  status("done");
  results.done = true;
}

async function save() {
  status("filming through a virtual camera…");
  const { file } = await film();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  results.filmed = btoa(s);
  status("done");
  results.done = true;
}

(params.get("only") ? only(params.get("only")!) : params.get("save") ? save() : main()).catch((e) => {
  console.error(e);
  status(`failed: ${e instanceof Error ? e.message : String(e)}`);
  results.error = String(e);
});
