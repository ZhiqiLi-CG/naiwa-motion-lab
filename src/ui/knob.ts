/** A slider with an exact numeric field beside it (and its unit); both edit the same value. */
import { h, icon } from "./dom";
import { formatValue } from "./format";

export interface KnobOpts {
  id: string;
  label: string;
  /** Shown as the tooltip. */
  hint: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  unit: string;
  /** Mark it as rebuilding the simulation when changed. */
  rebuild?: boolean;
  set(v: number): void;
}

export function knob(o: KnobOpts) {
  const clamp = (v: number) => Math.min(o.max, Math.max(o.min, v));
  const field = h("input", {
    class: "nw-num",
    type: "number",
    inputmode: "decimal",
    min: o.min,
    max: o.max,
    step: o.step,
    "aria-label": o.label,
    onchange: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) o.set(clamp(v));
    },
  });
  const slider = h("input", {
    id: o.id,
    class: "nw-slider",
    type: "range",
    min: o.min,
    max: o.max,
    step: o.step,
    oninput: (e: Event) => o.set(Number((e.target as HTMLInputElement).value)),
  });
  const unit = o.unit && o.unit !== "×" ? h("span", { class: "nw-num-unit" }, o.unit) : null;
  // the range's ends sit beside the slider, without the unit (the field shows it)
  const end = (v: number) => h("span", { class: "nw-knob-end", "aria-hidden": "true" }, formatValue(v, o.digits, o.unit === "×" ? "×" : ""));
  const row = h(
    "div",
    { class: "nw-knob", title: o.hint || null },
    h(
      "div",
      { class: "nw-knob-head" },
      h("label", { for: o.id, class: "nw-knob-label" }, o.label, o.rebuild ? icon("rebuild") : null),
      h("span", { class: "nw-num-wrap" }, field, unit),
    ),
    h("div", { class: "nw-knob-track" }, end(o.min), slider, end(o.max)),
  );
  return {
    row,
    slider,
    /** Show v (null: the default, drawn at `at` with an empty field showing `placeholder`). */
    show(v: number | null, at: number, placeholder = "") {
      const x = v ?? at;
      if (document.activeElement !== slider && slider.value !== String(x)) slider.value = String(x);
      slider.style.setProperty("--fill", `${((x - o.min) / (o.max - o.min)) * 100}%`);
      if (document.activeElement !== field) field.value = v === null ? "" : v.toFixed(o.digits);
      field.placeholder = placeholder;
    },
  };
}
