/** The top bar: brand, the simulation readouts (desktop), record with its running time, language, sound, theme, help. */
import type { AppState } from "../contracts";
import { copy } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { frogMark, h, icon } from "./dom";
import { formatClock } from "./format";
import { createReadouts } from "./readouts";

export function createTopbar(ctx: Ctx, host: HTMLElement, theme: () => "light" | "dark"): Part {
  const { store, commands } = ctx;
  const T = copy();

  const recIcon = h("span", { class: "nw-rec-icon" }, icon("record"));
  const recText = h("span", { class: "nw-rec-text" }, T.record);
  const rec = h(
    "button",
    { class: "nw-btn nw-btn--rec nw-btn--sm", onclick: () => (store.get().recording.active ? commands.stopRecording() : commands.startRecording()) },
    recIcon,
    recText,
  );
  // 中/EN: both shown, the current one marked; a click switches
  const lang = h(
    "button",
    { class: "nw-lang", "data-lang-toggle": true, "aria-label": T.langSwitch, "data-tip": `${T.langSwitch}  L`, onclick: () => store.set({ lang: store.get().lang === "zh" ? "en" : "zh" }) },
    h("span", { "data-l": "zh" }, "中"),
    h("span", { "data-l": "en" }, "EN"),
  );
  const sound = h("button", { class: "nw-icon-btn", onclick: () => store.set({ sound: !store.get().sound }) });
  const themeBtn = h("button", { class: "nw-icon-btn", onclick: () => store.set({ theme: theme() === "dark" ? "light" : "dark" }) });
  const help = h("button", { class: "nw-icon-btn", "aria-label": T.help, "data-tip": `${T.help}  ?`, onclick: () => ctx.openHelp() }, icon("help"));

  const center = h("div", { class: "nw-topbar-center" });
  const readouts = createReadouts(center);
  host.append(
    h(
      "header",
      { class: "nw-topbar" },
      h(
        "div",
        { class: "nw-brand", title: `${T.product} · 奶蛙` },
        frogMark(),
        h("span", { class: "nw-brand-text" }, h("span", { class: "nw-brand-name" }, T.brand), h("span", { class: "nw-brand-sub" }, T.brandSub)),
      ),
      center,
      h("div", { class: "nw-actions" }, rec, h("span", { class: "nw-divider", "aria-hidden": "true" }), lang, sound, themeBtn, help),
    ),
  );

  let clock = 0;
  const tick = () => {
    const at = store.get().recording.startedAt;
    // startedAt is wall-clock (Date.now()), as the integration sets it
    recText.textContent = formatClock(at === null ? 0 : Date.now() - at);
  };
  let shownTheme: "light" | "dark" | null = null;
  return {
    update(s: AppState, prev) {
      readouts.update(s, prev);
      if (changed(s, prev, (x) => x.recording)) {
        const live = s.recording.active;
        rec.classList.toggle("is-live", live);
        rec.setAttribute("aria-label", live ? T.stopRecord : T.record);
        rec.setAttribute("data-tip", `${live ? T.stopRecord : T.record}  R`);
        recIcon.replaceChildren(icon(live ? "stop" : "record"));
        clearInterval(clock);
        if (live) {
          tick();
          clock = window.setInterval(tick, 250);
        } else recText.textContent = T.record;
      }
      if (changed(s, prev, (x) => x.lang)) lang.dataset.current = s.lang;
      if (changed(s, prev, (x) => x.sound)) {
        sound.replaceChildren(icon(s.sound ? "soundOn" : "soundOff"));
        sound.setAttribute("aria-pressed", String(s.sound));
        sound.setAttribute("aria-label", s.sound ? T.soundOn : T.soundOff);
        sound.setAttribute("data-tip", s.sound ? T.soundOn : T.soundOff);
      }
      const t = theme();
      if (t !== shownTheme) {
        shownTheme = t;
        themeBtn.replaceChildren(icon(t === "dark" ? "sun" : "moon"));
        const label = t === "dark" ? T.toLight : T.toDark;
        themeBtn.setAttribute("aria-label", label);
        themeBtn.setAttribute("data-tip", `${label}  T`);
      }
    },
    dispose: () => clearInterval(clock),
  };
}
