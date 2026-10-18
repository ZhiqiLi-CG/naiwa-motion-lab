/** MotionSources: procedural dances, dance tracks, the webcam and analysed uploaded videos. */
import type { DanceTrack, MotionKind, MotionSource, MotionStatus, PoseFrame } from "../contracts";
import { tr, type Text } from "../i18n";
import type { ProceduralDance } from "./dances";
import type { LandmarkFrame, PersonFrame, Recording } from "./api";
import type { RetargetPipeline } from "./core";
import { hipOf, loadLandmarker, onFrames, pickPerson, PreviewView, stamp, toFrame } from "./mediapipe";
import { blendPose, idlePose, type BodyPose } from "./pose";
import { recordingOf, TrackPlayer, type Track } from "./track";
import { accumulate, type CameraStep } from "./cameraMotion";
import { VideoCamera } from "./cameraFrames";
import { AUTO, coherence } from "../algorithms/motion/coherence";

/** A status with its text in both languages (shown in the current one, re-shown when the language changes). */
export type Status = Omit<MotionStatus, "message"> & { text?: Text };
export type Emit = (s: Status) => void;
/** The pipeline a source runs through (null before the rig is bound); rebuilt when the retargeter changes. */
export type Retarget = () => RetargetPipeline | null;
/** A pipeline for a new source; recorded sources say what they know of the whole take. */
export type OpenRetarget = (recording?: Recording) => Retarget;

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const FADE_IN_MS = 400;
/** Longest stretch of an uploaded video that is analysed. */
export const MAX_VIDEO_SECONDS = 60;

/** A source the user can mirror while it runs (camera and video). */
export interface MirrorableSource extends MotionSource {
  setMirror(on: boolean): void;
}

/** Longest step a source takes at once (a stalled tab must not skip half a dance). */
const MAX_STEP = 0.1;

/** Loops a pose function of time, easing in from idle. Time advances by the dt it is given (pause, slow motion). */
class LoopSource implements MotionSource {
  private time = 0;
  constructor(
    readonly kind: MotionKind,
    private readonly duration: number,
    private readonly poseAt: (t: number, dt: number) => BodyPose | null,
    private readonly retarget: Retarget,
  ) {}
  update(_nowMs: number, dt: number): PoseFrame | null {
    const step = Math.min(Math.max(dt, 0), MAX_STEP);
    this.time += step;
    const pose = this.poseAt(this.time % this.duration, step);
    const r = this.retarget();
    if (!r || !pose) return null;
    return r.pose(blendPose(idlePose(), pose, smooth((this.time * 1000) / FADE_IN_MS)), step);
  }
  dispose(): void {}
}

export const proceduralSource = (d: ProceduralDance, open: OpenRetarget): MotionSource =>
  new LoopSource("dance", d.duration, (t) => d.pose(t), open());

/** A dance track; its clock starts at the first update even if the track is still loading. */
export function trackSource(track: Promise<Track>, duration: number, open: OpenRetarget, emit: Emit): MotionSource {
  let player: TrackPlayer | null = null;
  let retarget: Retarget = () => null;
  track.then(
    (t) => {
      retarget = open(recordingOf(t));
      player = new TrackPlayer(t, retarget);
    },
    (e) => {
      console.warn(e);
      emit({ state: "error", text: { zh: "这支舞加载失败了，请检查网络后再试", en: "Couldn't load this dance. Check your connection and try again." } });
    },
  );
  return new LoopSource("dance", duration, (t, dt) => player?.goal(t, dt, false) ?? null, () => retarget());
}

/**
 * Follows a stream of BodyPoses that can drop out: holds the last one briefly, eases back to idle, and eases in
 * again when the person is back. Times are in ms of whatever clock the source runs on.
 */
class Presence {
  private latest: BodyPose | null = null;
  private seenAt = -Infinity;
  private shown: BodyPose | null = null;
  private from: BodyPose | null = null;
  private since = 0;
  lost = true;

  feed(pose: BodyPose | null, ms: number): void {
    if (!pose) return;
    if (ms - this.seenAt > 250) {
      this.from = this.shown;
      this.since = ms;
    }
    this.latest = pose;
    this.seenAt = ms;
  }

