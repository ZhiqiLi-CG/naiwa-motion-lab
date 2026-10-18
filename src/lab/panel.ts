/**
 * The conversation panel: beside the 3D view on wide screens (left of the Lab panel and of the code lab when they are
 * open), a bottom sheet on phones. Codex's messages, compact tool lines, plans, jobs with progress and stop, and the
 * produced things as cards to apply; a composer for starting a job; the message box with send / stop.
 */
import { tr, type Text } from "../i18n";
import { renderMarkdown } from "../labcode/markdown";
import { h, icon } from "../ui/dom";
import type { Artifact } from "./client";
import { L } from "./copy";
import { metricRows, type Feed, type FeedItem, type StepItem } from "./feed";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PanelHandlers {
  send(text: string): void;
  stop(): void;
  newChat(): void;
  /** Apply an artefact; resolves true when it was applied. */
  apply(a: Artifact): Promise<boolean>;
  stopJob(run: string): void;
  fileUrl(path: string): string;
  /** Right edge the panel must stay left of (the Lab panel, the code lab), in px from the window's right. */
  rightEdge(): number;
}

export interface Composer {
  title: Text;
  summary: Text;
  /** Free text (a goal, or the words of a dance). */
  text?: { label: Text; hint?: Text; required?: boolean };
  budget?: { min: number; max: number; value: number };
  start(values: { text: string; budget: number }): void;
}

const PHONE = "(max-width: 720px)";
const WIDTH = 360;
const GUTTER = 12;

const textOf = (t: Text | string | undefined): string => (t === undefined ? "" : typeof t === "string" ? t : tr(t));
const baseName = (p: string) => p.split("/").pop() ?? p;

