/**
 * The sound effects, synthesized: each voice builds a small WebAudio graph on any BaseAudioContext (so the same code
 * renders in an OfflineAudioContext for checks) and returns the time it ends. Nothing is sampled.
 */
import type { SfxKind } from "../contracts";

export type Rnd = () => number;

export interface VoiceArgs {
  ctx: BaseAudioContext;
  out: AudioNode;
  /** Start time (ctx seconds). */
  t: number;
  /** Strength 0..1. */
  s: number;
  rnd: Rnd;
}

type VoiceFn = (v: VoiceArgs) => number;

const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
/** A random factor around 1, ±range. */
const vary = (rnd: Rnd, range: number) => 1 + (rnd() * 2 - 1) * range;
const SILENT = 1e-4;

/* ---------------------------------------------------------------------------------------------------------------- */
/* Building blocks                                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Two seconds of white noise per context (fixed seed: renders are repeatable). */
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let x = 0x9e3779b9;
    for (let i = 0; i < d.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      d[i] = ((x >>> 0) / 0xffffffff) * 2 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function noise(v: VoiceArgs, start: number, end: number): AudioBufferSourceNode {
  const src = v.ctx.createBufferSource();
  src.buffer = noiseBuffer(v.ctx);
  src.loop = true;
  src.start(start, v.rnd() * 1.5);
  src.stop(end);
  return src;
}

function osc(v: VoiceArgs, type: OscillatorType, start: number, end: number): OscillatorNode {
  const o = v.ctx.createOscillator();
  o.type = type;
  o.start(start);
  o.stop(end);
  return o;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** A gain with a percussive envelope: rise to peak in attack seconds, exponential fall to silence by end. */
function perc(ctx: BaseAudioContext, t: number, attack: number, peak: number, end: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, end);
  g.gain.setValueAtTime(0, end);
  return g;
}

function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Effects                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

/** "DUANG~": a rubbery spring. Harder = lower, longer and wobblier. */
const boing: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const f0 = lerp(560, 210, s) * vary(rnd, 0.08);
  const dur = lerp(0.38, 0.95, s) * vary(rnd, 0.1);
  const end = t + dur;

  const body = osc(v, "triangle", t, end);
  const reed = osc(v, "sawtooth", t, end);
  for (const o of [body, reed]) {
    o.frequency.setValueAtTime(f0 * 0.55, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(f0 * lerp(0.82, 0.7, s), end);
  }
  // The wobble: a vibrato whose depth dies away, the same LFO sweeping the reed's resonance.
  const lfo = osc(v, "sine", t, end);
  lfo.frequency.setValueAtTime(lerp(17, 11, s) * vary(rnd, 0.1), t);
  lfo.frequency.linearRampToValueAtTime(lerp(13, 8, s), end);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(f0 * lerp(0.14, 0.24, s), t);
  depth.gain.exponentialRampToValueAtTime(f0 * 0.01, end);
  lfo.connect(depth);
  depth.connect(body.frequency);
  depth.connect(reed.frequency);

  const res = filter(ctx, "lowpass", f0 * 3, 9);
  const sweep = ctx.createGain();
  sweep.gain.value = 4;
  depth.connect(sweep).connect(res.frequency);
  res.frequency.setValueAtTime(f0 * 4, t);
  res.frequency.exponentialRampToValueAtTime(f0 * 1.6, end);

  const amp = perc(ctx, t, 0.006, lerp(0.35, 0.6, s), end);
  const reedGain = ctx.createGain();
  reedGain.gain.value = 0.35;
  body.connect(amp);
  chain(reed, res, reedGain, amp);
  amp.connect(v.out);
  return end;
};

/** Wet squelch: noise through a falling resonance, gurgling, with a low blorp under it. */
const squish: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const dur = lerp(0.18, 0.42, s) * vary(rnd, 0.15);
  const end = t + dur;

  const bp = filter(ctx, "bandpass", 1, lerp(5, 3, s));
  bp.frequency.setValueAtTime(lerp(1900, 1300, s) * vary(rnd, 0.15), t);
  bp.frequency.exponentialRampToValueAtTime(280, end);
  const env = perc(ctx, t, 0.012, lerp(0.7, 1.1, s), end);
  // Bubbles: an irregular tremolo.
  const bubbles = ctx.createGain();
  bubbles.gain.value = 0.55;
  const lfo = osc(v, "square", t, end);
  lfo.frequency.setValueAtTime(lerp(28, 45, rnd()), t);
  lfo.frequency.linearRampToValueAtTime(lerp(14, 24, rnd()), end);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth).connect(bubbles.gain);
  chain(noise(v, t, end), bp, env, bubbles, v.out);

  const blorp = osc(v, "sine", t, end);
  blorp.frequency.setValueAtTime(lerp(300, 170, s) * vary(rnd, 0.1), t);
  blorp.frequency.exponentialRampToValueAtTime(lerp(110, 65, s), end);
  chain(blorp, perc(ctx, t, 0.015, lerp(0.18, 0.32, s), end), v.out);
  return end;
};

