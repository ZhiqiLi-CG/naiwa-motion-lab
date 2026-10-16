// Add (or rebuild) a real-video dance: node tools/dances/add.mjs <id> [--fresh]
// Reads tools/dances/dances.json, downloads the source into .cache/dances/src/, cuts the window into frames, runs the
// app's PoseLandmarker on every frame, cleans the track, picks a seamless loop, writes public/dances/<id>.json and
// public/dances/index.json, and renders check videos under .cache/dances/<id>/ (skeleton over the frames).
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openSession } from "./browser.mjs";
import { buildTrack } from "./track.mjs";
import { renderChecks } from "./checks.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const CACHE = path.join(ROOT, ".cache/dances");
const YTDLP = path.join(ROOT, ".cache/tools/ytdlp/yt-dlp");
const MODEL = path.join(CACHE, "models/pose_landmarker_heavy.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task";
const MODES = ["forward", "backward", "image"];
const GPU_RUN = "/home/zhiqili/robotgen-studio/tools/gpu_run.sh";
const HY_PYTHON = path.join(ROOT, ".cache/envs/hymotion/bin/python");
const HY_CODE = path.join(CACHE, "hymotion/code");

const [id, ...flags] = process.argv.slice(2);
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/dances/dances.json"), "utf8"));
const dance = catalog.find((d) => d.id === id);
if (!dance) {
  console.error(`usage: node tools/dances/add.mjs <id> [--fresh]; ids: ${catalog.map((d) => d.id).join(", ")}`);
  process.exit(1);
}
const fresh = flags.includes("--fresh");
const dir = path.join(CACHE, id);
fs.mkdirSync(path.join(CACHE, "src"), { recursive: true });
fs.mkdirSync(dir, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const step = (msg) => console.log(`[${id}] ${msg}`);

let session = null;
const raw = {};
const video = dance.generate ? null : await fromVideo();
const gen = dance.generate ? fromGenerator() : null;
const { fps, t0, first, framesDir, width, height } = video ?? gen;

/** A real video: download, cut the window into frames, run the pose model (cached per step). */
async function fromVideo() {
  // 1. Source video (kept in the cache only, never committed or shipped).
  const srcFile = path.join(CACHE, "src", `${dance.video}.mp4`);
  if (!fs.existsSync(srcFile)) {
    step(`downloading ${dance.url}`);
    run("python3", [YTDLP, "-q", "-f", "bv*[height<=1080][vcodec^=avc1]/bv*[height<=1080]", "--remux-video", "mp4",
      "-o", srcFile, dance.url]);
  }
  if (!fs.existsSync(MODEL)) {
    step("downloading the heavy pose model");
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    run("curl", ["-sSL", "-o", MODEL, MODEL_URL]);
  }
  const probe = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=r_frame_rate,start_time", "-of", "json", srcFile])).streams[0];
  const [fn, fd] = probe.r_frame_rate.split("/").map(Number);
  const fps = fn / fd;
  const t0 = Number(probe.start_time) || 0;

  // 2. The window as frames at the source rate (no resampling), optionally cropped to the dancer.
  const first = Math.round((dance.window[0] - t0) * fps);
  const count = Math.round((dance.window[1] - t0) * fps) - first;
  const framesDir = path.join(dir, "frames");
  const frameKey = JSON.stringify({ video: dance.video, first, count, crop: dance.crop ?? null });
  const keyFile = path.join(framesDir, "key.json");
  if (fresh || !fs.existsSync(keyFile) || fs.readFileSync(keyFile, "utf8") !== frameKey) {
    step(`frames ${first}..${first + count - 1} at ${fps} fps`);
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    run("ffmpeg", ["-v", "error", "-ss", String(t0 + (first - 0.5) / fps), "-i", srcFile, "-frames:v", String(count),
      ...(dance.crop ? ["-vf", `crop=${dance.crop}`] : []), "-q:v", "1", path.join(framesDir, "%05d.jpg")]);
    for (const f of fs.readdirSync(dir)) if (f.startsWith("raw-")) fs.rmSync(path.join(dir, f));
    fs.writeFileSync(keyFile, frameKey);
  }
  // One shot only: a cut inside the window would make the pose jump.
  const cuts = spawnSync("ffmpeg", ["-hide_banner", "-i", path.join(framesDir, "%05d.jpg"), "-vf",
    "select='gt(scene,0.35)',showinfo", "-f", "null", "-"]).stderr.toString();
  if (/pts_time/.test(cuts)) step("WARNING: a scene cut inside the window; check the contact sheet");
  const [width, height] = run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
    path.join(framesDir, "00001.jpg")]).trim().split(",").map(Number);

  // 3. Pose per frame with the app's PoseLandmarker (heavy model): VIDEO mode forward and backward in time, and IMAGE
  //    mode (every frame on its own); three independent runs let the cleaning outvote the one that went wrong.
  for (const mode of MODES) {
    const f = path.join(dir, `raw-${mode}.json`);
    if (!fs.existsSync(f)) {
      session ??= await openSession({ framesDir, model: MODEL });
      step(`pose (${mode}) on ${count} frames`);
      const t = Date.now();
      fs.writeFileSync(f, JSON.stringify(await session.extract({ count, fps, mode })));
      step(`  ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    raw[mode] = JSON.parse(fs.readFileSync(f, "utf8"));
  }
  return { fps, t0, first, framesDir, width, height, srcFile };
}

/** A motion generated from a text prompt by HY-Motion 1.0 (tools/dances/hy_motion.py), already in landmark form; the
 *  check renders draw it over plain frames. */
function fromGenerator() {
  const g = dance.generate;
  const f = path.join(dir, "raw-generated.json");
  const key = JSON.stringify(g);
  const keyFile = path.join(dir, "generate.json");
  if (fresh || !fs.existsSync(f) || !fs.existsSync(keyFile) || fs.readFileSync(keyFile, "utf8") !== key) {
    step(`generating with HY-Motion: "${g.prompt}" (${g.seconds} s, seed ${g.seed})`);
    // The motion model and its 8-bit text encoder take about 15 GB of the shared card.
    execFileSync(GPU_RUN, ["--need", "16000", HY_PYTHON, path.join(ROOT, "tools/dances/hy_motion.py"), "--code", HY_CODE,
      "--prompt", g.prompt, "--seconds", String(g.seconds), "--seed", String(g.seed), "--llm-8bit", "--out", f],
      { stdio: ["ignore", "inherit", "inherit"] });
    fs.writeFileSync(keyFile, key);
  }
  const gen = JSON.parse(fs.readFileSync(f, "utf8"));
  raw.generated = gen.frames;
  const [width, height] = [1280, Math.round(1280 / gen.aspect)];
  const framesDir = path.join(dir, "frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=0x2a2e36:s=${width}x${height}`, "-frames:v",
    String(gen.frames.length), "-q:v", "2", path.join(framesDir, "%05d.jpg")]);
  return { fps: gen.fps, t0: 0, first: 0, framesDir, width, height, srcFile: null };
}

// 4. Clean, loop, write.
// "loop": [min, max] seconds to search for the best loop, or "loopAt": [start, end] seconds in the video to use as is.
const loopAt = dance.loopAt?.map((t) => Math.round((t - t0) * fps) - first);
const track = buildTrack({ raw, fps, aspect: width / height, loop: dance.loop, loopAt, log: step });
const src = dance.generate
  ? { title: `HY-Motion 1.0 生成：${dance.generate.prompt}`, url: "https://github.com/Tencent-Hunyuan/HY-Motion-1.0" }
  : { title: dance.title, url: dance.url };
const startSec = (first + track.loopStart) / fps + t0;
const out = {
  id,
  name: dance.name,
  nameEn: dance.nameEn,
  fps,
  duration: +(track.frames.length / fps).toFixed(3),
  aspect: +(width / height).toFixed(4),
  source: { ...src, start: +startSec.toFixed(2), end: +(startSec + track.frames.length / fps).toFixed(2) },
  frames: track.frames,
};
validate(out);
const pub = path.join(ROOT, "public/dances");
fs.mkdirSync(pub, { recursive: true });
fs.writeFileSync(path.join(pub, `${id}.json`), JSON.stringify(out));
const indexFile = path.join(pub, "index.json");
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [];
const entry = { id, name: dance.name, nameEn: dance.nameEn, duration: out.duration, file: `dances/${id}.json` };
const order = catalog.map((d) => d.id);
const merged = [...index.filter((e) => e.id !== id), entry].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
fs.writeFileSync(indexFile, JSON.stringify(merged, null, 2) + "\n");
step(`wrote public/dances/${id}.json: ${track.frames.length} frames, ${out.duration} s, ` +
  `${(fs.statSync(path.join(pub, `${id}.json`)).size / 1024).toFixed(0)} KB; source ${out.source.start}-${out.source.end} s`);

/** The shape the motion module reads (DanceTrack in src/contracts.ts), and a seam no bigger than an ordinary step. */
function validate(t) {
  const ok = (cond, msg) => {
    if (!cond) throw new Error(`invalid track: ${msg}`);
  };
  ok(t.name && t.nameEn, "a Chinese and an English name");
  ok(t.frames.length >= 2 && Math.abs(t.duration * t.fps - t.frames.length) < 0.01, "duration and fps vs frames");
  for (const f of t.frames)
    for (const kind of ["world", "image"]) {
      ok(f[kind].length === 33, `${kind} has 33 landmarks`);
      for (const p of f[kind]) ok(p.length === 4 && p.every(Number.isFinite) && p[3] >= 0 && p[3] <= 1, `${kind} point`);
    }
  const dist = (f, g) => Math.hypot(...f.world.flatMap((p, j) => [0, 1, 2].map((c) => p[c] - g.world[j][c])));
  const steps = t.frames.map((f, i) => dist(f, t.frames[(i + 1) % t.frames.length]));
  const seam = steps.at(-1);
  const sorted = steps.slice(0, -1).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  step(`seam step ${seam.toFixed(3)} vs median step ${med.toFixed(3)}, max ${sorted.at(-1).toFixed(3)}`);
  ok(seam <= sorted.at(-1), "the seam jumps more than any frame inside the loop");
}

// 5. The cut as small test videos (webcam/upload tests) and the check renders.
if (video) {
  const loopArgs = ["-ss", String(t0 + (first + track.loopStart - 0.5) / fps), "-i", video.srcFile,
    "-frames:v", String(track.frames.length)];
  const small = [dance.crop ? `crop=${dance.crop}` : null, "scale='min(640,iw*360/ih)':-2"].filter(Boolean).join(",");
  run("ffmpeg", ["-v", "error", "-y", ...loopArgs, "-vf", small, "-an", "-c:v", "libx264", "-crf", "20", "-pix_fmt",
    "yuv420p", path.join(dir, `${id}-small.mp4`)]);
  run("ffmpeg", ["-v", "error", "-y", ...loopArgs, "-vf", small, "-an", "-pix_fmt", "yuv420p",
    path.join(dir, `${id}-small.y4m`)]);
}
session ??= await openSession({ framesDir, model: MODEL });
await renderChecks({ session, dir, id, fps, reference: raw.forward ?? raw.generated, track, log: step });
await session.close();
