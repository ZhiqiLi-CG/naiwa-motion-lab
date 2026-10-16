/** The panels of 跟着我跳 (camera), 视频模仿 (video) and 舞蹈库 (dance), and the picture-in-picture preview. */
import type { AppState, Mode } from "../contracts";
import { TEXT } from "./copy";
import { changed, replay, type Ctx, type Part, type UIDance } from "./ctx";
import { append, h, icon } from "./dom";
import type { IconName } from "./icons";
import { motionChip, pickVideo } from "./overlays";

function panel(mode: Mode, iconName: IconName, title: string, sub: string) {
  const id = `nw-${mode}-title`;
  const chip = motionChip();
  const body = h("div", { class: "nw-panel-body" }, h("div", { class: "nw-status-row" }, chip.el));
  const el = h(
    "section",
    { class: "nw-panel nw-mode-panel", "data-for": mode, "aria-labelledby": id },
    h(
      "header",
      { class: "nw-panel-head" },
      h("span", { class: "nw-panel-badge" }, icon(iconName)),
      h("div", { class: "nw-panel-titles" }, h("h2", { id, class: "nw-panel-title" }, title), h("p", { class: "nw-panel-sub" }, sub)),
    ),
    body,
  );
  return { el, chip, body };
}

function tips(list: { icon: IconName; text: string }[], note: string) {
  return h(
    "div",
    { class: "nw-tips nw-expand-only" },
    h("ul", { class: "nw-tip-list" }, ...list.map((t) => h("li", { class: "nw-tip" }, h("span", { class: "nw-tip-icon" }, icon(t.icon)), t.text))),
    h("p", { class: "nw-note" }, note),
  );
}

function mirrorSwitch(ctx: Ctx) {
  const sw = h(
    "button",
    { class: "nw-switch", role: "switch", "aria-checked": "false", "aria-label": TEXT.camera.mirror, onclick: () => ctx.store.set({ mirror: !ctx.store.get().mirror }) },
    h("span", { class: "nw-switch-thumb" }),
  );
  const row = h(
    "div",
    { class: "nw-switch-row" },
    h("span", { class: "nw-switch-icon" }, icon("mirror")),
    h("span", { class: "nw-switch-texts" }, h("span", { class: "nw-switch-label" }, TEXT.camera.mirror), h("span", { class: "nw-switch-hint" }, TEXT.camera.mirrorHint)),
    sw,
  );
  return { row, update: (on: boolean) => sw.setAttribute("aria-checked", String(on)) };
}

/** A status line under the chip: the motion module's own words (e.g. "正在加载姿态模型…"). */
function statusLine() {
  const el = h("p", { class: "nw-status-msg" });
  return {
    el,
    update(m: AppState["motion"]) {
      el.textContent = m.message ?? "";
      el.hidden = !m.message;
    },
  };
}

export function createCameraPanel(ctx: Ctx, host: HTMLElement): Part {
  const { commands } = ctx;
  const mirror = mirrorSwitch(ctx);
  const line = statusLine();
  const startable = commands.startCamera !== undefined;
  const btn = startable
    ? h("button", { class: "nw-btn nw-btn--primary nw-btn--lg nw-btn--block", "data-autofocus": true }, icon("camera"), TEXT.camera.start)
    : null;
  const { el, chip, body } = panel("camera", "camera", TEXT.camera.title, TEXT.camera.sub);
  append(body, [line.el, btn, mirror.row, tips(TEXT.camera.tips, TEXT.camera.privacy)]);
  host.append(el);
  let running = false;
  btn?.addEventListener("click", () => {
    if (running) commands.stopCamera?.();
    else commands.startCamera?.();
    replay(btn, "is-squish");
  });
  return {
    update(s, prev) {
      if (changed(s, prev, (x) => x.mirror)) mirror.update(s.mirror);
      if (!changed(s, prev, (x) => x.motion) && !changed(s, prev, (x) => x.mode)) return;
      chip.update(s.motion);
      line.update(s.motion);
      if (!btn) return;
      const st = s.mode === "camera" ? s.motion.state : "idle";
      running = st === "ready" || st === "tracking" || st === "lost";
      const busy = st === "loading";
      btn.disabled = busy;
      btn.className = `nw-btn nw-btn--lg nw-btn--block ${running ? "nw-btn--secondary" : "nw-btn--primary"}`;
      btn.replaceChildren(icon("camera"), busy ? TEXT.camera.starting : running ? TEXT.camera.stop : TEXT.camera.start);
    },
  };
}

