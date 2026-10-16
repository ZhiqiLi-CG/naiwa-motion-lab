/** The bar under the viewport: playback (pause, single step, 0.25× / 0.5× / 1×), the ways to perturb the body
 *  (poke / drag, probe ball) and reset. */
import { SPEEDS, TOOLS, copy } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { h, icon } from "./dom";
import { segmented } from "./panel";

export function createTransport(ctx: Ctx, host: HTMLElement): Part {
  const { store, commands } = ctx;
  const T = copy();
  const pause = h("button", {
    class: "nw-icon-btn nw-icon-btn--solid",
    onclick: () => {
      const p = store.get().playback;
      store.set({ playback: { ...p, paused: !p.paused } });
    },
  });
  const step = h(
    "button",
    { class: "nw-icon-btn", "aria-label": T.transport.step, "data-tip": `${T.transport.step}  .`, onclick: () => commands.stepSim() },
    icon("step"),
  );
  const speed = segmented(
    T.transport.speed,
    SPEEDS.map((v) => ({ value: v, text: `${v}×` })),
    (timeScale) => store.set({ playback: { ...store.get().playback, timeScale } }),
    "nw-seg--mono",
  );
  const tools = segmented(
    T.transport.interact,
    TOOLS.map((t) => ({ value: t.id, text: T.transport.tools[t.id], icon: t.icon, tip: `${T.transport.toolHints[t.id]}  ${t.key}` })),
    (tool) => store.set({ tool }),
  );
  const reset = h(
    "button",
    { class: "nw-btn nw-btn--ghost nw-btn--sm", "aria-label": T.transport.reset, "data-tip": `${T.transport.resetHint}  X`, onclick: () => commands.resetFrog() },
    icon("reset"),
    h("span", {}, T.transport.reset),
  );
  host.append(
    h(
      "div",
      { class: "nw-transport", role: "toolbar", "aria-label": T.transport.playback },
      h("div", { class: "nw-transport-group", role: "group", "aria-label": T.transport.playback }, pause, step, speed.el),
      h("span", { class: "nw-divider", "aria-hidden": "true" }),
      h("div", { class: "nw-transport-group", role: "group", "aria-label": T.transport.interact }, tools.el),
      h("span", { class: "nw-divider", "aria-hidden": "true" }),
      reset,
    ),
  );
  return {
    update(s, prev) {
      if (changed(s, prev, (x) => x.playback)) {
        const { paused, timeScale } = s.playback;
        pause.replaceChildren(icon(paused ? "play" : "pause"));
        const label = paused ? T.transport.resume : T.transport.pause;
        pause.setAttribute("aria-label", label);
        pause.setAttribute("aria-pressed", String(paused));
        pause.setAttribute("data-tip", `${label}  Space`);
        step.disabled = !paused;
        speed.set(timeScale);
      }
      tools.set(s.tool);
    },
  };
}
