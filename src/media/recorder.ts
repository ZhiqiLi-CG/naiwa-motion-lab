/** Recording the composited frame (stage, companion video, watermark) and the mix into one video file. */
import type { Recorder, Recording } from "../contracts";
import { createCompositor } from "./compose";
import { hasEnoughVideo, mp4Samples, type Mp4Samples } from "./mp4";

export interface RecorderOptions {
  /** Longest clip (ms); the recorder stops itself there and calls onAutoStop. Default 30 s. */
  maxMs?: number;
  /** Capture frame rate. Default 30. */
  fps?: number;
  /** Long side of the recorded frame (px). Default 1280: H.264 level 3.1, which every phone plays. */
  maxSide?: number;
  /** Called with the clip when the length cap stopped the recording (stop() then resolves with the same clip). */
  onAutoStop?: (rec: Recording) => void;
  /** The browser's recorder failed (the encoder gave up): the recorder is idle again and stop() rejects. */
  onError?: (err: Error) => void;
}

/**
 * MP4 (H.264, AAC where the browser can encode it) plays and shares best on phones and in WeChat; WebM (VP9/VP8)
 * otherwise, and on a device where the MP4 types recorded without a picture (some hardware H.264 encoders stall).
 */
const VIDEO_TYPES_WITH_AUDIO = [
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const VIDEO_TYPES_SILENT = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

/** Recorded alongside an MP4 until its first seconds show frames: VP8 first, the cheapest to encode. */
const BACKUP_WITH_AUDIO = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
const BACKUP_SILENT = ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];

/** The MP4's frames are judged once its file holds this much audio (about 2.4 s), and on at least two readings
 *  of it a second apart (about 0.8 s of audio between them); the backup goes when they pass. */
const CHECK_AFTER_AUDIO_FRAMES = 120;
const CHECK_STEP_AUDIO_FRAMES = 40;
/** stop() records on for at most this long while the clip is short of what was asked for (the encoders started late). */
const MAX_WAIT_FOR_PICTURE_MS = 8000;
/** Shortest clip (ms). */
const MIN_CLIP_MS = 500;
/** Slack between the clip asked for (start() to stop()) and the one encoded: the first composed frame and the
 *  encoder's ordinary start. */
const START_SLACK_MS = 1000;

export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    "captureStream" in HTMLCanvasElement.prototype
  );
}

/** The first supported type, skipping those that recorded without a picture on this device. */
export function pickMimeType(withAudio: boolean, bad: ReadonlySet<string> = badTypes()): string {
  return firstSupported(withAudio ? VIDEO_TYPES_WITH_AUDIO : VIDEO_TYPES_SILENT, bad);
}

function firstSupported(list: string[], bad: ReadonlySet<string>): string {
  return list.find((t) => !bad.has(t) && MediaRecorder.isTypeSupported(t)) ?? "";
}

interface Encoder {
  mr: MediaRecorder;
  /** The type asked for (the key in the bad-type list); the blob carries mr.mimeType, which may add detail. */
  type: string;
  chunks: Blob[];
  /** Settles when the recorder has stopped (rejects on an encoder error). */
  stopped: Promise<void>;
}

