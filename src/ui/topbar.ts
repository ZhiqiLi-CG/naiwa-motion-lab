/** The top bar: brand, the four modes, record with a running timer, sound, theme, help. */
import type { AppState } from "../contracts";
import { MODES, TEXT } from "./copy";
import { changed, replay, type Ctx, type Part } from "./ctx";
import { frogMark, h, icon } from "./dom";
import { formatClock } from "./format";

export function createTopbar(ctx: Ctx, host: HTMLElement, theme: () => "light" | "dark"): Part {
  const { store, commands } = ctx;

  const modeBtns = MODES.map((m) =>
    h(
      "button",
      {
        class: "nw-mode",
        "data-mode": m.id,
        "aria-pressed": "false",
        "data-tip": `${m.label}  ${m.key}`,
        onclick: () => store.set({ mode: m.id }),
      },
      icon(m.icon),
      h("span", { class: "nw-mode-label" }, m.label),
      h("span", { class: "nw-mode-short" }, m.short),
    ),
  );
  const modes = h("nav", { class: "nw-island nw-modes", "aria-label": "玩法" }, h("span", { class: "nw-modes-pill" }), ...modeBtns);

  const recIcon = h("span", { class: "nw-rec-icon" }, icon("record"));
  const recText = h("span", { class: "nw-rec-text" }, TEXT.record);
  const rec = h(
    "button",
    {
      class: "nw-btn nw-btn--rec",
      "data-tip": `${TEXT.record}  R`,
      onclick: () => (store.get().recording.active ? commands.stopRecording() : commands.startRecording()),
    },
    recIcon,
    recText,
  );

  const sound = h("button", { class: "nw-icon-btn", onclick: () => store.set({ sound: !store.get().sound }) });
  const themeBtn = h("button", {
    class: "nw-icon-btn",
    onclick: () => store.set({ theme: theme() === "dark" ? "light" : "dark" }),
  });
  const help = h(
    "button",
    { class: "nw-icon-btn", "aria-label": TEXT.help, "data-tip": `${TEXT.help}  ?`, onclick: () => ctx.openHelp() },
    icon("help"),
  );

  host.append(
    h(
      "header",
      { class: "nw-topbar" },
      h(
        "div",
        { class: "nw-island nw-brand", title: "奶蛙 Playground" },
        frogMark(),
        h("span", { class: "nw-brand-name" }, TEXT.brand),
        h("span", { class: "nw-brand-sub" }, TEXT.brandSub),
      ),
      modes,
      h("div", { class: "nw-island nw-actions" }, rec, sound, themeBtn, help),
    ),
  );

  let clock = 0;
  const tick = () => {
    const at = store.get().recording.startedAt;
    // startedAt is performance.now(), like every time in the contract
    recText.textContent = formatClock(at === null ? 0 : performance.now() - at);
  };

  let shownTheme: "light" | "dark" | null = null;
  return {
    update(s: AppState, prev) {
      if (changed(s, prev, (x) => x.mode)) {
        const i = MODES.findIndex((m) => m.id === s.mode);
        modes.style.setProperty("--i", String(i));
        modeBtns.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
        if (prev) replay(modeBtns[i]!, "is-boing");
      }
      if (changed(s, prev, (x) => x.recording)) {
        const live = s.recording.active;
        rec.classList.toggle("is-live", live);
        rec.setAttribute("aria-label", live ? TEXT.stopRecord : TEXT.record);
        rec.setAttribute("data-tip", `${live ? TEXT.stopRecord : TEXT.record}  R`);
        recIcon.replaceChildren(icon(live ? "stop" : "record"));
        clearInterval(clock);
        if (live) {
          tick();
          clock = window.setInterval(tick, 250);
        } else recText.textContent = TEXT.record;
      }
      if (changed(s, prev, (x) => x.sound)) {
        sound.replaceChildren(icon(s.sound ? "soundOn" : "soundOff"));
        sound.setAttribute("aria-pressed", String(s.sound));
        sound.setAttribute("aria-label", s.sound ? TEXT.soundOn : TEXT.soundOff);
        sound.setAttribute("data-tip", `${s.sound ? TEXT.soundOn : TEXT.soundOff}  S`);
        if (prev) replay(sound, "is-boing");
      }
      const t = theme();
      if (t !== shownTheme) {
        shownTheme = t;
        themeBtn.replaceChildren(icon(t === "dark" ? "sun" : "moon"));
        const label = t === "dark" ? TEXT.toLight : TEXT.toDark;
        themeBtn.setAttribute("aria-label", label);
        themeBtn.setAttribute("data-tip", `${label}  T`);
        if (prev) replay(themeBtn, "is-boing");
      }
    },
  };
}
