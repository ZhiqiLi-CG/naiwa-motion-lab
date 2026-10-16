/**
 * The frog's own life: blinking, breathing, little idle expressions and its reactions to what happens to it. Pure
 * state (no three.js objects); the character turns the outputs into morph weights, eye movements and the idle stance.
 */
import type { Expression, FrogEvent } from "../contracts";

/** What the frog is feeling, for sounds and effects (the integration may listen). */
export type Mood = "calm" | "surprised" | "giggling" | "laughing" | "flying" | "dizzy" | "relieved";

export interface LifeOutput {
  /** Expression targets of the life layer, 0..1. */
  expr: Record<Expression, number>;
  /** Hands on the belly (the signature laugh), 0..1. */
  holdBelly: number;
  /** Shaking with laughter, 0..1. */
  shake: number;
  /** Wriggling while tickled, 0..1. */
  squirm: number;
  /** Swaying head and spinning eyes, 0..1. */
  dizzy: number;
  /** The relieved sigh (slump then straighten), 0..1. */
  relief: number;
  /** Startle (arms up, lean back), 0..1. */
  startle: number;
  /** Breathing, -1 (out) … 1 (in). */
  breath: number;
  /** Extra gaze offset in radians around the eye's up and side axes (dizzy circles, glances, saccades). */
  gaze: { yaw: number; pitch: number; spin: number };
}

const EXPRS: Expression[] = ["laugh", "tongue", "blink", "surprise"];
const zero = (): Record<Expression, number> => ({ laugh: 0, tongue: 0, blink: 0, surprise: 0 });
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** How much each kind of event amuses it (repeated fun builds a giggle, then the big belly laugh). */
const FUN: Partial<Record<FrogEvent["kind"], number>> = { poke: 0.2, slap: 0.3, squish: 0.16, ball: 0.14, tickle: 0.07 };
const GIGGLE_AT = 0.35;
const LAUGH_AT = 1.1;
const LAUGH_TIME = 2.6;

export class Life {
  readonly out: LifeOutput = {
    expr: zero(), holdBelly: 0, shake: 0, squirm: 0, dizzy: 0, relief: 0, startle: 0, breath: 0,
    gaze: { yaw: 0, pitch: 0, spin: 0 },
  };
  mood: Mood = "calm";

  private t = 0;
  private rand: () => number;
  // Blinking.
  private nextBlink = 1.5;
  private blinkT = -1;
  private doubleBlink = false;
  // Reactions.
  private surprise = 0;
  private surpriseHold = 0;
  private fun = 0;
  private funIdle = 0;
  private laughT = 0;
  private tickle = 0;
  private grabbed = false;
  private flying = 0;
  private airTime = 0;
  private dizzyT = 0;
  private dizzyAmount = 0;
  private reliefT = 0;
  private uprightFor = 0;
  // Idle micro-expressions.
  private nextIdle = 6;
  private idleKind: "blep" | "smile" | "glance" | null = null;
  private idleT = 0;
  private glance = { yaw: 0, pitch: 0 };
  private saccadeT = 0.5;
  private saccade = { yaw: 0, pitch: 0 };

  constructor(random: () => number = Math.random) {
    this.rand = random;
  }

  react(e: FrogEvent, upright: number): void {
    if (!this.lively) return;
    const s = clamp01(e.strength);
    const belly = e.region === "belly" ? 1.5 : 1;
    const fun = (FUN[e.kind] ?? 0) * belly * (0.5 + s);
    if (fun) {
      this.fun += fun;
      this.funIdle = 0;
    }
    switch (e.kind) {
      case "poke":
      case "slap":
      case "ball":
        if (this.laughT <= 0) this.startle(0.45 + 0.55 * s, e.kind === "slap" ? 0.5 : 0.3);
        break;
      case "squish":
        this.startle(0.25 + 0.3 * s, 0.2);
        break;
      case "tickle":
        this.tickle = Math.min(1, this.tickle + 0.12 + 0.2 * s);
        break;
      case "grab":
        this.grabbed = true;
        this.startle(0.8, 0.4);
        break;
      case "release":
        this.grabbed = false;
        if (s > 0.2) {
          this.flying = s;
          this.airTime = 0;
        }
        break;
      case "land": {
        const hard = Math.max(s, this.flying ? 0.35 + 0.4 * this.flying + 0.3 * Math.min(this.airTime, 1.5) : 0);
        this.flying = 0;
        if (hard > 0.25) {
          this.dizzyAmount = clamp01(hard);
          this.dizzyT = 1 + 2.2 * this.dizzyAmount * (upright > 0.8 ? 0.6 : 1);
          this.reliefT = 0;
          this.uprightFor = 0;
        }
        break;
      }
    }
    if (this.fun >= LAUGH_AT && this.laughT <= 0 && this.dizzyT <= 0) {
      this.laughT = LAUGH_TIME;
      this.fun = GIGGLE_AT;
    }
  }

