/** Typed arrays to and from the base64 PackedArray of the session file. */
import type { PackedArray } from "./format";

type Typed = Float32Array | Int16Array | Uint8Array;
const CTORS = { f32: Float32Array, i16: Int16Array, u8: Uint8Array } as const;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunks keep String.fromCharCode below the argument-count limit.
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** Typed arrays are little-endian on every platform the app runs on, as the format requires. */
export function pack(dtype: PackedArray["dtype"], shape: number[], values: ArrayLike<number>, scale?: number): PackedArray {
  const n = shape.reduce((a, b) => a * b, 1);
  if (values.length !== n) throw new Error(`pack: ${values.length} values for shape [${shape}]`);
  const arr: Typed = new CTORS[dtype](n);
  if (scale === undefined) arr.set(values);
  else {
    const lim = dtype === "i16" ? 32767 : 255;
    const lo = dtype === "i16" ? -32767 : 0;
    for (let i = 0; i < n; i++) arr[i] = Math.max(lo, Math.min(lim, Math.round(values[i] / scale)));
  }
  const out: PackedArray = { dtype, shape, data: toBase64(new Uint8Array(arr.buffer)) };
  if (scale !== undefined) out.scale = scale;
  return out;
}

/** Values as floats (scale applied). */
export function unpack(p: PackedArray): Float32Array {
  const raw = new CTORS[p.dtype](fromBase64(p.data));
  const out = new Float32Array(raw.length);
  const s = p.scale ?? 1;
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] * s;
  return out;
}

/** i16 packing with the finest step that still holds the largest magnitude. */
export function packI16(shape: number[], values: Float32Array): PackedArray {
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, Math.abs(values[i]));
  return pack("i16", shape, values, Math.max(max, 1e-6) / 32767);
}
