/**
 * Offline renders of the effects and numbers about them (level, clipping, length, spectrum, syllables), for checking
 * the sounds where nobody can listen: dev/media.html shows them, the headless check reads them.
 */
import type { SfxKind } from "../contracts";
import { VOICES, createMaster, type Rnd } from "./synth";

export const SFX_KINDS: SfxKind[] = ["boing", "squish", "slap", "pop", "whoosh", "land", "ball", "pump", "giggle", "laugh"];
const RATE = 48000;

export function seeded(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Hit {
  kind: SfxKind;
  at: number;
  strength: number;
}

/** Render hits (through the master bus unless raw) into a stereo buffer of the given length. */
export async function render(hits: Hit[], seconds: number, seed = 1, raw = false): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE);
  let out: AudioNode = ctx.destination;
  if (!raw) {
    const master = createMaster(ctx);
    master.output.connect(ctx.destination);
    out = master.input;
  }
  const rnd = seeded(seed);
  for (const h of hits) VOICES[h.kind]({ ctx, out, t: h.at, s: h.strength, rnd });
  return ctx.startRendering();
}

export interface Metrics {
  /** Max |sample| over both channels, and in dBFS. */
  peak: number;
  peakDb: number;
  /** Samples at or above 0.999 (clipping), and NaN/Infinity samples. */
  clipped: number;
  bad: number;
  /** Seconds from the first to the last sample above -50 dBFS. */
  onset: number;
  length: number;
  /** Loudest 50 ms window, dBFS RMS. */
  loudDb: number;
  /** Spectral centroid and strongest frequency of the average spectrum (Hz). */
  centroid: number;
  dominant: number;
  /** Share of energy below 200 Hz (what phone speakers lose). */
  lowShare: number;
  /** Loudest 50 ms window after a 300 Hz high-pass, dBFS RMS: roughly what a phone or laptop speaker plays. */
  smallDb: number;
  /** Envelope peaks at least 12 dB above their surroundings, ≥ 70 ms apart (syllables / bounces). */
  beats: number;
  /** Median pitch of voiced 40 ms frames by autocorrelation (Hz; 0 if none). */
  f0: number;
  /** Peaks of the smoothed average spectrum above 250 Hz (the voice's formants), Hz, low to high, with how far each
   *  stands above the lower of its two neighbouring valleys (dB). */
  peaks: { hz: number; db: number }[];
}

export function measure(buf: AudioBuffer): Metrics {
  const n = buf.length;
  const mono = new Float32Array(n);
  let peak = 0;
  let clipped = 0;
  let bad = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const x = d[i];
      if (!Number.isFinite(x)) {
        bad++;
        continue;
      }
      const m = Math.abs(x);
      if (m > peak) peak = m;
      if (m >= 0.999) clipped++;
      mono[i] += x / buf.numberOfChannels;
    }
  }
  const floor = Math.pow(10, -50 / 20);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(mono[i]) > floor) {
      if (first < 0) first = i;
      last = i;
    }
  }

  // RMS envelope in 10 ms hops.
  const hop = Math.round(RATE * 0.01);
  const env: number[] = [];
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += mono[j] * mono[j];
    env.push(Math.sqrt(s / hop));
  }
  let loud = 0;
  for (let i = 0; i + 5 <= env.length; i++) {
    let s = 0;
    for (let j = i; j < i + 5; j++) s += env[j] * env[j];
    loud = Math.max(loud, Math.sqrt(s / 5));
  }

  const spectrum = averageSpectrum(mono, first, last);
  let num = 0;
  let den = 0;
  let low = 0;
  let best = 0;
  let dominant = 0;
  spectrum.power.forEach((p, k) => {
    const f = k * spectrum.binHz;
    num += f * p;
    den += p;
    if (f < 200) low += p;
    if (p > best) {
      best = p;
      dominant = f;
    }
  });

  return {
    peak,
    peakDb: db(peak),
    clipped,
    bad,
    onset: first < 0 ? 0 : first / RATE,
    length: first < 0 ? 0 : (last - first) / RATE,
    loudDb: db(loud),
    centroid: den ? num / den : 0,
    dominant,
    lowShare: den ? low / den : 0,
    smallDb: db(loudest(highpass(mono, 300))),
    beats: countBeats(env),
    f0: medianPitch(mono, env),
    peaks: spectralPeaks(spectrum.power, spectrum.binHz),
  };
}

