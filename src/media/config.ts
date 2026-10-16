/**
 * Settings links: a short URL hash that reproduces mode, tool, physics params, preset, dance and mirror.
 *
 * Format (version 1): `#v=1&m=dance&t=hand&p=jelly&k=85.65.100.100.70&d=belly-laugh&r=1`
 * k = the PhysicsParams in PARAM_ORDER, each ×100 as an integer. Later versions only append to k and add keys, so a
 * decoder of any version reads older links; unknown keys and malformed values are skipped, never thrown on.
 */
import type { AppState, Mode, PhysicsParams, Tool } from "../contracts";
import { MATERIAL_PRESETS, initialState } from "../store";

const VERSION = 1;
const MODES: readonly Mode[] = ["play", "camera", "video", "dance"];
const TOOLS: readonly Tool[] = ["hand", "ball", "feather", "pump"];
/** Position of each param in k; append only. */
const PARAM_ORDER = ["softness", "bounciness", "gravity", "bellySize", "stubbornness"] as const;
/** Accepted range per param (wider than any slider, only to keep a hand-edited link from breaking the physics). */
const PARAM_RANGE: Record<keyof PhysicsParams, [number, number]> = {
  softness: [0, 1],
  bounciness: [0, 1],
  gravity: [0, 4],
  bellySize: [0.5, 2.5],
  stubbornness: [0, 1],
};
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const MAX_HASH = 512;

export type ConfigState = Pick<AppState, "mode" | "tool" | "params" | "preset" | "dance" | "mirror">;
export type ConfigPatch = Partial<ConfigState>;

/** The hash, starting with "#", for `location.hash = …` or `url + …`. */
export function encodeConfig(state: ConfigState): string {
  // A link cannot carry the uploaded video, so it opens in play mode instead of an empty video mode.
  const mode = state.mode === "video" ? "play" : state.mode;
  const k = PARAM_ORDER.map((name) => Math.round(state.params[name] * 100)).join(".");
  const parts = [`v=${VERSION}`, `m=${mode}`, `t=${state.tool}`, `p=${state.preset}`, `k=${k}`, `d=${state.dance}`];
  parts.push(`r=${state.mirror ? 1 : 0}`);
  return `#${parts.join("&")}`;
}

/** Settings from a hash (with or without "#", or a whole URL). Returns only what is present and valid. */
export function decodeConfig(hash: string): ConfigPatch {
  const at = hash.indexOf("#");
  const body = (at >= 0 ? hash.slice(at + 1) : hash).slice(0, MAX_HASH);
  const q = new URLSearchParams(body);
  const out: ConfigPatch = {};

  const mode = q.get("m");
  if (isOneOf(mode, MODES)) out.mode = mode === "video" ? "play" : mode;
  const tool = q.get("t");
  if (isOneOf(tool, TOOLS)) out.tool = tool;
  const preset = MATERIAL_PRESETS.find((p) => p.id === q.get("p"));
  if (preset) out.preset = preset.id;
  const dance = q.get("d");
  if (dance !== null && ID.test(dance)) out.dance = dance;
  const mirror = q.get("r");
  if (mirror === "1" || mirror === "0") out.mirror = mirror === "1";

  const k = q.get("k");
  if (k !== null) {
    // Missing or bad entries come from the link's preset, else from the defaults, so params are always complete.
    const params: PhysicsParams = { ...(preset ?? { params: initialState().params }).params };
    let any = false;
    k.split(".").forEach((raw, i) => {
      const name = PARAM_ORDER[i];
      if (name === undefined || !/^-?\d{1,4}$/.test(raw)) return;
      const [lo, hi] = PARAM_RANGE[name];
      params[name] = Math.min(hi, Math.max(lo, Number(raw) / 100));
      any = true;
    });
    if (any) out.params = params;
  } else if (preset) {
    out.params = { ...preset.params };
  }
  return out;
}

function isOneOf<T extends string>(v: string | null, list: readonly T[]): v is T {
  return v !== null && (list as readonly string[]).includes(v);
}
