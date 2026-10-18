/**
 * The code lab panel, opened from the Lab's "编辑代码 / Edit code": pick a slot of the running simulator or
 * retargeter, read the source of the block in it (the page's own code is read-only; "复制为我的 / Fork" makes an
 * editable copy), edit it, apply it (Ctrl/Cmd+S) into the running core, compare it with the built-in block on the
 * same scene or motion, and read the block's learning page next to the code. A side sheet on wide screens (the frog
 * stays in view), a full-screen sheet on phones.
 */
import "./labcode.css";
import type { AppState, RigSpec } from "../contracts";
import { getLang, onLang, tr, type Text } from "../i18n";
import type { Binding } from "../motion/rig";
import { fetchTrack, type Track } from "../motion/track";
import type { Store } from "../store";
import { append, h, icon } from "../ui/dom";
import { apiPage, blockSources, learnPage, nameIn, type BlockSource, type CoreKind } from "./catalog";
import { CORES } from "./cores";
import { createEditor, type Editor, type EditorProblem } from "./editor";
import { createLab, LAB_ASSEMBLY, labBlockId, type CompareResult, type Lab, type LabError, type LabHost } from "./lab";
import { pageSource } from "./loader";
import { renderMarkdown } from "./markdown";
import type { MetricRow } from "./runs";
import { browserStorage, type LabStorage, type UserBlock } from "./storage";

export interface CodeLabOptions {
  /** Where the sheet is mounted (e.g. the UI root). */
  host: HTMLElement;
  /** The page's store: the lab reads the running simulator / retargeter and the physics sliders, and switches the
   *  simulator / retargeter to "My experiment" when a block is applied (the page rebuilds it as usual). */
  store: Store;
  /** The frog's rig (Character.spec) and the motion module's bound rig (motion.binding()); null before boot. */
  spec(): RigSpec | null;
  binding(): Binding | null;
  toast?(message: string, kind?: "info" | "success" | "error"): void;
  storage?: LabStorage;
}

export interface CodeLabTarget {
  kind: CoreKind;
  slot?: string;
}

export interface CodeLab {
  open(target: CodeLabTarget): void;
  close(): void;
  isOpen(): boolean;
  /** Resolves when the user's saved experiments are registered again: await it before building the simulation at
   *  boot, so a page reloaded on "My experiment" finds it. */
  readonly ready: Promise<void>;
  readonly lab: Lab;
  destroy(): void;
}

