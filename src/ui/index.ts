/**
 * The DOM interface of Naiwa Motion Lab: a top bar (brand, simulation readouts, record, language, sound, theme,
 * help), the Motion panel (source, transfer status, the person's preview with skeleton, per-source controls), the
 * Simulation panel (material presets, global knobs, material by region) and the bar under the viewport (playback,
 * interaction, reset). On phones the two panels are tabs of one bottom sheet. It floats over the 3D stage (#stage)
 * with pointer events only on its own controls, renders from the store and writes the store (mode, tool, params,
 * preset, dance, mirror, sound, theme, lang, recordLayout, playback); everything else goes through the commands.
 * Switching the language rebuilds it in the other language (the preview element survives).
 *
 * Styles: import "./styles/index.css" once (src/styles/index.css).
 */
import type { AppState, DanceInfo, MaterialPreset, UIHandles } from "../contracts";
import { setLang, type Lang } from "../i18n";
import type { Store } from "../store";
import { LAB_KEY, copy } from "./copy";
import type { Ctx, Part, ToastKind, UICommands } from "./ctx";
import { h, icon } from "./dom";
import { resolveTheme } from "./format";
import { watchInsets, type Insets } from "./insets";
import { bindKeys } from "./keys";
import { createMotionPanel } from "./motion";
import { createDialogs, createDropTarget, createLoading, createToasts } from "./overlays";
import { createReadouts } from "./readouts";
import { createHelp, createRecordingSheet } from "./sheets";
import { createSimulationPanel } from "./simulation";
import { createTopbar } from "./topbar";
import { createTransport } from "./transport";

export type { CameraCommands, UICommands } from "./ctx";
export type { Insets } from "./insets";
export type { PluginInfo } from "./plugins";
export { resolveTheme } from "./format";

export interface UIOptions {
  /** Shown while the store's live list (AppState.dances) is still empty. */
  dances: DanceInfo[];
  presets: MaterialPreset[];
}

export interface MountedUI extends UIHandles {
  /** The theme the page shows now ("system" resolved); also set as <html data-theme>. */
  theme(): "light" | "dark";
  /** Called whenever the shown theme changes (the stage should follow: Stage.setTheme). */
  onTheme(cb: (theme: "light" | "dark") => void): () => void;
  /** Pixels of each window edge the UI covers now (top bar, side panels, the bar under the viewport, phone sheet). */
  insets(): Insets;
  /** Called whenever the covered edges change: frame the frog in the free middle (e.g. a camera view offset). */
  onInsets(cb: (insets: Insets) => void): () => void;
  dispose(): void;
}

type Tab = "motion" | "sim";
const PHONE = "(max-width: 720px)";

/** One build of the UI in one language. */
interface View {
  lang: Lang;
  parts: Part[];
  toast(message: string, kind?: ToastKind): void;
  dialogs: ReturnType<typeof createDialogs>;
  openHelp(): void;
  sheetChanged(): void;
  insets: ReturnType<typeof watchInsets>;
  dispose(): void;
}

function readLab(): boolean {
  try {
    return localStorage.getItem(LAB_KEY) === "open";
  } catch {
    return false;
  }
}

