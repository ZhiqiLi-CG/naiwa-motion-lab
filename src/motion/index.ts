/**
 * Motion module: built-in dances, dances captured from real videos, "我的舞蹈" saved in this browser, the webcam and
 * uploaded videos → PoseFrames for the bound frog rig. Everything goes through the retargeting pipeline (core.ts) of
 * the chosen retargeter (api.ts): people through all of it, procedural dances (written as goals) from the solver on.
 */
import type {
  DanceIndexEntry, DanceInfo, DanceTrack, MotionModule, MotionSource, MotionStatus, RetargeterInfo, RetargeterOptions, RigInfo,
} from "../contracts";
import { onLang, tr, type Text } from "../i18n";
import type { Recording, RetargetMetrics } from "./api";
import { DEFAULT_RETARGETER, registerBuiltins } from "./blocks";
import { createRetargetPipeline, type RetargetPipeline } from "./core";
import { PROCEDURAL_DANCES } from "./dances";
import { hasRetargeter, listRetargeters, onRetargetersChanged } from "./registry";
import { bindRig, type Binding } from "./rig";
import { loadSaved, putSaved, removeSaved } from "./saved";
import { proceduralSource, startCamera, startVideo, trackSource, type MirrorableSource, type OpenRetarget, type Status, type VideoSource } from "./sources";
import { fetchTrack, type Track } from "./track";

export * from "./api";
export { DEFAULT_RETARGETER } from "./blocks";
export type { MirrorableSource, VideoSource } from "./sources";
export { MAX_VIDEO_SECONDS } from "./sources";

export interface NaiwaMotion extends MotionModule {
  startCamera(opts: { mirror: boolean; preview: HTMLElement }): Promise<MirrorableSource>;
  startVideo(file: File | string, opts: { mirror: boolean; preview: HTMLElement }): Promise<VideoSource>;
  /** The current binding (null before bind), for debugging views. */
  binding(): Binding | null;
  /** Every registered retargeter (built in and the user's), with its declared parameters. */
  retargeters(): RetargeterInfo[];
  onRetargetersChanged(cb: (list: RetargeterInfo[]) => void): () => void;
  /** Use this retargeter and settings from now on, also for running sources (settings apply live where the blocks
   *  can take them, else the pipeline is rebuilt). An unknown id keeps the default. */
  setRetargeter(options: RetargeterOptions): void;
  /** The retargeter in use. */
  retargeter(): RetargeterOptions;
  /** Quality of the running source over the last two seconds (null before it showed a frame). */
  metrics(): RetargetMetrics | null;
}

/** Metrics as labelled readouts for the lab (the UI's PluginMetric). */
export function metricReadouts(m: RetargetMetrics): { label: Text; value: string }[] {
  return [
    { label: { zh: "方向偏差", en: "Direction error" }, value: `${m.fidelity.toFixed(1)}°` },
    { label: { zh: "加加速度", en: "Jerk" }, value: `${m.jerk.toFixed(0)} m/s³` },
    { label: { zh: "四肢入体", en: "Limb penetration" }, value: `${(m.penetration * 1000).toFixed(1)} mm` },
    { label: { zh: "脚滑", en: "Foot slide" }, value: `${(m.footSlide * 100).toFixed(1)} cm/s` },
  ];
}

interface Entry {
  info: DanceInfo;
  /** Procedural dances have no track. */
  track?: () => Promise<Track>;
}

