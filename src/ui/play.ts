/** 捏捏奶蛙: the tool dock (hand, ball, feather, pump + ball rain and reset) and the poke/throw counter. */
import { milestone, TEXT, TOOLS } from "./copy";
import { changed, replay, type Ctx, type Part } from "./ctx";
import { h, icon } from "./dom";

export function createDock(ctx: Ctx, host: HTMLElement): Part {
  const { store, commands } = ctx;
  const tools = TOOLS.map((t) =>
    h(
      "button",
      {
        class: "nw-tool",
        "data-tool": t.id,
        "aria-pressed": "false",
        "data-tip": `${t.label}  ${t.key}`,
        onclick: () => store.set({ tool: t.id }),
      },
      h("span", { class: "nw-tool-icon" }, icon(t.icon)),
      h("span", { class: "nw-tool-label" }, t.label),
      h("kbd", { class: "nw-tool-key" }, t.key),
    ),
  );
  const action = (label: string, name: "rain" | "reset", key: string, run: () => void) => {
    const b = h(
      "button",
      { class: "nw-tool nw-tool--action", "data-tip": `${label}  ${key}` },
      h("span", { class: "nw-tool-icon" }, icon(name)),
      h("span", { class: "nw-tool-label" }, label),
      h("kbd", { class: "nw-tool-key" }, key),
    );
    b.addEventListener("click", () => {
      run();
      replay(b, "is-boing");
    });
    return b;
  };
  const hint = h("p", { class: "nw-tool-hint" });
  host.append(
    h(
      "div",
      { class: "nw-dock-wrap" },
      hint,
      h(
        "div",
        { class: "nw-island nw-dock", role: "toolbar", "aria-label": "工具" },
        h("div", { class: "nw-tools" }, ...tools),
        h("span", { class: "nw-dock-sep", "aria-hidden": "true" }),
        action(TEXT.rain, "rain", "B", () => commands.rainBalls()),
        action(TEXT.reset, "reset", "X", () => commands.resetFrog()),
      ),
    ),
  );
  return {
    update(s, prev) {
      if (!changed(s, prev, (x) => x.tool)) return;
      const i = TOOLS.findIndex((t) => t.id === s.tool);
      tools.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
      hint.textContent = TOOLS[i]?.hint ?? "";
      if (prev) {
        replay(tools[i]!, "is-wiggle");
        replay(hint, "is-pop");
      }
    },
  };
}

export function createCounter(ctx: Ctx, host: HTMLElement): Part {
  const pokes = h("b", { class: "nw-count-num" }, "0");
  const throws = h("b", { class: "nw-count-num" }, "0");
  const el = h(
    "div",
    { class: "nw-island nw-counter", "aria-label": "战绩" },
    h("span", { class: "nw-count" }, icon("hand"), "戳了", pokes, "下"),
    h("span", { class: "nw-count" }, icon("sparkle"), "抛飞", throws, "次"),
  );
  host.append(el);
  return {
    update(s, prev) {
      if (!changed(s, prev, (x) => x.stats)) return;
      for (const [key, num] of [
        ["pokes", pokes],
        ["throws", throws],
      ] as const) {
        const n = s.stats[key];
        if (prev && n === prev.stats[key]) continue;
        num.textContent = String(n);
        if (!prev) continue;
        replay(num, "is-bump");
        const cheer = n > prev.stats[key] ? milestone(key, n) : null;
        if (cheer) ctx.toast(cheer, "success");
      }
    },
  };
}
