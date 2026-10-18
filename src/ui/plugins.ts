/** A lab section for a pluggable algorithm (the simulator, the motion-transfer retargeter): pick one of the registered
 *  ones (built in or the user's own; one that cannot run in this browser is disabled and says why), see which backend
 *  actually runs it, open its code (the integration connects the code lab), and set its declared parameters:
 *  number → compact slider with the exact value and unit, choice → segmented (or a select for many), boolean → switch;
 *  parameters that rebuild the simulation are marked. Its live metrics sit under the list. */
import type { AppState, SimParameter, SimulatorInfo, SimulatorOptions } from "../contracts";
import { tr, type Text } from "../i18n";
import { copy, isText } from "./copy";
import { changed, type Ctx } from "./ctx";
import { h, icon } from "./dom";
import { knob } from "./knob";
import { segmented, switchRow } from "./panel";

type Value = number | string | boolean;

/** A registered plugin as the UI reads it: SimulatorInfo / RetargeterInfo, plus (proposed for the contract) the
 *  backend that actually runs it, e.g. { zh: "CPU 并行 · 8 线程", en: "CPU parallel · 8 workers" } when a GPU
 *  simulator falls back to workers, or "WebGPU". Shown in the row's summary area when present. */
export type PluginInfo = SimulatorInfo & { backend?: Text | string | null };

/** The value a parameter has under these settings (its default when unset). */
export function paramValue(p: SimParameter, settings: Record<string, Value>): Value {
  return settings[p.key] ?? p.default;
}

/** Decimal places that show a step exactly (1 → 0, 0.01 → 2, 0.0001 → 4). */
export function stepDigits(step: number): number {
  return Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));
}

/** The backend line's text, or "" without one. */
export function backendText(info: PluginInfo): string {
  const b = info.backend;
  return b === undefined || b === null ? "" : isText(b) ? tr(b) : b;
}

export interface PluginSectionOpts {
  /** "sim" or "retarget": prefixes the controls' ids. */
  id: string;
  title: string;
  /** The neutral line shown while nothing is registered. */
  empty: string;
  list(s: AppState): PluginInfo[];
  chosen(s: AppState): SimulatorOptions;
  choose(o: SimulatorOptions): void;
  /** Opens the chosen one's code; the entry is left out without it. */
  edit?(id: string): void;
  /** A "用 Codex 优化" entry for the section's head (src/ui/codex.ts; hidden unless Codex is available). */
  codex?: HTMLElement;
  /** Live metrics as label → value (empty: none shown). */
  metrics(s: AppState): [string, string][];
  /** Which state changes refresh the metrics. */
  metricsSource(s: AppState): unknown;
}