export function createMotion(): NaiwaMotion {
  registerBuiltins();
  let binding: Binding | null = null;
  const getBinding = () => binding;

  // The retargeter: each source holds a getter that rebuilds its pipeline when the rig, the retargeter or one of its
  // blocks changes (a new registration), and hands new settings to it live when its blocks can take them.
  let options: RetargeterOptions = { id: DEFAULT_RETARGETER, settings: {} };
  let structure = 0;
  let settingsRev = 0;
  let latest: RetargetPipeline | null = null;
  onRetargetersChanged(() => {
    if (!hasRetargeter(options.id)) {
      console.warn(`motion: retargeter "${options.id}" is gone, back to ${DEFAULT_RETARGETER}`);
      options = { id: DEFAULT_RETARGETER, settings: {} };
    }
    structure++;
  });
  // A retargeter that fails to build (a user's block throwing) falls back to the default.
  const build = (rig: Binding, recording: Recording | null): RetargetPipeline => {
    try {
      return createRetargetPipeline(rig, options, recording);
    } catch (e) {
      if (options.id === DEFAULT_RETARGETER) throw e;
      console.warn(`motion: retargeter "${options.id}" failed to build, back to ${DEFAULT_RETARGETER}`, e);
      options = { id: DEFAULT_RETARGETER, settings: {} };
      structure++;
      return createRetargetPipeline(rig, options, recording);
    }
  };
  const open: OpenRetarget = (recording) => {
    let built: { p: RetargetPipeline; rig: Binding; structure: number; settings: number } | null = null;
    return () => {
      if (!binding) return null;
      if (built && built.rig === binding && built.structure === structure && built.settings !== settingsRev && built.p.setSettings(options.settings)) {
        built.settings = settingsRev;
      }
      if (!built || built.rig !== binding || built.structure !== structure || built.settings !== settingsRev) {
        built = { p: build(binding, recording ?? null), rig: binding, structure, settings: settingsRev };
      }
      return (latest = built.p);
    };
  };
  const statusListeners = new Set<(s: MotionStatus) => void>();
  const listListeners = new Set<(d: DanceInfo[]) => void>();
  // The last status is kept with both languages so a language switch re-shows it translated.
  let status: Status = { state: "idle" };
  const show = () => {
    const { text, ...rest } = status;
    const s: MotionStatus = text ? { ...rest, message: tr(text) } : rest;
    statusListeners.forEach((l) => l(s));
  };
  const emit = (s: Status) => {
    status = s;
    show();
  };
  onLang(show);

  const entries: Entry[] = PROCEDURAL_DANCES.map(({ id, name, nameEn, duration }) => ({ info: { id, name, nameEn, duration, origin: "procedural" } }));
  const list = () => entries.map((e) => e.info);
  const changed = () => listListeners.forEach((l) => l(list()));
  const cached = (load: () => Promise<Track>) => {
    let p: Promise<Track> | null = null;
    return () => (p ??= load().catch((e) => ((p = null), Promise.reject(e))));
  };
  const mine = (t: Track): Entry => ({
    info: { id: t.id, name: t.name, nameEn: t.nameEn ?? t.name, duration: t.duration, origin: "mine" },
    track: () => Promise.resolve(t),
  });

  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  const presets = fetch(new URL("dances/index.json", base))
    .then((r) => (r.ok ? (r.json() as Promise<DanceIndexEntry[]>) : []))
    .then((index) =>
      Promise.all(
        index.map(async (e) => {
          const load = cached(() => fetchTrack(new URL(e.file, base).href));
          // The credit (source title) lives in the track itself.
          const t = await load().catch(() => null);
          const info: DanceInfo = { id: e.id, name: e.name, nameEn: e.nameEn ?? t?.nameEn, duration: e.duration, origin: "video", credit: t?.source.title };
          return { info, track: load };
        }),
      ),
    )
    .catch((e) => (console.warn("motion: no dance index", e), [] as Entry[]));
  const saved = loadSaved().catch((e) => (console.warn("motion: saved dances unavailable", e), [] as Track[]));
  const ready = Promise.all([presets, saved]).then(([p, s]) => {
    entries.push(...p, ...s.map(mine));
    changed();
  });

  // Camera and video share the detector and the preview: one at a time, a new start replaces the old one
  // (dispose is idempotent, so the integrator disposing it too is fine).
  let live: MotionSource | null = null;
  let generation = 0;
  const begin = () => {
    live?.dispose();
    live = null;
    return ++generation;
  };
  const own = <S extends MotionSource>(gen: number, src: S): S => {
    if (gen !== generation) {
      src.dispose();
      throw new Error("motion: replaced by a newer start");
    }
    return (live = src);
  };

  return {
    ready: () => ready,
    bind(rig: RigInfo) {
      binding = bindRig(rig);
    },
    binding: getBinding,
    async startCamera({ mirror, preview }) {
      const gen = begin();
      return own(gen, await startCamera(mirror, preview, open, emit));
    },
    async startVideo(file, { mirror, preview }) {
      const gen = begin();
      return own(gen, await startVideo(file, mirror, preview, open, emit, () => gen !== generation));
    },
    startDance(id: string) {
      const e = entries.find((d) => d.info.id === id);
      if (!e) console.warn(`motion: unknown dance "${id}", playing ${entries[0].info.id}`);
      const entry = e ?? entries[0];
      if (!entry.track) return proceduralSource(PROCEDURAL_DANCES.find((d) => d.id === entry.info.id)!, open);
      return trackSource(entry.track(), entry.info.duration, open, emit);
    },
    dances: list,
    async saveDance(track: DanceTrack, name: string) {
      const label = name.trim().slice(0, 16) || tr({ zh: "我的舞蹈", en: "My dance" });
      const t: Track = { ...(track as Track), id: `mine-${Date.now().toString(36)}`, name: label, nameEn: label };
      await putSaved(t);
      const entry = mine(t);
      entries.push(entry);
      changed();
      return entry.info;
    },
    async deleteDance(id: string) {
      const i = entries.findIndex((e) => e.info.id === id && e.info.origin === "mine");
      if (i < 0) return;
      await removeSaved(id);
      entries.splice(i, 1);
      changed();
    },
    onDancesChanged(cb) {
      listListeners.add(cb);
      return () => listListeners.delete(cb);
    },
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    retargeters: listRetargeters,
    onRetargetersChanged: (cb) => onRetargetersChanged(() => cb(listRetargeters())),
    setRetargeter(next) {
      if (!hasRetargeter(next.id)) {
        console.warn(`motion: unknown retargeter "${next.id}", using ${DEFAULT_RETARGETER}`);
        next = { id: DEFAULT_RETARGETER, settings: next.settings };
      }
      if (next.id !== options.id) structure++;
      else settingsRev++;
      options = { id: next.id, settings: { ...next.settings } };
    },
    retargeter: () => options,
    metrics: () => latest?.metrics() ?? null,
  };
}
