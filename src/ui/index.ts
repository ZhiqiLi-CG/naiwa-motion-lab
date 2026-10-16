/**
 * The DOM interface of 奶蛙 Playground. It floats over the 3D stage (#stage) with pointer events only on its own
 * controls, so the frog stays touchable everywhere else. It renders from the store and writes the store (mode, tool,
 * params, preset, dance, mirror, sound, theme); everything else goes through the commands.
 *
 * Styles: import "./styles/index.css" once (src/styles/index.css).
 */
import type { AppState, MaterialPreset, UIHandles } from "../contracts";
import type { Store } from "../store";
import type { Ctx, Part, UICommands, UIDance } from "./ctx";
import { h, icon } from "./dom";
import { resolveTheme } from "./format";
import { bindKeys } from "./keys";
import { createCameraPanel, createDancePanel, createPip, createVideoPanel } from "./modes";
import { createDialogs, createDropTarget, createLoading, createPokeHint, createToasts } from "./overlays";
import { createCounter, createDock } from "./play";
import { createFeel } from "./feel";
import { createHelp, createRecordingSheet } from "./sheets";
import { createTopbar } from "./topbar";

export type { CameraCommands, UICommands, UIDance } from "./ctx";
export { resolveTheme } from "./format";

export interface UIOptions {
  dances: UIDance[];
  presets: MaterialPreset[];
}

export interface MountedUI extends UIHandles {
  /** The theme the page shows now ("system" resolved); also set as <html data-theme>. */
  theme(): "light" | "dark";
  /** Called whenever the shown theme changes (the stage should follow: Stage.setTheme). */
  onTheme(cb: (theme: "light" | "dark") => void): () => void;
  /** Replace the dance list (MotionModule.ready() completes it after mount). */
  setDances(dances: UIDance[]): void;
  dispose(): void;
}

export function mountUI(root: HTMLElement, store: Store, commands: UICommands, opts: UIOptions): MountedUI {
  root.classList.add("nw-ui");
  root.dataset.sheet = "closed";
  root.dataset.feel = window.matchMedia("(max-width: 720px)").matches ? "closed" : "open";

  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const theme = () => resolveTheme(store.get().theme, dark.matches);
  const themeListeners = new Set<(t: "light" | "dark") => void>();
  let shownTheme: "light" | "dark" | null = null;
  const applyTheme = () => {
    const t = theme();
    if (t === shownTheme) return;
    shownTheme = t;
    document.documentElement.dataset.theme = t;
    for (const cb of themeListeners) cb(t);
  };
  applyTheme();

  const layer = h("div", { class: "nw-layer" });
  const sheet = h("div", { class: "nw-sheet" });
  const sheetHandle = h(
    "button",
    { class: "nw-sheet-handle", "aria-expanded": "false", onclick: () => ctx.setSheet() },
    h("span", { class: "nw-sheet-grip", "aria-hidden": "true" }),
    h("span", { class: "nw-sheet-label" }),
    icon("chevronDown"),
  );
  sheet.append(sheetHandle);
  const overlays = h("div", { class: "nw-overlays" });
  root.append(layer, sheet, overlays);

  const toast = createToasts(overlays);
  const dialogs = createDialogs(overlays);
  const ctx: Ctx = {
    root,
    store,
    commands,
    presets: opts.presets,
    toast,
    openHelp: () => openHelp(),
    setSheet(open) {
      const next = open ?? root.dataset.sheet !== "open";
      root.dataset.sheet = next ? "open" : "closed";
      sheetHandle.setAttribute("aria-expanded", String(next));
      sheetHandle.querySelector(".nw-sheet-label")!.textContent = next ? "收起" : "更多玩法 · 手感";
    },
    setFeel(open) {
      // on a phone the feel panel lives in the bottom sheet, so F opens the sheet
      if (window.matchMedia("(max-width: 720px)").matches) return ctx.setSheet(open);
      const next = open ?? root.dataset.feel !== "open";
      root.dataset.feel = next ? "open" : "closed";
    },
    dialogOpen: () => dialogs.isOpen(),
    closeDialog: () => dialogs.closeTop(),
  };
  ctx.setSheet(false);
  const openHelp = createHelp(ctx, dialogs);

  // Desktop: everything floats in `layer` and the sheet wrapper is transparent to layout; phone: the sheet is a
  // bottom sheet holding the dock, the mode panels and the feel panel.
  const pip = createPip(layer);
  const dance = createDancePanel(ctx, sheet, opts.dances);
  const parts: Part[] = [
    createTopbar(ctx, layer, theme),
    createCounter(ctx, layer),
    createPokeHint(layer),
    pip.part,
    createDock(ctx, sheet),
    createCameraPanel(ctx, sheet),
    createVideoPanel(ctx, sheet),
    dance,
    createFeel(ctx, sheet),
    createRecordingSheet(ctx, dialogs),
    createLoading(overlays),
  ];
  createDropTarget(ctx, overlays);

  const render = (s: AppState, prev: AppState | null) => {
    if (!prev || s.theme !== prev.theme) applyTheme();
    root.dataset.mode = s.mode;
    root.dataset.recording = String(s.recording.active);
    root.dataset.loading = String(s.loading.active);
    for (const p of parts) p.update(s, prev);
  };
  render(store.get(), null);
  const unsubscribe = store.subscribe(render);
  const onSystemTheme = () => {
    applyTheme();
    const s = store.get();
    render(s, s);
  };
  dark.addEventListener("change", onSystemTheme);
  const unbindKeys = bindKeys(ctx, theme);

  return {
    preview: pip.preview,
    toast,
    theme,
    onTheme(cb) {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    setDances: (list) => dance.setDances(list),
    dispose() {
      unsubscribe();
      unbindKeys();
      dark.removeEventListener("change", onSystemTheme);
      root.replaceChildren();
      root.classList.remove("nw-ui");
    },
  };
}