  output(ms: number): BodyPose | null {
    const age = ms - this.seenAt;
    this.lost = age > 300;
    let out: BodyPose | null;
    if (this.latest && age < 250) {
      const w = smooth((ms - this.since) / 300);
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

/** Camera errors for the user. */
function cameraError(e: unknown): Text {
  const name = (e as { name?: string }).name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return { zh: "摄像头权限被拒绝了，请在浏览器地址栏旁允许使用摄像头", en: "Camera access was blocked. Allow the camera next to the address bar." };
  if (name === "NotFoundError" || name === "OverconstrainedError") return { zh: "没有找到摄像头", en: "No camera found." };
  if (name === "NotReadableError" || name === "AbortError")
    return { zh: "摄像头被别的应用占用了，关掉它再试试", en: "Another app is using the camera. Close it and try again." };
  return { zh: "摄像头打不开，请检查后再试", en: "Couldn't open the camera." };
}

const LOADING_MODEL: Text = { zh: "正在加载姿态模型…", en: "Loading the pose model…" };
const MODEL_FAILED: Text = { zh: "姿态模型加载失败了，请刷新页面再试", en: "Couldn't load the pose model. Reload the page and try again." };
const WITH_YOU: Text = { zh: "正在跟着你跳", en: "Dancing with you" };
const CANCELLED: Text = { zh: "已取消", en: "Cancelled" };

/** Report an error status and throw it. */
function failWith(emit: Emit, text: Text): never {
  emit({ state: "error", text });
  throw new Error(tr(text));
}

export async function startCamera(mirror: boolean, preview: HTMLElement, open: OpenRetarget, emit: Emit): Promise<MirrorableSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    failWith(emit, { zh: "这个页面用不了摄像头（需要 https 网址）", en: "The camera needs a secure (https) page." });
  }
  emit({ state: "loading", text: { zh: "正在打开摄像头…", en: "Opening the camera…" } });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    failWith(emit, cameraError(e));
  }
  emit({ state: "loading", text: LOADING_MODEL });
  const view = new PreviewView(preview, mirror);
  view.video.srcObject = stream;
  let detector;
  try {
    [detector] = await Promise.all([loadLandmarker(), view.video.play()]);
  } catch (e) {
    console.warn(e);
    stream.getTracks().forEach((t) => t.stop());
    view.dispose();
    failWith(emit, MODEL_FAILED);
  }
  await detector.setOptions({ numPoses: 1 });
  emit({ state: "ready", text: { zh: "摄像头准备好了，退后一点让全身入镜", en: "Camera ready. Step back so your whole body is in view." } });

