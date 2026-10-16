/** Pieces the panels share: the panel frame, status chips, switches and segmented choices. */
import type { MotionStatus } from "../contracts";
import { MOTION_CHIP, copy, type ChipTone } from "./copy";
import type { Ctx } from "./ctx";
import { h, icon } from "./dom";
import type { IconName } from "./icons";

/** A floating panel (a tab of the bottom sheet on phones) with a collapsible body. */
export function panel(ctx: Ctx, id: "motion" | "sim", iconName: IconName, title: string, sub: string) {
  const T = copy();
  const titleId = `nw-${id}-title`;
  const body = h("div", { class: "nw-panel-body", id: `nw-${id}-body` });
  const toggle = h(
    "button",
    { class: "nw-icon-btn nw-icon-btn--sm nw-panel-toggle", "aria-label": T.sim.collapse, "aria-controls": `nw-${id}-body`, "data-tip": T.sim.collapse },
    icon("chevronDown"),
  );
  const el = h(
    "section",
    { class: `nw-panel nw-panel--${id}`, "data-tab": id, "aria-labelledby": titleId },
    h(
      "header",
      { class: "nw-panel-head" },
      h("span", { class: "nw-panel-icon" }, icon(iconName)),
      h("div", { class: "nw-panel-titles" }, h("h2", { id: titleId, class: "nw-panel-title" }, title), h("p", { class: "nw-panel-sub" }, sub)),
      toggle,
    ),
    body,
  );
  // collapsed state lives on the root, so a rebuilt panel (language switch) keeps it
  const key = `${id}Collapsed` as const;
  const show = (open: boolean) => {
    el.classList.toggle("is-collapsed", !open);
    toggle.setAttribute("aria-expanded", String(open));
    ctx.root.dataset[key] = String(!open);
  };
  show(ctx.root.dataset[key] !== "true");
  toggle.addEventListener("click", () => show(el.classList.contains("is-collapsed")));
  return { el, body };
}

/** A titled group inside a panel. */
export function section(title: string, ...children: (Node | null)[]) {
  return h("div", { class: "nw-section" }, h("h3", { class: "nw-section-title" }, title), ...children);
}

export function statusChip() {
  const text = h("span", {});
  const el = h("span", { class: "nw-status" }, h("span", { class: "nw-status-dot" }), text);
  return {
    el,
    set(t: string, tone: ChipTone, o: { live?: boolean; busy?: boolean } = {}) {
      el.className = `nw-status nw-status--${tone}${o.live ? " is-live" : ""}${o.busy ? " is-busy" : ""}`;
      text.textContent = t;
    },
  };
}

/** The transfer status: state, detector fps while tracking, analysis progress while a video is analysed. */
export function motionChip() {
  const chip = statusChip();
  return {
    el: chip.el,
    update(m: MotionStatus) {
      const T = copy();
      const d = MOTION_CHIP[m.state];
      const extra =
        m.state === "tracking" && m.fps
          ? ` · ${Math.round(m.fps)} fps`
          : m.state === "loading" && m.progress !== undefined
            ? ` · ${Math.round(m.progress * 100)}%`
            : "";
      chip.set(T.motion.status[m.state] + extra, d.tone, d);
    },
  };
}

export function switchRow(iconName: IconName | null, label: string, hint: string, onToggle: () => void) {
  const sw = h("button", { class: "nw-switch", role: "switch", "aria-checked": "false", "aria-label": label, onclick: onToggle }, h("span", { class: "nw-switch-thumb" }));
  const row = h(
    "div",
    { class: "nw-switch-row" },
    iconName ? h("span", { class: "nw-switch-icon" }, icon(iconName)) : null,
    h("span", { class: "nw-switch-texts" }, h("span", { class: "nw-switch-label" }, label), h("span", { class: "nw-switch-hint" }, hint)),
    sw,
  );
  return { row, set: (on: boolean) => sw.setAttribute("aria-checked", String(on)) };
}

/** Pill buttons choosing one value; `set` marks the current one. */
export function segmented<V extends string | number>(
  label: string,
  options: { value: V; text: string; icon?: IconName; tip?: string }[],
  pick: (v: V) => void,
  cls = "",
) {
  const btns = options.map((o) =>
    h(
      "button",
      { class: "nw-seg-btn", "aria-pressed": "false", "aria-label": o.icon ? o.text : null, "data-tip": o.tip, onclick: () => pick(o.value) },
      o.icon ? icon(o.icon) : null,
      h("span", {}, o.text),
    ),
  );
  const el = h("div", { class: `nw-seg ${cls}`, role: "group", "aria-label": label }, ...btns);
  let shown: V | null = null;
  return {
    el,
    set(v: V) {
      if (v === shown) return;
      shown = v;
      btns.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i]!.value === v)));
    },
  };
}
