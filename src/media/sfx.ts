/** Sound effects: one AudioContext, every effect through the limiting master bus, to the speakers and to a stream. */
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
  let streamDest: MediaStreamAudioDestinationNode | null = null;
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
    bus = ctx.createGain();
    bus.gain.value = enabled ? 1 : 0;
    bus.connect(master.input);
    streamDest = ctx.createMediaStreamDestination();
    master.output.connect(ctx.destination);
    master.output.connect(streamDest);
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
      if (ctx && bus) bus.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
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
  };
}
