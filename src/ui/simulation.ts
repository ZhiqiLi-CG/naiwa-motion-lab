/** 仿真 Simulation: the simulator and its parameters, material presets, the global knobs with exact values and units
 *  (softness, damping, gravity, volume, upright recovery), and material by region with a body map that marks the
 *  region being adjusted. */
import type { AppState, FleshRegion, PhysicsParams } from "../contracts";
import { tr } from "../i18n";
import { KNOBS, REGION_GROUPS, copy, presetName, type RegionGroupDef } from "./copy";
import { changed, type Ctx, type Part } from "./ctx";
import { append, h, icon } from "./dom";
import { formatCount, formatMs, matchingPreset } from "./format";
import { knob } from "./knob";
import { panel, section } from "./panel";
import { createPluginSection, type PluginMetric } from "./plugins";

type GroupId = RegionGroupDef["id"];

/** The group's value: its first region's (they are written together), or null while it keeps the defaults. */
export function groupValue(g: RegionGroupDef, rs: PhysicsParams["regionSoftness"]): number | null {
  return rs?.[g.regions[0]!] ?? null;
}

/** Set every region of the group to v, keeping the other regions as they are. */
export function withGroup(g: RegionGroupDef, v: number, rs: PhysicsParams["regionSoftness"]): Partial<Record<FleshRegion, number>> {
  const next = { ...rs };
  for (const r of g.regions) next[r] = v;
  return next;
}

const SVG = "http://www.w3.org/2000/svg";

