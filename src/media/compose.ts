/**
 * The recorded frame: the stage canvas, the companion video (picture in picture or "真人 vs 奶蛙" side by side) and
 * a small plain "Naiwa Motion Lab" mark, drawn into a canvas of a fixed size (the long side capped, so phones and WeChat
 * can play the file) that the recorder captures.
 */
import type { RecordOptions } from "../contracts";
import { tr } from "../i18n";

export type Layout = NonNullable<RecordOptions["layout"]>;

export interface Compositor {
  readonly canvas: HTMLCanvasElement;
  stop(): void;
}

export interface ComposeOptions {
  companion: HTMLVideoElement | null;
  /** Called once, after the first frame is drawn (start recording then, so the clip opens on a real picture). */
  onFirstFrame: () => void;
  layout: Layout;
  fps: number;
  /** Long side of the recorded frame (px). */
  maxSide: number;
}

/** "真人 vs 奶蛙". */
const LABELS = { person: { zh: "真人", en: "Dancer" }, frog: { zh: "奶蛙", en: "Naiwa" } };
const GAP_COLOR = "#16130d";
const PANEL_COLOR = "#2a2418";
const STAGE_COLOR = "#fff3d1";

export function createCompositor(stage: HTMLCanvasElement, opts: ComposeOptions): Compositor {
  const video = opts.companion && opts.layout !== "frog" ? opts.companion : null;
  const layout: Layout = video ? opts.layout : "frog";
  const [w, h] = frameSize(stage, layout, opts.maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { alpha: false })!;
  // Nothing is drawn before the first composed frame: a canvas painted earlier hands that frame to the stream first.
  g.imageSmoothingQuality = "high";
  // What the user saw: a preview flipped by CSS (the mirrored camera) is recorded flipped too.
  const mirrored = video ? isMirrored(video) : false;
  const mark = watermark(Math.round(Math.min(w, h) * 0.022));
  const labels = { person: tr(LABELS.person), frog: tr(LABELS.frog) };
  const unit = Math.min(w, h) / 720;

  const draw = () => {
    g.fillStyle = GAP_COLOR;
    g.fillRect(0, 0, w, h);
    const ready = video !== null && video.readyState >= 2 && video.videoWidth > 0;
    if (layout === "side-by-side") {
      const gap = Math.round(6 * unit);
      const aV = ready ? video.videoWidth / video.videoHeight : 9 / 16;
      const [a, b] = split(w, h, gap, aV, stage.width / stage.height);
      panel(g, ready ? video : null, a.x, a.y, a.w, a.h, mirrored);
      panel(g, stage, b.x, b.y, b.w, b.h, false);
      label(g, labels.person, a.x + 14 * unit, a.y + 14 * unit, unit);
      label(g, labels.frog, b.x + 14 * unit, b.y + 14 * unit, unit);
    } else {
      panel(g, stage, 0, 0, w, h, false);
      if (layout === "pip" && ready) inset(g, video, w, h, unit, mirrored);
    }
    g.drawImage(mark, w - mark.width - Math.round(12 * unit), h - mark.height - Math.round(12 * unit));
  };

  // The stage's WebGL drawing buffer is readable only in the frame it was rendered, after its render: so draw in an
  // animation frame callback queued behind the stage's. Requested first from a task (outside any frame callback, so
  // it lands after the stage loop's already queued callback), then chained, which keeps that order every frame.
  let raf = 0;
  let last = -Infinity;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (now - last < 1000 / opts.fps - 4) return;
    const first = last === -Infinity;
    last = now;
    draw();
    if (first) opts.onFirstFrame();
  };
  const kick = setTimeout(() => (raf = requestAnimationFrame(tick)), 0);

  return {
    canvas,
    stop() {
      stopped = true;
      clearTimeout(kick);
      cancelAnimationFrame(raf);
    },
  };
}

