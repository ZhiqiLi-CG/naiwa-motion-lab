/**
 * Motion module: built-in dances, dances captured from real videos, "我的舞蹈" saved in this browser, the webcam and
 * uploaded videos → PoseFrames for the bound frog rig. All of them go through one BodyPose → rig solver (rig.ts), and
 * everything that comes from a person goes through one Retargeter (retarget.ts).
 */
import type { DanceIndexEntry, DanceInfo, DanceTrack, MotionModule, MotionSource, MotionStatus, RigInfo } from "../contracts";
import { PROCEDURAL_DANCES } from "./dances";
import { bindRig, type Binding } from "./rig";
import { loadSaved, putSaved, removeSaved } from "./saved";
import { proceduralSource, startCamera, startVideo, trackSource, type MirrorableSource, type VideoSource } from "./sources";
import { fetchTrack, type Track } from "./track";

export type { MirrorableSource, VideoSource } from "./sources";
export { MAX_VIDEO_SECONDS } from "./sources";

export interface NaiwaMotion extends MotionModule {
  startCamera(opts: { mirror: boolean; preview: HTMLElement }): Promise<MirrorableSource>;
  startVideo(file: File | string, opts: { mirror: boolean; preview: HTMLElement }): Promise<VideoSource>;
  /** The current binding (null before bind), for debugging views. */
  binding(): Binding | null;
}

interface Entry {
  info: DanceInfo;
  /** Procedural dances have no track. */
  track?: () => Promise<Track>;
}

export function createMotion(): NaiwaMotion {
  let binding: Binding | null = null;
  const getBinding = () => binding;
  const statusListeners = new Set<(s: MotionStatus) => void>();
  const listListeners = new Set<(d: DanceInfo[]) => void>();
  const emit = (s: MotionStatus) => statusListeners.forEach((l) => l(s));

  const entries: Entry[] = PROCEDURAL_DANCES.map(({ id, name, duration }) => ({ info: { id, name, duration, origin: "procedural" } }));
  const list = () => entries.map((e) => e.info);
  const changed = () => listListeners.forEach((l) => l(list()));
  const cached = (load: () => Promise<Track>) => {
    let p: Promise<Track> | null = null;
    return () => (p ??= load().catch((e) => ((p = null), Promise.reject(e))));
  };
  const mine = (t: Track): Entry => ({
    info: { id: t.id, name: t.name, duration: t.duration, origin: "mine" },
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
          return { info: { id: e.id, name: e.name, duration: e.duration, origin: "video", credit: t?.source.title }, track: load } as Entry;
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
      return own(gen, await startCamera(mirror, preview, getBinding, emit));
    },
    async startVideo(file, { mirror, preview }) {
      const gen = begin();
      return own(gen, await startVideo(file, mirror, preview, getBinding, emit, () => gen !== generation));
    },
    startDance(id: string) {
      const e = entries.find((d) => d.info.id === id);
      if (!e) console.warn(`motion: unknown dance "${id}", playing ${entries[0].info.id}`);
      const entry = e ?? entries[0];
      if (!entry.track) return proceduralSource(PROCEDURAL_DANCES.find((d) => d.id === entry.info.id)!, getBinding);
      return trackSource(entry.track(), getBinding, emit);
    },
    dances: list,
    async saveDance(track: DanceTrack, name: string) {
      const t: Track = { ...(track as Track), id: `mine-${Date.now().toString(36)}`, name: name.trim().slice(0, 16) || "我的舞蹈" };
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
  };
}
