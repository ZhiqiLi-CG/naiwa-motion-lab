/**
 * MediaPipe PoseLandmarker, self-hosted under public/mediapipe/ (nothing loads from Google), and the preview: the
 * camera or video with the tracked skeleton drawn over it.
 */
import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { LandmarkFrame } from "./api";

let landmarker: Promise<PoseLandmarker> | null = null;

/** The usage-logging endpoint @mediapipe/tasks-vision posts to (from every task, every minute, with no option to turn
 *  it off). Nothing may leave for Google. */
export const MEDIAPIPE_LOG_HOST = "odml.pa.googleapis.com";
let telemetryBlocked = false;

/**
 * Keep MediaPipe's usage logging on the device: the runtime sends it with the page's fetch, so fetch answers requests
 * to its host itself (204, no network). The logger takes a non-200 answer as a failure and stops for good.
 */
export function blockMediapipeTelemetry(): void {
  if (telemetryBlocked || typeof globalThis.fetch !== "function") return;
  telemetryBlocked = true;
  const fetch0 = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      if (new URL(url, location.href).hostname === MEDIAPIPE_LOG_HOST) return Promise.resolve(new Response(null, { status: 204 }));
    } catch {
      // not a URL we can read: let fetch handle it
    }
    return fetch0(input, init);
  };
}

/** The shared detector (loaded once; a failed load can be retried). Phones get the lite model. */
export function loadLandmarker(): Promise<PoseLandmarker> {
  blockMediapipeTelemetry();
  landmarker ??= (async () => {
    const base = new URL(`${import.meta.env.BASE_URL}mediapipe/`, document.baseURI).href;
    const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`);
    const phone = matchMedia("(pointer: coarse)").matches;
    const modelAssetPath = `${base}pose_landmarker_${phone ? "lite" : "full"}.task`;
    const make = (delegate: "GPU" | "CPU") =>
      PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate }, runningMode: "VIDEO", numPoses: 1 });
    try {
      return await make("GPU");
    } catch (e) {
      console.warn("motion: no GPU for the pose model, using the CPU", e);
      return await make("CPU");
    }
  })();
  landmarker.catch(() => (landmarker = null));
  return landmarker;
}

let lastStamp = 0;
/** Detector timestamps must increase strictly across every source that shares it. */
export function stamp(nowMs: number): number {
  lastStamp = Math.max(lastStamp + 1, Math.round(nowMs));
  return lastStamp;
}

/**
 * The person to follow among the detected ones: the biggest in the picture, preferring whoever was followed just
 * before (so a passer-by does not steal the frog).
 */
export function pickPerson(res: PoseLandmarkerResult, aspect: number, prevHip: [number, number] | null): number {
  let best = -1, bestScore = -Infinity;
  res.landmarks.forEach((lm, i) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of lm) {
      if ((p.visibility ?? 1) < 0.5) continue;
      x0 = Math.min(x0, p.x * aspect), x1 = Math.max(x1, p.x * aspect), y0 = Math.min(y0, p.y), y1 = Math.max(y1, p.y);
    }
    const size = x1 > x0 ? Math.sqrt((x1 - x0) * (y1 - y0)) : 0;
    const hip: [number, number] = [((lm[23].x + lm[24].x) / 2) * aspect, (lm[23].y + lm[24].y) / 2];
    const jump = prevHip ? Math.hypot(hip[0] - prevHip[0], hip[1] - prevHip[1]) : 0;
    const score = size - 1.5 * jump;
    if (score > bestScore) (bestScore = score), (best = i);
  });
  return best;
}

export function toFrame(res: PoseLandmarkerResult, i: number): LandmarkFrame {
  if (i < 0 || !res.worldLandmarks[i]) return { world: [], image: [] };
  const arr = (l: { x: number; y: number; z: number; visibility?: number }[]) => l.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]);
  return { world: arr(res.worldLandmarks[i]), image: arr(res.landmarks[i]) };
}

export const hipOf = (f: LandmarkFrame, aspect: number): [number, number] | null =>
  f.image.length < 33 ? null : [((f.image[23][0] + f.image[24][0]) / 2) * aspect, (f.image[23][1] + f.image[24][1]) / 2];

/** Calls cb once per new video frame. */
export function onFrames(video: HTMLVideoElement, cb: (nowMs: number, mediaTime: number) => void): () => void {
  let stop = false;
  let id = 0;
  const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
    if (stop) return;
    cb(now, meta.mediaTime);
    if (!stop) id = video.requestVideoFrameCallback(tick);
  };
  id = video.requestVideoFrameCallback(tick);
  return () => {
    stop = true;
    video.cancelVideoFrameCallback(id);
  };
}

/** The preview: the video (contained, mirrored like a selfie when asked) with a skeleton canvas over it. */
export class PreviewView {
  readonly root = document.createElement("div");
  readonly video = document.createElement("video");
  private readonly flip = document.createElement("div");
  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d")!;

  constructor(parent: HTMLElement, mirror: boolean) {
    this.root.className = "naiwa-motion-preview";
    this.root.style.cssText = "position:absolute;inset:0;overflow:hidden;background:#000";
    this.flip.style.cssText = "position:absolute;inset:0";
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none";
    this.flip.append(this.video, this.canvas);
    this.root.append(this.flip);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.append(this.root);
    this.setMirror(mirror);
  }

  setMirror(on: boolean): void {
    this.flip.style.transform = on ? "scaleX(-1)" : "";
  }

  /** Draw the skeleton of image landmarks (null clears it). */
  draw(image: number[][] | null): void {
    const { canvas, ctx, video } = this;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = this.root.clientWidth, ch = this.root.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!image || image.length < 33 || !video.videoWidth) return;
    const s = Math.min(cw / video.videoWidth, ch / video.videoHeight);
    const w = video.videoWidth * s, h = video.videoHeight * s;
    ctx.setTransform(dpr, 0, 0, dpr, (cw - w) / 2 * dpr, (ch - h) / 2 * dpr);
    const at = (i: number) => [image[i][0] * w, image[i][1] * h] as const;
    const lw = Math.max(2, Math.min(w, h) / 90);
    ctx.lineCap = "round";
    for (const pass of [0, 1]) {
      ctx.lineWidth = pass ? lw : lw + 2.5;
      for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
        if (start < 11 && end < 11) continue; // face mesh lines clutter a small preview
        const v = Math.min(image[start][3], image[end][3]);
        if (v < 0.3) continue;
        ctx.strokeStyle = pass ? `rgba(255, 211, 77, ${v})` : `rgba(40, 30, 0, ${0.6 * v})`;
        ctx.beginPath();
        ctx.moveTo(...at(start));
        ctx.lineTo(...at(end));
        ctx.stroke();
      }
    }
    ctx.fillStyle = "#fff6d8";
    for (let i = 0; i < 33; i++) {
      if ((i > 0 && i < 11) || image[i][3] < 0.3) continue;
      const [x, y] = at(i);
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? lw * 2.2 : lw * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  dispose(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.srcObject = null;
    this.video.load();
    this.root.remove();
  }
}