export function createRecorder(opts: RecorderOptions = {}): Recorder {
  const maxMs = opts.maxMs ?? 30_000;
  const fps = opts.fps ?? 30;
  const maxSide = opts.maxSide ?? 1280;
  let running = false;
  let stopping: Promise<Recording> | null = null;
  let stopRec: (() => Promise<Recording>) | null = null;
  let last: Recording | null = null;
  if (canRecord()) scheduleWarmUp(() => running);

  return {
    get active() {
      return running && stopping === null;
    },
    start(stage, audio, recOpts) {
      if (running) throw new Error("recorder already running");
      const requestedAt = performance.now();
      const comp = createCompositor(stage, {
        companion: recOpts?.companion ?? null,
        layout: recOpts?.layout ?? "frog",
        fps,
        maxSide,
        // The clip opens on the first composed frame, not on an empty one.
        onFirstFrame: () => begin(),
      });
      const { canvas } = comp;
      const stream = canvas.captureStream(fps);
      const audioTracks = audio?.getAudioTracks() ?? [];
      for (const t of audioTracks) stream.addTrack(t);
      const withAudio = audioTracks.length > 0;
      const bad = badTypes();
      const options: MediaRecorderOptions = {
        // About 0.08 bit per pixel per frame: crisp toon shading without phone-choking files.
        videoBitsPerSecond: Math.round(Math.min(8e6, Math.max(1.5e6, canvas.width * canvas.height * fps * 0.08))),
        audioBitsPerSecond: 128_000,
      };

      let failed: (err: Error) => void = () => undefined;
      const failure = new Promise<never>((_, reject) => (failed = reject));
      failure.catch(() => undefined);

      const open = (type: string): Encoder => {
        const mr = new MediaRecorder(stream, { ...options, mimeType: type });
        const enc: Encoder = { mr, type, chunks: [], stopped: Promise.resolve() };
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) enc.chunks.push(e.data);
        };
        enc.stopped = new Promise<void>((resolve, reject) => {
          mr.onstop = () => resolve();
          mr.onerror = (e) => {
            const err = (e as ErrorEvent).error ?? new Error("recording failed");
            reject(err);
            onEncoderError(enc, err);
          };
        });
        enc.stopped.catch(() => undefined);
        return enc;
      };
      const isMp4 = (enc: Encoder) => (enc.mr.mimeType || enc.type).startsWith("video/mp4");

      let main = open(pickMimeType(withAudio, bad));
      // Until the MP4 shows frames a WebM records alongside, so a stalled H.264 encoder never leaves a clip without
      // a picture.
      const backupType = isMp4(main) ? firstSupported(withAudio ? BACKUP_WITH_AUDIO : BACKUP_SILENT, bad) : "";
      let backup: Encoder | null = backupType ? open(backupType) : null;
      let checked = false;
      // Frames stop while the tab is hidden (the compositor draws in animation frames): no verdict on the encoder then.
      let sawHidden = document.visibilityState === "hidden";
      const onVisibility = () => {
        if (document.visibilityState === "hidden") sawHidden = true;
      };
      document.addEventListener("visibilitychange", onVisibility);

      // The clip starts when the encoder does (its start event), which can be seconds after start() while the H.264
      // encoder loads; frames before that are not in the file.
      let startedAt = performance.now();
      let encoding = false;
      main.mr.addEventListener(
        "start",
        () => {
          startedAt = performance.now();
          encoding = true;
        },
        { once: true },
      );
      const begin = () => {
        if (main.mr.state !== "inactive") return;
        startedAt = performance.now();
        main.mr.start(1000);
        backup?.mr.start(1000);
      };
      const drop = (enc: Encoder) => {
        enc.mr.ondataavailable = null;
        enc.mr.onerror = null;
        if (enc.mr.state !== "inactive") enc.mr.stop();
      };
      /** The MP4 has no picture: the WebM, recording since the same first frame, becomes the clip. */
      const promoteBackup = (blame = true) => {
        if (!backup) return;
        if (blame && !sawHidden) markBad(main.type);
        drop(main);
        main = backup;
        backup = null;
      };
      function onEncoderError(enc: Encoder, err: Error) {
        if (enc === backup) {
          backup = null;
        } else if (enc === main && backup) {
          promoteBackup();
        } else if (enc === main) {
          idle();
          failed(err);
          opts.onError?.(err);
        }
      }

      // The verdict a few seconds in, on the fragments so far, measured against the audio in them (the muxer may hold
      // data back, the encoder may start late). A slow start passes on the frames since the previous reading, a stall
      // fails both ways. Without audio there is no such measure: the backup then records the whole clip and stop()
      // decides.
      let reading = false;
      let prev: Mp4Samples = { video: 0, audio: 0 };
      main.mr.addEventListener("dataavailable", () => {
        if (checked || reading || !backup || !withAudio || stopping) return;
        reading = true;
        const mp4 = main;
        void new Blob(mp4.chunks).arrayBuffer().then((buf) => {
          reading = false;
          // A stop() since then decides on the whole file.
          if (stopping || main !== mp4) return;
          const counts = mp4Samples(new Uint8Array(buf));
          const step = { video: counts.video - prev.video, audio: counts.audio - prev.audio };
          const ready = counts.audio >= CHECK_AFTER_AUDIO_FRAMES && prev.audio > 0 && step.audio >= CHECK_STEP_AUDIO_FRAMES;
          if (!ready) {
            if (prev.audio === 0 || step.audio >= CHECK_STEP_AUDIO_FRAMES) prev = counts;
            return;
          }
          checked = true;
          if (!hasEnoughVideo(counts, 0, fps) && !hasEnoughVideo(step, 0, fps)) promoteBackup();
          else if (backup) {
            drop(backup);
            backup = null;
          }
        });
      });

      const idle = () => {
        // Only the frame track is ours; the audio tracks belong to the sfx stream and keep running.
        for (const t of stream.getVideoTracks()) t.stop();
        comp.stop();
        clearTimeout(cap);
        document.removeEventListener("visibilitychange", onVisibility);
        running = false;
        stopping = null;
        stopRec = null;
      };

      const finish = async (): Promise<Recording> => {
        // Stopped before the first frame: start, so that stop() still delivers a (tiny) clip.
        begin();
        // A clip stopped before the encoders got going has no picture in either file: record on until the encoder has
        // started, the clip holds about what was asked for, and the WebM (which writes nothing before its first frame)
        // has data; a few seconds at most. The MP4 is not to blame for a slow start.
        const asked = Math.max(MIN_CLIP_MS, performance.now() - requestedAt - START_SLACK_MS);
        let slowStart = false;
        for (const until = performance.now() + MAX_WAIT_FOR_PICTURE_MS; running && performance.now() < until; slowStart = true) {
          const webm = backup ?? (isMp4(main) ? null : main);
          if (encoding && performance.now() - startedAt >= asked && (!webm || bytes(webm) >= 1024)) break;
          webm?.mr.requestData();
          await new Promise((r) => setTimeout(r, 250));
        }
        const encs = backup ? [main, backup] : [main];
        for (const e of encs) if (e.mr.state !== "inactive") e.mr.stop();
        await Promise.race([Promise.allSettled(encs.map((e) => e.stopped)), failure]);
        const durationMs = performance.now() - startedAt;
        // No verdict yet (stopped early, or no audio to measure by): count the whole file's frames now.
        if (isMp4(main) && !checked) {
          const good = hasEnoughVideo(mp4Samples(new Uint8Array(await blobOf(main).arrayBuffer())), durationMs, fps);
          // A backup stopped before its encoder delivered a frame holds no clip either.
          const fallback = backup && (await backup.stopped.then(() => true, () => false)) && bytes(backup) >= 1024;
          if (!good && fallback) promoteBackup(!slowStart);
          // Nothing else to offer for this clip; the next one starts with the next type.
          else if (!good && !sawHidden && !slowStart) markBad(main.type);
        }
        idle();
        const blob = blobOf(main);
        if (last) URL.revokeObjectURL(last.url);
        last = {
          blob,
          mimeType: blob.type,
          durationMs,
          url: URL.createObjectURL(blob),
          fileName: fileName(new Date(), blob.type),
        };
        return last;
      };
      const stopNow = () => {
        stopping ??= finish();
        return stopping;
      };
      const cap = setTimeout(
        () =>
          void stopNow().then(
            (r) => opts.onAutoStop?.(r),
            () => undefined,
          ),
        maxMs,
      );
      running = true;
      stopRec = stopNow;
    },
    stop() {
      if (stopRec) return stopRec();
      if (last) return Promise.resolve(last);
      return Promise.reject(new Error("recorder not started"));
    },
  };
}

