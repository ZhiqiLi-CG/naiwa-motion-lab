/** Pointer gestures, the same for mouse, pen and touch. A press on the frog (handler.hitTest) is an interaction:
 *  press start/end around everything, a tap if it is short and still, a drag once it moves; a fast swipe across the
 *  frog is a slap when the handler wants swipes. A press elsewhere orbits once it moves, or is a tap. Two touches
 *  pinch to zoom (and orbit with their middle). The recogniser is plain logic over (x, y, t) so it can be tested. */
import * as THREE from "three";
import type { GestureHandler, PointerInfo } from "../contracts";

export interface StageGestureHandler extends GestureHandler {
  /** A fast swipe across the frog: it started on the frog moving fast, or swept over it from the background.
   *  p is where it crossed the frog; velocity in px/s. Without this member such swipes are drags (from the frog) or
   *  orbit (from the background). */
  onSwipe?(p: PointerInfo, velocity: THREE.Vector2): void;
}

/** What the recogniser drives besides the handler: rays for client points and the camera. */
export interface GestureHost {
  info(x: number, y: number, t: number, pointerType: string): PointerInfo;
  /** Orbit by a pointer movement (px); orbitStart marks where a gesture began so orbitCancel can undo it. */
  orbitStart(): void;
  orbit(dx: number, dy: number): void;
  orbitCancel(): void;
  /** Release of an orbit drag with this pointer velocity (px/s). */
  fling(vx: number, vy: number): void;
  zoom(factor: number): void;
}

export const SLOP_PX: Record<string, number> = { mouse: 5, pen: 8, touch: 12 };
export const TAP_MS = 400;
/** Pointer speed that makes a swipe a slap rather than a grab or an orbit (CSS px/s). */
export const SWIPE_SPEED = 1000;
/** A press on the frog is a slap only if it is that fast this early (pressing, waiting, then yanking throws). */
export const SWIPE_START_MS = 150;
/** Only this young a background gesture can still turn into a slap. */
export const SWIPE_WINDOW_MS = 350;
const VELOCITY_WINDOW_MS = 80;
/** Held still this long before release: no fling, no throw. */
const STILL_MS = 70;
const SWEEP_STEP_PX = 10;
const KEEP_MS = 160;

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Track {
  id: number;
  type: string;
  x0: number;
  y0: number;
  t0: number;
  x: number;
  y: number;
  t: number;
  samples: Sample[];
}

type Phase = "press" | "drag" | "swiped" | "background" | "orbit" | "pinch";

const ZERO = new THREE.Vector2();

/** Velocity over the last few samples (px/s); zero if the pointer stopped before `now`. */
export function estimateVelocity(samples: readonly Sample[], now: number, out = new THREE.Vector2()): THREE.Vector2 {
  out.set(0, 0);
  const n = samples.length;
  if (n < 2) return out;
  const last = samples[n - 1];
  if (now - last.t > STILL_MS) return out;
  let i = n - 2;
  while (i > 0 && last.t - samples[i - 1].t <= VELOCITY_WINDOW_MS) i--;
  const ref = samples[i];
  const dt = (last.t - ref.t) / 1000;
  if (dt <= 0) return out;
  return out.set((last.x - ref.x) / dt, (last.y - ref.y) / dt);
}

export class GestureRecognizer {
  handler: StageGestureHandler | null = null;
  private tracks = new Map<number, Track>();
  private phase: Phase | null = null;
  private onFrog = false;
  private primary: Track | null = null;
  private pinchDist = 0;
  private pinchX = 0;
  private pinchY = 0;

  constructor(private readonly host: GestureHost) {}

  /** Whether a gesture is in progress (for hover handling by the caller). */
  get active(): boolean {
    return this.phase !== null;
  }