export function createPanel(host: HTMLElement, on: PanelHandlers) {
  const status = h("span", { class: "nw-cx-status" }, h("span", { class: "nw-cx-status-dot" }), h("span", {}));
  const log = h("div", { class: "nw-cx-log", role: "log", "aria-live": "polite" });
  const empty = h(
    "div",
    { class: "nw-cx-empty" },
    h("p", {}, tr(L.empty)),
    h("div", { class: "nw-cx-suggest" }, ...L.suggestions.map((s) => h("button", { class: "nw-chip", type: "button", onclick: () => prefill(tr(s)) }, tr(s)))),
  );
  const busyLine = h("p", { class: "nw-cx-busy" }, h("span", { class: "nw-cx-spinner", "aria-hidden": "true" }), tr(L.thinking));
  const items = h("div", { class: "nw-cx-items" });
  log.append(empty, items, busyLine);
  const composeHost = h("div", { class: "nw-cx-compose-host" });
  const input = h("textarea", { class: "nw-input nw-cx-input", rows: "2", placeholder: tr(L.placeholder), "aria-label": tr(L.placeholder) });
  const sendBtn = h("button", { class: "nw-btn nw-btn--primary nw-btn--sm nw-cx-send", type: "submit" });
  const form = h("form", { class: "nw-cx-form" }, input, h("div", { class: "nw-cx-form-row" }, h("span", { class: "nw-cx-keys" }, tr(L.keys)), sendBtn));
  const el = h(
    "section",
    { class: "nw-cx", hidden: true, "aria-label": tr(L.title) },
    h(
      "header",
      { class: "nw-cx-head" },
      h("span", { class: "nw-cx-mark" }, icon("sparkle")),
      h("div", { class: "nw-cx-titles" }, h("h2", { class: "nw-cx-title" }, tr(L.title)), status),
      h("button", { class: "nw-icon-btn nw-icon-btn--sm", type: "button", "aria-label": tr(L.newChat), title: tr(L.newChat), onclick: () => on.newChat() }, icon("again")),
      h("button", { class: "nw-icon-btn nw-icon-btn--sm", type: "button", "aria-label": tr(L.close), title: tr(L.close), onclick: () => close() }, icon("close")),
    ),
    log,
    composeHost,
    form,
  );
  host.append(el);

  let busy = false;
  let connected = true;
  const setSend = () => {
    sendBtn.replaceChildren(icon(busy ? "stop" : "play"), tr(busy ? L.stop : L.send));
    sendBtn.classList.toggle("nw-btn--secondary", busy);
    sendBtn.classList.toggle("nw-btn--primary", !busy);
    sendBtn.disabled = !connected;
  };
  setSend();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return on.stop();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    on.send(text);
  });
  input.addEventListener("keydown", (e) => {
    // the page's own shortcuts stay out of the message box
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === "Escape") close();
  });

  /* ---------------- items ---------------- */
  const shown = new Map<string, { item: FeedItem; el: HTMLElement }>();

  function toolLine(x: Extract<StepItem, { kind: "tool" }>): HTMLElement {
    const head = h(
      "span",
      { class: "nw-cx-tool-head" },
      h("span", { class: "nw-cx-tool-dot", "aria-hidden": "true" }),
      h("span", { class: "nw-cx-tool-kind" }, textOf(L.tools[x.tool] ?? L.tools.shell)),
      h("code", { class: "nw-cx-tool-title", title: x.title }, x.title),
    );
    const cls = `nw-cx-tool nw-cx-tool--${x.status}${x.tool === "page" ? " nw-cx-tool--page" : ""}`;
    if (!x.output.trim()) return h("div", { class: cls }, head);
    return h("details", { class: cls }, h("summary", {}, head), h("pre", { class: "nw-cx-tool-out" }, x.output));
  }

  function artifactCard(a: Artifact): HTMLElement {
    const btn = h("button", { class: "nw-btn nw-btn--primary nw-btn--sm", type: "button" }, icon(a.kind === "file" ? "link" : "check"), textOf(L.apply[a.kind]));
    btn.addEventListener("click", () => {
      btn.disabled = true;
      void on.apply(a).then((ok) => {
        if (ok && a.kind !== "file") btn.replaceChildren(icon("check"), tr(L.applied));
        else btn.disabled = false;
      });
    });
    const title =
      a.title !== undefined
        ? textOf(a.title)
        : a.kind === "preset"
          ? textOf((a.data.name as Text | undefined) ?? L.artifacts.preset)
          : (a.name ?? baseName(a.path));
    const detail =
      a.kind === "preset"
        ? Object.entries((a.data.params as Record<string, unknown> | undefined) ?? a.data)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => `${k} ${(v as number).toFixed(2)}`)
            .join(" · ")
        : a.path;
    const why = a.kind === "preset" && typeof a.data.why === "string" ? h("p", { class: "nw-cx-card-why" }, a.data.why) : null;
    return h(
      "div",
      { class: "nw-cx-card" },
      h("div", { class: "nw-cx-card-head" }, h("span", { class: "nw-badge" }, textOf(L.artifacts[a.kind])), h("b", { class: "nw-cx-card-title" }, title)),
      detail ? h("p", { class: "nw-cx-card-detail", title: detail }, detail) : null,
      why,
      h("div", { class: "nw-cx-card-actions" }, btn, a.kind !== "preset" && a.kind !== "file" ? h("a", { class: "nw-btn nw-btn--ghost nw-btn--sm", href: on.fileUrl(a.path), target: "_blank", rel: "noopener" }, tr(L.apply.file)) : null),
    );
  }

  function stepEl(x: StepItem): HTMLElement {
    switch (x.kind) {
      case "assistant":
        return h("div", { class: "nw-cx-msg nw-cx-msg--codex" }, h("div", { class: "nw-md" }, renderMarkdown(x.text)));
      case "tool":
        return toolLine(x);
      case "plan":
        return h(
          "div",
          { class: "nw-cx-plan" },
          h("span", { class: "nw-cx-plan-k" }, tr(L.plan)),
          h("ul", {}, ...x.items.map((t) => h("li", { class: t.done ? "is-done" : "" }, icon(t.done ? "check" : "free"), t.text))),
        );
      case "artifact":
        return artifactCard(x.artifact);
      case "error":
        return h("p", { class: "nw-cx-error" }, icon("alert"), x.text);
    }
  }

  function jobCard(x: Extract<FeedItem, { kind: "job" }>): HTMLElement {
    const chip = h("span", { class: `nw-cx-chip nw-cx-chip--${x.status}` }, tr(L.job[x.status]));
    const stop = x.status === "running" ? h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", type: "button", onclick: () => on.stopJob(x.run) }, icon("stop"), tr(L.job.stop)) : null;
    const pct = Math.round(x.progress * 100);
    const bar =
      x.status === "running"
        ? h("div", { class: "nw-cx-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct) }, h("span", { style: `width:${pct}%` }))
        : null;
    const last = x.log.at(-1);
    const toolsDone = x.steps.filter((s) => s.kind === "tool").length;
    const steps = x.log.length || x.steps.length
      ? h(
          "details",
          { class: "nw-cx-job-steps", open: x.status === "running" ? true : null },
          h("summary", {}, `${tr(L.job.log)} · ${toolsDone}`),
          ...x.log.map((l) => h("p", { class: "nw-cx-job-log" }, l)),
          ...x.steps.filter((s) => s.kind !== "artifact").map(stepEl),
        )
      : null;
    const r = x.result;
    const metrics = r?.metrics ? metricTable(r.metrics) : null;
    return h(
      "div",
      { class: "nw-cx-job" },
      h("div", { class: "nw-cx-job-head" }, icon("flask"), h("b", {}, x.name ? tr(x.name) : x.run), chip, stop),
      bar,
      x.status === "running" && last ? h("p", { class: "nw-cx-job-now" }, last) : null,
      steps,
      r ? h("div", { class: "nw-cx-job-summary nw-md" }, renderMarkdown(tr(r.summary))) : null,
      metrics,
      ...(r?.artifacts ?? []).map(artifactCard),
      ...x.steps.filter((s): s is Extract<StepItem, { kind: "artifact" }> => s.kind === "artifact").map((s) => artifactCard(s.artifact)),
      x.error && x.status !== "stopped" ? h("p", { class: "nw-cx-error" }, icon("alert"), x.error) : null,
    );
  }

  function metricTable(m: NonNullable<NonNullable<Extract<FeedItem, { kind: "job" }>["result"]>["metrics"]>): HTMLElement {
    const fmt = (v: number | null) => (v === null ? "—" : Math.abs(v) >= 100 ? v.toFixed(0) : String(+v.toPrecision(3)));
    return h(
      "div",
      { class: "nw-cx-metrics" },
      h(
        "table",
        { class: "nw-cx-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, tr(L.job.metric)), h("th", { scope: "col" }, tr(L.job.before)), h("th", { scope: "col" }, tr(L.job.after)))),
        h(
          "tbody",
          {},
          ...metricRows(m).map((row) =>
            h(
              "tr",
              {},
              h("th", { scope: "row" }, h("code", {}, row.key)),
              h("td", {}, fmt(row.before)),
              h("td", { class: row.verdict ? `nw-cx-diff--${row.verdict}` : "" }, fmt(row.after), row.verdict && row.verdict !== "same" ? ` · ${tr(L.job[row.verdict])}` : ""),
            ),
          ),
        ),
      ),
      h("p", { class: "nw-cx-note" }, tr(L.job.lowerBetter)),
    );
  }

  function itemEl(x: FeedItem): HTMLElement {
    if (x.kind === "user") return h("div", { class: "nw-cx-msg nw-cx-msg--user" }, x.text);
    if (x.kind === "job") return jobCard(x);
    return stepEl(x);
  }

  function render(feed: Feed) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const keys = new Set(feed.items.map((x) => x.key));
    for (const [k, v] of shown) if (!keys.has(k)) (v.el.remove(), shown.delete(k));
    let i = 0;
    for (const x of feed.items) {
      let s = shown.get(x.key);
      if (!s || s.item !== x) {
        const next = itemEl(x);
        // keep a details element open/closed as the user left it
        const wasOpen = s?.el.querySelector("details")?.open;
        if (s && wasOpen !== undefined) next.querySelector("details")?.toggleAttribute("open", wasOpen);
        if (s) s.el.replaceWith(next);
        s = { item: x, el: next };
        shown.set(x.key, s);
      }
      if (items.children[i] !== s.el) items.insertBefore(s.el, items.children[i] ?? null);
      i++;
    }
    empty.hidden = feed.items.length > 0;
    busy = feed.busy;
    busyLine.hidden = !(busy && feed.items.at(-1)?.kind !== "assistant");
    setSend();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  /* ---------------- composer ---------------- */
  function compose(c: Composer | null) {
    composeHost.replaceChildren();
    if (!c) return;
    const text = c.text ? h("textarea", { class: "nw-input nw-cx-compose-text", rows: "2", placeholder: c.text.hint ? tr(c.text.hint) : "", "aria-label": tr(c.text.label) }) : null;
    text?.addEventListener("keydown", (e) => e.stopPropagation());
    const budget = c.budget ? h("input", { class: "nw-input nw-cx-compose-budget", type: "number", min: String(c.budget.min), max: String(c.budget.max), value: String(c.budget.value), "aria-label": tr(L.budget) }) : null;
    const start = h("button", { class: "nw-btn nw-btn--primary nw-btn--sm", type: "submit" }, icon("play"), tr(L.start));
    const f = h(
      "form",
      { class: "nw-cx-compose" },
      h("div", { class: "nw-cx-compose-head" }, icon("sparkle"), h("b", {}, tr(c.title))),
      h("p", { class: "nw-cx-note" }, tr(c.summary), " ", tr(L.usage)),
      text ? h("label", { class: "nw-cx-field" }, h("span", {}, tr(c.text!.label)), text) : null,
      budget ? h("label", { class: "nw-cx-field nw-cx-field--row" }, h("span", {}, tr(L.budget)), budget) : null,
      h("div", { class: "nw-cx-card-actions" }, start, h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm", type: "button", onclick: () => compose(null) }, tr(L.cancel))),
    );
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = text?.value.trim() ?? "";
      if (c.text?.required && !t) return text?.focus();
      const b = budget ? Math.max(c.budget!.min, Math.min(c.budget!.max, Math.round(Number(budget.value) || c.budget!.value))) : 0;
      compose(null);
      c.start({ text: t, budget: b });
    });
    composeHost.append(f);
    requestAnimationFrame(() => (text ?? start).focus());
  }

  function prefill(text: string) {
    input.value = text;
    input.focus();
  }

  /* ---------------- placement ---------------- */
  const insetListeners = new Set<(i: Insets) => void>();
  const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const phone = matchMedia(PHONE);
  function place() {
    if (el.hidden || phone.matches) {
      el.style.removeProperty("right");
      el.style.removeProperty("width");
    } else {
      const right = Math.max(GUTTER, on.rightEdge() + GUTTER);
      const width = Math.max(280, Math.min(WIDTH, innerWidth - right - 2 * GUTTER));
      el.style.right = `${right}px`;
      el.style.width = `${width}px`;
    }
    const i = insets();
    insetListeners.forEach((cb) => cb(i));
  }
  function insets(): Insets {
    if (el.hidden || phone.matches) return NONE;
    const left = el.getBoundingClientRect().left;
    return { ...NONE, right: Math.max(0, Math.round(innerWidth - left)) };
  }
  addEventListener("resize", place);
  phone.addEventListener("change", place);

  function open() {
    if (!el.hidden) return;
    el.hidden = false;
    place();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    place();
  }

  return {
    el,
    open,
    close,
    isOpen: () => !el.hidden,
    render,
    compose,
    prefill,
    place,
    setStatus(text: string, ok: boolean) {
      status.className = `nw-cx-status ${ok ? "is-ok" : "is-off"}`;
      status.lastElementChild!.textContent = text;
      connected = ok;
      setSend();
    },
    insets,
    onInsets(cb: (i: Insets) => void) {
      insetListeners.add(cb);
      return () => insetListeners.delete(cb);
    },
    dispose() {
      removeEventListener("resize", place);
      phone.removeEventListener("change", place);
      el.remove();
    },
  };
}

export type Panel = ReturnType<typeof createPanel>;