/**
 * The first MP4 recording of a page can take seconds to start while the browser loads its H.264 encoder (4.6 s
 * measured on Windows with an AMD GPU, for any frame size), and a clip stopped before then holds sound only. A tiny
 * silent recording right after the page loads gets that done before anyone presses record.
 */
function scheduleWarmUp(recording: () => boolean) {
  const type = pickMimeType(true);
  if (!type.startsWith("video/mp4")) return;
  const run = () => {
    if (recording()) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const g = canvas.getContext("2d");
    if (!g) return;
    const stream = canvas.captureStream(30);
    let k = 0;
    // a changing picture, so frames keep coming
    const draw = setInterval(() => {
      g.fillStyle = k++ % 2 ? "#fff3d1" : "#2a2418";
      g.fillRect(0, 0, 64, 64);
    }, 33);
    let mr: MediaRecorder;
    const end = () => {
      clearInterval(draw);
      clearTimeout(cap);
      for (const t of stream.getTracks()) t.stop();
      if (mr?.state !== "inactive") mr?.stop();
    };
    const cap = setTimeout(end, 15_000);
    try {
      mr = new MediaRecorder(stream, { mimeType: type });
      // Started means the encoder is loaded; the first data means it encodes.
      mr.ondataavailable = end;
      mr.onerror = end;
      mr.onstart = () => setTimeout(() => mr.state === "recording" && mr.requestData(), 300);
      mr.start();
    } catch {
      end();
    }
  };
  // At once, not at idle time: the page is rarely idle while the frog moves, and the loading happens off the main
  // thread.
  setTimeout(run, 0);
}

function bytes(enc: Encoder): number {
  return enc.chunks.reduce((n, c) => n + c.size, 0);
}

function blobOf(enc: Encoder): Blob {
  return new Blob(enc.chunks, { type: enc.mr.mimeType || enc.type || "video/webm" });
}

/* ---------------- types that recorded without a picture on this device ---------------- */

const BAD_KEY = "naiwa.recorder.badTypes";
/** Forgotten after a week: drivers and browsers get updated, and MP4 shares best. */
const BAD_TTL_MS = 7 * 24 * 3600 * 1000;

function badTypes(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(BAD_KEY) ?? "null") as { types?: unknown; at?: unknown } | null;
    if (!saved || typeof saved.at !== "number" || !Array.isArray(saved.types)) return new Set();
    if (Date.now() - saved.at > BAD_TTL_MS) return new Set();
    return new Set(saved.types.filter((t): t is string => typeof t === "string"));
  } catch {
    return new Set();
  }
}

function markBad(type: string) {
  const types = badTypes().add(type);
  try {
    localStorage.setItem(BAD_KEY, JSON.stringify({ types: [...types], at: Date.now() }));
  } catch {
    // Storage blocked: the next clip tries the same type again (and its backup still covers it).
  }
}

/** naiwa-20261016-153000.mp4, local time. */
export function fileName(d: Date, mimeType: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `naiwa-${stamp}.${mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`;
}
