/** The recording result sheet and the help dialog. */
import type { AppState, Recording, ThemeChoice } from "../contracts";
import { SHORTCUTS, TEXT } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { h, icon } from "./dom";
import { formatDuration } from "./format";
import type { createDialogs } from "./overlays";

type Dialogs = ReturnType<typeof createDialogs>;

export function createRecordingSheet(ctx: Ctx, dialogs: Dialogs): Part {
  const { commands } = ctx;
  function show(rec: Recording) {
    const video = h("video", {
      class: "nw-rec-video",
      src: rec.url,
      controls: true,
      autoplay: true,
      loop: true,
      muted: true,
      playsinline: true,
    });
    const busy = (b: HTMLButtonElement, run: () => Promise<void>, fail: string, ok?: string) => {
      b.disabled = true;
      run().then(
        () => ok && ctx.toast(ok, "success"),
        () => ctx.toast(fail, "error"),
      ).finally(() => (b.disabled = false));
    };
    const share: HTMLButtonElement = h(
      "button",
      { class: "nw-btn nw-btn--primary nw-btn--lg", "data-autofocus": true, onclick: () => busy(share, () => commands.shareRecording(), TEXT.toasts.shareFailed) },
      icon("save"),
      TEXT.rec.share,
    );
    const copy: HTMLButtonElement = h(
      "button",
      {
        class: "nw-btn nw-btn--secondary nw-btn--lg",
        onclick: () => busy(copy, () => commands.copyConfigLink(), TEXT.toasts.linkFailed, TEXT.toasts.linkCopied),
      },
      icon("link"),
      TEXT.rec.copy,
    );
    const again = h(
      "button",
      {
        class: "nw-btn nw-btn--ghost nw-btn--lg",
        onclick: () => {
          close();
          commands.startRecording();
        },
      },
      icon("again"),
      TEXT.rec.again,
    );
    const close = dialogs.open({
      title: TEXT.rec.title,
      cls: "nw-dialog--rec",
      body: [
        h("div", { class: "nw-rec-frame" }, video),
        h("p", { class: "nw-rec-sub" }, TEXT.rec.sub(formatDuration(rec.durationMs))),
        h("div", { class: "nw-rec-actions" }, share, copy, again),
      ],
      onClose: () => video.pause(),
    });
  }
  return {
    update(s: AppState, prev) {
      if (prev && changed(s, prev, (x) => x.lastRecording) && s.lastRecording) show(s.lastRecording);
    },
  };
}

export function createHelp(ctx: Ctx, dialogs: Dialogs) {
  const { store } = ctx;
  return function openHelp() {
    if (dialogs.isOpen()) return;
    const themeBtns = (Object.keys(TEXT.themes) as ThemeChoice[]).map((t) =>
      h(
        "button",
        {
          class: "nw-seg-btn",
          "aria-pressed": String(store.get().theme === t),
          onclick: () => {
            store.set({ theme: t });
            themeBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(Object.keys(TEXT.themes)[i] === t)));
          },
        },
        TEXT.themes[t],
      ),
    );
    const fps = store.get().stats.fps;
    dialogs.open({
      title: TEXT.helpTitle,
      cls: "nw-dialog--help",
      body: [
        h(
          "div",
          { class: "nw-help-grid" },
          h(
            "section",
            {},
            h("h3", { class: "nw-caption" }, "玩法"),
            h(
              "dl",
              { class: "nw-howto" },
              ...TEXT.howTo.flatMap(([a, b]) => [h("dt", {}, a), h("dd", {}, b)]),
            ),
          ),
          h(
            "section",
            { class: "nw-only-keys" },
            h("h3", { class: "nw-caption" }, TEXT.keysTitle),
            h(
              "dl",
              { class: "nw-keys" },
              ...SHORTCUTS.flatMap(([keys, what]) => [
                h("dt", {}, ...keys.map((k) => h("kbd", { class: "nw-kbd" }, k))),
                h("dd", {}, what),
              ]),
            ),
          ),
        ),
        h(
          "div",
          { class: "nw-help-foot" },
          h("span", { class: "nw-caption" }, TEXT.themeTitle),
          h("div", { class: "nw-seg", role: "group", "aria-label": TEXT.themeTitle }, ...themeBtns),
          h("span", { class: "nw-spacer" }),
          fps > 0 ? h("span", { class: "nw-fps" }, `画面 ${Math.round(fps)} fps`) : null,
        ),
      ],
    });
  };
}