const T = {
  title: { zh: "代码实验室", en: "Code lab" },
  kinds: { simulator: { zh: "模拟器", en: "Simulator" }, retargeter: { zh: "动作迁移", en: "Motion transfer" } } as Record<CoreKind, Text>,
  running: { zh: "运行中", en: "Running" },
  close: { zh: "关闭", en: "Close" },
  slots: { zh: "模块槽", en: "Slots" },
  covered: { zh: "由其他模块覆盖", en: "covered by another block" },
  source: { zh: "源码", en: "Source" },
  inSlot: { zh: "当前在用", en: "In use" },
  library: { zh: "内置与示例", en: "Built in and examples" },
  mine: { zh: "我的", en: "Mine" },
  example: { zh: "示例", en: "example" },
  fork: { zh: "复制为我的", en: "Fork" },
  apply: { zh: "应用", en: "Apply" },
  applying: { zh: "正在编译和试运行…", en: "Compiling and trying it…" },
  compare: { zh: "对比", en: "Compare" },
  restore: { zh: "换回内置", en: "Use built-in" },
  remove: { zh: "删除", en: "Delete" },
  removeConfirm: { zh: "删除这个模块？代码会从这个浏览器里移除。", en: "Delete this block? Its code is removed from this browser." },
  readOnly: { zh: "内置 · 只读", en: "Built in · read-only" },
  readOnlyNote: {
    zh: "这是页面自带的代码，只读。点「复制为我的」得到一份可以修改的副本，改完按 Ctrl/⌘+S 应用到正在运行的模拟中。",
    en: "This is the page's own code, read-only. Fork it to get a copy you can edit, then press Ctrl/⌘+S to apply it to the running simulation.",
  },
  stateLive: { zh: "我的 · 运行中", en: "Mine · running" },
  stateIdle: { zh: "我的 · 未应用", en: "Mine · not applied" },
  stateEdited: { zh: "我的 · 有改动未应用", en: "Mine · edited, not applied" },
  saved: { zh: "已保存在这个浏览器", en: "Saved in this browser" },
  notSaved: { zh: "这个浏览器不能保存，关闭页面后会丢失", en: "This browser cannot save; it is lost when the page closes" },
  noSource: { zh: "这个模块的源码不在页面里。", en: "This block's source is not part of the page." },
  tabs: { code: { zh: "代码", en: "Code" }, learn: { zh: "学习", en: "Learn" }, compare: { zh: "对比", en: "Compare" }, api: { zh: "接口", en: "API" } },
  noLearn: {
    zh: "这个模块还没有学习页。下面是它的说明；「接口」里是这个槽的接口文档。",
    en: "This block has no learning page yet. Its summary is below; the API tab documents the slot.",
  },
  problems: { zh: "问题", en: "Problems" },
  noProblems: { zh: "没有问题", en: "No problems" },
  line: (l: number, c: number): Text => ({ zh: `第 ${l} 行，第 ${c} 列`, en: `line ${l}, column ${c}` }),
  phases: {
    compile: { zh: "编译错误", en: "Compile error" },
    load: { zh: "加载错误", en: "Load error" },
    check: { zh: "模块不完整", en: "Incomplete block" },
    trial: { zh: "试运行出错", en: "Failed its trial run" },
    runtime: { zh: "运行时出错", en: "Runtime error" },
  } as Record<LabError["phase"], Text>,
  keptPrevious: { zh: "页面里仍是之前的模块。", en: "The page keeps the previous block." },
  fellBackVersion: { zh: "已退回这个模块的上一个版本。", en: "Fell back to the previous version of this block." },
  fellBackBlock: { zh: "已换回之前的模块。", en: "Fell back to the previous block." },
  applied: (name: string): Text => ({ zh: `「${name}」已换进正在运行的模拟`, en: `"${name}" is now running` }),
  stack: { zh: "调用栈", en: "Stack" },
  compareIntro: {
    zh: "在同一个场景里分别运行内置模块和你的模块（其余槽相同），比较质量指标。数值越小越好。",
    en: "Runs the built-in block and yours on the same scene (the other slots the same) and compares the quality numbers. Lower is better.",
  },
  compareRun: { zh: "运行对比", en: "Run the comparison" },
  comparing: { zh: "对比中…", en: "Comparing…" },
  compareNeedsMine: { zh: "先「复制为我的」，再和内置模块对比。", en: "Fork the block first, then compare it with the built-in one." },
  metric: { zh: "指标", en: "Metric" },
  builtin: { zh: "内置", en: "Built in" },
  diff: { zh: "差别", en: "Difference" },
  better: { zh: "更好", en: "better" },
  worse: { zh: "更差", en: "worse" },
  same: { zh: "相同", en: "same" },
  scene: { zh: "场景", en: "Scene" },
  failed: { zh: "对比失败", en: "The comparison failed" },
  shortcuts: { zh: "Ctrl/⌘+S 应用 · Esc 关闭", en: "Ctrl/⌘+S apply · Esc close" },
  loading: { zh: "正在读取源码…", en: "Reading the source…" },
};

type Selection = { type: "page"; src: BlockSource } | { type: "mine"; key: string } | { type: "none"; id: string };
type Tab = "code" | "learn" | "compare" | "api";

let mounted: CodeLab | null = null;

/** Open the mounted code lab (the Lab panel's "Edit code" calls this). */
export function openCodeLab(target: CodeLabTarget): void {
  if (!mounted) throw new Error("labcode: mountCodeLab first");
  mounted.open(target);
}

