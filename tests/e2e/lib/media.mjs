// Test media and recordings: the dance clip as Chrome's fake webcam, ffprobe/ffmpeg checks of a recorded file.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Chrome's fake camera reads y4m; convert the committed mp4 once (redone when the mp4 is newer). */
export function ensureY4m(mp4, y4m) {
  if (existsSync(y4m) && statSync(y4m).mtimeMs >= statSync(mp4).mtimeMs) return y4m;
  mkdirSync(dirname(y4m), { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", mp4, "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe", y4m]);
  return y4m;
}

/** Decode every video frame of a recording: is it a playable file, how long, how big, with sound? */
export function probeRecording(file) {
  const info = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=format_name,duration", "-of", "json", file]).toString(),
  );
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  // MediaRecorder WebM carries no duration: take it from the decoded frames' timestamps instead.
  const dec = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time,best_effort_timestamp_time", "-of", "csv=p=0", file]);
  const times = dec.stdout.toString().trim().split("\n").map((l) => parseFloat(l.split(",").find((x) => x && x !== "N/A"))).filter((t) => Number.isFinite(t));
  const errors = dec.stderr.toString().trim();
  return {
    format: info.format?.format_name,
    codec: video?.codec_name,
    width: video?.width,
    height: video?.height,
    audio: audio?.codec_name ?? null,
    frames: times.length,
    duration: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    errors: errors ? errors.split("\n").slice(0, 5) : [],
  };
}

/** One frame of a video as PNG. */
export function extractFrame(file, seconds, png) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", png]);
  return png;
}

/** Mean loudness of a file's sound in dB (null when it has none). */
export function audioLevel(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  return m ? (m[1] === "-inf" ? -Infinity : parseFloat(m[1])) : null;
}

/** Frames of a clip at these seconds, as PNG files. */
export function clipFrames(file, seconds, dir, stem) {
  return seconds.map((s, i) => extractFrame(file, s, `${dir}/${stem}-${i}.png`));
}