/** A smack on soft skin: a bright crack and a fleshy thump. */
const slap: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const end = t + lerp(0.1, 0.2, s);

  const hp = filter(ctx, "highpass", 700);
  const tone = filter(ctx, "peaking", 2400 * vary(rnd, 0.15), 1.2);
  tone.gain.value = 8;
  const lp = filter(ctx, "lowpass", lerp(4000, 9000, s));
  chain(noise(v, t, end), hp, tone, lp, perc(ctx, t, 0.001, lerp(0.45, 0.75, s), t + lerp(0.06, 0.12, s)), v.out);

  const thump = osc(v, "sine", t, end);
  thump.frequency.setValueAtTime(lerp(240, 190, s) * vary(rnd, 0.1), t);
  thump.frequency.exponentialRampToValueAtTime(80, t + 0.09);
  chain(thump, perc(ctx, t, 0.002, lerp(0.3, 0.5, s), end), v.out);
  return end;
};

/** A cartoon mouth pop: a quick upward bloop with a click. */
const pop: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const end = t + 0.11;
  const p = vary(rnd, 0.12);
  const o = osc(v, "sine", t, end);
  o.frequency.setValueAtTime(lerp(320, 240, s) * p, t);
  o.frequency.exponentialRampToValueAtTime(lerp(1000, 1400, s) * p, t + 0.05);
  chain(o, perc(ctx, t, 0.003, lerp(0.35, 0.55, s), end), v.out);
  chain(noise(v, t, t + 0.01), filter(ctx, "highpass", 2500), perc(ctx, t, 0.0005, 0.25, t + 0.008), v.out);
  return end;
};

/** Air rushing past, sweeping across the stereo field. */
const whoosh: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const dur = lerp(0.28, 0.6, s) * vary(rnd, 0.12);
  const end = t + dur;
  const peakAt = t + dur * 0.45;

  const wide = filter(ctx, "bandpass", 1, 1.4);
  const whistle = filter(ctx, "bandpass", 1, 7);
  for (const f of [wide, whistle]) {
    f.frequency.setValueAtTime(380, t);
    f.frequency.exponentialRampToValueAtTime(lerp(1500, 2800, s) * vary(rnd, 0.15), peakAt);
    f.frequency.exponentialRampToValueAtTime(500, end);
  }
  const env = v.ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(lerp(0.9, 1.3, s), peakAt);
  env.gain.linearRampToValueAtTime(0, end);
  const whistleGain = ctx.createGain();
  whistleGain.gain.value = 0.5;
  const pan = ctx.createStereoPanner();
  const dir = rnd() < 0.5 ? -1 : 1;
  pan.pan.setValueAtTime(-0.6 * dir, t);
  pan.pan.linearRampToValueAtTime(0.6 * dir, end);
  const src = noise(v, t, end);
  src.connect(wide).connect(env);
  src.connect(whistle).connect(whistleGain).connect(env);
  chain(env, pan, v.out);
  return end;
};

