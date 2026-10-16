/** 模拟器 Simulator: pick one of the registered simulators (CPU / GPU examples, the user's own; one that cannot run in
 *  this browser says why), edit its code (the integration opens the code lab), and set its declared parameters:
 *  number → slider with the exact value and unit, choice → segmented (or a select for many), boolean → switch. The
 *  live cost (step time, particles, cells) sits beside it. */
import type { AppState, SimParameter, SimulatorInfo } from "../contracts";
import { tr } from "../i18n";
import { copy } from "./copy";
import { changed, type Ctx } from "./ctx";
import { h, icon } from "./dom";
import { formatCount, formatMs } from "./format";
import { knob } from "./knob";
import { segmented, switchRow } from "./panel";

type Value = number | string | boolean;

/** The value a parameter has under these settings (its default when unset). */
export function paramValue(p: SimParameter, settings: Record<string, Value>): Value {
  return settings[p.key] ?? p.default;
}

export function createSimulatorSection(ctx: Ctx) {
  const { store, commands } = ctx;
  const T = copy();
  const list = h("ul", { class: "nw-sims", role: "radiogroup", "aria-label": T.sim.simulator });
  const params = h("div", { class: "nw-sim-params" });
  const cost = h("p", { class: "nw-cost" });
  const edit = commands.editSimulator
    ? h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", onclick: () => commands.editSimulator?.(store.get().simulator.id) }, icon("code"), T.sim.editCode)
    : null;
  const el = h(
    "div",
    { class: "nw-section" },
    h("div", { class: "nw-section-head" }, h("h3", { class: "nw-section-title" }, T.sim.simulator), edit),
    list,
    cost,
    params,
  );

  const set = (key: string, v: Value) => {
    const cur = store.get().simulator;
    store.set({ simulator: { ...cur, settings: { ...cur.settings, [key]: v } } });
  };

  let shownList: SimulatorInfo[] | null = null;
  let shownId: string | null = null;
  let rows: { id: string; el: HTMLElement }[] = [];
  let controls: { p: SimParameter; show(v: Value): void }[] = [];

  function renderList(sims: SimulatorInfo[]) {
    rows = sims.map((s) => {
      const btn = h(
        "button",
        {
          class: "nw-sim",
          role: "radio",
          "aria-checked": "false",
          disabled: s.unavailable !== null,
          onclick: () => store.set({ simulator: { id: s.id, settings: {} } }),
        },
        h(
          "span",
          { class: "nw-sim-head" },
          h("span", { class: "nw-sim-name" }, tr(s.name)),
          h("span", { class: `nw-badge nw-badge--${s.device}` }, T.sim.devices[s.device]),
          s.origin === "user" ? h("span", { class: "nw-badge" }, T.sim.mine) : null,
        ),
        h("span", { class: "nw-sim-summary" }, tr(s.summary)),
        s.unavailable ? h("span", { class: "nw-sim-why" }, icon("alert"), `${T.sim.unavailable}: ${tr(s.unavailable)}`) : null,
      );
      return { id: s.id, el: h("li", {}, btn) };
    });
    list.replaceChildren(...(rows.length ? rows.map((r) => r.el) : [h("li", { class: "nw-note" }, T.sim.loadingSims)]));
  }

  function control(p: SimParameter): { el: HTMLElement; show(v: Value): void } {
    const label = tr(p.label);
    const help = [p.help ? tr(p.help) : "", p.rebuild ? T.sim.rebuildTip : ""].filter(Boolean).join(" · ");
    if (p.kind === "number") {
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      const step = p.step ?? (max - min) / 100;
      const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));
      const k = knob({ id: `nw-sp-${p.key}`, label, hint: help, min, max, step, digits, unit: p.unit ?? "", rebuild: p.rebuild, set: (v) => set(p.key, v) });
      return { el: k.row, show: (v) => k.show(Number(v), Number(v)) };
    }
    if (p.kind === "boolean") {
      const sw = switchRow(null, label, help, () => set(p.key, !paramValue(p, store.get().simulator.settings)));
      return { el: sw.row, show: (v) => sw.set(Boolean(v)) };
    }
    const choices = p.choices ?? [];
    const head = h("span", { class: "nw-field-label", title: help }, label, p.rebuild ? icon("rebuild") : null);
    if (choices.length <= 4) {
      const seg = segmented<string>(label, choices.map((c) => ({ value: c.value, text: tr(c.label) })), (v) => set(p.key, v), "nw-seg--block");
      return { el: h("div", { class: "nw-field" }, head, seg.el), show: (v) => seg.set(String(v)) };
    }
    const select = h(
      "select",
      { class: "nw-select", "aria-label": label, onchange: (e: Event) => set(p.key, (e.target as HTMLSelectElement).value) },
      ...choices.map((c) => h("option", { value: c.value }, tr(c.label))),
    );
    return { el: h("div", { class: "nw-field" }, head, select), show: (v) => (select.value = String(v)) };
  }

  function renderParams(info: SimulatorInfo | undefined) {
    controls = [];
    const items = (info?.parameters ?? []).map((p) => {
      const c = control(p);
      controls.push({ p, show: c.show });
      return c.el;
    });
    params.replaceChildren(...(items.length ? [h("h4", { class: "nw-subtitle" }, T.sim.params), ...items] : []));
  }

  return {
    el,
    update(s: AppState, prev: AppState | null) {
      if (s.simulators !== shownList) {
        shownList = s.simulators;
        renderList(s.simulators);
        shownId = null;
      }
      if (s.simulator.id !== shownId) {
        shownId = s.simulator.id;
        for (const r of rows) r.el.firstElementChild!.setAttribute("aria-checked", String(r.id === shownId));
        renderParams(s.simulators.find((x) => x.id === shownId));
        prev = null;
      }
      if (changed(s, prev, (x) => x.simulator)) for (const c of controls) c.show(paramValue(c.p, s.simulator.settings));
      if (changed(s, prev, (x) => x.stats)) {
        const st = s.stats;
        cost.textContent = `${T.readouts.step} ${formatMs(st.stepMs)} ms · ${T.readouts.particles} ${formatCount(st.particles)} · ${T.readouts.cells} ${formatCount(st.cells)}`;
      }
    },
  };
}
