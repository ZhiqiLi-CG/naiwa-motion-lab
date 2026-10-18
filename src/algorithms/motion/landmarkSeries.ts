/**
 * Shared by the filter blocks: a person frame as one flat series of numbers (world x y z, then image x y z, for each of
 * the 33 landmarks) and back, the scale between the two kinds of coordinate, and the bridging of short gaps in a
 * recording.
 */
import type { PersonFrame } from "../../motion/api";

export const COUNT = 33;
/** Values per frame: 33 landmarks × (world xyz + image xyz). */
export const SERIES = COUNT * 6;
/** Picture fractions per metre of a person in frame (a 1.7 m dancer fills about 0.7 of the picture's height). */
export const IMAGE_PER_METRE = 0.4;
/** Longest gap of a recording bridged (s); a longer one restarts the filter. */
export const MAX_GAP = 0.5;

export const present = (f: PersonFrame) => f.world.length >= COUNT && f.image.length >= COUNT;

/** The frame's numbers, in place into `out`. */
export function flatten(f: PersonFrame, out = new Float64Array(SERIES)): Float64Array {
  for (let i = 0; i < COUNT; i++)
    for (let c = 0; c < 3; c++) (out[i * 3 + c] = f.world[i][c]), (out[COUNT * 3 + i * 3 + c] = f.image[i][c]);
  return out;
}

/** A frame from filtered numbers, keeping the visibilities of `like`. */
export function unflatten(v: ArrayLike<number>, like: PersonFrame): PersonFrame {
  const at = (base: number, i: number, vis: number) => [v[base + i * 3], v[base + i * 3 + 1], v[base + i * 3 + 2], vis];
  return {
    world: like.world.map((p, i) => at(0, i, p[3])),
    image: like.image.map((p, i) => at(COUNT * 3, i, p[3])),
    aspect: like.aspect,
  };
}

/** Visibility of the landmark a series value belongs to. */
export const visibility = (f: PersonFrame, k: number) => f.world[Math.floor((k % (COUNT * 3)) / 3)][3];

/** Whether series value k is an image coordinate (its noise and motion scale by IMAGE_PER_METRE). */
export const isImage = (k: number) => k >= COUNT * 3;

/**
 * The runs of a recording to filter: consecutive frames with a person, gaps up to MAX_GAP included (marked missing,
 * for the filter to bridge), longer gaps splitting runs.
 */
export function runs(frames: PersonFrame[], fps: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let from = -1, last = -1;
  frames.forEach((f, i) => {
    if (!present(f)) return;
    if (from >= 0 && (i - last - 1) / fps > MAX_GAP) out.push({ from, to: last });
    if (from < 0 || (i - last - 1) / fps > MAX_GAP) from = i;
    last = i;
  });
  if (from >= 0) out.push({ from, to: last });
  return out;
}
