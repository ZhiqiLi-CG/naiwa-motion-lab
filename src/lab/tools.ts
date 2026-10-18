/**
 * The page side of Codex's tools (lab/bin/naiwa.mjs <action>, documented in lab/AGENTS.md): each action reads or
 * drives the live page through the store, the UI commands and the running simulation, and returns plain JSON. Files
 * (screenshots, recordings) go back as { $file } for the server to write.
 */
import * as THREE from "three";
import type { AppState, BoneName, DanceTrack, FrogHit, MaterialPreset, PhysicsParams, SimulatorInfo, SimulatorOptions, Stage } from "../contracts";
import { FLESH_REGIONS } from "../contracts";
import type { CodeLab } from "../labcode";
import type { NaiwaMotion } from "../motion";
import type { LabFrogSim } from "../sim";
import type { Store } from "../store";
import type { UICommands } from "../ui";
import { summariseProbe, surfaceDisplacement, type ProbeSample } from "./probe";

export interface PageHost {
  store: Store;
  commands: UICommands;
  sim(): LabFrogSim | null;
  stage: Stage;
  motion: NaiwaMotion;
  codeLab: CodeLab | null;
  presets: MaterialPreset[];
  /** A repo file through the Lab server (artefacts, Codex's drafts). */
  fetchFile(path: string): Promise<Response>;
}