/** A soft heavy body hitting the floor: low thud, a mid knock phones can play, a flub of flesh. */
const land: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const end = t + lerp(0.25, 0.5, s);

  const low = osc(v, "sine", t, end);
  low.frequency.setValueAtTime(lerp(120, 95, s) * vary(rnd, 0.08), t);
  low.frequency.exponentialRampToValueAtTime(42, end);
  chain(low, perc(ctx, t, 0.004, lerp(0.5, 0.8, s), end), v.out);

  const knock = osc(v, "triangle", t, t + 0.15);
  knock.frequency.setValueAtTime(lerp(260, 200, s) * vary(rnd, 0.1), t);
  knock.frequency.exponentialRampToValueAtTime(110, t + 0.15);
  chain(knock, perc(ctx, t, 0.002, lerp(0.2, 0.3, s), t + 0.15), v.out);

  const flub = filter(ctx, "bandpass", 420 * vary(rnd, 0.15), 2.5);
  chain(noise(v, t, t + 0.2), flub, perc(ctx, t + 0.005, 0.006, lerp(0.5, 0.9, s), t + 0.2), v.out);
  return end;
};

/** A rubber ball: a short pitched bonk with an inharmonic overtone. */
const ball: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const f = lerp(700, 480, s) * vary(rnd, 0.1);
  const end = t + 0.16;
  const a = osc(v, "sine", t, end);
  a.frequency.setValueAtTime(f * 1.2, t);
  a.frequency.exponentialRampToValueAtTime(f, t + 0.012);
  chain(a, perc(ctx, t, 0.001, lerp(0.35, 0.6, s), end), v.out);
  const b = osc(v, "sine", t, t + 0.06);
  b.frequency.value = f * 2.63;
  chain(b, perc(ctx, t, 0.001, lerp(0.12, 0.2, s), t + 0.06), v.out);
  chain(noise(v, t, t + 0.008), filter(ctx, "bandpass", 3000, 1), perc(ctx, t, 0.0005, 0.3, t + 0.006), v.out);
  return end;
};