  private startle(amount: number, hold: number): void {
    this.surprise = Math.max(this.surprise, amount);
    this.surpriseHold = Math.max(this.surpriseHold, hold);
  }

  /** Off: the frog holds still with a neutral face (stills, tests); reactions are ignored. */
  lively = true;

  /** upright: how upright the body is (1 standing … -1 upside down). */
  update(dt: number, upright: number): LifeOutput {
    this.t += dt;
    const o = this.out;
    const e = o.expr;
    for (const k of EXPRS) e[k] = 0;
    if (!this.lively) {
      Object.assign(o, { holdBelly: 0, shake: 0, squirm: 0, dizzy: 0, relief: 0, startle: 0, breath: 0 });
      Object.assign(o.gaze, { yaw: 0, pitch: 0, spin: 0 });
      this.mood = "calm";
      return o;
    }
    const r = this.rand;

    // Startle: held a moment, then fades.
    if (this.surpriseHold > 0) this.surpriseHold -= dt;
    else this.surprise = Math.max(0, this.surprise - dt * 2.2);
    if (this.grabbed) this.surprise = Math.max(this.surprise, 0.45);
    o.startle = this.surprise;

    // Fun fades once nothing has happened for a moment; tickling fades fast.
    this.funIdle += dt;
    if (this.funIdle > 0.8) this.fun = Math.max(0, this.fun - dt * 0.35);
    this.tickle = Math.max(0, this.tickle - dt * 1.6);
    o.squirm = this.tickle;

    // Laughing: the big belly laugh, else a giggle when amused (tickling giggles at once).
    let laugh = 0;
    let hold = 0;
    let shake = 0;
    if (this.laughT > 0) {
      this.laughT -= dt;
      const env = clamp01(Math.min((LAUGH_TIME - this.laughT) / 0.25, this.laughT / 0.6));
      laugh = env * (0.88 + 0.12 * Math.sin(this.t * 2 * Math.PI * 7.5));
      hold = env;
      shake = env;
      if (this.laughT <= 0 && this.tickle > 0.3) this.laughT = LAUGH_TIME; // keeps laughing while still tickled
    } else {
      const g = clamp01(Math.max((this.fun - GIGGLE_AT * 0.5) / GIGGLE_AT, this.tickle * 1.4));
      if (g > 0) {
        // "hehehe": the mouth pops open and shut a few times a second.
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 2 * Math.PI * 5.5);
        laugh = g * (0.32 + 0.38 * pulse);
        shake = g * 0.45;
        hold = g * 0.35;
      }
    }
    e.laugh = laugh;
    o.holdBelly = hold;
    o.shake = shake;

    // Flying through the air: wide-eyed grin with the tongue out.
    if (this.flying > 0) {
      this.airTime += dt;
      e.tongue = 0.75;
      e.surprise = Math.max(e.surprise, 0.35);
      if (this.airTime > 4) this.flying = 0; // never landed (the sim said nothing)
    }

