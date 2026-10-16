/**
 * The session file: what was played in the browser while recording, so that tools/genesis-hd can re-create the same
 * shot in Genesis and render it in high quality. One JSON document (optionally gzipped); per-frame tracks are packed
 * typed arrays so that a 20 s clip stays well under a megabyte.
 *
 * Space and units are the browser's (src/contracts.ts): meters, +Y up, the frog at home at the origin facing +Z.
 * Times are seconds since the recording started (the first frame of the browser video).
 */
import type { BodyMode, FrogEventKind, HitRegion, PhysicsParams } from "../contracts";

export const SESSION_FORMAT = "naiwa-session";
export const SESSION_VERSION = 1;

/** A little-endian typed array in base64. Row-major; `shape[0]` counts frames (or items). Values are
 *  `stored * scale` (quantised tracks carry a scale; float tracks have none). */
export interface PackedArray {
  dtype: "f32" | "i16" | "u8";
  shape: number[];
  scale?: number;
  data: string;
}

export interface SessionEvent {
  t: number;
  kind: FrogEventKind;
  point: [number, number, number];
  strength: number;
  region?: HitRegion;
  /** Unit direction of the push where the caller knows it (poke direction, slap velocity direction). */
  dir?: [number, number, number];
}

export interface SessionFile {
  format: typeof SESSION_FORMAT;
  version: typeof SESSION_VERSION;
  /** ISO time the recording started. */
  createdAt: string;
  /** The character asset the browser played (URL as loaded, and its size in bytes when known). */
  character: { url: string; bytes?: number };
  /** Names of the bones of the bone tracks, in track order. */
  bones: string[];
  /** Names of the expressions of the expression track, in track order. */
  expressions: string[];
  frameCount: number;
  /** f32 [N]: time of each frame. */
  time: PackedArray;
  /** i16 [N, B, 3] (scale in meters): world position of each bone. */
  bonePos: PackedArray;
  /** i16 [N, B, 4] (scale 1/32767): world rotation of each bone, quaternion x, y, z, w. Bones are rigid; a scale in
   *  the matrices handed to the recorder is dropped. */
  boneRot: PackedArray;
  camera: {
    /** i16 [N, 3]: world position. */
    pos: PackedArray;
    /** i16 [N, 4]: world rotation (three.js camera: looks down its -Z, +Y up). */
    rot: PackedArray;
    /** f32 [N, 2]: vertical field of view (degrees) and aspect (width / height). */
    lens: PackedArray;
  };
  /** u8 [N, E] (scale 1/255): expression weights as shown. */
  expressionWeights: PackedArray;
  balls: {
    /** u8 [N]: number of balls in each frame. */
    count: PackedArray;
    /** f32 [sum(count), 4]: x, y, z, radius of each ball, frame after frame. */
    data: PackedArray;
  };
  /** The material and body mode, first at t = 0 and again whenever they change. */
  params: { t: number; params: PhysicsParams; mode: BodyMode }[];
  events: SessionEvent[];
  stage: { theme: "light" | "dark" };
}
