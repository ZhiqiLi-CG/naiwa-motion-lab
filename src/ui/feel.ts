/** 手感: the five physics sliders with live values and the material presets. */
import type { PhysicsParams } from "../contracts";
import { PARAMS, PRESET_SWATCH, TEXT } from "./copy";
import { changed, replay, type Ctx, type Part } from "./ctx";
import { h, icon } from "./dom";
import { formatParam, matchingPreset } from "./format";

export function createFeel(ctx: Ctx, host: HTMLElement): Part {
  const { store, presets } = ctx;

  const chips = presets.map((p) =>
    h(
      "button",
      {
        class: "nw-chip",
        "aria-pressed": "false",
        onclick: (e: MouseEvent) => {
          store.set({ preset: p.id, params: { ...p.params } });
          replay(e.currentTarget as Element, "is-squish");
        },
      },
      h("span", { class: "nw-chip-swatch", style: `background:${PRESET_SWATCH[p.id] ?? "var(--accent)"}` }),
      p.name,
    ),
  );
  const custom = h("span", { class: "nw-feel-custom" }, icon("sparkle"), TEXT.custom);

  const sliders = PARAMS.map((d) => {
    const id = `nw-p-${d.key}`;
    const value = h("output", { class: "nw-slider-value", for: id });
    const input = h("input", {
      id,
      class: "nw-slider",
      type: "range",
      min: d.min,
      max: d.max,
      step: d.step,
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        store.set({ params: { [d.key]: v } as Partial<PhysicsParams> });
      },
    });
    const row = h(
      "div",
      { class: "nw-param" },
      h("div", { class: "nw-param-head" }, h("label", { for: id, class: "nw-param-label" }, d.label), value),
      input,
      h("div", { class: "nw-param-ends", "aria-hidden": "true" }, h("span", {}, d.lo), h("span", {}, d.hi)),
    );
    return { d, input, value, row };
  });

  const toggle = h(
    "button",
    { class: "nw-icon-btn nw-panel-toggle", "aria-label": "收起手感", "data-tip": "收起 / 展开  F", onclick: () => ctx.setFeel() },
    icon("chevronDown"),
  );
  const copy = h(
    "button",
    {
      class: "nw-btn nw-btn--ghost nw-btn--sm nw-feel-link",
      onclick: () =>
        ctx.commands.copyConfigLink().then(
          () => ctx.toast(TEXT.toasts.linkCopied, "success"),
          () => ctx.toast(TEXT.toasts.linkFailed, "error"),
        ),
    },
    icon("link"),
    TEXT.copyLink,
  );

  host.append(
    h(
      "section",
      { class: "nw-panel nw-feel nw-expand-only", "aria-labelledby": "nw-feel-title" },
      h(
        "header",
        { class: "nw-panel-head" },
        h("span", { class: "nw-panel-badge" }, icon("sliders")),
        h("div", { class: "nw-panel-titles" }, h("h2", { id: "nw-feel-title", class: "nw-panel-title" }, TEXT.feel), h("p", { class: "nw-panel-sub" }, TEXT.feelSub)),
        toggle,
      ),
      h(
        "div",
        { class: "nw-panel-body nw-feel-body" },
        h("div", { class: "nw-presets-head" }, h("span", { class: "nw-caption" }, TEXT.presets), custom),
        h("div", { class: "nw-presets", role: "group", "aria-label": TEXT.presets }, ...chips),
        ...sliders.map((s) => s.row),
        copy,
      ),
    ),
  );

  return {
    update(s, prev) {
      if (!changed(s, prev, (x) => x.params)) return;
      for (const { d, input, value, row } of sliders) {
        const v = s.params[d.key];
        if (input.value !== String(v)) input.value = String(v);
        input.style.setProperty("--fill", `${((v - d.min) / (d.max - d.min)) * 100}%`);
        value.textContent = formatParam(d.key, v);
        if (prev && prev.params[d.key] !== v && document.activeElement !== input) replay(row, "is-jiggle");
      }
      const match = matchingPreset(s.params, presets);
      chips.forEach((c, i) => c.setAttribute("aria-pressed", String(presets[i]!.id === match)));
      custom.hidden = match !== null;
    },
  };
}
