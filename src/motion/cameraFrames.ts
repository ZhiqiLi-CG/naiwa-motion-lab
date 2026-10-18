/**
 * The camera estimate during an uploaded video's analysis (browser): each frame the detector sees is also drawn small
 * (CAMERA_SIZE on its long side) into a canvas kept on the CPU, turned to grayscale and handed to the estimator
 * (cameraMotion.ts) with the boxes of every person the detector found, so dancers do not count as background.
 */
import { CAMERA_SIZE, CameraEstimator, personBoxes, type CameraStep } from "./cameraMotion";

export class VideoCamera {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gray: Uint8Array;
  private readonly estimator = new CameraEstimator();
  readonly w: number;
  readonly h: number;
  /** The last people seen and how many frames ago (a missed detection must not make a dancer background). */
  private lastPeople: number[][][] = [];
  private missed = 0;
  /** Milliseconds spent drawing and reading back the frames, and estimating; frames seen. */
  grabMs = 0;
  estimateMs = 0;
  frames = 0;
  get ms(): number {
    return this.grabMs + this.estimateMs;
  }

  constructor(video: HTMLVideoElement) {
    const vw = Math.max(1, video.videoWidth), vh = Math.max(1, video.videoHeight);
    const k = CAMERA_SIZE / Math.max(vw, vh);
    this.w = Math.max(16, Math.round(vw * k));
    this.h = Math.max(16, Math.round(vh * k));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.ctx.imageSmoothingQuality = "low";
    this.gray = new Uint8Array(this.w * this.h);
  }

  /** The frame now on screen, with the image landmarks of everyone detected in it. */
  push(video: HTMLVideoElement, people: number[][][]): CameraStep {
    const t0 = performance.now();
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    const rgba = this.ctx.getImageData(0, 0, this.w, this.h).data;
    for (let i = 0, j = 0; i < this.gray.length; i++, j += 4) this.gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    const t1 = performance.now();
    if (people.length) (this.lastPeople = people), (this.missed = 0);
    else if (++this.missed <= 30) people = this.lastPeople;
    const step = this.estimator.push(this.gray, this.w, this.h, personBoxes(people));
    this.grabMs += t1 - t0;
    this.estimateMs += performance.now() - t1;
    this.frames++;
    return step;
  }
}