/** A schematic 奶蛙 front view (viewBox 80×120): head, body with the belly patch, arms over the belly, legs. */
function bodyMap(): { svg: SVGSVGElement; part: Record<GroupId, SVGGElement> } {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 80 120");
  svg.setAttribute("class", "nw-body-map");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
<g data-part="leg"><path class="nw-bm-limb" d="M31 96v12M49 96v12"/><ellipse class="nw-bm-fill" cx="29" cy="111" rx="8" ry="3.6"/><ellipse class="nw-bm-fill" cx="51" cy="111" rx="8" ry="3.6"/></g>
<g data-part="belly"><path class="nw-bm-fill" d="M24 34c-6 8-14 18-14 34 0 18 12 31 30 31s30-13 30-31c0-16-8-26-14-34z"/><ellipse class="nw-bm-patch" cx="40" cy="72" rx="17" ry="18"/></g>
<g data-part="head"><path class="nw-bm-fill" d="M40 7c-11 0-18 8-18 18 0 3 .8 6.5 2 9h32c1.2-2.5 2-6 2-9 0-10-7-18-18-18z"/><circle class="nw-bm-eye" cx="24.5" cy="21" r="3.6"/><circle class="nw-bm-eye" cx="55.5" cy="21" r="3.6"/></g>
<g data-part="arm"><path class="nw-bm-limb" d="M18 49c-8 10-6 20 6 25M62 49c8 10 6 20-6 25"/><circle class="nw-bm-hand" cx="25" cy="74.5" r="4.2"/><circle class="nw-bm-hand" cx="55" cy="74.5" r="4.2"/></g>`;
  const part = {} as Record<GroupId, SVGGElement>;
  for (const g of svg.querySelectorAll<SVGGElement>("[data-part]")) part[g.dataset.part as GroupId] = g;
  return { svg, part };
}

export function createSimulationPanel(ctx: Ctx, host: HTMLElement): Part {
  const { store, presets } = ctx;
  const T = copy();
  const { el, body } = panel(ctx, "sim", "sliders", T.sim.title, T.sim.sub);
  el.setAttribute("data-lab-only", "");

  const simulator = createPluginSection(ctx, {
    id: "sim",
    title: T.sim.simulator,
    list: (s) => s.simulators,
    chosen: (s) => s.simulator,
    choose: (simulator) => store.set({ simulator }),
    edit: ctx.commands.editSimulator,
    metrics: (s) => [
      [T.readouts.step, `${formatMs(s.stats.stepMs)} ms`],
      [T.readouts.particles, formatCount(s.stats.particles)],
      [T.readouts.cells, formatCount(s.stats.cells)],
    ],
    metricsSource: (s) => s.stats,
  });
  // the retargeter's own readouts, when it reports them (proposed MotionStatus.metrics)
  const retargeter = createPluginSection(ctx, {
    id: "retarget",
    title: T.sim.retargeter,
    list: (s) => s.retargeters,
    chosen: (s) => s.retargeter,
    choose: (retargeter) => store.set({ retargeter }),
    edit: ctx.commands.editRetargeter,
    metrics: (s) => ((s.motion as { metrics?: PluginMetric[] }).metrics ?? []).map((m) => [tr(m.label), m.value]),
    metricsSource: (s) => s.motion,
  });

  /* ---- presets ---- */
  const chips = presets.map((p) =>
    h(
      "button",
      { class: "nw-chip", "aria-pressed": "false", onclick: () => store.set({ preset: p.id, params: { ...p.params } }) },
      presetName(p),
    ),
  );
  const modified = h("span", { class: "nw-tag" }, T.sim.modified);

  /* ---- global knobs ---- */
  const knobs = KNOBS.map((d) => {
    const k = knob({
      id: `nw-k-${d.id}`,
      label: T.sim.knobs[d.id].label,
      hint: T.sim.knobs[d.id].hint,
      min: d.min,
      max: d.max,
      step: d.step,
      digits: d.digits,
      unit: d.unit,
      set: (v) => store.set({ params: { [d.param]: d.fromView(v) } as Partial<PhysicsParams> }),
    });
    return { d, k };
  });

  /* ---- material by region ---- */
  const map = bodyMap();
  const mark = (id: GroupId | null) => {
    for (const [k, g] of Object.entries(map.part)) g.classList.toggle("is-active", k === id);
  };
  const regions = REGION_GROUPS.map((g) => {
    const k = knob({
      id: `nw-r-${g.id}`,
      label: T.sim.regionNames[g.id],
      hint: T.sim.regionsSub,
      min: 0,
      max: 1,
      step: 0.01,
      digits: 2,
      unit: "",
      set: (v) => store.set({ params: { regionSoftness: withGroup(g, v, store.get().params.regionSoftness) } }),
    });
    k.row.classList.add("nw-knob--compact");
    for (const ev of ["pointerenter", "focusin"]) k.row.addEventListener(ev, () => mark(g.id));
    k.row.addEventListener("pointerleave", () => {
      if (!k.row.contains(document.activeElement)) mark(null);
    });
    k.row.addEventListener("focusout", () => mark(null));
    map.part[g.id].addEventListener("click", () => k.slider.focus());
    return { g, k };
  });
  const resetRegions = h(
    "button",
    { class: "nw-btn nw-btn--ghost nw-btn--sm", onclick: () => store.set({ params: { regionSoftness: undefined } }) },
    icon("reset"),
    T.sim.regionReset,
  );

  const link = h(
    "button",
    { class: "nw-btn nw-btn--ghost nw-btn--sm nw-panel-link", onclick: () => ctx.commands.copyConfigLink().catch(() => ctx.toast(T.toasts.linkFailed, "error")) },
    icon("link"),
    T.sim.copyLink,
  );

  append(body, [
    simulator.el,
    retargeter.el,
    section(T.sim.presets, h("div", { class: "nw-chips", role: "group", "aria-label": T.sim.presets }, ...chips, modified)),
    section(T.sim.global, ...knobs.map((x) => x.k.row)),
    section(
      T.sim.regions,
      h("p", { class: "nw-note" }, T.sim.regionsSub),
      h("div", { class: "nw-regions" }, map.svg, h("div", { class: "nw-regions-knobs" }, ...regions.map((x) => x.k.row))),
      resetRegions,
    ),
    link,
  ]);
  host.append(el);

  return {
    update(s: AppState, prev) {
      simulator.update(s, prev);
      retargeter.update(s, prev);
      if (!changed(s, prev, (x) => x.params)) return;
      for (const { d, k } of knobs) k.show(d.toView(s.params[d.param]), 0);
      const rs = s.params.regionSoftness;
      for (const { g, k } of regions) {
        const v = groupValue(g, rs);
        k.show(v, g.nominal, T.sim.regionDefault);
        map.part[g.id].style.setProperty("--soft", String(v ?? g.nominal));
      }
      resetRegions.hidden = rs === undefined;
      const match = matchingPreset(s.params, presets);
      chips.forEach((c, i) => c.setAttribute("aria-pressed", String(presets[i]!.id === match)));
      modified.hidden = match !== null;
    },
  };
}
