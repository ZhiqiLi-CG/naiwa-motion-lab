/**
 * Sound: one AudioContext; every effect and the attached video's music go through the master bus, then to the
 * speakers and to a stream for recording.
 */
import type { Sfx, SfxKind } from "../contracts";
import { VOICES, createMaster } from "./synth";

/** Shortest gap between two plays of the same effect (ms): a burst of events makes one sound, not a buzz. */
const MIN_GAP: Record<SfxKind, number> = {
  boing: 70,
  squish: 60,
  slap: 45,
  pop: 35,
  whoosh: 140,
  land: 90,
  ball: 30,
  pump: 150,
  giggle: 0,
  laugh: 0,
};
/** Giggle and laugh are one voice: a new one waits until the frog has finished the last. */
const SPEECH: ReadonlySet<SfxKind> = new Set(["giggle", "laugh"]);
const MAX_VOICES = 14;
/** Sounds asked for while the context is still resuming after unlock() are kept (the first tap's sound). */
const RESUME_GRACE_MS = 1000;

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  let bus: GainNode | null = null;
  let music: GainNode | null = null;
  let mute: GainNode | null = null;
  let streamDest: MediaStreamAudioDestinationNode | null = null;
  // A media element can feed WebAudio only once in its life, so its source node is kept for re-attaching.
  const musicSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  let musicEl: HTMLMediaElement | null = null;
  let enabled = true;
  let unlockedAt = -Infinity;
  let speechEnd = 0;
  const lastPlay = new Map<SfxKind, number>();
  const voiceEnds: number[] = [];

  function ensure(): AudioContext | null {
    if (ctx) return ctx;
    if (typeof AudioContext === "undefined") return null;
    ctx = new AudioContext({ latencyHint: "interactive" });
    const master = createMaster(ctx);
    bus = master.input;
    music = master.music;
    mute = ctx.createGain();
    mute.gain.value = enabled ? 1 : 0;
    streamDest = ctx.createMediaStreamDestination();
    master.output.connect(mute);
    mute.connect(ctx.destination);
    mute.connect(streamDest);
    return ctx;
  }

  return {
    unlock() {
      const c = ensure();
      if (!c) return;
      unlockedAt = performance.now();
      if (c.state !== "running") void c.resume();
      // iOS starts output only once something plays inside the gesture.
      const tick = c.createBufferSource();
      tick.buffer = c.createBuffer(1, 1, c.sampleRate);
      tick.connect(c.destination);
      tick.start();
    },
    setEnabled(on) {
      enabled = on;
      if (ctx && mute) mute.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
    },
    play(kind, strength = 0.6) {
      if (!enabled || !ctx || !bus) return;
      if (ctx.state !== "running") {
        if (performance.now() - unlockedAt > RESUME_GRACE_MS) return;
        void ctx.resume();
      }
      const now = performance.now();
      if (now - (lastPlay.get(kind) ?? -Infinity) < MIN_GAP[kind]) return;
      const t = ctx.currentTime + 0.005;
      if (SPEECH.has(kind) && t < speechEnd) return;
      while (voiceEnds.length && voiceEnds[0] <= t) voiceEnds.shift();
      if (voiceEnds.length >= MAX_VOICES) return;
      lastPlay.set(kind, now);
      const end = VOICES[kind]({ ctx, out: bus, t, s: Math.min(1, Math.max(0, strength)), rnd: Math.random });
      if (SPEECH.has(kind)) speechEnd = end;
      voiceEnds.push(end);
      voiceEnds.sort((a, b) => a - b);
    },
    get stream() {
      ensure();
      return streamDest?.stream ?? null;
    },
    attachMusic(el) {
      if (el === musicEl) return;
      // Once captured, an element sounds only through the graph: the detached one falls silent, no echo is possible.
      if (musicEl) musicSources.get(musicEl)?.disconnect();
      musicEl = el;
      const c = el && ensure();
      if (!el || !c || !music) return;
      let src = musicSources.get(el);
      if (!src) {
        src = c.createMediaElementSource(el);
        musicSources.set(el, src);
      }
      // Its sound is wanted now (a muted element would feed silence); loudness is the mix's business.
      el.muted = false;
      src.connect(music);
      if (c.state !== "running" && performance.now() - unlockedAt < RESUME_GRACE_MS) void c.resume();
    },
  };
}
