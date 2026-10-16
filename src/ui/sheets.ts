/** The recording result sheet and the help dialog. */
import type { AppState, Recording, ThemeChoice } from "../contracts";
import type { Lang } from "../i18n";
import { SHORTCUT_KEYS, copy, formatDuration } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { frogMark, h, icon } from "./dom";
import type { createDialogs } from "./overlays";
import { segmented } from "./panel";

type Dialogs = ReturnType<typeof createDialogs>;

export function createRecordingSheet(ctx: Ctx, dialogs: Dialogs): Part {
  const { commands } = ctx;
  const T = copy();
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
    // the commands announce their own success; the sheet reports a failure
    const busy = (b: HTMLButtonElement, run: () => Promise<void>, fail: string) => {
      b.disabled = true;
      run()
        .catch(() => ctx.toast(fail, "error"))
        .finally(() => (b.disabled = false));
    };
    const share: HTMLButtonElement = h(
      "button",
      { class: "nw-btn nw-btn--primary nw-btn--lg", "data-autofocus": true, onclick: () => busy(share, () => commands.shareRecording(), T.toasts.shareFailed) },
      icon("save"),
      T.rec.share,
    );
    const link: HTMLButtonElement = h(
      "button",
      { class: "nw-btn nw-btn--secondary nw-btn--lg", onclick: () => busy(link, () => commands.copyConfigLink(), T.toasts.linkFailed) },
      icon("link"),
      T.rec.copy,
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
      T.rec.again,
    );
    const close = dialogs.open({
      title: T.rec.title,
      cls: "nw-dialog--rec",
      badge: h("span", { class: "nw-dialog-badge" }, icon("check")),
      body: [
        h("div", { class: "nw-rec-frame" }, video),
        h("p", { class: "nw-rec-sub" }, T.rec.sub(formatDuration(rec.durationMs))),
        h("div", { class: "nw-rec-actions" }, share, link, again),
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
    const T = copy();
    const themes = segmented<ThemeChoice>(
      T.themeTitle,
      (Object.keys(T.themes) as ThemeChoice[]).map((t) => ({ value: t, text: T.themes[t] })),
      (theme) => {
        store.set({ theme });
        themes.set(theme);
      },
    );
    themes.set(store.get().theme);
    // switching the language rebuilds the UI in the other one, this dialog included
    const langs = segmented<Lang>(T.langTitle, [{ value: "zh", text: "中文" }, { value: "en", text: "English" }], (lang) => store.set({ lang }));
    langs.set(store.get().lang);
    dialogs.open({
      title: T.product,
      cls: "nw-dialog--help",
      badge: frogMark("nw-mark nw-dialog-mark"),
      body: [
        h("p", { class: "nw-help-sub" }, T.helpSub),
        h(
          "div",
          { class: "nw-help-grid" },
          h(
            "section",
            {},
            h("h3", { class: "nw-section-title" }, T.viewTitle),
            h("dl", { class: "nw-defs" }, ...T.viewOps.flatMap(([a, b]) => [h("dt", {}, a), h("dd", {}, b)])),
          ),
          h(
            "section",
            { class: "nw-only-keys" },
            h("h3", { class: "nw-section-title" }, T.keysTitle),
            h(
              "dl",
              { class: "nw-keys" },
              ...SHORTCUT_KEYS.flatMap((keys, i) => [
                h("dt", {}, ...keys.map((k) => h("kbd", { class: "nw-kbd" }, k))),
                h("dd", {}, T.shortcuts[i]),
              ]),
            ),
          ),
        ),
        h(
          "div",
          { class: "nw-help-foot" },
          h(
            "div",
            { class: "nw-help-setting" },
            h("span", { class: "nw-section-title" }, T.themeTitle),
            themes.el,
          ),
          h(
            "div",
            { class: "nw-help-setting" },
            h("span", { class: "nw-section-title" }, T.langTitle),
            langs.el,
          ),
        ),
      ],
    });
  };
}
