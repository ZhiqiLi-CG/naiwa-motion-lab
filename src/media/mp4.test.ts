import { describe, expect, it } from "vitest";
import { hasEnoughVideo, mp4Samples } from "./mp4";

/** A box: 32-bit size, four-character type, payload. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of payload) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const u32 = (...xs: number[]) => {
  const out = new Uint8Array(xs.length * 4);
  xs.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x));
  return out;
};
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// tkhd v0: version/flags, creation, modification, track id, ...; hdlr: version/flags, pre_defined, handler.
const trak = (id: number, handler: string, stszCount = 0) =>
  box(
    "trak",
    box("tkhd", u32(0, 0, 0, id, 0)),
    box("mdia", box("hdlr", u32(0, 0), ascii(handler), u32(0, 0, 0)), box("minf", box("stbl", box("stsz", u32(0, 0, stszCount))))),
  );
const moof = (...trafs: [track: number, samples: number][]) =>
  box("moof", ...trafs.map(([id, n]) => box("traf", box("tfhd", u32(0, id)), box("trun", u32(0, n, 0)))));
const moov = (...traks: Uint8Array[]) => box("moov", ...traks);

describe("mp4Samples", () => {
  it("counts the video and audio tracks' samples across fragments", () => {
    const file = cat(box("ftyp", ascii("isom")), moov(trak(1, "vide"), trak(2, "soun")), moof([1, 17], [2, 8]), box("mdat"), moof([1, 21], [2, 11]));
    expect(mp4Samples(file)).toEqual({ video: 38, audio: 19 });
  });

  it("finds no video without a video track, and little when the video encoder stalled", () => {
    expect(mp4Samples(cat(moov(trak(1, "soun")), moof([1, 120])))).toEqual({ video: 0, audio: 120 });
    // The AMD failure (from a real file): the video track is declared, the audio runs, the video stops after 3 frames.
    expect(mp4Samples(cat(moov(trak(1, "vide"), trak(2, "soun")), moof([1, 3], [2, 120])))).toEqual({ video: 3, audio: 120 });
  });

  it("reads a plain (unfragmented) file's sample tables", () => {
    expect(mp4Samples(moov(trak(1, "vide", 90), trak(2, "soun", 140)))).toEqual({ video: 90, audio: 140 });
  });

  it("skips a box cut off by the end of the data", () => {
    const file = cat(moov(trak(1, "vide")), moof([1, 30]), moof([1, 30]));
    expect(mp4Samples(file.subarray(0, file.length - 5)).video).toBe(30);
  });
});

describe("hasEnoughVideo", () => {
  it("measures the video against the audio in the file", () => {
    expect(hasEnoughVideo({ video: 3, audio: 120 }, 0, 30)).toBe(false);
    expect(hasEnoughVideo({ video: 60, audio: 94 }, 0, 30)).toBe(true);
    // the muxer still holding everything back is not a stall: little audio, little video
    expect(hasEnoughVideo({ video: 1, audio: 4 }, 4000, 30)).toBe(true);
  });

  it("falls back to the clip's length without audio", () => {
    expect(hasEnoughVideo({ video: 3, audio: 0 }, 2000, 30)).toBe(false);
    expect(hasEnoughVideo({ video: 97, audio: 0 }, 3400, 30)).toBe(true);
    expect(hasEnoughVideo({ video: 1, audio: 0 }, 50, 30)).toBe(true);
    expect(hasEnoughVideo({ video: 0, audio: 0 }, 50, 30)).toBe(false);
  });
});