    // Dizzy after a landing, then relief once it stands upright again.
    if (this.dizzyT > 0) {
      this.dizzyT -= dt;
      const d = this.dizzyAmount * clamp01(this.dizzyT / 0.8);
      o.dizzy = d;
      e.tongue = Math.max(e.tongue, 0.6 * d);
      e.blink = Math.max(e.blink, 0.18 * d);
      if (this.dizzyT <= 0) {
        if (upright > 0.8) this.reliefT = 2.2;
        else this.dizzyT = 0.3; // still lying there: stays woozy until it is back on its feet
      }
      this.uprightFor = 0;
    } else {
      o.dizzy = 0;
      if (this.reliefT <= 0 && this.dizzyAmount > 0) {
        this.uprightFor = upright > 0.85 ? this.uprightFor + dt : 0;
        if (this.uprightFor > 0.4) this.reliefT = 2.2;
      }
    }
    if (this.reliefT > 0) {
      this.reliefT -= dt;
      const x = clamp01(Math.min((2.2 - this.reliefT) / 0.3, this.reliefT / 0.8));
      o.relief = x;
      e.blink = Math.max(e.blink, 0.55 * x);
      e.laugh = Math.max(e.laugh, 0.18 * x);
      if (this.reliefT <= 0) this.dizzyAmount = 0;
    } else o.relief = 0;

    e.surprise = Math.max(e.surprise, this.surprise);

    // Breathing: slow, a deep breath now and then; faster after excitement.
    const excited = clamp01(this.fun + o.dizzy + this.surprise);
    o.breath = Math.sin(this.t * 2 * Math.PI * (0.28 + 0.25 * excited));

    // Idle micro-expressions while nothing is going on.
    const calm = this.surprise < 0.05 && laugh < 0.05 && this.flying === 0 && o.dizzy === 0 && o.relief === 0;
    if (calm) {
      this.nextIdle -= dt;
      if (this.nextIdle <= 0 && !this.idleKind) {
        const p = r();
        this.idleKind = p < 0.35 ? "glance" : p < 0.65 ? "blep" : "smile";
        this.idleT = this.idleKind === "glance" ? 1.4 : this.idleKind === "blep" ? 0.9 : 1.8;
        this.glance = { yaw: (r() - 0.5) * 1.2, pitch: (r() - 0.4) * 0.5 };
        this.nextIdle = 6 + 8 * r();
      }
    } else if (this.idleKind) this.idleT = Math.min(this.idleT, 0.2);
    let gYaw = 0, gPitch = 0;
    if (this.idleKind) {
      this.idleT -= dt;
      const x = clamp01(Math.min(this.idleT / 0.2, 1));
      if (this.idleKind === "blep") e.tongue = Math.max(e.tongue, 0.55 * x);
      else if (this.idleKind === "smile") e.laugh = Math.max(e.laugh, 0.16 * x);
      else {
        gYaw = this.glance.yaw * x;
        gPitch = this.glance.pitch * x;
      }
      if (this.idleT <= 0) this.idleKind = null;
    }

    // Small saccades keep the eyes alive.
    this.saccadeT -= dt;
    if (this.saccadeT <= 0) {
      this.saccadeT = 0.4 + 1.4 * r();
      this.saccade = { yaw: (r() - 0.5) * 0.12, pitch: (r() - 0.5) * 0.08 };
    }
    o.gaze.yaw = gYaw + this.saccade.yaw;
    o.gaze.pitch = gPitch + this.saccade.pitch;
    o.gaze.spin = o.dizzy;

    // Blinking (not while startled or laughing with the eyes already squeezed shut).
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0 && this.surprise < 0.4) {
      this.blinkT = 0;
      this.doubleBlink = r() < 0.18;
      this.nextBlink = 1.8 + 3.8 * r();
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      // Fast close, a brief hold, slower open.
      const t = this.blinkT;
      const b = t < 0.06 ? t / 0.06 : t < 0.09 ? 1 : 1 - (t - 0.09) / 0.1;
      e.blink = Math.max(e.blink, clamp01(b));
      if (t > 0.19) {
        this.blinkT = this.doubleBlink ? -0.12 : -1;
        this.doubleBlink = false;
      }
    } else if (this.blinkT > -1 && this.blinkT < 0) {
      this.blinkT += dt;
      if (this.blinkT >= 0) this.blinkT = 0;
    }

    this.mood =
      this.laughT > 0 ? "laughing"
      : this.flying > 0 ? "flying"
      : o.dizzy > 0.05 ? "dizzy"
      : o.relief > 0.05 ? "relieved"
      : laugh > 0.05 ? "giggling"
      : this.surprise > 0.3 ? "surprised"
      : "calm";
    return o;
  }
}
