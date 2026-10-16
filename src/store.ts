/** The app state: one small observable store shared by the UI (reads and writes it) and the integration (src/main.ts). */
import type { AppState, MaterialPreset, PhysicsParams } from "./contracts";
import { getLang } from "./i18n";

export type Listener = (state: AppState, prev: AppState) => void;

export interface Store {
  get(): AppState;
  /** Shallow-merge a patch (params merges one level deeper). */
  set(patch: Partial<Omit<AppState, "params">> & { params?: Partial<PhysicsParams> }): void;
  subscribe(listener: Listener): () => void;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: "jelly", name: "果冻", nameEn: "Jelly", params: { softness: 0.85, bounciness: 0.65, gravity: 1, bellySize: 1, stubbornness: 0.7 } },
  { id: "mochi", name: "麻薯", nameEn: "Mochi", params: { softness: 0.95, bounciness: 0.15, gravity: 1, bellySize: 1, stubbornness: 0.5 } },
  { id: "balloon", name: "气球", nameEn: "Balloon", params: { softness: 0.6, bounciness: 0.85, gravity: 0.35, bellySize: 1.35, stubbornness: 0.8 } },
  { id: "pudding", name: "布丁", nameEn: "Pudding", params: { softness: 0.7, bounciness: 0.45, gravity: 1, bellySize: 1.05, stubbornness: 0.9 } },
  { id: "rubber", name: "橡皮", nameEn: "Rubber", params: { softness: 0.35, bounciness: 0.9, gravity: 1, bellySize: 1, stubbornness: 1 } },
];

export function initialState(): AppState {
  return {
    mode: "play",
    tool: "hand",
    params: { ...MATERIAL_PRESETS[0].params },
    preset: MATERIAL_PRESETS[0].id,
    dance: "belly-laugh",
    mirror: true,
    sound: false,
    theme: "system",
    lang: getLang(),
    recording: { active: false, startedAt: null },
    recordLayout: "pip",
    lastRecording: null,
    dances: [],
    canSaveDance: false,
    motion: { state: "idle" },
    simulator: { id: "cpu-constraints", settings: {} },
    simulators: [],
    retargeter: { id: "retarget-default", settings: {} },
    retargeters: [],
    playback: { paused: false, timeScale: 1 },
    stats: { fps: 0, stepMs: 0, particles: 0, cells: 0, volumeRatio: 1 },
    loading: { active: true, message: "" },
  };
}

export function createStore(initial: AppState = initialState()): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const { params, ...rest } = patch;
      state = { ...state, ...rest, params: params ? { ...state.params, ...params } : state.params };
      for (const l of listeners) l(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