  const retarget = open();
  const presence = new Presence();
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
      if (!presence.lost) emit({ state: "tracking", text: WITH_YOU, fps });
    }
    const r = retarget();
    if (!frame.world.length || !r) return;
    const t = now / 1000;
    const dt = lastT ? Math.min(0.2, t - lastT) : 1 / 30;
    lastT = t;
    presence.feed(r.live({ ...frame, aspect }, t, dt, mirror), now);
  });

  return {
    kind: "camera",
    media: view.video,
    setMirror(on) {
      mirror = on;
      view.setMirror(on);
    },
    update(nowMs, dt) {
      const pose = presence.output(nowMs);
      if (presence.lost !== wasLost) {
        wasLost = presence.lost;
        emit(wasLost ? { state: "lost", text: { zh: "找不到你啦，退后一点让全身入镜", en: "Can't see you. Step back so your whole body is in view." } } : { state: "tracking", text: WITH_YOU, fps: fps || undefined });
      }
      const r = retarget();
      return pose && r ? r.pose(pose, dt) : null;
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

/** How uploads are analysed. dev/coherence.html turns the camera handling (the estimate and the AUTO coherence
 *  steps) off, or asks for the last analysis' camera steps and its frames without the camera handling (`keepRaw`),
 *  to compare. */
export const videoAnalysis: { camera: boolean; keepRaw?: boolean; steps?: CameraStep[]; raw?: LandmarkFrame[] } = { camera: true };

export interface VideoSource extends MirrorableSource {
  track(): DanceTrack | null;
}

/**
 * Uploaded video: analysed first, as fast as the device allows (played muted and sped up while the detector keeps
 * up), smoothed with frames before and after, then played with its sound and the frog in sync with video time.
 *
 * While it is analysed, the camera's motion is estimated from the background of the same frames (cameraFrames.ts):
 * pans, zooms and shot cuts. Before the retargeter's smoothing, the camera is taken out of the person's picture
 * landmarks and each shot is re-anchored onto the one before (the AUTO steps of src/algorithms/motion/coherence), so
 * the camera no longer reads as the person travelling, hopping or turning. The track keeps the estimate (camera,
 * cuts) and is marked cameraUndone.
 */
export async function startVideo(
  file: File | string,
  mirror: boolean,
  preview: HTMLElement,
  open: OpenRetarget,
  emit: Emit,
  cancelled: () => boolean,
): Promise<VideoSource> {
  emit({ state: "loading", text: LOADING_MODEL, progress: 0 });
  const view = new PreviewView(preview, mirror);
  const url = typeof file === "string" ? file : URL.createObjectURL(file);
  const title = typeof file === "string" ? decodeURIComponent(file.split("/").pop() ?? "视频") : file.name;
  const fail = (text: Text): never => {
    view.dispose();
    if (typeof file !== "string") URL.revokeObjectURL(url);
    // A start replaced by a newer one goes quietly: the newer one owns the status now.
    if (!cancelled()) emit({ state: "error", text });
    throw new Error(tr(text));
  };
  const UNPLAYABLE: Text = { zh: "这个视频播放不了，换一个 MP4 视频试试", en: "Can't play this video. Try an MP4." };
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
    return fail(MODEL_FAILED);
  }
  try {
    await meta;
  } catch (e) {
    console.warn(e);
    return fail(UNPLAYABLE);
  }
  if (cancelled()) return fail(CANCELLED);
  const video = view.video;
  const aspect = video.videoWidth / Math.max(1, video.videoHeight);
  // A recorded stream (MediaRecorder WebM) may not know its duration until it has played: then the analysis ends it.
  let length = Number.isFinite(video.duration) ? Math.min(video.duration, MAX_VIDEO_SECONDS) : MAX_VIDEO_SECONDS;

  // Analyse: one detection per presented frame, the playback rate adapted so ~15–22 samples land per video second.
  await detector.setOptions({ numPoses: 3 });
  const samples: { t: number; frame: LandmarkFrame; step: CameraStep | null }[] = [];
  let camera: VideoCamera | null = videoAnalysis.camera ? new VideoCamera(video) : null;
  let prevHip: [number, number] | null = null;
  let rate = 2;
  let lastProgress = -1;
  let detectMs = 0;
  const started = performance.now();
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
        reject(CANCELLED);
        return;
      }
      if (mediaTime >= length || video.ended) {
        stop();
        resolve();
        return;
      }
      const d0 = performance.now();
      const res = detector.detectForVideo(video, stamp(now));
      detectMs += performance.now() - d0;
      const frame = toFrame(res, pickPerson(res, aspect, prevHip));
      prevHip = hipOf(frame, aspect) ?? prevHip;
      let step: CameraStep | null = null;
      try {
        step = camera?.push(video, res.landmarks.map((l) => l.map((p) => [p.x, p.y, p.z, p.visibility ?? 1]))) ?? null;
      } catch (e) {
        // A picture that cannot be read back (another origin): no camera estimate for this video.
        console.warn("motion: no camera estimate", e);
        camera = null;
      }
      samples.push({ t: mediaTime, frame, step });
      view.draw(frame.image.length ? frame.image : null);
      if (lastMedia >= 0) {
        const gap = mediaTime - lastMedia;
        if (gap > 1 / 15) rate = Math.max(0.5, rate * 0.9);
        else if (gap < 1 / 22) rate = Math.min(4, rate * 1.05);
        video.playbackRate = rate;
      }
      lastMedia = mediaTime;
      const progress = Math.min(1, mediaTime / length);
      if (progress - lastProgress > 0.02) {
        lastProgress = progress;
        const pc = Math.round(progress * 100);
        emit({ state: "loading", text: { zh: `正在分析视频里的动作… ${pc}%`, en: `Reading the moves in the video… ${pc}%` }, progress });
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
  }).catch((e) => fail(e === CANCELLED ? CANCELLED : UNPLAYABLE));
  video.pause();
  await detector.setOptions({ numPoses: 1 });
  const wall = (performance.now() - started) / 1000;
  if (!Number.isFinite(video.duration) || video.duration < length) length = Math.min(length, (samples[samples.length - 1]?.t ?? 0) + 1 / 30);
  const per = (ms: number) => (ms / Math.max(1, camera?.frames ?? 1)).toFixed(2);
  const cam = camera ? ` · camera ${camera.w}×${camera.h}: ${per(camera.ms)} ms per frame (${per(camera.grabMs)} reading the frame, ${per(camera.estimateMs)} estimating)` : "";
  console.info(`motion: analysed ${samples.length} frames of ${length.toFixed(1)} s in ${wall.toFixed(1)} s (${(detectMs / Math.max(1, samples.length)).toFixed(1)} ms per detection, final rate ${rate.toFixed(2)}×${cam})`);
  // Shot-relative camera per sample, and which shot each sample is in.
  const estimate = camera && samples.length && samples.every((s) => s.step) ? accumulate(samples.map((s) => s.step!)) : null;
  videoAnalysis.steps = samples.map((s) => s.step!).filter(Boolean);
  const shotOf: number[] = [];
  if (estimate) samples.forEach((_, i) => shotOf.push((i ? shotOf[i - 1] : 0) + (estimate.cuts.includes(i) ? 1 : 0)));

  // Resample to 30 fps, then smooth with past and future frames. Between two samples with the person (closer than a
  // quarter second, in the same shot) the landmarks and the camera are interpolated: the detector keeps up with only
  // 15–22 samples a second, and repeating each one gave the frog stair-step targets (jerky at full speed, and in slow
  // motion only the steps' slow tail). Elsewhere the nearest sample; a gap longer than a quarter second stays empty.
  const fps = 30;
  const n = Math.max(2, Math.floor(length * fps));
  const frames: PersonFrame[] = [];
  const cameraTrack: { shift: [number, number]; scale: number }[] = [];
  const cuts: number[] = [];
  let j = 0, prevSample = 0;
  for (let k = 0; k < n; k++) {
    const t = k / fps;
    while (j + 1 < samples.length && samples[j + 1].t <= t) j++;
    const a = samples[j], b = samples[j + 1];
    const near = !b || Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b;
    const between = !!b && a.t <= t && t < b.t && b.t - a.t < 0.25 && a.frame.world.length >= 33 && b.frame.world.length >= 33 && (!estimate || shotOf[j] === shotOf[j + 1]);
    const w = between ? (t - a.t) / (b.t - a.t) : 0;
    const mix = (p: number[][], q: number[][]) => p.map((x, i) => x.map((v, c) => v + (q[i][c] - v) * w));
    if (between) frames.push({ world: mix(a.frame.world, b.frame.world), image: mix(a.frame.image, b.frame.image), aspect });
    else frames.push({ ...(near && Math.abs(near.t - t) < 0.25 ? near.frame : { world: [], image: [] }), aspect });
    if (estimate) {
      // Frame and camera from the same samples, so they belong together.
      const i = near === a ? j : j + 1;
      if (between) {
        const ca = estimate.camera[j], cb = estimate.camera[j + 1];
        cameraTrack.push({ shift: [ca.shift[0] + (cb.shift[0] - ca.shift[0]) * w, ca.shift[1] + (cb.shift[1] - ca.shift[1]) * w], scale: ca.scale + (cb.scale - ca.scale) * w });
      } else cameraTrack.push(estimate.camera[i]);
      if (k > 0 && shotOf[i] !== shotOf[prevSample]) cuts.push(k);
      prevSample = i;
    }
  }
  const seen = frames.filter((f) => f.world.length >= 33).length;
  if (seen < Math.max(3, n * 0.2)) return fail({ zh: "视频里没有找到人，换一个人物全身入镜的视频试试", en: "No one found in this video. Try one with a person in full view." });
  // The pipeline exists once the rig is bound (the character may still be loading while the video is analysed).
  // The camera taken out and shots anchored onto each other (before the smoothing).
  const analysed: Track = { id: "", name: "", fps, duration: n / fps, aspect, source: { title, url: "", start: 0, end: n / fps }, frames };
  if (estimate) Object.assign(analysed, { camera: cameraTrack, cuts });
  const coherent = videoAnalysis.camera ? coherence(analysed, AUTO) : { track: analysed, report: null };
  const r = coherent.report;
  if (r) console.info(`motion: coherence ${r.ms.toFixed(0)} ms: ${r.shots} shot(s), ${r.movingShots} with a moving camera, cuts at ${JSON.stringify(r.cuts)}`);
  const filter = await new Promise<RetargetPipeline>((resolve) => {
    const r = open();
    const poll = () => {
      const p = r();
      if (p) resolve(p);
      else setTimeout(poll, 100);
    };
    poll();
  });
  const track: Track = {
    id: `video-${Date.now().toString(36)}`,
    name: title.replace(/\.[^.]+$/, "").slice(0, 16) || tr({ zh: "我的舞蹈", en: "My dance" }),
    fps,
    duration: n / fps,
    aspect,
    source: { title, url: typeof file === "string" ? file : "", start: 0, end: n / fps },
    frames: filter.recorded(coherent.track.frames.map((f) => ({ ...f, aspect })), fps).map(({ world, image }): LandmarkFrame => ({ world, image })),
  };
  if (videoAnalysis.keepRaw) videoAnalysis.raw = filter.recorded(frames, fps).map(({ world, image }): LandmarkFrame => ({ world, image }));
  // The estimate is kept for reference; the cuts are those the person confirmed.
  if (estimate) Object.assign(track, { camera: cameraTrack, cuts: coherent.track.cuts, cameraUndone: coherent.track.cameraUndone });

  // Play with sound, the frog following video time (seeking and looping stay in sync).
  const retarget = open(recordingOf(track));
  const player = new TrackPlayer(track, retarget);
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
  }
  const capped = Number.isFinite(video.duration) && video.duration > MAX_VIDEO_SECONDS;
  const along: Text = capped
    ? { zh: `跟着视频跳（只分析了前 ${MAX_VIDEO_SECONDS} 秒）`, en: `Dancing along (first ${MAX_VIDEO_SECONDS} s of the video)` }
    : { zh: "跟着视频跳", en: "Dancing along with the video" };
  let status: Status = { state: "tracking", text: along, progress: 1 };
  if (video.muted) {
    status = { state: "tracking", text: { zh: `${along.zh} · 点一下视频打开声音`, en: `${along.en} · tap the video for sound` }, progress: 1 };
    view.root.addEventListener("pointerdown", () => ((video.muted = false), emit((status = { state: "tracking", text: along, progress: 1 }))), { once: true });
  }
  emit(status);
  // This status goes out before the caller has the source; it is said again on the first update, when the caller has
  // it (the page offers to keep the analysed dance once a video source reports tracking).
  let announced = false;

  // Motion time runs on the dt the caller gives (pause, single step, slow motion) and the video follows it: paused at
  // dt = 0, a single step after a pause is a seek, otherwise it plays at the caller's time scale.
  let clock = 0;
  let fedAt = 0;
  let lastT = -1;
  let lastNow = -1;
  let prevStep = 1;
  let scale = 1;
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
    update(nowMs, dt) {
      if (!announced) {
        announced = true;
        if (!wasLost) emit(status);
      }
      const step = Math.min(Math.max(dt, 0), MAX_STEP);
      const wall = lastNow < 0 ? step : (nowMs - lastNow) / 1000;
      lastNow = nowMs;
      if (step === 0) {
        if (!video.paused) video.pause();
      } else if (video.paused && prevStep === 0) {
        video.currentTime = Math.min(video.currentTime + step, length - 1e-3);
      } else {
        if (wall > 0) scale += (step / wall - scale) * 0.3;
        const rate = Math.min(4, Math.max(0.0625, Math.round(scale * 20) / 20));
        if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
        if (video.paused) video.play().catch(() => undefined);
      }
      prevStep = step;
      clock += step * 1000;

      const t = Math.min(video.currentTime, track.duration - 1e-3);
      if (t !== lastT) {
        lastT = t;
        const f = track.frames[Math.min(track.frames.length - 1, Math.round(t * fps))];
        view.draw(f.image.length ? f.image : null);
        presence.feed(player.goal(t, (clock - fedAt) / 1000, mirror), clock);
        fedAt = clock;
      }
      const pose = presence.output(clock);
      if (presence.lost !== wasLost) {
        wasLost = presence.lost;
        emit(wasLost ? { state: "lost", text: { zh: "这一段视频里没看到人", en: "No one in this part of the video" } } : { state: "tracking", text: along });
      }
      const r = retarget();
      return pose && r ? r.pose(pose, step) : null;
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
