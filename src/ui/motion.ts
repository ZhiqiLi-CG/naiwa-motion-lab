/** 动作 Motion: the source (free / camera / uploaded video / preset motions), the transfer status, the person's
 *  preview with the skeleton, and each source's controls: camera start/stop, the video upload → analysis → playback
 *  flow with "save as my motion", the grouped preset list. Mirror and the recording layout for camera and video. */
import type { AppState, DanceInfo, Mode } from "../contracts";
import { DANCE_ORIGINS, RECORD_LAYOUTS, SOURCES, copy, danceName } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { append, h, icon } from "./dom";
import { pickVideo } from "./overlays";
import { motionChip, panel, section, segmented, switchRow } from "./panel";

/** "my dance.final.mp4" → "my dance.final", at most 16 characters (what the motion module keeps). */
export function danceNameFrom(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim().slice(0, 16);
}

const PHONE = "(max-width: 720px)";
const CONFIRM_MS = 3000;
export const originOf = (d: DanceInfo) => d.origin ?? "procedural";

export function createMotionPanel(ctx: Ctx, host: HTMLElement, layer: HTMLElement, preview: HTMLElement, initialDances: DanceInfo[]): Part {
  const { store, commands } = ctx;
  const T = copy();
  const { el, body } = panel(ctx, "motion", "motion", T.motion.title, T.motion.sub);

  const source = segmented<Mode>(
    T.motion.title,
    SOURCES.map((s) => ({ value: s.id, text: T.motion.sources[s.id], icon: s.icon, tip: `${T.motion.sources[s.id]}  ${s.key}` })),
    (mode) => store.set({ mode }),
    "nw-seg--block nw-seg--4",
  );
  const hint = h("p", { class: "nw-hint" });
  const chip = motionChip();
  const message = h("p", { class: "nw-status-msg" });
  const status = h("div", { class: "nw-status-row" }, chip.el, message);

  /* ---- preview: in the panel on desktop, a corner picture over the viewport on phones ---- */
  const pv = createPreview(preview);
  const slot = h("div", { class: "nw-preview-slot" });
  const phone = window.matchMedia(PHONE);
  const place = () => (phone.matches ? layer : slot).append(pv.frame);
  place();
  phone.addEventListener("change", place);

  /* ---- camera ---- */
  let running = false;
  const camBtn = commands.startCamera
    ? h("button", {
        class: "nw-btn nw-btn--primary nw-btn--block",
        onclick: () => (running ? commands.stopCamera?.() : commands.startCamera?.()),
      })
    : null;
  const camera = h("div", { class: "nw-group" }, camBtn, h("p", { class: "nw-note" }, T.camera.tip, " · ", T.camera.privacy));

  /* ---- video ---- */
  const video = createVideoSection(ctx);

  /* ---- presets ---- */
  const presets = createPresetList(ctx, initialDances);

  const mirror = switchRow("mirror", T.motion.mirror, T.motion.mirrorHint, () => store.set({ mirror: !store.get().mirror }));
  const layout = segmented(
    T.motion.layoutTitle,
    RECORD_LAYOUTS.map((l) => ({ value: l.id, text: T.motion.layouts[l.id], icon: l.icon })),
    (recordLayout) => store.set({ recordLayout }),
    "nw-seg--block nw-seg--cards",
  );
  const live = h("div", { class: "nw-group" }, mirror.row, section(T.motion.layoutTitle, layout.el));

  append(body, [source.el, hint, status, slot, camera, video.el, presets.el, live]);
  host.append(el);

  const scoped: [HTMLElement, Mode[]][] = [
    [slot, ["camera", "video"]],
    [camera, ["camera"]],
    [video.el, ["video"]],
    [presets.el, ["dance"]],
    [live, ["camera", "video"]],
  ];

  return {
    update(s, prev) {
      if (changed(s, prev, (x) => x.mode)) {
        source.set(s.mode);
        hint.textContent = T.motion.sourceHints[s.mode];
        for (const [node, modes] of scoped) node.hidden = !modes.includes(s.mode);
      }
      if (changed(s, prev, (x) => x.motion) || changed(s, prev, (x) => x.mode)) {
        chip.update(s.motion);
        message.textContent = s.motion.message ?? "";
        message.hidden = !s.motion.message;
        status.hidden = s.mode === "play";
        if (camBtn) {
          const st = s.mode === "camera" ? s.motion.state : "idle";
          running = st === "ready" || st === "tracking" || st === "lost";
          camBtn.disabled = st === "loading";
          camBtn.className = `nw-btn nw-btn--block ${running ? "nw-btn--secondary" : "nw-btn--primary"}`;
          camBtn.replaceChildren(icon("camera"), st === "loading" ? T.camera.starting : running ? T.camera.stop : T.camera.start);
        }
      }
      if (changed(s, prev, (x) => x.mirror)) mirror.set(s.mirror);
      layout.set(s.recordLayout);
      pv.update(s, prev);
      video.update(s, prev);
      presets.update(s, prev);
    },
    dispose: () => phone.removeEventListener("change", place),
  };
}