export function mountCodeLab(opts: CodeLabOptions): CodeLab {
  const { store } = opts;
  let trackPromise: Promise<Track | null> | null = null;
  const host: LabHost = {
    current: (k) => (k === "simulator" ? store.get().simulator : store.get().retargeter),
    choose: (k, o) => store.set(k === "simulator" ? { simulator: o } : { retargeter: o }),
    spec: opts.spec,
    params: () => store.get().params,
    binding: opts.binding,
    track: () => (trackPromise ??= loadTrack(store.get()).catch(() => ((trackPromise = null), null))),
  };
  const lab = createLab(host, opts.storage ?? browserStorage);
  const toast = (m: string, k?: "info" | "success" | "error") => opts.toast?.(m, k);

  /* ---------------- state ---------------- */
  let kind: CoreKind = "simulator";
  let slot = "output";
  let sel: Selection = { type: "none", id: "" };
  let tab: Tab = "learn";
  let dirty = false;
  let busy = false;
  let lastError: LabError | null = null;
  let compareResult: CompareResult | null = null;
  let compareFor: string | null = null;
  let compareError: string | null = null;
  let compareProgress: number | null = null;
  let sources: BlockSource[] = [];
  let openNow = false;
  let loadToken = 0;
  let saveTimer = 0;

  /* ---------------- skeleton ---------------- */
  const head = h("header", { class: "nw-cl-head" });
  const slotsRow = h("div", { class: "nw-cl-slots", role: "tablist" });
  const bar = h("div", { class: "nw-cl-bar" });
  const note = h("p", { class: "nw-cl-note" });
  const editorHost = h("div", { class: "nw-cl-editor" });
  const problemsEl = h("div", { class: "nw-cl-problems", "aria-live": "polite" });
  const codePane = h("div", { class: "nw-cl-code" }, note, editorHost, problemsEl);
  const tabsRow = h("div", { class: "nw-cl-tabs", role: "tablist" });
  const sideBody = h("div", { class: "nw-cl-side-body" });
  const side = h("aside", { class: "nw-cl-side" }, sideBody);
  const main = h("div", { class: "nw-cl-main" }, codePane, side);
  const root = h(
    "section",
    { class: "nw-cl", role: "dialog", "aria-modal": "false", hidden: true, tabindex: "-1" },
    head,
    slotsRow,
    bar,
    tabsRow,
    main,
  );
  opts.host.append(root);

  const editor: Editor = createEditor(editorHost, {
    label: tr(T.title),
    onChange: () => {
      if (sel.type !== "mine") return;
      if (!dirty) {
        dirty = true;
        renderBar();
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (sel.type === "mine" && !lab.save(sel.key, editor.get())) renderBar();
      }, 400) as unknown as number;
    },
    onSave: () => void apply(),
  });

  /* ---------------- helpers ---------------- */
  const core = () => CORES[kind];
  const runningBlocks = () => core().blocksOf(host.current(kind).id) ?? core().blocksOf(lab.base(kind)) ?? {};
  const keyOf = (blockId: string) => (blockId.startsWith("mine-") ? blockId.slice(5) : null);
  const mineInSlot = () => lab.blocks(kind).filter((b) => b.slot === slot);
  const pageSourcesInSlot = () => sources.filter((s) => s.kind === kind && s.slot === slot);
  const nameOfMine = (b: UserBlock): string => {
    const n = lab.nameOf(b.key) ?? nameIn(b.code);
    return n ? tr(n) : b.from.id;
  };
  const nameOfPage = (s: BlockSource): string => {
    const n = core().block(s.id)?.name ?? s.name;
    return n ? tr(n) : s.id;
  };
  const isLive = (key: string) => runningBlocks()[slot] === labBlockId(key) && host.current(kind).id === LAB_ASSEMBLY[kind];
  const currentMine = () => (sel.type === "mine" ? lab.block(sel.key) : undefined);
  /** The block whose learning page and comparison apply: the one forked from, or the page block. */
  const learnId = () => (sel.type === "page" ? sel.src.id : sel.type === "mine" ? (lab.block(sel.key)?.from.id ?? "") : sel.id);

  function btn(label: string, iconName: Parameters<typeof icon>[0] | null, cls: string, onclick: () => void, attrs: Record<string, string | boolean> = {}) {
    return h("button", { class: `nw-btn nw-btn--sm ${cls}`, type: "button", onclick, ...attrs }, iconName ? icon(iconName) : null, label);
  }

  /* ---------------- rendering ---------------- */
  function renderHead() {
    const assembly = core().assemblies().find((a) => a.id === host.current(kind).id);
    const kinds = h(
      "div",
      { class: "nw-seg nw-cl-kinds", role: "group", "aria-label": tr(T.title) },
      ...(Object.keys(T.kinds) as CoreKind[]).map((k) =>
        h("button", { class: "nw-seg-btn", type: "button", "aria-pressed": String(k === kind), onclick: () => k !== kind && open({ kind: k }) }, h("span", {}, tr(T.kinds[k]))),
      ),
    );
    head.replaceChildren(
      h("h2", { class: "nw-cl-title" }, icon("code"), tr(T.title)),
      kinds,
      h(
        "span",
        { class: "nw-cl-running", title: assembly ? tr(assembly.summary) : "" },
        h("span", { class: "nw-cl-running-k" }, tr(T.running)),
        h("b", {}, assembly ? tr(assembly.name) : host.current(kind).id),
        assembly?.origin === "user" ? h("span", { class: "nw-badge" }, tr(T.mine)) : null,
      ),
      h("span", { class: "nw-cl-keys" }, tr(T.shortcuts)),
      h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm nw-cl-close", type: "button", "aria-label": tr(T.close), title: tr(T.close), onclick: close }, icon("close")),
    );
  }

  function renderSlots() {
    const blocks = runningBlocks();
    const exp = lab.experiment(kind);
    slotsRow.setAttribute("aria-label", tr(T.slots));
    slotsRow.replaceChildren(
      ...core().slots.map((s) => {
        const id = blocks[s];
        const mine = exp?.slots[s] !== undefined && host.current(kind).id === LAB_ASSEMBLY[kind];
        const blockName = id ? (keyOf(id) ? lab.nameOf(keyOf(id)!) : core().block(id)?.name) : null;
        return h(
          "button",
          {
            class: "nw-cl-slot",
            type: "button",
            role: "tab",
            "aria-selected": String(s === slot),
            disabled: !id,
            title: id ? `${tr(core().slotLabel(s))}: ${blockName ? tr(blockName) : id}` : tr(core().slotLabel(s)),
            onclick: () => s !== slot && selectSlot(s),
          },
          h("span", { class: "nw-cl-slot-k" }, tr(core().slotLabel(s))),
          h("span", { class: "nw-cl-slot-v" }, id ? (blockName ? tr(blockName) : id) : tr(T.covered)),
          mine ? h("span", { class: "nw-cl-slot-dot", "aria-label": tr(T.mine) }) : null,
        );
      }),
    );
  }

  function renderBar() {
    const select = h("select", {
      class: "nw-select nw-cl-source",
      "aria-label": tr(T.source),
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        const [type, rest] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
        if (type === "mine") show({ type: "mine", key: rest });
        else {
          const src = sources.find((s) => s.path === rest.split("#")[0] && s.id === rest.split("#")[1]);
          if (src) show({ type: "page", src });
        }
      },
    });
    const running = runningBlocks()[slot];
    const pages = pageSourcesInSlot();
    const runningPage = pages.find((s) => s.id === running);
    const opt = (value: string, text: string) => h("option", { value, selected: valueOf(sel) === value }, text);
    if (runningPage) select.append(h("optgroup", { label: tr(T.inSlot) }, opt(`page:${runningPage.path}#${runningPage.id}`, `${nameOfPage(runningPage)} · ${runningPage.id}`)));
    const others = pages.filter((s) => s !== runningPage);
    if (others.length) {
      select.append(
        h(
          "optgroup",
          { label: tr(T.library) },
          ...others.map((s) => opt(`page:${s.path}#${s.id}`, `${nameOfPage(s)} · ${s.id}${s.path.includes("/examples/") ? ` (${tr(T.example)})` : ""}`)),
        ),
      );
    }
    const mine = mineInSlot();
    if (mine.length) select.append(h("optgroup", { label: tr(T.mine) }, ...mine.map((b) => opt(`mine:${b.key}`, `${nameOfMine(b)}${isLive(b.key) ? ` · ${tr(T.running)}` : ""}`))));
    if (sel.type === "none") select.prepend(h("option", { value: "", selected: true, disabled: true }, sel.id || "—"));

    const b = currentMine();
    let chip: HTMLElement;
    if (sel.type === "page") chip = h("span", { class: "nw-cl-chip" }, tr(T.readOnly));
    else if (b) {
      const live = isLive(b.key);
      chip = h("span", { class: `nw-cl-chip ${live && !dirty ? "nw-cl-chip--live" : dirty ? "nw-cl-chip--edited" : ""}` }, tr(dirty ? T.stateEdited : live ? T.stateLive : T.stateIdle));
    } else chip = h("span", { class: "nw-cl-chip" }, "—");

    const actions: HTMLElement[] = [];
    if (sel.type === "page") actions.push(btn(tr(T.fork), "sparkle", "nw-btn--primary", fork));
    if (b) {
      actions.push(btn(busy ? tr(T.applying) : tr(T.apply), "play", "nw-btn--primary", () => void apply(), { disabled: busy, title: "Ctrl/⌘+S", "aria-keyshortcuts": "Control+S Meta+S" }));
    }
    if (sel.type !== "none") actions.push(btn(tr(T.compare), "swap", "nw-btn--secondary", () => setTab("compare")));
    if (lab.experiment(kind)?.slots[slot] && host.current(kind).id === LAB_ASSEMBLY[kind]) actions.push(btn(tr(T.restore), "again", "nw-btn--ghost", () => lab.restore(kind, slot)));
    if (b) actions.push(btn(tr(T.remove), "trash", "nw-btn--ghost nw-cl-danger", removeMine));
    const saveNote = b ? h("span", { class: "nw-cl-save" }, tr(lab.persistent() ? T.saved : T.notSaved)) : null;
    bar.replaceChildren(h("div", { class: "nw-cl-bar-left" }, select, chip, saveNote), h("div", { class: "nw-cl-actions" }, ...actions));

    note.hidden = sel.type !== "page" && sel.type !== "none";
    note.replaceChildren(sel.type === "none" ? tr(T.noSource) : tr(T.readOnlyNote));
  }

  function renderTabs() {
    const tabs: Tab[] = ["code", "learn", "compare", "api"];
    tabsRow.replaceChildren(
      ...tabs.map((t) =>
        h("button", { class: `nw-cl-tab nw-cl-tab--${t}`, type: "button", role: "tab", "aria-selected": String(t === tab), onclick: () => setTab(t) }, tr(T.tabs[t])),
      ),
    );
    root.dataset.view = tab;
  }

  function renderProblems() {
    const err = lastError;
    if (!err) {
      problemsEl.hidden = true;
      problemsEl.replaceChildren();
      editor.problems([]);
      return;
    }
    problemsEl.hidden = false;
    const located = err.problems.filter((p) => p.to >= p.from);
    editor.problems(located.map((p): EditorProblem => ({ from: p.from, to: Math.max(p.to, p.from + 1), message: tr(p.message), severity: "error" })));
    const fallbackNote = err.phase === "runtime" ? null : h("span", { class: "nw-cl-err-note" }, tr(T.keptPrevious));
    problemsEl.replaceChildren();
    append(problemsEl, [
      h(
        "div",
        { class: "nw-cl-err-head" },
        icon("alert"),
        h("b", {}, tr(T.phases[err.phase])),
        fallbackNote,
        h("button", { class: "nw-btn nw-btn--ghost nw-btn--sm nw-cl-err-close", type: "button", "aria-label": tr(T.close), onclick: () => ((lastError = null), renderProblems()) }, icon("close")),
      ),
      h("p", { class: "nw-cl-err-msg" }, err.message),
      located.length
        ? h(
            "ul",
            { class: "nw-cl-err-list" },
            ...located.map((p) => {
              const [l, c] = editor.lineCol(p.from);
              return h("li", {}, h("button", { class: "nw-cl-err-at", type: "button", onclick: () => editor.reveal(p.from) }, tr(T.line(l, c))), " ", tr(p.message));
            }),
          )
        : null,
      err.stack ? h("details", { class: "nw-cl-stack" }, h("summary", {}, tr(T.stack)), h("pre", {}, err.stack)) : null,
    ]);
  }

  let sideToken = 0;
  async function renderSide() {
    const token = ++sideToken;
    const view: Tab = tab === "code" ? "learn" : tab;
    if (view === "learn") {
      const id = learnId();
      const page = id ? await learnPage(kind, id, getLang()) : null;
      if (token !== sideToken) return;
      if (page) sideBody.replaceChildren(h("article", { class: "nw-md" }, renderMarkdown(page)));
      else {
        const info = id ? core().block(id) : undefined;
        const src = sources.find((s) => s.id === id);
        const name = info?.name ?? src?.name;
        sideBody.replaceChildren(
          h(
            "article",
            { class: "nw-md" },
            h("h2", { class: "nw-md-h" }, name ? tr(name) : id || tr(core().slotLabel(slot))),
            h("p", { class: "nw-cl-muted" }, tr(T.noLearn)),
            info ? h("p", {}, tr((info as { summary?: Text }).summary ?? { zh: "", en: "" })) : null,
          ),
        );
      }
      return;
    }
    if (view === "api") {
      const doc = await apiPage(kind);
      if (token !== sideToken) return;
      sideBody.replaceChildren(h("article", { class: "nw-md" }, renderMarkdown(doc)));
      return;
    }
    renderCompare();
  }

  function renderCompare() {
    const b = currentMine();
    const intro = h("p", { class: "nw-cl-muted" }, tr(T.compareIntro));
    if (!b) {
      sideBody.replaceChildren(h("div", { class: "nw-cl-compare" }, intro, h("p", { class: "nw-note" }, tr(T.compareNeedsMine)), sel.type === "page" ? btn(tr(T.fork), "sparkle", "nw-btn--primary", fork) : null));
      return;
    }
    const run = btn(compareProgress !== null ? tr(T.comparing) : tr(T.compareRun), "swap", "nw-btn--primary", () => void runCompare(), { disabled: compareProgress !== null });
    const progress =
      compareProgress !== null
        ? h("div", { class: "nw-cl-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(compareProgress * 100)) }, h("span", { style: `width:${Math.round(compareProgress * 100)}%` }))
        : null;
    const result = compareFor === b.key && compareResult ? compareTable(compareResult) : null;
    const error = compareFor === b.key && compareError ? h("p", { class: "nw-cl-err-msg" }, `${tr(T.failed)}: ${compareError}`) : null;
    sideBody.replaceChildren(h("div", { class: "nw-cl-compare" }, intro, h("div", { class: "nw-cl-compare-run" }, run, progress), error, result));
  }

  function compareTable(r: CompareResult): HTMLElement {
    const fmt = (row: MetricRow) => `${row.value.toFixed(row.digits)}${row.unit ? ` ${row.unit}` : ""}`;
    const rows = r.builtin.rows.map((a) => {
      const m = r.mine.rows.find((x) => x.key === a.key);
      let diff: HTMLElement = h("td", {}, "—");
      if (m) {
        const d = m.value - a.value;
        const tol = Math.max(Math.abs(a.value), Math.abs(m.value)) * 0.01 + 10 ** -a.digits / 2;
        const rel = a.value !== 0 ? `${d > 0 ? "+" : "−"}${Math.abs((d / a.value) * 100).toFixed(0)}%` : "";
        const verdict = Math.abs(d) <= tol ? "same" : d < 0 ? "better" : "worse";
        diff = h(
          "td",
          { class: `nw-cl-diff nw-cl-diff--${verdict}` },
          verdict === "same" ? tr(T.same) : `${rel || `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(a.digits)}`} ${tr(T[verdict])}`,
        );
      }
      return h("tr", {}, h("th", { scope: "row" }, tr(a.label)), h("td", {}, fmt(a)), h("td", {}, m ? fmt(m) : "—"), diff);
    });
    return h(
      "div",
      { class: "nw-cl-compare-result" },
      h("p", { class: "nw-cl-scene" }, h("b", {}, `${tr(T.scene)}: `), tr(r.scene)),
      h(
        "p",
        { class: "nw-cl-scene" },
        h("b", {}, `${tr(T.builtin)}: `),
        `${tr(r.builtin.name)} (${r.builtin.id})`,
        h("br", {}),
        h("b", {}, `${tr(T.mine)}: `),
        tr(r.mine.name),
      ),
      h(
        "div",
        { class: "nw-md-scroll" },
        h(
          "table",
          { class: "nw-cl-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", { scope: "col" }, tr(T.metric)),
              h("th", { scope: "col", title: tr(r.builtin.name) }, tr(T.builtin)),
              h("th", { scope: "col", title: tr(r.mine.name) }, tr(T.mine)),
              h("th", { scope: "col" }, tr(T.diff)),
            ),
          ),
          h("tbody", {}, ...rows),
        ),
      ),
    );
  }

  function renderAll() {
    renderHead();
    renderSlots();
    renderBar();
    renderTabs();
    renderProblems();
    void renderSide();
  }

  /* ---------------- actions ---------------- */
  function valueOf(s: Selection): string {
    return s.type === "mine" ? `mine:${s.key}` : s.type === "page" ? `page:${s.src.path}#${s.src.id}` : "";
  }

  async function show(next: Selection) {
    sel = next;
    dirty = false;
    lastError = null;
    const token = ++loadToken;
    if (next.type === "page") {
      editor.set(tr(T.loading), false);
      const code = await pageSource(next.src.path).catch((e: Error) => `// ${e.message}`);
      if (token !== loadToken) return;
      editor.set(code, false);
    } else if (next.type === "mine") {
      editor.set(lab.block(next.key)?.code ?? "", true);
    } else editor.set("", false);
    renderBar();
    renderSlots();
    renderProblems();
    void renderSide();
  }

  /** What opens for a slot: the user's block running there, else the page's block in it. */
  function defaultSelection(): Selection {
    const id = runningBlocks()[slot];
    const key = id ? keyOf(id) : null;
    if (key && lab.block(key)) return { type: "mine", key };
    const page = sources.find((s) => s.kind === kind && s.id === id);
    if (page) return { type: "page", src: page };
    const mine = mineInSlot()[0];
    return mine ? { type: "mine", key: mine.key } : { type: "none", id: id ?? "" };
  }

  function selectSlot(s: string) {
    slot = s;
    compareResult = null;
    compareError = null;
    void show(defaultSelection());
  }

  function fork() {
    if (sel.type !== "page") return;
    const b = lab.fork(sel.src, editor.get());
    void show({ type: "mine", key: b.key }).then(() => editor.focus());
  }

  async function apply() {
    const b = currentMine();
    if (!b || busy) return;
    clearTimeout(saveTimer);
    lab.save(b.key, editor.get());
    busy = true;
    renderBar();
    const r = await lab.apply(b.key);
    busy = false;
    if (r.ok) {
      dirty = false;
      lastError = null;
      toast(tr(T.applied(nameOfMine(b))), "success");
    } else {
      lastError = r.error;
      toast(`${tr(T.phases[r.error.phase])} · ${tr(T.keptPrevious)}`, "error");
    }
    renderAll();
  }

  function removeMine() {
    const b = currentMine();
    if (!b || !confirm(tr(T.removeConfirm))) return;
    lab.remove(b.key);
    void show(defaultSelection());
  }

  async function runCompare() {
    const b = currentMine();
    if (!b || compareProgress !== null) return;
    if (dirty) lab.save(b.key, editor.get());
    compareFor = b.key;
    compareResult = null;
    compareError = null;
    compareProgress = 0;
    renderCompare();
    try {
      compareResult = await lab.compare(b.key, (f) => {
        compareProgress = f;
        const bar = sideBody.querySelector<HTMLElement>(".nw-cl-progress > span");
        if (bar) bar.style.width = `${Math.round(f * 100)}%`;
      });
    } catch (e) {
      compareError = e instanceof Error ? e.message : String(e);
    }
    compareProgress = null;
    if (tab === "compare" || tab === "code") renderCompare();
  }

  /** On a wide screen the code is always shown, so "code" only matters on a phone. */
  function setTab(t: Tab) {
    tab = t;
    renderTabs();
    void renderSide();
  }

  /* ---------------- open / close ---------------- */
  async function open(target: CodeLabTarget) {
    kind = target.kind;
    const blocks = runningBlocks();
    slot = target.slot ?? lastSlot[kind] ?? (kind === "simulator" ? "output" : "filter");
    if (!blocks[slot]) slot = core().slots.find((s) => blocks[s]) ?? slot;
    lastSlot[kind] = slot;
    if (!openNow) {
      openNow = true;
      // A phone shows one view at a time: the code first.
      if (matchMedia("(max-width: 820px)").matches && tab !== "compare") tab = "code";
      root.hidden = false;
      document.addEventListener("keydown", onKey, true);
      requestAnimationFrame(() => root.focus({ preventScroll: true }));
    }
    sources = await blockSources();
    renderAll();
    await show(defaultSelection());
  }
  const lastSlot: Partial<Record<CoreKind, string>> = {};

  function close() {
    if (!openNow) return;
    openNow = false;
    root.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    if (sel.type === "mine") lab.save(sel.key, editor.get());
  }

  function onKey(e: KeyboardEvent) {
    if (!openNow) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void apply();
      return;
    }
    // Esc inside the editor first closes its own popups (search, completions).
    if (e.key === "Escape" && !(e.target instanceof Element && e.target.closest(".cm-editor"))) {
      e.stopPropagation();
      close();
    }
    // The page's own shortcuts (tools, play/pause) stay off while typing here.
    if (e.target instanceof Node && root.contains(e.target) && !e.ctrlKey && !e.metaKey) e.stopPropagation();
  }

  /* ---------------- outside changes ---------------- */
  const offLab = lab.onEvent((e) => {
    if (e.type === "fallback") {
      const b = lab.block(e.key);
      if (sel.type === "mine" && sel.key === e.key) lastError = e.error;
      toast(`${b ? nameOfMine(b) : e.key}: ${tr(T.phases.runtime)} · ${tr(e.restored === "previous-version" ? T.fellBackVersion : T.fellBackBlock)}`, "error");
    }
    if (openNow) renderAll();
  });
  const offStore = store.subscribe((s, prev) => {
    if (!openNow) return;
    if (s.simulator !== prev.simulator || s.retargeter !== prev.retargeter || s.simulators !== prev.simulators || s.retargeters !== prev.retargeters) {
      renderHead();
      renderSlots();
      renderBar();
    }
  });
  const offLang = onLang(() => openNow && renderAll());

  const api: CodeLab = {
    open: (t) => void open(t),
    close,
    isOpen: () => openNow,
    ready: lab.ready,
    lab,
    destroy() {
      close();
      offLab();
      offStore();
      offLang();
      editor.destroy();
      root.remove();
      if (mounted === api) mounted = null;
    },
  };
  mounted = api;
  return api;
}

/** The dance chosen in the page when it is a captured one, else the first captured dance. */
async function loadTrack(s: AppState): Promise<Track | null> {
  const base = new URL(import.meta.env.BASE_URL, document.baseURI);
  const res = await fetch(new URL("dances/index.json", base));
  if (!res.ok) return null;
  const index = (await res.json()) as { id: string; file: string }[];
  const entry = index.find((e) => e.id === s.dance) ?? index[0];
  return entry ? fetchTrack(new URL(entry.file, base).href) : null;
}