export function createVideoPanel(ctx: Ctx, host: HTMLElement): Part {
  const input = h("input", { type: "file", accept: "video/*", class: "nw-file", tabindex: "-1", "aria-hidden": "true" });
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) pickVideo(ctx, f);
    input.value = "";
  });
  const fileName = h("p", { class: "nw-file-name" });
  fileName.hidden = true;
  ctx.root.addEventListener("nw:video", (e) => {
    fileName.replaceChildren(icon("film"), h("span", { class: "nw-truncate" }, (e as CustomEvent<string>).detail));
    fileName.hidden = false;
  });
  const zone = h(
    "button",
    { class: "nw-dropzone", onclick: () => input.click() },
    h("span", { class: "nw-dropzone-icon" }, icon("upload")),
    h("span", { class: "nw-dropzone-title" }, TEXT.video.drop),
    h("span", { class: "nw-dropzone-sub" }, "或者点这里", h("u", {}, TEXT.video.pick)),
  );
  const mirror = mirrorSwitch(ctx);
  const line = statusLine();
  const { el, chip, body } = panel("video", "film", TEXT.video.title, TEXT.video.sub);
  append(body, [line.el, zone, input, fileName, mirror.row, tips(TEXT.video.tips, TEXT.video.privacy)]);
  host.append(el);
  return {
    update(s, prev) {
      if (changed(s, prev, (x) => x.mirror)) mirror.update(s.mirror);
      if (changed(s, prev, (x) => x.motion)) {
        chip.update(s.motion);
        line.update(s.motion);
      }
    },
  };
}

const CANDIES = 5;

export function createDancePanel(ctx: Ctx, host: HTMLElement, dances: UIDance[]) {
  const grid = h("div", { class: "nw-dance-grid", role: "group", "aria-label": TEXT.dance.title });
  const { el, chip, body } = panel("dance", "music", TEXT.dance.title, TEXT.dance.sub);
  body.append(grid);
  host.append(el);
  let cards: { id: string; el: HTMLElement }[] = [];

  function render(list: UIDance[]) {
    cards = list.map((d, i) => {
      const card = h(
        "button",
        {
          class: "nw-dance",
          "aria-pressed": "false",
          style: `--candy: var(--candy-${(i % CANDIES) + 1})`,
          onclick: () => {
            ctx.store.set({ mode: "dance", dance: d.id });
            replay(card, "is-squish");
          },
        },
        h("span", { class: "nw-dance-disc" }, icon("music"), h("span", { class: "nw-eq", "aria-hidden": "true" }, h("i", {}), h("i", {}), h("i", {}))),
        h("span", { class: "nw-dance-name" }, d.name),
        h("span", { class: "nw-dance-meta" }, TEXT.dance.loop(d.duration)),
        d.source ? h("span", { class: "nw-dance-src nw-truncate", title: d.source.title }, `${TEXT.dance.from} ${d.source.title}`) : null,
      );
      return { id: d.id, el: card };
    });
    grid.replaceChildren(...(cards.length ? cards.map((c) => c.el) : [h("p", { class: "nw-empty" }, TEXT.dance.empty)]));
  }
  function mark(s: AppState) {
    for (const c of cards) c.el.setAttribute("aria-pressed", String(s.mode === "dance" && c.id === s.dance));
  }
  render(dances);
  return {
    update(s: AppState, prev: AppState | null) {
      if (changed(s, prev, (x) => x.motion)) chip.update(s.motion);
      if (changed(s, prev, (x) => x.dance) || changed(s, prev, (x) => x.mode)) mark(s);
    },
    setDances(list: UIDance[]) {
      render(list);
      mark(ctx.store.get());
    },
  };
}

export function createPip(host: HTMLElement): { part: Part; preview: HTMLElement } {
  const preview = h("div", { class: "nw-pip-media" });
  const emptyText = h("span", {});
  const label = h("span", { class: "nw-pip-label" });
  const fps = h("span", { class: "nw-pip-fps" });
  const el = h(
    "figure",
    { class: "nw-pip", "aria-label": "预览" },
    preview,
    h("div", { class: "nw-pip-empty" }, icon("person"), emptyText),
    h("figcaption", { class: "nw-pip-bar" }, h("span", { class: "nw-pip-dot" }), label, fps),
  );
  host.append(el);
  return {
    preview,
    part: {
      update(s, prev) {
        if (!changed(s, prev, (x) => x.mode) && !changed(s, prev, (x) => x.motion)) return;
        const cam = s.mode === "camera";
        label.textContent = cam ? TEXT.pip.camera : TEXT.pip.video;
        emptyText.textContent = cam ? TEXT.pip.emptyCamera : TEXT.pip.emptyVideo;
        el.classList.toggle("is-live", s.motion.state === "tracking");
        fps.textContent = s.motion.state === "tracking" && s.motion.fps ? `${Math.round(s.motion.fps)} fps` : "";
      },
    },
  };
}