  down(id: number, x: number, y: number, t: number, type: string): void {
    if (this.tracks.size >= 2) return;
    const track: Track = { id, type, x0: x, y0: y, t0: t, x, y, t, samples: [{ x, y, t }] };
    this.tracks.set(id, track);
    const h = this.handler;
    if (this.tracks.size === 1) {
      this.primary = track;
      const p = this.host.info(x, y, t, type);
      this.onFrog = h ? h.hitTest(p.ray) : false;
      this.host.orbitStart();
      if (this.onFrog) {
        this.phase = "press";
        h?.onPressStart?.(p);
      } else {
        this.phase = "background";
      }
      h?.onHover(p);
      return;
    }
    // A second finger: whatever the first was doing ends, and the two pinch.
    const first = this.primary!;
    const p = this.host.info(first.x, first.y, t, first.type);
    if (this.phase === "drag") h?.onDragEnd(p, ZERO.clone());
    if (this.onFrog) h?.onPressEnd?.(p);
    this.onFrog = false;
    this.phase = "pinch";
    this.startPinch();
  }

  /** samples: the coalesced positions since the last call, oldest first. */
  move(id: number, samples: readonly Sample[], type: string): void {
    const h = this.handler;
    const track = this.tracks.get(id);
    const last = samples[samples.length - 1];
    if (!track) {
      // Hover (mouse and pen only report movement without a press).
      if (!this.phase && h) h.onHover(this.host.info(last.x, last.y, last.t, type));
      return;
    }
    const px = track.x;
    const py = track.y;
    for (const s of samples) track.samples.push(s);
    while (track.samples.length > 2 && last.t - track.samples[0].t > KEEP_MS) track.samples.shift();
    track.x = last.x;
    track.y = last.y;
    track.t = last.t;

    if (this.phase === "pinch") {
      this.movePinch();
      return;
    }
    if (track !== this.primary) return;
    const p = this.host.info(last.x, last.y, last.t, type);
    h?.onHover(p);
    const moved = Math.hypot(last.x - track.x0, last.y - track.y0) > (SLOP_PX[type] ?? SLOP_PX.mouse);

    switch (this.phase) {
      case "press": {
        if (!moved || !h) return;
        const v = estimateVelocity(track.samples, last.t);
        if (h.onSwipe && last.t - track.t0 <= SWIPE_START_MS && v.length() >= SWIPE_SPEED) {
          this.phase = "swiped";
          h.onSwipe(this.host.info(track.x0, track.y0, last.t, type), v);
          return;
        }
        this.phase = "drag";
        h.onDragStart(this.host.info(track.x0, track.y0, track.t0, type));
        h.onDragMove(p);
        return;
      }
      case "drag":
        h?.onDragMove(p);
        return;
      case "background":
        if (!moved) return;
        this.phase = "orbit";
        if (this.sweep(track, track.x0, track.y0)) return;
        this.host.orbit(last.x - track.x0, last.y - track.y0);
        return;
      case "orbit":
        if (this.sweep(track, px, py)) return;
        this.host.orbit(last.x - px, last.y - py);
        return;
      default:
        return;
    }
  }

  up(id: number, x: number, y: number, t: number): void {
    this.end(id, x, y, t, false);
  }

  cancel(id: number, t: number): void {
    const track = this.tracks.get(id);
    if (track) this.end(id, track.x, track.y, t, true);
  }

  /** The mouse left the canvas. */
  leave(): void {
    if (!this.phase) this.handler?.onHover(null);
  }

  wheel(deltaPx: number, pinch: boolean): void {
    this.host.zoom(Math.exp(deltaPx * (pinch ? 0.01 : 0.0012)));
  }

