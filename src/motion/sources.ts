/** MotionSources: procedural dances, dance tracks, the webcam and analysed uploaded videos. */
import type { DanceTrack, MotionKind, MotionSource, MotionStatus, PoseFrame } from "../contracts";
import type { ProceduralDance } from "./dances";
import { hipOf, loadLandmarker, onFrames, pickPerson, PreviewView, stamp, toFrame } from "./mediapipe";
import { OneEuro } from "./oneEuro";
import { blendPose, idlePose, type BodyPose } from "./pose";
import { Retargeter, type LandmarkFrame } from "./retarget";
import { solve, type Binding } from "./rig";
import { smoothFrames, TrackPlayer, type Track } from "./track";

export type Emit = (s: MotionStatus) => void;
export type GetBinding = () => Binding | null;

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const FADE_IN_MS = 400;
/** Longest stretch of an uploaded video that is analysed. */
export const MAX_VIDEO_SECONDS = 60;

/** A source the user can mirror while it runs (camera and video). */
export interface MirrorableSource extends MotionSource {
  setMirror(on: boolean): void;
}

/** Loops a pose function of time, easing in from idle. */
class LoopSource implements MotionSource {
  private start: number | null = null;
  private last = 0;
  constructor(
    readonly kind: MotionKind,
    private readonly duration: number,
    private readonly poseAt: (t: number, dt: number) => BodyPose | null,
    private readonly binding: GetBinding,
  ) {}
  update(nowMs: number): PoseFrame | null {
    this.start ??= nowMs;
    const b = this.binding();
    const ms = nowMs - this.start;
    const dt = Math.max(0, Math.min(0.1, (nowMs - this.last) / 1000));
    this.last = nowMs;
    const pose = this.poseAt((((ms / 1000) % this.duration) + this.duration) % this.duration, dt);
    if (!b || !pose) return null;
    return solve(b, blendPose(idlePose(), pose, smooth(ms / FADE_IN_MS)));
  }
  dispose(): void {}
}

export const proceduralSource = (d: ProceduralDance, binding: GetBinding): MotionSource =>
  new LoopSource("dance", d.duration, (t) => d.pose(t), binding);

export function trackSource(track: Track | Promise<Track>, binding: GetBinding, emit: Emit): MotionSource {
  let player: TrackPlayer | null = null;
  let duration = 1;
  Promise.resolve(track).then(
    (t) => {
      player = new TrackPlayer(t);
      duration = t.duration;
    },
    (e) => {
      console.warn(e);
      emit({ state: "error", message: "这支舞加载失败了，请检查网络后再试" });
    },
  );
  let src: LoopSource | null = null;
  return {
    kind: "dance",
    update(nowMs) {
      if (!player) return null;
      src ??= new LoopSource("dance", duration, (t, dt) => player!.pose(t, dt, false), binding);
      return src.update(nowMs);
    },
    dispose() {},
  };
}

/**
 * Follows a stream of BodyPoses that can drop out: holds the last one briefly, eases back to idle, and eases in
 * again when the person is back.
 */
class Presence {
  private latest: BodyPose | null = null;
  private seenAt = -Infinity;
  private shown: BodyPose | null = null;
  private from: BodyPose | null = null;
  private since = 0;
  lost = true;

  feed(pose: BodyPose | null, nowMs: number): void {
    if (!pose) return;
    if (nowMs - this.seenAt > 250) {
      this.from = this.shown;
      this.since = nowMs;
    }
    this.latest = pose;
    this.seenAt = nowMs;
  }

  output(nowMs: number): BodyPose | null {
    const age = nowMs - this.seenAt;
    this.lost = age > 300;
    let out: BodyPose | null;
    if (this.latest && age < 250) {
      const w = smooth((nowMs - this.since) / 300);
      out = this.from && w < 1 ? blendPose(this.from, this.latest, w) : this.latest;
    } else if (this.latest && age < 700) out = this.latest;
    else if (this.latest) {
      const w = smooth((age - 700) / 800);
      out = w < 1 ? blendPose(this.latest, idlePose(), w) : null;
    } else out = null;
    this.shown = out;
    return out;
  }
}

/** Camera errors in plain Chinese. */
function cameraError(e: unknown): string {
  const name = (e as { name?: string }).name;
  if (name === "NotAllowedError" || name === "SecurityError") return "摄像头权限被拒绝了，请在浏览器地址栏旁允许使用摄像头";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "没有找到摄像头";
  if (name === "NotReadableError" || name === "AbortError") return "摄像头被别的应用占用了，关掉它再试试";
  return "摄像头打不开，请检查后再试";
}