function spectralPeaks(power: Float32Array, binHz: number): { hz: number; db: number }[] {
  const half = Math.round(230 / binHz);
  const sm = new Float32Array(power.length);
  for (let k = 0; k < power.length; k++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(power.length - 1, k + half); j++, n++) s += power[j];
    sm[k] = 10 * Math.log10(s / n + 1e-20);
  }
  const lo = Math.ceil(250 / binHz);
  const hi = Math.floor(5000 / binHz);
  const found: { hz: number; db: number }[] = [];
  for (let k = lo; k < hi; k++) {
    if (!(sm[k] > sm[k - 1] && sm[k] >= sm[k + 1])) continue;
    let left = sm[k];
    for (let j = k; j >= 1 && sm[j - 1] <= left + 0.01; j--) left = Math.min(left, sm[j - 1]);
    let right = sm[k];
    for (let j = k; j < sm.length - 1 && sm[j + 1] <= right + 0.01; j++) right = Math.min(right, sm[j + 1]);
    const prominence = sm[k] - Math.max(left, right);
    if (prominence > 3) found.push({ hz: Math.round(k * binHz), db: Math.round(prominence) });
  }
  return found.sort((a, b) => b.db - a.db).slice(0, 4).sort((a, b) => a.hz - b.hz);
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** Second-order (RBJ) high-pass. */
function highpass(x: Float32Array, f: number): Float32Array {
  const w = (2 * Math.PI * f) / RATE;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** RMS of the loudest 50 ms window. */
function loudest(x: Float32Array): number {
  const win = Math.round(RATE * 0.05);
  const hop = Math.round(RATE * 0.01);
  let best = 0;
  for (let i = 0; i + win <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += x[j] * x[j];
    best = Math.max(best, s / win);
  }
  return Math.sqrt(best);
}

function countBeats(env: number[]): number {
  const top = Math.max(...env);
  if (top <= 0) return 0;
  const minGap = 7;
  let beats = 0;
  let lastAt = -minGap;
  let valley = Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    valley = Math.min(valley, env[i]);
    const isPeak = env[i] >= env[i - 1] && env[i] > env[i + 1] && env[i] > top * 0.15;
    // A new beat needs a dip of 12 dB since the previous one (or the start).
    if (isPeak && i - lastAt >= minGap && valley < env[i] / 4) {
      beats++;
      lastAt = i;
      valley = Infinity;
    }
  }
  return beats;
}

function medianPitch(x: Float32Array, env: number[]): number {
  const top = Math.max(...env);
  const win = Math.round(RATE * 0.04);
  const pitches: number[] = [];
  const minLag = Math.floor(RATE / 900);
  const maxLag = Math.ceil(RATE / 80);
  for (let e = 0; e < env.length; e += 2) {
    if (env[e] < top * 0.3) continue;
    const start = e * Math.round(RATE * 0.01);
    if (start + win + maxLag > x.length) break;
    let r0 = 0;
    for (let i = 0; i < win; i++) r0 += x[start + i] * x[start + i];
    let bestLag = 0;
    let bestR = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let r = 0;
      for (let i = 0; i < win; i++) r += x[start + i] * x[start + i + lag];
      if (r > bestR) {
        bestR = r;
        bestLag = lag;
      }
    }
    // Voiced: a strong periodic peak.
    if (bestLag && bestR > 0.5 * r0) pitches.push(RATE / bestLag);
  }
  if (!pitches.length) return 0;
  pitches.sort((a, b) => a - b);
  return pitches[pitches.length >> 1];
}

const FFT = 2048;

function averageSpectrum(x: Float32Array, first: number, last: number): { power: Float32Array; binHz: number } {
  const power = new Float32Array(FFT / 2);
  const re = new Float32Array(FFT);
  const im = new Float32Array(FFT);
  if (first >= 0) {
    for (let start = first; start < last; start += FFT / 2) {
      for (let i = 0; i < FFT; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));
        re[i] = (x[start + i] ?? 0) * w;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < FFT / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    }
  }
  return { power, binHz: RATE / FFT };
}

/** In-place radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Waveform (top) and spectrogram (bottom, 0–8 kHz, log power) of the first `seconds` of a buffer. */
export function drawSound(canvas: HTMLCanvasElement, buf: AudioBuffer, title: string, seconds = buf.duration): void {
  const g = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const x = buf.getChannelData(0).subarray(0, Math.min(buf.length, Math.round(seconds * RATE)));
  g.fillStyle = "#16130d";
  g.fillRect(0, 0, w, h);
  const waveH = Math.round(h * 0.35);
  g.strokeStyle = "#ffd54a";
  g.beginPath();
  const per = x.length / w;
  for (let px = 0; px < w; px++) {
    let lo = 0;
    let hi = 0;
    for (let i = Math.floor(px * per); i < Math.floor((px + 1) * per); i++) {
      lo = Math.min(lo, x[i]);
      hi = Math.max(hi, x[i]);
    }
    g.moveTo(px + 0.5, waveH / 2 - hi * (waveH / 2));
    g.lineTo(px + 0.5, waveH / 2 - lo * (waveH / 2) + 1);
  }
  g.stroke();
  // ±1 guides: anything touching them clips.
  g.fillStyle = "rgba(255,80,80,.5)";
  g.fillRect(0, 0, w, 1);
  g.fillRect(0, waveH - 1, w, 1);

  const specH = h - waveH;
  const N = 1024;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const img = g.createImageData(w, specH);
  const maxBin = Math.floor((8000 / RATE) * N);
  const dbs = new Float32Array(w * specH);
  let top = -Infinity;
  for (let px = 0; px < w; px++) {
    // Centre the window on the column.
    const start = Math.floor(px * per) - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let py = 0; py < specH; py++) {
      const k = Math.floor(((specH - 1 - py) / specH) * maxBin);
      const p = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
      dbs[py * w + px] = p;
      top = Math.max(top, p);
    }
  }
  // 70 dB of range below the loudest bin.
  for (let px = 0; px < w; px++) {
    for (let py = 0; py < specH; py++) {
      const v = Math.max(0, Math.min(1, (dbs[py * w + px] - top + 70) / 70));
      const o = (py * w + px) * 4;
      img.data[o] = 255 * Math.min(1, v * 1.6);
      img.data[o + 1] = 255 * Math.max(0, v * 1.4 - 0.4);
      img.data[o + 2] = 255 * Math.max(0, v * 2 - 1.4) + 30 * (1 - v);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, waveH);
  g.fillStyle = "#fff";
  g.font = "12px sans-serif";
  g.fillText(title, 6, 14);
}