export function createPluginSection(ctx: Ctx, o: PluginSectionOpts) {
  const { store } = ctx;
  const T = copy();
  const list = h("ul", { class: "nw-sims", role: "radiogroup", "aria-label": o.title });
  const empty = h("p", { class: "nw-note" }, o.empty);
  const params = h("div", { class: "nw-sim-params" });
  const metrics = h("p", { class: "nw-cost" });
  const edit = o.edit ? h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", onclick: () => o.edit?.(o.chosen(store.get()).id) }, icon("code"), T.sim.editCode) : null;
  const el = h(
    "div",
    { class: "nw-section" },
    h("div", { class: "nw-section-head" }, h("h3", { class: "nw-section-title" }, o.title), h("span", { class: "nw-section-actions" }, o.codex ?? null, edit)),
    list,
    empty,
    metrics,
    params,
  );

  const set = (key: string, v: Value) => {
    const cur = o.chosen(store.get());
    o.choose({ ...cur, settings: { ...cur.settings, [key]: v } });
  };

  let shownList: PluginInfo[] | null = null;
  let shownId: string | null = null;
  let rows: { id: string; btn: HTMLElement }[] = [];
  let controls: { p: SimParameter; show(v: Value): void }[] = [];

  function row(x: PluginInfo): HTMLElement {
    const backend = backendText(x);
    const btn = h(
      "button",
      {
        class: "nw-sim",
        role: "radio",
        "aria-checked": "false",
        disabled: x.unavailable !== null,
        // picking the one in use again keeps its settings
        onclick: () => {
          if (o.chosen(store.get()).id !== x.id) o.choose({ id: x.id, settings: {} });
        },
      },
      h(
        "span",
        { class: "nw-sim-head" },
        h("span", { class: "nw-sim-name" }, tr(x.name)),
        x.origin === "user" ? h("span", { class: "nw-badge" }, T.sim.mine) : null,
        h("span", { class: `nw-badge nw-badge--${x.device}` }, T.sim.devices[x.device]),
      ),
      h("span", { class: "nw-sim-summary" }, tr(x.summary)),
      backend && !x.unavailable ? h("span", { class: "nw-sim-backend" }, h("span", { class: "nw-sim-backend-dot", "aria-hidden": "true" }), `${T.sim.runsOn} ${backend}`) : null,
      x.unavailable ? h("span", { class: "nw-sim-why" }, icon("alert"), `${T.sim.unavailable}: ${tr(x.unavailable)}`) : null,
    );
    rows.push({ id: x.id, btn });
    return h("li", {}, btn);
  }

  function control(p: SimParameter): { el: HTMLElement; show(v: Value): void } {
    const label = tr(p.label);
    const help = [p.help ? tr(p.help) : "", p.rebuild ? T.sim.rebuildTip : ""].filter(Boolean).join(" · ");
    if (p.kind === "number") {
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      const step = p.step ?? (max - min) / 100;
      const k = knob({ id: `nw-${o.id}-${p.key}`, label, hint: help, min, max, step, digits: stepDigits(step), unit: p.unit ?? "", rebuild: p.rebuild, inline: true, set: (v) => set(p.key, v) });
      return { el: k.row, show: (v) => k.show(Number(v), Number(v)) };
    }
    if (p.kind === "boolean") {
      const sw = switchRow(null, label, p.help ? tr(p.help) : "", () => set(p.key, !paramValue(p, o.chosen(store.get()).settings)));
      if (p.rebuild) sw.row.querySelector(".nw-switch-label")!.append(icon("rebuild"));
      if (help) sw.row.title = help;
      return { el: sw.row, show: (v) => sw.set(Boolean(v)) };
    }
    const choices = p.choices ?? [];
    const head = h("span", { class: "nw-field-label", title: help || null }, label, p.rebuild ? icon("rebuild") : null);
    if (choices.length <= 4) {
      const seg = segmented<string>(label, choices.map((c) => ({ value: c.value, text: tr(c.label) })), (v) => set(p.key, v), "nw-seg--block");
      return { el: h("div", { class: "nw-field" }, head, seg.el), show: (v) => seg.set(String(v)) };
    }
    const select = h(
      "select",
      { class: "nw-select", "aria-label": label, onchange: (e: Event) => set(p.key, (e.target as HTMLSelectElement).value) },
      ...choices.map((c) => h("option", { value: c.value }, tr(c.label))),
    );
    return {
      el: h("div", { class: "nw-field" }, head, select),
      show: (v) => {
        select.value = String(v);
      },
    };
  }

  function renderParams(info: PluginInfo | undefined) {
    controls = [];
    const ps = info?.parameters ?? [];
    const items = ps.map((p) => {
      const c = control(p);
      controls.push({ p, show: c.show });
      return c.el;
    });
    const note = ps.some((p) => p.rebuild) ? h("p", { class: "nw-note nw-rebuild-note" }, icon("rebuild"), T.sim.rebuildNote) : null;
    params.replaceChildren(...(items.length ? [h("h4", { class: "nw-subtitle" }, T.sim.params), ...items] : []), ...(note ? [note] : []));
  }

  return {
    el,
    update(s: AppState, prev: AppState | null) {
      const items = o.list(s);
      const cur = o.chosen(s);
      if (items !== shownList) {
        shownList = items;
        rows = [];
        list.replaceChildren(...items.map(row));
        list.hidden = items.length === 0;
        empty.hidden = items.length > 0;
        if (edit) edit.hidden = items.length === 0;
        shownId = null;
      }
      if (cur.id !== shownId) {
        shownId = cur.id;
        renderParams(items.find((x) => x.id === shownId));
        prev = null;
      }
      for (const r of rows) r.btn.setAttribute("aria-checked", String(r.id === shownId));
      if (prev === null || o.chosen(prev) !== cur) for (const c of controls) c.show(paramValue(c.p, cur.settings));
      if (changed(s, prev, o.metricsSource) || prev === null) {
        const m = items.length ? o.metrics(s) : [];
        metrics.hidden = m.length === 0;
        metrics.replaceChildren(
          ...m.map(([k, v]) => h("span", { class: "nw-readout" }, h("span", { class: "nw-readout-k" }, k), h("b", { class: "nw-readout-v" }, v))),
        );
      }
    },
  };
}

/** A labelled readout a retargeter may report (proposed: MotionStatus.metrics). */
export interface PluginMetric {
  label: Text;
  value: string;
}