export async function startCamera(mirror: boolean, preview: HTMLElement, binding: GetBinding, emit: Emit): Promise<MirrorableSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "这个页面用不了摄像头（需要 https 或 localhost）";
    emit({ state: "error", message });
    throw new Error(message);
  }
  emit({ state: "loading", message: "正在打开摄像头…" });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    const message = cameraError(e);
    emit({ state: "error", message });
    throw new Error(message);
  }
  emit({ state: "loading", message: "正在加载姿态模型…" });
  const view = new PreviewView(preview, mirror);
  view.video.srcObject = stream;
  let detector;
  try {
    [detector] = await Promise.all([loadLandmarker(), view.video.play()]);
  } catch (e) {
    console.warn(e);
    stream.getTracks().forEach((t) => t.stop());
    view.dispose();
    const message = "姿态模型加载失败了，请刷新页面再试";
    emit({ state: "error", message });
    throw new Error(message);
  }
  await detector.setOptions({ numPoses: 1 });
  emit({ state: "ready", message: "摄像头准备好了，退后一点让全身入镜" });

  const retarget = new Retargeter();
  const presence = new Presence();
  const worldFilter = new OneEuro(1.5, 3);
  const imageFilter = new OneEuro(1.5, 4);
  let lastT = 0;
  let count = 0;
  let windowStart = performance.now();
  let fps = 0;
  let wasLost = true;
  let disposed = false;
  const stop = onFrames(view.video, (now) => {
    if (disposed || view.video.readyState < 2) return;
    const aspect = view.video.videoWidth / Math.max(1, view.video.videoHeight);
    const res = detector.detectForVideo(view.video, stamp(now));
    const frame = toFrame(res, 0);
    view.draw(frame.image.length ? frame.image : null);
    count++;
    if (now - windowStart > 1000) {
      fps = (count * 1000) / (now - windowStart);
      count = 0;
      windowStart = now;
      if (!presence.lost) emit({ state: "tracking", message: "正在跟着你跳", fps });
    }
    if (!frame.world.length) return;
    const t = now / 1000;
    const w = frame.world.flatMap((p) => p.slice(0, 3));
    const im = frame.image.flatMap((p) => p.slice(0, 3));
    worldFilter.filter(w, t);
    imageFilter.filter(im, t);
    const back = (flat: number[], src: number[][]) => src.map((p, i) => [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2], p[3]]);
    const filtered: LandmarkFrame = { world: back(w, frame.world), image: back(im, frame.image) };
    const dt = lastT ? Math.min(0.2, t - lastT) : 1 / 30;
    lastT = t;
    presence.feed(retarget.pose(filtered, aspect, dt, mirror), now);
  });

  return {
    kind: "camera",
    media: view.video,
    setMirror(on) {
      mirror = on;
      view.setMirror(on);
    },
    update(nowMs) {
      const pose = presence.output(nowMs);
      if (presence.lost !== wasLost) {
        wasLost = presence.lost;
        emit(wasLost ? { state: "lost", message: "找不到你啦，退后一点让全身入镜" } : { state: "tracking", message: "正在跟着你跳", fps });
      }
      const b = binding();
      return pose && b ? solve(b, pose) : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      stream.getTracks().forEach((t) => t.stop());
      view.dispose();
      emit({ state: "idle" });
    },
  };
}

export interface VideoSource extends MirrorableSource {
  track(): DanceTrack | null;
}

/**
 * Uploaded video: analysed first, as fast as the device allows (played muted and sped up while the detector keeps
 * up), smoothed with frames before and after, then played with its sound and the frog in sync with video time.
 */
