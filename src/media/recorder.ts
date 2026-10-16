/** Recording the canvas and the sound effects into one video file with MediaRecorder. */
import type { Recorder, Recording } from "../contracts";

export interface RecorderOptions {
  /** Longest clip (ms); the recorder stops itself there and calls onAutoStop. Default 30 s. */
  maxMs?: number;
  /** Capture frame rate. Default 30. */
  fps?: number;
  /** Called with the clip when the length cap stopped the recording (stop() then resolves with the same clip). */
  onAutoStop?: (rec: Recording) => void;
}

/** MP4 (H.264, AAC where the browser can encode it) plays and shares best on phones and in WeChat; WebM otherwise. */
const VIDEO_TYPES_WITH_AUDIO = [
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4;codecs=avc1,opus",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const VIDEO_TYPES_SILENT = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    "captureStream" in HTMLCanvasElement.prototype
  );
}

export function pickMimeType(withAudio: boolean): string {
  const list = withAudio ? VIDEO_TYPES_WITH_AUDIO : VIDEO_TYPES_SILENT;
  return list.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function createRecorder(opts: RecorderOptions = {}): Recorder {
  const maxMs = opts.maxMs ?? 30_000;
  const fps = opts.fps ?? 30;
  let rec: MediaRecorder | null = null;
  let stopping: Promise<Recording> | null = null;
  let stopRec: (() => Promise<Recording>) | null = null;
  let last: Recording | null = null;

  return {
    get active() {
      return rec !== null && stopping === null;
    },
    start(canvas, audio) {
      if (rec) throw new Error("recorder already running");
      const stream = canvas.captureStream(fps);
      const audioTracks = audio?.getAudioTracks() ?? [];
      for (const t of audioTracks) stream.addTrack(t);
      const mimeType = pickMimeType(audioTracks.length > 0);
      const mr = new MediaRecorder(stream, {
        mimeType,
        // About 0.08 bit per pixel per frame: crisp toon shading without phone-choking files.
        videoBitsPerSecond: Math.round(Math.min(8e6, Math.max(1.5e6, canvas.width * canvas.height * fps * 0.08))),
        audioBitsPerSecond: 128_000,
      });
      const chunks: Blob[] = [];
      const startedAt = performance.now();
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const finished = new Promise<Recording>((resolve, reject) => {
        mr.onstop = () => {
          // Only the canvas track is ours; the audio tracks belong to the sfx stream and keep running.
          for (const t of stream.getVideoTracks()) t.stop();
          clearTimeout(cap);
          const type = mr.mimeType || mimeType || "video/webm";
          const blob = new Blob(chunks, { type });
          if (last) URL.revokeObjectURL(last.url);
          last = {
            blob,
            mimeType: type,
            durationMs: performance.now() - startedAt,
            url: URL.createObjectURL(blob),
            fileName: fileName(new Date(), type),
          };
          rec = null;
          stopping = null;
          stopRec = null;
          resolve(last);
        };
        mr.onerror = (e) => reject((e as ErrorEvent).error ?? new Error("recording failed"));
      });
      const stopNow = () => {
        if (!stopping) {
          stopping = finished;
          mr.stop();
        }
        return finished;
      };
      const cap = setTimeout(() => void stopNow().then((r) => opts.onAutoStop?.(r)), maxMs);
      rec = mr;
      stopRec = stopNow;
      mr.start(1000);
    },
    stop() {
      if (stopRec) return stopRec();
      if (last) return Promise.resolve(last);
      return Promise.reject(new Error("recorder not started"));
    },
  };
}

/** naiwa-20261016-153000.mp4, local time. */
export function fileName(d: Date, mimeType: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `naiwa-${stamp}.${mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`;
}