/** The camera/video picture (the motion module draws into `preview`), with a scrim label and the analysis bar. */
function createPreview(preview: HTMLElement) {
  const T = copy();
  const emptyText = h("span", {});
  const label = h("span", {});
  const fps = h("span", { class: "nw-preview-fps" });
  const progress = h("span", { class: "nw-preview-progress", "aria-hidden": "true" });
  const frame = h(
    "figure",
    { class: "nw-preview", "aria-label": T.pip.label },
    preview,
    h("div", { class: "nw-preview-empty" }, icon("person"), emptyText),
    h("figcaption", { class: "nw-preview-bar" }, h("span", { class: "nw-preview-dot" }), label, fps),
    progress,
  );
  return {
    frame,
    update(s: AppState, prev: AppState | null) {
      if (!changed(s, prev, (x) => x.mode) && !changed(s, prev, (x) => x.motion)) return;
      const cam = s.mode === "camera";
      frame.hidden = s.mode !== "camera" && s.mode !== "video";
      label.textContent = cam ? T.pip.camera : T.pip.video;
      emptyText.textContent = cam ? T.pip.emptyCamera : T.pip.emptyVideo;
      frame.classList.toggle("is-live", s.motion.state === "tracking");
      fps.textContent = s.motion.state === "tracking" && s.motion.fps ? `${Math.round(s.motion.fps)} fps` : "";
      const analysing = s.mode === "video" && s.motion.state === "loading" && s.motion.progress !== undefined;
      progress.hidden = !analysing;
      progress.style.setProperty("--p", `${Math.round((s.motion.progress ?? 0) * 100)}%`);
    },
  };
}

/** Upload → analysis progress → playback, then keep the analysed motion under a name. */
function createVideoSection(ctx: Ctx) {
  const { commands } = ctx;
  const T = copy();
  const input = h("input", { type: "file", accept: "video/*", class: "nw-file", tabindex: "-1", "aria-hidden": "true" });
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) pickVideo(ctx, f);
    input.value = "";
  });
  const zone = h(
    "button",
    { class: "nw-dropzone", onclick: () => input.click() },
    icon("upload"),
    h("span", {}, h("span", { class: "nw-dropzone-or" }, T.video.drop, " "), h("u", {}, T.video.pick)),
  );
  // the file name is kept on the root, so a rebuilt panel (language switch) still shows it
  let fileName = ctx.root.dataset.videoName ?? "";
  const fileText = h("span", { class: "nw-truncate" }, fileName);
  const fileRow = h(
    "div",
    { class: "nw-file-row" },
    icon("film"),
    fileText,
    h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", onclick: () => input.click() }, T.video.swap),
  );

  const pct = h("span", { class: "nw-progress-pct" });
  const bar = h("div", { class: "nw-progress-bar" }, h("span", { class: "nw-progress-fill" }));
  const progress = h(
    "div",
    { class: "nw-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": T.video.analysing },
    h("div", { class: "nw-progress-head" }, h("span", {}, T.video.analysing), pct),
    bar,
    h("p", { class: "nw-note" }, T.video.analysingHint),
  );

  const keepBtn = h("button", { class: "nw-btn nw-btn--secondary nw-btn--block" });
  const nameInput = h("input", { class: "nw-input", type: "text", maxlength: "16", placeholder: T.video.namePlaceholder, "aria-label": T.video.namePlaceholder });
  const saveBtn = h("button", { class: "nw-btn nw-btn--primary nw-btn--sm", type: "submit" }, T.video.save);
  const form = h(
    "form",
    { class: "nw-keep-form" },
    nameInput,
    saveBtn,
    h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", type: "button", onclick: () => showForm(false) }, T.video.cancel),
  );
  let kept = false;
  let canSave = false;
  const showForm = (open: boolean) => {
    form.hidden = !open;
    keepBtn.hidden = open;
    if (!open) return;
    nameInput.value = danceNameFrom(fileName);
    nameInput.focus();
    nameInput.select();
  };
  const markKept = (done: boolean) => {
    kept = done;
    keepBtn.disabled = done || !canSave;
    keepBtn.replaceChildren(icon(done ? "check" : "keep"), done ? T.video.kept : T.video.keep);
  };
  markKept(false);
  showForm(false);
  keepBtn.addEventListener("click", () => showForm(true));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim() || danceNameFrom(fileName) || T.video.namePlaceholder;
    saveBtn.disabled = true;
    // the command announces the save itself
    commands
      .saveDance(name)
      .then(
        () => {
          showForm(false);
          markKept(true);
        },
        () => ctx.toast(T.video.saveFailed, "error"),
      )
      .finally(() => (saveBtn.disabled = false));
  });
  ctx.root.addEventListener("nw:video", (e) => {
    fileName = (e as CustomEvent<string>).detail;
    fileText.textContent = fileName;
    markKept(false);
    showForm(false);
  });

  const keep = h("div", { class: "nw-keep" }, keepBtn, form);
  const el = h("div", { class: "nw-group" }, zone, input, fileRow, progress, keep, h("p", { class: "nw-note" }, T.video.tip, " · ", T.video.privacy));
  return {
    el,
    update(s: AppState, prev: AppState | null) {
      if (changed(s, prev, (x) => x.canSaveDance)) {
        canSave = s.canSaveDance;
        keepBtn.disabled = kept || !canSave;
      }
      if (!changed(s, prev, (x) => x.motion) && !changed(s, prev, (x) => x.mode)) return;
      const m = s.motion;
      const mine = s.mode === "video";
      const analysing = mine && m.state === "loading";
      const playing = mine && (m.state === "ready" || m.state === "tracking" || m.state === "lost");
      zone.hidden = (analysing || playing) && fileName !== "";
      fileRow.hidden = !zone.hidden;
      progress.hidden = !analysing;
      if (analysing) {
        const known = m.progress !== undefined;
        const p = Math.round((m.progress ?? 0) * 100);
        progress.classList.toggle("is-indeterminate", !known);
        bar.style.setProperty("--p", `${p}%`);
        pct.textContent = known ? `${p}%` : "";
        if (known) progress.setAttribute("aria-valuenow", String(p));
        else progress.removeAttribute("aria-valuenow");
      }
      keep.hidden = !playing;
    },
  };
}