/** Even sizes (H.264 needs them): the stage's shape, or 16:9 / 9:16 following the stage for side by side. */
function frameSize(stage: HTMLCanvasElement, layout: Layout, maxSide: number): [number, number] {
  const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
  const portrait = stage.height > stage.width;
  if (layout === "side-by-side") return portrait ? [even((maxSide * 9) / 16), even(maxSide)] : [even(maxSide), even((maxSide * 9) / 16)];
  const s = Math.min(1, maxSide / Math.max(stage.width, stage.height));
  return [even(stage.width * s), even(stage.height * s)];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The two panels of "真人 vs 奶蛙" (aV, aS: the video's and the stage's width/height). Side by side, unless a wide
 * video meets a portrait frame (then the video sits on top at its own shape). Side by side, a video that fits in half
 * the frame at full height gets exactly its width; otherwise both lose the same share of their sides.
 */
function split(w: number, h: number, gap: number, aV: number, aS: number): [Box, Box] {
  if (h > w && aV >= 1) {
    const hV = Math.round(Math.min(h * 0.5, w / aV));
    return [
      { x: 0, y: 0, w, h: hV },
      { x: 0, y: hV + gap, w, h: h - hV - gap },
    ];
  }
  const inner = w - gap;
  const exact = h * aV;
  const wV = Math.round(exact <= inner / 2 ? exact : inner * Math.min(0.65, Math.max(0.35, aV / (aV + aS))));
  return [
    { x: 0, y: 0, w: wV, h },
    { x: wV + gap, y: 0, w: w - wV - gap, h },
  ];
}

/** Fill a panel with a source scaled to the panel's full height (heads and feet are never cut; wide sources lose a
 *  little of their sides, narrow ones sit centred). */
function panel(
  g: CanvasRenderingContext2D,
  src: HTMLVideoElement | HTMLCanvasElement | null,
  x: number,
  y: number,
  pw: number,
  ph: number,
  mirrored: boolean,
): void {
  g.fillStyle = src instanceof HTMLCanvasElement ? STAGE_COLOR : PANEL_COLOR;
  g.fillRect(x, y, pw, ph);
  if (!src) return;
  const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
  const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
  if (!sw || !sh) return;
  const scale = ph / sh;
  // The part of the source that fits the panel's width.
  const cropW = Math.min(sw, pw / scale);
  const dw = cropW * scale;
  g.save();
  g.beginPath();
  g.rect(x, y, pw, ph);
  g.clip();
  const dx = x + (pw - dw) / 2;
  if (mirrored) {
    g.translate(dx + dw, y);
    g.scale(-1, 1);
    g.drawImage(src, (sw - cropW) / 2, 0, cropW, sh, 0, 0, dw, ph);
  } else {
    g.drawImage(src, (sw - cropW) / 2, 0, cropW, sh, dx, y, dw, ph);
  }
  g.restore();
}

/** The video as a rounded inset in the top-left corner, white-rimmed, with a soft shadow. */
function inset(g: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number, unit: number, mirrored: boolean): void {
  const a = video.videoWidth / video.videoHeight;
  let ih = h * (h > w ? 0.32 : 0.44);
  let iw = ih * a;
  const maxW = w * (h > w ? 0.46 : 0.36);
  if (iw > maxW) {
    iw = maxW;
    ih = iw / a;
  }
  const m = 16 * unit;
  const r = 10 * unit;
  const rim = 2 * unit;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.25)";
  g.shadowBlur = 10 * unit;
  g.shadowOffsetY = 2 * unit;
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.beginPath();
  g.roundRect(m - rim, m - rim, iw + 2 * rim, ih + 2 * rim, r + rim);
  g.fill();
  g.restore();
  g.save();
  g.beginPath();
  g.roundRect(m, m, iw, ih, r);
  g.clip();
  panel(g, video, m, m, iw, ih, mirrored);
  g.restore();
}

/** A plain caption: small white text with a soft shadow, readable on video and on the stage. */
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, unit: number): void {
  const size = Math.round(18 * unit);
  g.save();
  g.font = `600 ${size}px ${FONT}`;
  g.textBaseline = "top";
  g.shadowColor = "rgba(0,0,0,0.75)";
  g.shadowBlur = 5 * unit;
  g.fillStyle = "rgba(255,255,255,0.95)";
  g.fillText(text, x, y);
  g.restore();
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif';

/** "Naiwa Motion Lab" in small plain text with a soft shadow, drawn once. */
function watermark(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const g = c.getContext("2d")!;
  const font = `600 ${size}px ${FONT}`;
  const text = "Naiwa Motion Lab";
  g.font = font;
  const pad = Math.ceil(size * 0.4);
  c.width = Math.ceil(g.measureText(text).width) + 2 * pad;
  c.height = Math.ceil(size * 1.3) + 2 * pad;
  g.font = font;
  g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,0.7)";
  g.shadowBlur = size * 0.3;
  g.fillStyle = "rgba(255,255,255,0.78)";
  g.fillText(text, pad, c.height / 2);
  return c;
}

function isMirrored(el: HTMLElement): boolean {
  const t = getComputedStyle(el).transform;
  return t !== "none" && new DOMMatrix(t).a < 0;
}
