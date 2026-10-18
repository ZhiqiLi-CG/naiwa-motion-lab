// Test media and recordings: the dance clip as Chrome's fake webcam, ffprobe/ffmpeg checks of a recorded file.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";

/** ffmpeg / ffprobe: FFMPEG / FFPROBE in the environment, else on PATH, else (Windows) winget's links or its
 *  Gyan.FFmpeg package folder, which a shell opened before the install does not have on its PATH yet. */
function findTool(name) {
  const env = process.env[name.toUpperCase()];
  if (env) return env;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const local = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && local) {
    dirs.push(join(local, "Microsoft", "WinGet", "Links"));
    const pkgs = join(local, "Microsoft", "WinGet", "Packages");
    if (existsSync(pkgs)) {
      for (const p of readdirSync(pkgs).filter((d) => /^Gyan\.FFmpeg/i.test(d))) {
        for (const b of readdirSync(join(pkgs, p))) dirs.push(join(pkgs, p, b, "bin"));
      }
    }
  }
  const hit = dirs.map((d) => join(d, exe)).find((f) => existsSync(f));
  if (!hit) throw new Error(`${name} not found: install it (winget install Gyan.FFmpeg, apt install ffmpeg) or set ${name.toUpperCase()}=<path>`);
  return hit;
}
let tools = null;
/** Paths of the two tools, looked up once. */
export function ff() {
  return (tools ??= { ffmpeg: findTool("ffmpeg"), ffprobe: findTool("ffprobe") });
}

/** Chrome's fake camera reads y4m; convert the committed mp4 once (redone when the mp4 is newer). */
export function ensureY4m(mp4, y4m) {
  if (existsSync(y4m) && statSync(y4m).mtimeMs >= statSync(mp4).mtimeMs) return y4m;
  mkdirSync(dirname(y4m), { recursive: true });
  execFileSync(ff().ffmpeg, ["-loglevel", "error", "-y", "-i", mp4, "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe", y4m]);
  return y4m;
}

/** Decode every video frame of a recording: is it a playable file, how long, how big, with sound? */
export function probeRecording(file) {
  const head = spawnSync(ff().ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name,duration", "-of", "json", file]);
  if (head.status !== 0) return { frames: 0, duration: 0, audio: null, errors: [head.stderr.toString().trim().split(/\r?\n/).pop()] };
  const info = JSON.parse(head.stdout.toString());
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  // MediaRecorder WebM carries no duration: take it from the decoded frames' timestamps instead.
  const dec = spawnSync(ff().ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "csv=p=0", file]);
  const times = dec.stdout.toString().trim().split(/\r?\n/).map((l) => parseFloat(l.split(",").find((x) => x && x !== "N/A"))).filter((t) => Number.isFinite(t));
  const errors = dec.stderr.toString().trim();
  return {
    format: info.format?.format_name,
    codec: video?.codec_name,
    width: video?.width,
    height: video?.height,
    audio: audio?.codec_name ?? null,
    frames: times.length,
    duration: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    errors: errors ? errors.split(/\r?\n/).slice(0, 5) : [],
  };
}

/** One frame of a video as PNG. */
export function extractFrame(file, seconds, png) {
  execFileSync(ff().ffmpeg, ["-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", png]);
  return png;
}

/** Mean loudness of a file's sound in dB (null when it has none). */
export function audioLevel(file) {
  const r = spawnSync(ff().ffmpeg, ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  return m ? (m[1] === "-inf" ? -Infinity : parseFloat(m[1])) : null;
}

/** Frames of a clip at these seconds, as PNG files. */
export function clipFrames(file, seconds, dir, stem) {
  return seconds.map((s, i) => extractFrame(file, s, join(dir, `${stem}-${i}.png`)));
}