export function mountUI(root: HTMLElement, store: Store, commands: UICommands, opts: UIOptions): MountedUI {
  root.classList.add("nw-ui");
  root.dataset.sheet = "closed";
  root.dataset.tab = "motion";
  root.dataset.lab = readLab() ? "open" : "closed";

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

  // The motion module draws the camera/video into this element, so it outlives every rebuild.
  const preview = h("div", { class: "nw-preview-media" });
  const insetListeners = new Set<(i: Insets) => void>();

  let view: View | null = null;
  const ctx: Ctx = {
    root,
    store,
    commands,
    presets: opts.presets,
    toast: (m, k) => view?.toast(m, k),
    openHelp: () => view?.openHelp(),
    setSheet(open) {
      root.dataset.sheet = (open ?? root.dataset.sheet !== "open") ? "open" : "closed";
      view?.sheetChanged();
    },
    setLab(open) {
      const next = open ?? root.dataset.lab !== "open";
      root.dataset.lab = next ? "open" : "closed";
      try {
        localStorage.setItem(LAB_KEY, next ? "open" : "closed");
      } catch {
        // storage blocked (private window): the choice lasts for this visit only
      }
      if (!next && root.dataset.tab === "sim") root.dataset.tab = "motion";
      // on a phone the lab is a tab of the bottom sheet: opening it shows that tab
      if (next && window.matchMedia(PHONE).matches) {
        root.dataset.tab = "sim";
        root.dataset.sheet = "open";
      }
      for (const b of root.querySelectorAll("[data-lab-toggle]")) b.setAttribute("aria-pressed", String(next));
      view?.sheetChanged();
    },
    dialogOpen: () => view?.dialogs.isOpen() ?? false,
    closeDialog: () => view?.dialogs.closeTop(),
  };

  function build(lang: Lang): View {
    setLang(lang);
    const T = copy(lang);
    const layer = h("div", { class: "nw-layer" });
    const sheet = h("div", { class: "nw-sheet" });
    const overlays = h("div", { class: "nw-overlays" });
    root.replaceChildren(layer, sheet, overlays);

    // Phone: the sheet's head holds the transport, the readouts and the two tabs; tapping the open tab closes it.
    const tabs = (["motion", "sim"] as Tab[]).map((t) =>
      h(
        "button",
        {
          class: "nw-tab",
          "data-tab": t,
          onclick: () => {
            const open = root.dataset.sheet === "open";
            if (open && root.dataset.tab === t) ctx.setSheet(false);
            else {
              root.dataset.tab = t;
              ctx.setSheet(true);
            }
          },
        },
        icon(t === "motion" ? "motion" : "sliders"),
        T.tabs[t],
        icon("chevronDown", "nw-icon nw-tab-chevron"),
      ),
    );
    tabs[1]!.setAttribute("data-lab-only", "");
    const head = h("div", { class: "nw-sheet-head" }, h("div", { class: "nw-tabs", role: "group", "aria-label": T.sheetToggle }, ...tabs));
    sheet.append(head);

    const toast = createToasts(overlays);
    const dialogs = createDialogs(overlays);
    // Desktop: the panels and the transport float on their own (the sheet wrapper is transparent to layout).
    const parts: Part[] = [
      createTopbar(ctx, layer, theme),
      createTransport(ctx, head),
      createReadouts(head, true),
      createMotionPanel(ctx, sheet, layer, preview, opts.dances),
      createSimulationPanel(ctx, sheet),
      createRecordingSheet(ctx, dialogs),
      createLoading(overlays),
    ];
    // phone order: the bar, the readouts, then the tabs
    head.append(head.querySelector(".nw-tabs")!);
    const disposeDrop = createDropTarget(ctx, overlays);
    const insets = watchInsets(root, (i) => insetListeners.forEach((cb) => cb(i)));
    const sheetChanged = () => {
      const open = root.dataset.sheet === "open";
      for (const b of tabs) b.setAttribute("aria-expanded", String(open && root.dataset.tab === b.dataset.tab));
      insets.refresh();
    };
    sheetChanged();
    return {
      lang,
      parts,
      toast,
      dialogs,
      openHelp: createHelp(ctx, dialogs),
      sheetChanged,
      insets,
      dispose() {
        for (const p of parts) p.dispose?.();
        disposeDrop();
        insets.dispose();
      },
    };
  }

  const render = (s: AppState, prev: AppState | null) => {
    if (!view || s.lang !== view.lang) {
      // the language toggle had focus: give it back in the new build
      const refocus = view !== null && root.contains(document.activeElement);
      view?.dispose();
      view = build(s.lang);
      prev = null;
      if (refocus) root.querySelector<HTMLElement>("[data-lang-toggle]")?.focus();
    }
    if (!prev || s.theme !== prev.theme) applyTheme();
    root.dataset.mode = s.mode;
    root.dataset.loading = String(s.loading.active);
    for (const p of view.parts) p.update(s, prev);
    view.insets.refresh();
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
    preview,
    toast: ctx.toast,
    theme,
    onTheme(cb) {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    insets: () => view!.insets.now(),
    onInsets(cb) {
      insetListeners.add(cb);
      return () => insetListeners.delete(cb);
    },
    dispose() {
      unsubscribe();
      unbindKeys();
      view?.dispose();
      dark.removeEventListener("change", onSystemTheme);
      root.replaceChildren();
      root.classList.remove("nw-ui");
    },
  };
}