export async function startVideo(
  file: File | string,
  mirror: boolean,
  preview: HTMLElement,
  binding: GetBinding,
  emit: Emit,
  cancelled: () => boolean,
): Promise<VideoSource> {
  emit({ state: "loading", message: "正在加载姿态模型…", progress: 0 });
  const view = new PreviewView(preview, mirror);
  const url = typeof file === "string" ? file : URL.createObjectURL(file);
  const title = typeof file === "string" ? decodeURIComponent(file.split("/").pop() ?? "视频") : file.name;
  const fail = (message: string): never => {
    view.dispose();
    if (typeof file !== "string") URL.revokeObjectURL(url);
    // A start replaced by a newer one goes quietly: the newer one owns the status now.
    if (!cancelled()) emit({ state: "error", message });
    throw new Error(message);
  };
  view.video.preload = "auto";
  view.video.src = url;
  const meta = new Promise<void>((resolve, reject) => {
    view.video.onloadeddata = () => resolve();
    view.video.onerror = () => reject(view.video.error);
  });
  let detector;
  try {
    detector = await loadLandmarker();
  } catch (e) {
    console.warn(e);
    return fail("姿态模型加载失败了，请刷新页面再试");
  }
  try {
    await meta;
  } catch (e) {
    console.warn(e);
    return fail("这个视频打不开，换一个 MP4 视频试试");
  }
  if (cancelled()) return fail("已取消");
  const video = view.video;
  const aspect = video.videoWidth / Math.max(1, video.videoHeight);
  const length = Number.isFinite(video.duration) ? Math.min(video.duration, MAX_VIDEO_SECONDS) : MAX_VIDEO_SECONDS;

  // Analyse: one detection per presented frame, the playback rate adapted so ~24 samples land per video second.
  await detector.setOptions({ numPoses: 3 });
  const samples: { t: number; frame: LandmarkFrame }[] = [];
  let prevHip: [number, number] | null = null;
  let rate = 2;
  let lastProgress = -1;
  await new Promise<void>((resolve, reject) => {
    let lastMedia = -1;
    const watchdog = setTimeout(() => {
      stop();
      reject(new Error("no frames"));
    }, 8000);
    const stop = onFrames(video, (now, mediaTime) => {
      clearTimeout(watchdog);
      if (cancelled()) {
        stop();
        reject(new Error("已取消"));
        return;
      }
      if (mediaTime >= length || video.ended) {
        stop();
        resolve();
        return;
      }
      const res = detector.detectForVideo(video, stamp(now));
      const frame = toFrame(res, pickPerson(res, aspect, prevHip));
      prevHip = hipOf(frame, aspect) ?? prevHip;
      samples.push({ t: mediaTime, frame });
      view.draw(frame.image.length ? frame.image : null);
      if (lastMedia >= 0) {
        const gap = mediaTime - lastMedia;
        if (gap > 1 / 18) rate = Math.max(0.5, rate * 0.85);
        else if (gap < 1 / 30) rate = Math.min(4, rate * 1.1);
        video.playbackRate = rate;
      }
      lastMedia = mediaTime;
      const progress = Math.min(1, mediaTime / length);
      if (progress - lastProgress > 0.02) {
        lastProgress = progress;
        emit({ state: "loading", message: `正在分析视频里的动作… ${Math.round(progress * 100)}%`, progress });
      }
    });
    video.onended = () => {
      stop();
      resolve();
    };
    video.muted = true;
    video.playbackRate = rate;
    video.currentTime = 0;
    video.play().catch(reject);
  }).catch((e) => fail(e instanceof Error && e.message === "已取消" ? "已取消" : "这个视频播放不了，换一个 MP4 视频试试"));
  video.pause();
  await detector.setOptions({ numPoses: 1 });

  // Resample to 30 fps (gaps longer than half a second stay empty), then smooth with past and future frames.
  const fps = 30;
  const n = Math.max(2, Math.floor(length * fps));
  const frames: LandmarkFrame[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = k / fps;
    while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
    const a = samples[j], b = samples[j + 1];
    const near = !b || Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
    frames.push(near && Math.abs(near.t - t) < 0.25 ? near.frame : { world: [], image: [] });
  }
  const seen = frames.filter((f) => f.world.length >= 33).length;
  if (seen < Math.max(3, n * 0.2)) return fail("视频里没有找到人，换一个人物全身入镜的视频试试");
  const track: Track = {
    id: `video-${Date.now().toString(36)}`,
    name: title.replace(/\.[^.]+$/, "").slice(0, 16) || "我的舞蹈",
    fps,
    duration: n / fps,
    aspect,
    source: { title, url: typeof file === "string" ? file : "", start: 0, end: n / fps },
    frames: smoothFrames(frames, fps),
  };

  // Play with sound, the frog following video time (seeking and looping stay in sync).
  const player = new TrackPlayer(track);
  const presence = new Presence();
  video.loop = length >= video.duration - 0.05;
  video.playbackRate = 1;
  video.currentTime = 0;
  video.ontimeupdate = () => {
    if (video.currentTime >= length) video.currentTime = 0;
  };
  video.muted = false;
  try {
    await video.play();
  } catch {
    // Browsers may refuse sound without a recent tap: play muted and let a tap on the preview unmute.
    video.muted = true;
    await video.play().catch(() => undefined);
    view.root.addEventListener("pointerdown", () => (video.muted = false), { once: true });
  }
  const capped = Number.isFinite(video.duration) && video.duration > MAX_VIDEO_SECONDS;
  emit({ state: "tracking", message: capped ? `跟着视频跳（只分析了前 ${MAX_VIDEO_SECONDS} 秒）` : "跟着视频跳", progress: 1 });

  let lastT = -1;
  let lastNow = 0;
  let held: BodyPose | null = null;
  let wasLost = false;
  let disposed = false;
  return {
    kind: "video",
    media: video,
    track: () => track,
    setMirror(on) {
      mirror = on;
      view.setMirror(on);
    },
    update(nowMs) {
      const t = Math.min(video.currentTime, track.duration - 1e-3);
      const dt = Math.max(0, Math.min(0.1, (nowMs - lastNow) / 1000));
      lastNow = nowMs;
      if (t !== lastT) {
        lastT = t;
        const f = track.frames[Math.min(track.frames.length - 1, Math.round(t * fps))];
        view.draw(f.image.length ? f.image : null);
        held = player.pose(t, dt, mirror) ?? held;
        presence.feed(held && f.world.length ? held : null, nowMs);
      } else if (video.paused) presence.feed(held, nowMs); // paused: hold still
      const pose = presence.output(nowMs);
      if (presence.lost !== wasLost) {
        wasLost = presence.lost;
        emit(wasLost ? { state: "lost", message: "这一段视频里没看到人" } : { state: "tracking", message: "跟着视频跳" });
      }
      const b = binding();
      return pose && b ? solve(b, pose) : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      view.dispose();
      if (typeof file !== "string") URL.revokeObjectURL(url);
      emit({ state: "idle" });
    },
  };
}