type Args = Record<string, unknown>;
export type Tool = (args: Args) => Promise<unknown> | unknown;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: unknown, dflt: number, min = -Infinity, max = Infinity) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required`);
  return v;
};
const vec = (v: unknown, dflt: THREE.Vector3): THREE.Vector3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? new THREE.Vector3(v[0], v[1], v[2]) : dflt.clone();

/** Regions a tool can aim at: where on the skeleton, and from which side the ray comes. */
export const AIM: Record<string, { bone: BoneName; to: BoneName | null; t: number; from: "front" | "back" | "side" }> = {
  belly: { bone: "spine", to: "chest", t: 0.2, from: "front" },
  body: { bone: "chest", to: "head", t: 0.3, from: "back" },
  head: { bone: "head", to: null, t: 0, from: "front" },
  arm: { bone: "upperarm_L", to: "forearm_L", t: 0.7, from: "side" },
  hand: { bone: "hand_L", to: null, t: 0, from: "front" },
  leg: { bone: "thigh_L", to: "shin_L", t: 0.6, from: "front" },
  foot: { bone: "foot_L", to: null, t: 0, from: "front" },
};

const compactPlugin = (x: SimulatorInfo) => ({
  id: x.id,
  name: x.name.en,
  device: x.device,
  origin: x.origin,
  unavailable: x.unavailable ? x.unavailable.en : null,
  parameters: x.parameters.map((p) => ({ key: p.key, kind: p.kind, min: p.min, max: p.max, default: p.default, unit: p.unit, rebuild: p.rebuild ?? false, choices: p.choices?.map((c) => c.value) })),
});

/** The state Codex reads (compact; the plugin lists only with list=true). */
export function readState(s: AppState, list: boolean) {
  return {
    mode: s.mode,
    tool: s.tool,
    params: s.params,
    preset: s.preset,
    dance: s.dance,
    simulator: s.simulator,
    retargeter: s.retargeter,
    playback: s.playback,
    stats: s.stats,
    motion: { state: s.motion.state, message: s.motion.message, metrics: s.motion.metrics?.map((m) => `${m.label.en}: ${m.value}`) },
    lang: s.lang,
    dances: s.dances.map((d) => ({ id: d.id, name: d.nameEn ?? d.name, origin: d.origin ?? "procedural", duration: d.duration })),
    ...(list ? { simulators: s.simulators.map(compactPlugin), retargeters: s.retargeters.map(compactPlugin) } : { simulatorIds: s.simulators.map((x) => x.id), retargeterIds: s.retargeters.map((x) => x.id) }),
  };
}

/** Physics params from tool args (unknown keys refused, regionSoftness merged unless replace). */
export function paramsPatch(args: Args, current: PhysicsParams): PhysicsParams {
  const keys = ["softness", "bounciness", "gravity", "bellySize", "stubbornness"] as const;
  const next: PhysicsParams = args.replace ? { ...current, regionSoftness: undefined } : { ...current };
  for (const [k, v] of Object.entries(args)) {
    if (k === "replace") continue;
    if ((keys as readonly string[]).includes(k)) next[k as (typeof keys)[number]] = num(v, current[k as (typeof keys)[number]], 0, 3);
    else if (k === "regionSoftness") {
      if (v === null) next.regionSoftness = undefined;
      else if (typeof v === "object") {
        const rs: Partial<Record<(typeof FLESH_REGIONS)[number], number>> = args.replace ? {} : { ...current.regionSoftness };
        for (const [r, x] of Object.entries(v as Args)) {
          if (!(FLESH_REGIONS as readonly string[]).includes(r)) throw new Error(`unknown region "${r}" (${FLESH_REGIONS.join(", ")})`);
          rs[r as (typeof FLESH_REGIONS)[number]] = num(x, 0.5, 0, 1);
        }
        next.regionSoftness = rs;
      }
    } else throw new Error(`unknown parameter "${k}" (${[...keys, "regionSoftness"].join(", ")})`);
  }
  return next;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function createTools(host: PageHost): Record<string, Tool> {
  const { store, commands } = host;
  const needSim = () => {
    const sim = host.sim();
    if (!sim) throw new Error("the simulation is not running yet");
    return sim;
  };
  const bones = new Map<BoneName, THREE.Matrix4>();
  const pos = (b: BoneName) => new THREE.Vector3().setFromMatrixPosition(bones.get(b) ?? new THREE.Matrix4());

  /** A point on the region's surface, hit by a ray from its side (else from the camera). */
  function aim(region: string): { hit: FrogHit; dir: THREE.Vector3 } {
    const a = AIM[region];
    if (!a) throw new Error(`unknown region "${region}" (${Object.keys(AIM).join(", ")})`);
    const sim = needSim();
    sim.readBones(bones);
    const target = a.to ? pos(a.bone).lerp(pos(a.to), a.t) : pos(a.bone);
    const root = bones.get("hips") ?? bones.get("root") ?? new THREE.Matrix4();
    const fwd = new THREE.Vector3().setFromMatrixColumn(root, 2).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
    const out = a.from === "front" ? fwd : a.from === "back" ? fwd.clone().negate() : side;
    for (const origin of [target.clone().addScaledVector(out, 1.5), host.stage.camera.position.clone()]) {
      const dir = target.clone().sub(origin).normalize();
      const hit = sim.raycast(new THREE.Ray(origin, dir));
      if (hit) return { hit, dir };
    }
    throw new Error(`could not reach the ${region}`);
  }

  function pluginSet(kind: "simulator" | "retargeter", args: Args) {
    const s = store.get();
    const cur: SimulatorOptions = s[kind];
    const list = kind === "simulator" ? s.simulators : s.retargeters;
    const id = typeof args.id === "string" ? args.id : cur.id;
    const info = list.find((x) => x.id === id);
    if (!info) throw new Error(`no ${kind} "${id}" (${list.map((x) => x.id).join(", ")})`);
    if (info.unavailable) throw new Error(`${id} cannot run here: ${info.unavailable.en}`);
    const settings = { ...(id === cur.id ? cur.settings : {}), ...((args.settings as SimulatorOptions["settings"]) ?? {}) };
    for (const k of Object.keys(settings)) if (!info.parameters.some((p) => p.key === k)) throw new Error(`${id} has no parameter "${k}"`);
    store.set(kind === "simulator" ? { simulator: { id, settings } } : { retargeter: { id, settings } });
    return { id, settings };
  }

  async function track(path: string): Promise<DanceTrack> {
    const r = await host.fetchFile(path);
    if (!r.ok) throw new Error(`cannot read ${path}`);
    const t = (await r.json()) as DanceTrack;
    if (!Array.isArray(t.frames) || !t.frames.length || !(t.fps > 0)) throw new Error(`${path} is not a DanceTrack (fps, duration, frames: [{ world, image }])`);
    return t;
  }
  let previews: string[] = [];

  async function screenshot(args: Args) {
    const { renderer, scene, camera } = host.stage;
    // the drawing buffer is only valid right after a render
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const width = Math.min(num(args.width, 960, 160, 1920), src.width);
    const height = Math.round((src.height * width) / src.width);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    c.getContext("2d")!.drawImage(src, 0, 0, width, height);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/png"));
    return { path: { $file: { ext: "png", name: "screenshot", base64: await blobToBase64(blob) } }, width, height };
  }

  async function probe(args: Args) {
    const sim = needSim();
    const scene = typeof args.scene === "string" ? args.scene : "poke";
    const region = typeof args.region === "string" ? args.region : "belly";
    const seconds = num(args.seconds, 2, 0.5, 8);
    if (store.get().playback.paused) throw new Error("the simulation is paused (playback paused=false first)");
    if (args.reset !== false) {
      commands.resetFrog();
      await sleep(num(args.settle, 0.8, 0, 5) * 1000);
    }
    const samples: ProbeSample[] = [];
    const ref = needSim().readBody().slice();
    const sample = (t: number) => {
      const s = (host.sim() ?? sim).stats();
      const d = surfaceDisplacement(ref, (host.sim() ?? sim).readBody());
      samples.push({ t, surfaceMean: d.mean, surfaceMax: d.max, deviation: s.deviation, deviationMax: s.deviationMax, jitter: s.jitter, penetration: s.penetration, invertedCells: s.invertedCells, volume: s.volume, stepMs: store.get().stats.stepMs });
    };
    for (let i = 3; i > 0; i--) {
      sample(-i * 0.1);
      await sleep(100);
    }
    if (scene === "poke") {
      const { hit, dir } = aim(region);
      sim.poke(hit, num(args.strength, 0.8, 0, 1), dir);
    } else if (scene === "slap") {
      const { hit, dir } = aim(region);
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      sim.slap(hit.point, side.multiplyScalar(num(args.speed, 6, 0, 14)).addScaledVector(dir, 2));
    } else if (scene === "drop") {
      const { hit } = aim(region);
      const g = sim.grab(hit);
      for (let k = 1; k <= 10; k++) {
        g.move(hit.point.clone().add(new THREE.Vector3(0, 0.04 * k, 0)));
        await sleep(30);
      }
      g.release(new THREE.Vector3(0, 0, 0));
    } else if (scene !== "rest") throw new Error(`unknown scene "${scene}" (poke, slap, drop, rest)`);
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      sample((performance.now() - t0) / 1000);
      await sleep(100);
    }
    return { scene, region, ...summariseProbe(samples) };
  }

  return {
    state: (a) => readState(store.get(), Boolean(a.list)),
    "state.set": (a) => {
      const allowed = ["mode", "tool", "dance", "mirror", "preset", "playback", "lang", "recordLayout"] as const;
      const patch: Partial<AppState> = {};
      for (const [k, v] of Object.entries(a)) {
        if (!(allowed as readonly string[]).includes(k)) throw new Error(`state.set takes ${allowed.join(", ")} (params, simulator and retargeter have their own actions)`);
        (patch as Record<string, unknown>)[k] = v;
      }
      store.set(patch);
      return readState(store.get(), false);
    },
    "params.set": (a) => {
      const params = paramsPatch(a, store.get().params);
      store.set({ params });
      return store.get().params;
    },
    preset: (a) => {
      const p = host.presets.find((x) => x.id === a.id);
      if (!p) throw new Error(`no preset "${String(a.id)}" (${host.presets.map((x) => x.id).join(", ")})`);
      store.set({ preset: p.id, params: { ...p.params, regionSoftness: undefined } });
      return store.get().params;
    },
    "simulator.set": (a) => pluginSet("simulator", a),
    "retargeter.set": (a) => pluginSet("retargeter", a),
    mode: (a) => {
      const mode = str(a.mode, "mode");
      if (mode !== "play" && mode !== "dance") throw new Error('mode is "play" (free, poke it) or "dance" (the camera and videos need the user)');
      store.set(mode === "dance" && typeof a.dance === "string" ? { mode, dance: a.dance } : { mode });
      return { mode, dance: store.get().dance };
    },
    "dance.play": (a) => {
      const id = str(a.id, "id");
      if (!store.get().dances.some((d) => d.id === id)) throw new Error(`no dance "${id}"`);
      store.set({ mode: "dance", dance: id });
      return { dance: id };
    },
    "dance.preview": async (a) => {
      const t = await track(str(a.path, "path"));
      for (const id of previews) await host.motion.deleteDance(id);
      const info = await host.motion.saveDance(t, `${String(a.name ?? t.name ?? "preview").slice(0, 12)}·预览`);
      previews = [info.id];
      store.set({ mode: "dance", dance: info.id });
      return { dance: info.id, frames: t.frames.length, duration: t.duration };
    },
    poke: (a) => {
      const { hit, dir } = aim(typeof a.region === "string" ? a.region : "belly");
      needSim().poke(hit, num(a.strength, 0.7, 0, 1), dir);
      return { region: hit.region, point: hit.point.toArray().map((v) => +v.toFixed(3)) };
    },
    slap: (a) => {
      const { hit, dir } = aim(typeof a.region === "string" ? a.region : "belly");
      const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
      const v = vec(a.velocity, side.multiplyScalar(num(a.speed, 6, 0, 14)));
      needSim().slap(hit.point, v.clampLength(0, 14));
      return { region: hit.region, velocity: v.toArray() };
    },
    "grab-throw": async (a) => {
      if (store.get().mode !== "play") throw new Error('grab-throw needs mode "play" (the frog is held at home while it dances)');
      const { hit } = aim(typeof a.region === "string" ? a.region : "head");
      const g = needSim().grab(hit);
      const lift = num(a.lift, 0.4, 0, 1.5);
      for (let k = 1; k <= 12; k++) {
        g.move(hit.point.clone().add(new THREE.Vector3(0, (lift * k) / 12, 0)));
        await sleep(25);
      }
      const v = vec(a.velocity, new THREE.Vector3(0, 2.5, 1.5)).clampLength(0, 12);
      g.release(v);
      return { region: hit.region, velocity: v.toArray() };
    },
    ball: (a) => {
      const sim = needSim();
      const { hit } = aim(typeof a.region === "string" ? a.region : "belly");
      const origin = host.stage.camera.position.clone().add(new THREE.Vector3(0, -0.25, 0));
      const flight = 0.5;
      const g = 9.81 * store.get().params.gravity;
      const v = hit.point.clone().sub(origin).divideScalar(flight);
      v.y += 0.5 * g * flight;
      sim.throwBall(origin, v, num(a.radius, 0.1, 0.03, 0.3));
      return { region: hit.region };
    },
    "balls.rain": () => (commands.rainBalls(), { ok: true }),
    "balls.clear": () => (needSim().clearBalls(), { ok: true }),
    reset: () => (commands.resetFrog(), { ok: true }),
    playback: (a) => {
      const cur = store.get().playback;
      store.set({ playback: { paused: typeof a.paused === "boolean" ? a.paused : cur.paused, timeScale: num(a.timeScale, cur.timeScale, 0.05, 2) } });
      return store.get().playback;
    },
    step: async (a) => {
      for (let i = num(a.frames, 1, 1, 120); i > 0; i--) {
        commands.stepSim();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return { ok: true };
    },
    wait: async (a) => (await sleep(num(a.ms, 500, 0, 30000)), { ok: true }),
    metrics: () => {
      const sim = host.sim();
      const s = store.get();
      return { fps: s.stats.fps, stepMs: s.stats.stepMs, sim: sim?.stats() ?? null, motion: host.motion.metrics() };
    },
    probe,
    screenshot,
    record: async (a) => {
      if (store.get().recording.active) throw new Error("already recording");
      commands.startRecording();
      await sleep(num(a.seconds, 3, 1, 20) * 1000);
      await commands.stopRecording();
      const rec = store.get().lastRecording;
      if (!rec) throw new Error("the recording failed");
      const ext = rec.mimeType.includes("mp4") ? "mp4" : "webm";
      return { path: { $file: { ext, name: "recording", base64: await blobToBase64(rec.blob) } }, seconds: rec.durationMs / 1000 };
    },
    "block.compare": async (a) => {
      const lab = host.codeLab?.lab;
      if (!lab) throw new Error("the code lab is not mounted");
      const core = a.core === "retargeter" ? "retargeter" : "simulator";
      const from = (a.from ?? {}) as { id?: string; path?: string };
      const code = typeof a.file === "string" ? await (await host.fetchFile(a.file)).text() : str(a.code, "file or code");
      const b = lab.fork({ kind: core, slot: str(a.slot, "slot"), id: str(from.id, "from.id"), path: str(from.path, "from.path"), name: null }, code);
      try {
        const r = await lab.compare(b.key);
        const rows = (x: typeof r.builtin) => x.rows.map((row) => ({ key: row.key, label: row.label.en, unit: row.unit, value: row.value }));
        return { scene: r.scene.en, builtin: rows(r.builtin), mine: rows(r.mine) };
      } finally {
        lab.remove(b.key);
      }
    },
  };
}
