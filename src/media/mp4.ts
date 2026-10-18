/**
 * Counting the frames in an MP4 the browser's MediaRecorder wrote: some hardware H.264 encoders (seen with AMD on
 * Windows) stall after a few frames while the audio carries on, and the file then plays as sound over a still or
 * black picture. The counts tell that apart from a real video.
 */

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf"]);

export interface Mp4Samples {
  /** Video frames (0 without a video track). */
  video: number;
  /** Audio frames (AAC 1024 samples ≈ 21 ms, Opus 20 ms; 0 without an audio track). */
  audio: number;
}

/**
 * Samples of the video and audio tracks in a whole or partial MP4, fragmented (moof/trun) or not (stsz). A box cut
 * off by the end of the buffer is skipped, so a recording still in progress can be counted.
 */
export function mp4Samples(buf: Uint8Array): Mp4Samples {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const kinds = new Map<number, "vide" | "soun">();
  const samples = new Map<number, number>();
  const add = (track: number, n: number) => samples.set(track, (samples.get(track) ?? 0) + n);

  // State carried while walking one trak / traf.
  let trackId = 0;
  let handler = "";
  let trakSamples = 0;

  const walk = (start: number, end: number) => {
    let o = start;
    while (o + 8 <= end) {
      let size = view.getUint32(o);
      const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      let head = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = Number(view.getBigUint64(o + 8));
        head = 16;
      } else if (size === 0) size = end - o;
      if (size < head || o + size > end) return;
      const p = o + head; // payload
      const fits = (n: number) => p + n <= o + size;
      if (type === "trak") {
        trackId = 0;
        handler = "";
        trakSamples = 0;
        walk(p, o + size);
        if (handler === "vide" || handler === "soun") {
          kinds.set(trackId, handler);
          add(trackId, trakSamples);
        }
      } else if (type === "traf") {
        trackId = 0;
        walk(p, o + size);
      } else if (CONTAINERS.has(type)) walk(p, o + size);
      else if (type === "tkhd" && fits(buf[p] === 1 ? 24 : 16)) trackId = view.getUint32(p + (buf[p] === 1 ? 20 : 12));
      else if (type === "hdlr" && fits(12)) handler = String.fromCharCode(...buf.subarray(p + 8, p + 12));
      else if (type === "stsz" && fits(12)) trakSamples = view.getUint32(p + 8);
      else if (type === "tfhd" && fits(8)) trackId = view.getUint32(p + 4);
      else if (type === "trun" && fits(8)) add(trackId, view.getUint32(p + 4));
      o += size;
    }
  };
  walk(0, buf.length);

  const out: Mp4Samples = { video: 0, audio: 0 };
  for (const [id, kind] of kinds) out[kind === "vide" ? "video" : "audio"] += samples.get(id) ?? 0;
  return out;
}

/** Audio frames last at least this long (Opus 20 ms, AAC 21.3 ms at 48 kHz): the audio's length from its count. */
const AUDIO_FRAME_S = 0.02;

/**
 * Enough video for the time the file covers: the audio's length when there is audio (the muxer may hold back
 * data, and the encoder may start late, so wall-clock time over-counts), else the clip's length. A stalled encoder
 * delivers a handful of frames over seconds, a working one close to the capture rate (less while the page is busy).
 */
export function hasEnoughVideo(s: Mp4Samples, durationMs: number, fps: number): boolean {
  const seconds = s.audio > 0 ? s.audio * AUDIO_FRAME_S : durationMs / 1000;
  return s.video >= Math.max(1, Math.floor(0.15 * fps * seconds));
}
