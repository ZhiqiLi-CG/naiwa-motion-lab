/**
 * The frog's own life, kept quiet so the motion and the flesh read cleanly: blinking, breathing, small eye
 * movements, and a brief surprise when something hits it hard. Pure state; the character turns it into morph
 * weights, eye movements and the idle stance.
 */
import type { Expression, FrogEvent } from "../contracts";

export interface LifeOutput {
  /** Expression weights of the life layer, 0..1. */
  expr: Record<Expression, number>;
  /** The brief surprise, 0..1 (a slight lean back in the idle stance). */
  startle: number;
  /** Breathing, -1 (out) … 1 (in). */
  breath: number;
  /** Small saccades: gaze offset around the eye's up and side axes (radians). */
  gaze: { yaw: number; pitch: number };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Hits below this strength get no reaction. */
const STARTLE_FROM = 0.5;
const STARTLING: FrogEvent["kind"][] = ["poke", "slap", "ball", "grab"];

export class Life {
  readonly out: LifeOutput = { expr: { laugh: 0, tongue: 0, blink: 0, surprise: 0 }, startle: 0, breath: 0, gaze: { yaw: 0, pitch: 0 } };
  /** Off: the frog holds still with a neutral face (stills, tests); hits are ignored. */
  lively = true;

  private t = 0;
  private nextBlink = 1.5;
  private blinkT = -1;
  private surprise = 0;
  private hold = 0;
  private saccadeT = 0.5;

  constructor(private rand: () => number = Math.random) {}

  react(e: FrogEvent): void {
    if (!this.lively || !STARTLING.includes(e.kind) || e.strength < STARTLE_FROM) return;
    this.surprise = Math.max(this.surprise, 0.45 + 0.55 * clamp01((e.strength - STARTLE_FROM) / (1 - STARTLE_FROM)));
    this.hold = 0.18;
  }

  update(dt: number): LifeOutput {
    const o = this.out, e = o.expr, r = this.rand;
    e.laugh = e.tongue = e.blink = e.surprise = 0;
    if (!this.lively) {
      o.startle = o.breath = o.gaze.yaw = o.gaze.pitch = 0;
      return o;
    }
    this.t += dt;

    // Surprise: held a moment, then gone within half a second.
    if (this.hold > 0) this.hold -= dt;
    else this.surprise = Math.max(0, this.surprise - dt * 2.4);
    e.surprise = o.startle = this.surprise;

    o.breath = Math.sin(this.t * 2 * Math.PI * 0.28);

    // Saccades keep the eyes alive.
    this.saccadeT -= dt;
    if (this.saccadeT <= 0) {
      this.saccadeT = 0.5 + 1.6 * r();
      o.gaze.yaw = (r() - 0.5) * 0.1;
      o.gaze.pitch = (r() - 0.5) * 0.06;
    }

    // Blinks every few seconds, now and then a double one; not while surprised.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0 && this.surprise < 0.3) {
      this.blinkT = 0;
      this.nextBlink = r() < 0.15 ? 0.3 : 2 + 3.5 * r();
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      // Fast close, a brief hold, slower open.
      const t = this.blinkT;
      e.blink = clamp01(t < 0.06 ? t / 0.06 : t < 0.09 ? 1 : 1 - (t - 0.09) / 0.1);
      if (t > 0.19) this.blinkT = -1;
    }
    return o;
  }
}