/** Preset motions grouped by origin; the player's own can be deleted (a second click confirms). */
function createPresetList(ctx: Ctx, initial: DanceInfo[]) {
  const { store, commands } = ctx;
  const T = copy();
  const el = h("div", { class: "nw-group nw-presets-list" });
  let rows: { id: string; el: HTMLElement }[] = [];
  let shown: DanceInfo[] | null = null;

  function row(d: DanceInfo): HTMLElement {
    const btn = h(
      "button",
      { class: "nw-row", "aria-pressed": "false", onclick: () => store.set({ mode: "dance", dance: d.id }) },
      h("span", { class: "nw-row-main" }, h("span", { class: "nw-row-name" }, danceName(d)), h("span", { class: "nw-row-meta" }, T.dance.loop(d.duration))),
      d.credit ? h("span", { class: "nw-row-credit", title: d.credit }, `${T.dance.from}: ${d.credit}`) : null,
    );
    rows.push({ id: d.id, el: btn });
    if (originOf(d) !== "mine") return h("li", {}, btn);
    let armed = 0;
    const del = h("button", { class: "nw-icon-btn nw-icon-btn--sm nw-row-del", "aria-label": T.dance.delete, "data-tip": T.dance.delete }, icon("trash"));
    const disarm = () => {
      clearTimeout(armed);
      armed = 0;
      del.classList.remove("is-armed");
      del.setAttribute("aria-label", T.dance.delete);
      del.setAttribute("data-tip", T.dance.delete);
    };
    del.addEventListener("click", () => {
      if (!armed) {
        del.classList.add("is-armed");
        del.setAttribute("aria-label", T.dance.confirmDelete);
        del.setAttribute("data-tip", T.dance.confirmDelete);
        armed = window.setTimeout(disarm, CONFIRM_MS);
        return;
      }
      disarm();
      del.disabled = true;
      commands.deleteDance(d.id).then(
        () => ctx.toast(T.dance.deleted(danceName(d)), "info"),
        () => {
          del.disabled = false;
          ctx.toast(T.dance.deleteFailed, "error");
        },
      );
    });
    return h("li", { class: "nw-row-wrap" }, btn, del);
  }

  function render(list: DanceInfo[]) {
    rows = [];
    const groups = DANCE_ORIGINS.flatMap((origin) => {
      const items = list.filter((d) => originOf(d) === origin);
      if (!items.length && origin !== "mine") return [];
      const content = items.length
        ? h("ul", { class: "nw-rows" }, ...items.map(row))
        : h(
            "div",
            { class: "nw-empty-mine" },
            h("p", { class: "nw-note" }, T.dance.mineEmpty),
            h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", onclick: () => store.set({ mode: "video" }) }, icon("upload"), T.dance.goVideo),
          );
      return [section(`${T.dance.groups[origin]}${items.length ? ` · ${items.length}` : ""}`, content)];
    });
    el.replaceChildren(...(groups.length ? groups : [h("p", { class: "nw-note" }, T.dance.empty)]));
  }
  const mark = (s: AppState) => {
    for (const r of rows) r.el.setAttribute("aria-pressed", String(s.mode === "dance" && r.id === s.dance));
  };
  return {
    el,
    update(s: AppState, prev: AppState | null) {
      const list = s.dances.length ? s.dances : initial;
      if (list !== shown) {
        shown = list;
        render(list);
        mark(s);
      } else if (changed(s, prev, (x) => x.dance) || changed(s, prev, (x) => x.mode)) mark(s);
    },
  };
}