/** One stroke of a pump, with the belly's rubbery squeak rising as it fills (strength = how full). */
const pump: VoiceFn = (v) => {
  const { ctx, t, s, rnd } = v;
  const dur = 0.3 * vary(rnd, 0.1);
  const end = t + dur;

  const air = filter(ctx, "bandpass", 1, 2);
  air.frequency.setValueAtTime(500, t);
  air.frequency.exponentialRampToValueAtTime(1800, end);
  const airEnv = ctx.createGain();
  airEnv.gain.setValueAtTime(0, t);
  airEnv.gain.linearRampToValueAtTime(0.8, t + 0.05);
  airEnv.gain.setValueAtTime(0.8, end - 0.08);
  airEnv.gain.linearRampToValueAtTime(0, end);
  chain(noise(v, t, end), air, airEnv, v.out);

  const f = lerp(300, 950, s) * vary(rnd, 0.05);
  const squeak = osc(v, "triangle", t + 0.04, end);
  squeak.frequency.setValueAtTime(f, t + 0.04);
  squeak.frequency.exponentialRampToValueAtTime(f * 1.3, end);
  const vib = osc(v, "sine", t + 0.04, end);
  vib.frequency.value = 7;
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = f * 0.03;
  vib.connect(vibDepth).connect(squeak.frequency);
  const sqEnv = ctx.createGain();
  sqEnv.gain.setValueAtTime(0, t + 0.04);
  sqEnv.gain.linearRampToValueAtTime(0.22, t + 0.1);
  sqEnv.gain.linearRampToValueAtTime(0, end);
  chain(squeak, sqEnv, v.out);
  return end;
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Voice: formant synthesis of a cartoon giggle and belly laugh                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Formant frequency, bandwidth-ish Q and level of one vowel (scaled up from an adult's: a small, cute tract). */
type Vowel = [freq: number, q: number, gain: number][];
const VOWEL_A: Vowel = [
  [880, 5, 1],
  [1350, 7, 0.55],
  [2850, 9, 0.22],
  [3800, 10, 0.08],
];
const VOWEL_E: Vowel = [
  [560, 5, 1],
  [2050, 8, 0.5],
  [2950, 9, 0.25],
  [3900, 10, 0.08],
];
const VOWEL_I: Vowel = [
  [380, 5, 1],
  [2450, 8, 0.45],
  [3250, 9, 0.22],
  [4100, 10, 0.08],
];

interface Syllable {
  /** Start (ctx seconds), length of the breathy "h", length of the voiced part. */
  t: number;
  h: number;
  voiced: number;
  /** Pitch at the start and end of the voiced part (Hz). */
  f0: number;
  f1: number;
  amp: number;
}

const glottalCache = new WeakMap<BaseAudioContext, PeriodicWave>();

/** A glottal-ish source: harmonics falling a little faster than a sawtooth, softer and less buzzy. */
function glottal(ctx: BaseAudioContext): PeriodicWave {
  let wave = glottalCache.get(ctx);
  if (!wave) {
    const n = 48;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.25);
    wave = ctx.createPeriodicWave(real, imag);
    glottalCache.set(ctx, wave);
  }
  return wave;
}

/** Speak a run of syllables "h + vowel" (vowel gliding from `from` to `to` inside each syllable). */
function speak(v: VoiceArgs, syllables: Syllable[], from: Vowel, to: Vowel): number {
  const { ctx } = v;
  const first = syllables[0];
  const last = syllables[syllables.length - 1];
  const t0 = first.t;
  const end = last.t + last.h + last.voiced + 0.05;

  const src = osc(v, "sine", t0, end);
  src.setPeriodicWave(glottal(ctx));
  // Liveliness: a little vibrato.
  const vib = osc(v, "sine", t0, end);
  vib.frequency.value = 5.5 + v.rnd();
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = first.f0 * 0.015;
  vib.connect(vibDepth).connect(src.frequency);

  const voiceGain = ctx.createGain();
  const breathGain = ctx.createGain();
  voiceGain.gain.setValueAtTime(0, t0);
  breathGain.gain.setValueAtTime(0, t0);
  src.frequency.setValueAtTime(first.f0, t0);

  for (const syl of syllables) {
    const vt = syl.t + syl.h;
    const ve = vt + syl.voiced;
    // "h": breath through the vowel's own resonances, overlapping the voice onset.
    breathGain.gain.setValueAtTime(0, syl.t);
    breathGain.gain.linearRampToValueAtTime(0.9 * syl.amp, syl.t + syl.h * 0.6);
    breathGain.gain.linearRampToValueAtTime(0.12 * syl.amp, vt + 0.02);
    breathGain.gain.linearRampToValueAtTime(0, ve);
    // Voice: quick rise, a held vowel, a soft cut-off.
    voiceGain.gain.setValueAtTime(0, vt - 0.01);
    voiceGain.gain.linearRampToValueAtTime(syl.amp, vt + 0.025);
    voiceGain.gain.linearRampToValueAtTime(syl.amp * 0.75, ve - 0.03);
    voiceGain.gain.linearRampToValueAtTime(0, ve);
    src.frequency.setValueAtTime(syl.f0, vt - 0.01);
    src.frequency.exponentialRampToValueAtTime(syl.f1, ve);
  }

  const mix = ctx.createGain();
  mix.gain.value = 1;
  const breath = noise(v, t0, end);
  const breathHp = filter(ctx, "highpass", 500);
  chain(breath, breathHp, breathGain);
  from.forEach(([f, q, g], i) => {
    const bp = filter(ctx, "bandpass", f, q);
    for (const syl of syllables) {
      bp.frequency.setValueAtTime(f, syl.t);
      bp.frequency.linearRampToValueAtTime(to[i][0], syl.t + syl.h + syl.voiced);
    }
    const lvl = ctx.createGain();
    lvl.gain.value = g;
    voiceGain.connect(bp);
    breathGain.connect(bp);
    chain(bp, lvl, mix);
  });
  src.connect(voiceGain);
  // A little of the source's low end, which the band-passes alone lose (keeps the voice round, not whistly).
  const body = filter(ctx, "lowpass", 500);
  const bodyGain = ctx.createGain();
  bodyGain.gain.value = 0.18;
  chain(voiceGain, body, bodyGain, mix);
  mix.connect(v.out);
  return end;
}

/** "嘿嘿": a cheeky two- or three-beat snicker, high and quick. */
const giggle: VoiceFn = (v) => {
  const { t, s, rnd } = v;
  const n = rnd() < lerp(0.25, 0.7, s) ? 3 : 2;
  const base = lerp(330, 400, s) * vary(rnd, 0.07);
  const syllables: Syllable[] = [];
  let at = t;
  for (let i = 0; i < n; i++) {
    const h = 0.035 * vary(rnd, 0.2);
    const voiced = 0.1 * vary(rnd, 0.2);
    const up = i === n - 1 && rnd() < 0.5 ? 1.08 : 0.94; // sometimes a cheeky rise at the end
    const f0 = base * (1 + 0.04 * i * (rnd() < 0.5 ? -1 : 1));
    syllables.push({ t: at, h, voiced, f0, f1: f0 * up, amp: lerp(0.5, 0.8, s) * (i === 0 ? 1 : 0.85) });
    at += h + voiced + 0.075 * vary(rnd, 0.25);
  }
  return speak(v, syllables, VOWEL_E, VOWEL_I);
};

/** "哈哈哈": a big belly laugh, the first beat loudest, each next a little lower and quicker. */
const laugh: VoiceFn = (v) => {
  const { t, s, rnd } = v;
  const n = Math.round(lerp(3, 6, s) + rnd() * 1.4 - 0.4);
  const base = lerp(250, 290, s) * vary(rnd, 0.06);
  const syllables: Syllable[] = [];
  let at = t;
  for (let i = 0; i < n; i++) {
    const k = i / Math.max(1, n - 1);
    const h = lerp(0.05, 0.035, k) * vary(rnd, 0.15);
    const voiced = lerp(0.17, 0.11, k) * vary(rnd, 0.15);
    const f0 = base * lerp(1.08, 0.8, k) * vary(rnd, 0.03);
    syllables.push({ t: at, h, voiced, f0, f1: f0 * 0.88, amp: lerp(0.9, 0.55, k) * lerp(0.6, 0.85, s) });
    at += h + voiced + lerp(0.06, 0.045, k) * vary(rnd, 0.2);
  }
  return speak(v, syllables, VOWEL_A, VOWEL_A);
};

export const VOICES: Record<SfxKind, VoiceFn> = { boing, squish, slap, pop, whoosh, land, giggle, laugh, pump, ball };

/** The bus every effect goes through: rumble filter, compressor, and a soft clipper so the sum never clips. */
export function createMaster(ctx: BaseAudioContext): { input: GainNode; output: AudioNode } {
  const input = ctx.createGain();
  input.gain.value = 0.9;
  const rumble = filter(ctx, "highpass", 35);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 10;
  comp.attack.value = 0.002;
  comp.release.value = 0.18;
  const makeup = ctx.createGain();
  // The shaper's curve spans ±2 of signal over its ±1 input.
  makeup.gain.value = 0.5 * 1.25;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  clip.oversample = "2x";
  return { input, output: chain(input, rumble, comp, makeup, clip) };
}

/** Linear to 0.6, then a tanh knee that never passes 0.97, over signal ±2. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = ((i / (n - 1)) * 2 - 1) * 2;
    const m = Math.abs(a);
    curve[i] = Math.sign(a) * (m <= 0.6 ? m : 0.6 + 0.37 * Math.tanh((m - 0.6) / 0.37));
  }
  return curve;
}