  private end(id: number, x: number, y: number, t: number, cancelled: boolean): void {
    const track = this.tracks.get(id);
    if (!track) return;
    this.tracks.delete(id);
    const h = this.handler;
    if (x !== track.x || y !== track.y) track.samples.push({ x, y, t });
    track.x = x;
    track.y = y;

    if (this.phase === "pinch") {
      const rest = [...this.tracks.values()][0];
      if (rest) {
        // The remaining finger carries on orbiting from where it is.
        this.primary = rest;
        rest.samples = [{ x: rest.x, y: rest.y, t }];
        this.phase = "orbit";
      } else {
        this.finish(track);
      }
      return;
    }
    if (track !== this.primary) return;

    const p = this.host.info(x, y, t, track.type);
    const tap = !cancelled && t - track.t0 <= TAP_MS;
    switch (this.phase) {
      case "press":
        if (tap) h?.onTap(p);
        break;
      case "drag":
        h?.onDragEnd(p, cancelled ? ZERO.clone() : estimateVelocity(track.samples, t));
        break;
      case "background":
        if (tap) h?.onTap(p);
        break;
      case "orbit": {
        const v = cancelled ? ZERO : estimateVelocity(track.samples, t);
        this.host.fling(v.x, v.y);
        break;
      }
      default:
        break;
    }
    if (this.onFrog) h?.onPressEnd?.(p);
    this.finish(track);
  }

  private finish(track: Track): void {
    this.phase = null;
    this.primary = null;
    this.onFrog = false;
    this.tracks.clear();
    // A finger is gone from the screen: stop looking at where it was. A mouse is still hovering.
    if (track.type !== "mouse") this.handler?.onHover(null);
  }

  /** A young fast background gesture sweeping over the frog becomes a slap there (and undoes its orbit). */
  private sweep(track: Track, fromX: number, fromY: number): boolean {
    const h = this.handler;
    if (!h?.onSwipe || track.t - track.t0 > SWIPE_WINDOW_MS) return false;
    const v = estimateVelocity(track.samples, track.t);
    if (v.length() < SWIPE_SPEED) return false;
    const len = Math.hypot(track.x - fromX, track.y - fromY);
    const steps = Math.max(1, Math.ceil(len / SWEEP_STEP_PX));
    for (let i = 1; i <= steps; i++) {
      const x = fromX + ((track.x - fromX) * i) / steps;
      const y = fromY + ((track.y - fromY) * i) / steps;
      const p = this.host.info(x, y, track.t, track.type);
      if (h.hitTest(p.ray)) {
        this.phase = "swiped";
        this.host.orbitCancel();
        h.onSwipe(p, v);
        return true;
      }
    }
    return false;
  }

  private startPinch(): void {
    const [a, b] = [...this.tracks.values()];
    this.pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.pinchX = (a.x + b.x) / 2;
    this.pinchY = (a.y + b.y) / 2;
  }

  private movePinch(): void {
    const [a, b] = [...this.tracks.values()];
    if (!a || !b) return;
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    this.host.zoom(this.pinchDist / dist);
    this.host.orbit(cx - this.pinchX, cy - this.pinchY);
    this.pinchDist = dist;
    this.pinchX = cx;
    this.pinchY = cy;
  }
}

/** Wire DOM pointer events of the canvas to a recogniser. Returns the unbind function. */
export function bindPointerEvents(el: HTMLElement, rec: GestureRecognizer): () => void {
  const type = (e: PointerEvent) => e.pointerType || "mouse";
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    rec.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, type(e));
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    const list = e.getCoalescedEvents?.() ?? [];
    const evs = list.length ? list : [e];
    rec.move(
      e.pointerId,
      evs.map((c) => ({ x: c.clientX, y: c.clientY, t: c.timeStamp })),
      type(e),
    );
  };
  const onUp = (e: PointerEvent) => rec.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  const onCancel = (e: PointerEvent) => rec.cancel(e.pointerId, e.timeStamp);
  const onLeave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") rec.leave();
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    rec.wheel(e.deltaY * unit, e.ctrlKey);
  };
  const prevent = (e: Event) => e.preventDefault();
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("contextmenu", prevent);
  // iOS Safari zooms the page on pinch unless its own gesture events are cancelled too.
  el.addEventListener("gesturestart", prevent);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("contextmenu", prevent);
    el.removeEventListener("gesturestart", prevent);
  };
}
