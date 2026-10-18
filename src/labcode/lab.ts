/**
 * The code lab's engine (no DOM): the user's blocks, compiled and loaded as modules of the page, tried off screen,
 * then hot-swapped into the running simulation or retargeter as one slot of "My experiment" (the assembly that was
 * running, with the user's blocks in some slots). A block that fails to compile, load, build or run never reaches
 * the page or is taken out of it again: the previous version of the block (or the previous assembly) comes back and
 * the error is reported with where in the user's code it happened.
 */
import type { PhysicsParams, RigSpec, SimulatorOptions } from "../contracts";
import type { Text } from "../i18n";
import type { Binding } from "../motion/rig";
import type { Track } from "../motion/track";
import type { BlockSource, CoreKind } from "./catalog";
import type { SourceProblem } from "./compile";
import { CORES, isAssembly, isBlockDefinition, type AnyAssembly, type AnyBlockDefinition } from "./cores";
import { guarded } from "./guard";
import { LoadError, loadUserModule, lineProblem, locate, userStack, type LoadedModule } from "./loader";
import { measureRetarget, measureSim, trialRetarget, trialSim, type MetricRow } from "./runs";
import type { Experiment, LabStorage, Saved, UserBlock } from "./storage";

/** What the lab needs from the page. */
export interface LabHost {
  /** The simulator / retargeter running now, and switching to another one (the page rebuilds it). */
  current(kind: CoreKind): SimulatorOptions;
  choose(kind: CoreKind, options: SimulatorOptions): void;
  /** The frog's rig for the simulation, the bound rig for motion transfer, the physics sliders (null: not loaded yet,
   *  the off-screen trial is skipped). */
  spec(): RigSpec | null;
  params(): PhysicsParams;
  binding(): Binding | null;
  /** A dance track to try and compare retargeting blocks on (null: a procedural dance is used). */
  track(): Promise<Track | null>;
}

export type LabPhase = "compile" | "load" | "check" | "trial" | "runtime";

export interface LabError {
  phase: LabPhase;
  message: string;
  /** Where in the user's code, when known. */
  problems: SourceProblem[];
  stack?: string;
}

export type LabEvent =
  | { type: "applied"; kind: CoreKind; key: string }
  | { type: "fallback"; kind: CoreKind; key: string; error: LabError; restored: "previous-version" | "previous-block" }
  | { type: "changed" };

export type ApplyResult = { ok: true } | { ok: false; error: LabError };

export interface CompareResult {
  slot: string;
  /** The block in that slot of the base assembly, and the user's. */
  builtin: { id: string; name: Text; rows: MetricRow[] };
  mine: { id: string; name: Text; rows: MetricRow[] };
  /** What it ran on. */
  scene: Text;
}

export const LAB_ASSEMBLY: Record<CoreKind, string> = { simulator: "lab-simulator", retargeter: "lab-retargeter" };
export const labBlockId = (key: string) => `mine-${key}`;

interface Live {
  /** The registered (guarded) definition and what else its module registered. */
  def: AnyBlockDefinition;
  name: Text;
  undo: () => void;
  version: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface Lab {
  /** Resolves when the saved experiments are loaded and registered again. */
  readonly ready: Promise<void>;
  blocks(kind?: CoreKind): UserBlock[];
  block(key: string): UserBlock | undefined;
  /** A new block of the user's, a copy of a page source; saved. */
  fork(source: BlockSource, code: string): UserBlock;
  /** Keep edited code (not applied). false: this browser could not save it. */
  save(key: string, code: string): boolean;
  remove(key: string): void;
  /** Compile, load, try, then swap the block into its slot of the running core. */
  apply(key: string): Promise<ApplyResult>;
  /** Put the base assembly's block back into a slot. */
  restore(kind: CoreKind, slot: string): void;
  experiment(kind: CoreKind): Experiment | undefined;
  /** The base assembly an experiment in this core would start from now. */
  base(kind: CoreKind): string;
  /** The name of the user's block as its code declares it (once loaded), else null. */
  nameOf(key: string): Text | null;
  compare(key: string, progress?: (f: number) => void): Promise<CompareResult>;
  /** Whether storage works (false: blocks last for this visit only). */
  persistent(): boolean;
  onEvent(cb: (e: LabEvent) => void): () => void;
}

export function createLab(host: LabHost, storage: LabStorage): Lab {
  const saved: Saved = storage.load();
  let persistent = true;
  const live = new Map<string, Live>();
  /** A runtime failure seen for this key and version already (one fallback per failure). */
  const failed = new Set<string>();
  /** Per key: the version before the last apply and the options running before it, to fall back to. */
  const history = new Map<string, { before: SimulatorOptions; previous: Live | null }>();
  const listeners = new Set<(e: LabEvent) => void>();
  const emit = (e: LabEvent) => listeners.forEach((l) => l(e));
  let versions = 0;

  const persist = () => {
    persistent = storage.save(saved);
    return persistent;
  };
  const find = (key: string) => saved.blocks.find((b) => b.key === key);
  const fileName = (b: UserBlock) => b.path.split("/").pop()!;

  function base(kind: CoreKind): string {
    const exp = saved.experiments[kind];
    const cur = host.current(kind).id;
    if (cur === LAB_ASSEMBLY[kind]) return exp?.base ?? cur;
    return CORES[kind].blocksOf(cur) ? cur : (exp?.base ?? cur);
  }

  /** The block ids of the experiment, slot by slot: the base assembly with the user's blocks swapped in. */
  function experimentBlocks(kind: CoreKind, exp: Experiment): Record<string, string> {
    const blocks = { ...(CORES[kind].blocksOf(exp.base) ?? {}) };
    for (const [slot, key] of Object.entries(exp.slots)) if (live.has(key)) blocks[slot] = labBlockId(key);
    return blocks;
  }

  /** Register "My experiment" for the core as it stands (or remove it when no slot holds a user block). */
  let assemblyUndo: Partial<Record<CoreKind, () => void>> = {};
  function registerExperiment(kind: CoreKind) {
    const exp = saved.experiments[kind];
    assemblyUndo[kind]?.();
    assemblyUndo[kind] = undefined;
    if (!exp || !Object.values(exp.slots).some((k) => live.has(k))) return;
    const core = CORES[kind];
    const baseInfo = core.assemblies().find((a) => a.id === exp.base);
    const mine = Object.entries(exp.slots).filter(([, k]) => live.has(k));
    const list = (lang: "zh" | "en") => mine.map(([slot, k]) => `${core.slotLabel(slot)[lang]}${lang === "zh" ? "：" : ": "}${live.get(k)!.name[lang]}`).join(lang === "zh" ? "；" : "; ");
    const def: AnyAssembly = {
      id: LAB_ASSEMBLY[kind],
      name: { zh: "我的实验", en: "My experiment" },
      summary: {
        zh: `基于「${baseInfo?.name.zh ?? exp.base}」，换上我的模块：${list("zh")}。`,
        en: `${baseInfo?.name.en ?? exp.base} with my blocks: ${list("en")}.`,
      },
      blocks: experimentBlocks(kind, exp),
    };
    assemblyUndo[kind] = core.registerAssembly(def, "user");
  }

  /** The experiment's options, a new object so the page rebuilds even when the id stays. */
  const experimentOptions = (kind: CoreKind): SimulatorOptions => {
    const cur = host.current(kind);
    return { id: LAB_ASSEMBLY[kind], settings: { ...cur.settings } };
  };

  function errorOf(e: unknown, b: UserBlock, phase: LabPhase): LabError {
    if (e instanceof LoadError) return { phase: e.phase, message: e.message, problems: e.problems };
    const err = e instanceof Error ? e : new Error(String(e));
    const at = locate(err);
    const problems = at && at.source.path === b.path ? [lineProblem(b.code, at.line, at.column, err.message)] : [];
    return { phase, message: phase === "check" ? err.message : `${err.name}: ${err.message}`, problems, stack: phase === "check" ? undefined : userStack(err) };
  }

  /** The block the module defines for the slot: one it registered or exported (the one forked from first). */
  function definitionIn(mod: LoadedModule, b: UserBlock): { def: AnyBlockDefinition; others: AnyBlockDefinition[]; assemblies: AnyAssembly[] } | string {
    const core = CORES[b.kind];
    const defs: AnyBlockDefinition[] = [];
    const assemblies: AnyAssembly[] = [];
    for (const r of mod.registered) {
      if (core.blockFns.includes(r.fn) && isBlockDefinition(r.def) && !defs.includes(r.def)) defs.push(r.def);
      if (core.assemblyFns.includes(r.fn) && isAssembly(r.def)) assemblies.push(r.def);
    }
    for (const v of Object.values(mod.exports)) if (isBlockDefinition(v) && !defs.includes(v)) defs.push(v);
    const inSlot = defs.filter((d) => d.slot === b.slot);
    const def = inSlot.find((d) => d.id === b.from.id) ?? inSlot[0];
    if (!def) {
      const found = defs.map((d) => `${d.id} (${d.slot})`).join(", ");
      return `No ${b.slot} block found: export a BlockDefinition<"${b.slot}"> or register one${found ? ` (found: ${found})` : ""}`;
    }
    if (!core.slots.includes(def.slot)) return `"${def.slot}" is not a slot of the ${b.kind}`;
    for (const k of ["name", "summary"] as const) {
      const t = def[k] as Partial<Text> | undefined;
      if (typeof t?.zh !== "string" || typeof t?.en !== "string") return `The block's ${k} must be { zh, en }`;
    }
    if (!Array.isArray(def.parameters)) return "The block's parameters must be an array (it may be empty)";
    // Other blocks it registered itself stay available to its own assemblies.
    return { def, others: defs.filter((d) => d !== def && mod.registered.some((r) => r.def === d)), assemblies };
  }

  /** Register the module's block (and what else it registered) under the lab's ids; returns how to take it out. */
  function install(b: UserBlock, found: Exclude<ReturnType<typeof definitionIn>, string>, id: string, version: number): Live {
    const core = CORES[b.kind];
    const ids = new Map<string, string>([[found.def.id, id]]);
    for (const d of found.others) ids.set(d.id, `${id}-${d.id}`);
    const report = (err: Error) => runtimeError(b.key, version, err);
    const undo = [
      core.registerBlock(guarded(found.def, id, report), "user"),
      ...found.others.map((d) => core.registerBlock(guarded(d, ids.get(d.id)!, report), "user")),
      ...found.assemblies.map((a) =>
        core.registerAssembly({ ...a, blocks: Object.fromEntries(Object.entries(a.blocks).map(([s, x]) => [s, ids.get(x) ?? x])) }, "user"),
      ),
    ];
    return { def: found.def, name: found.def.name, undo: () => undo.forEach((u) => u()), version };
  }

  async function load(b: UserBlock) {
    const mod = await loadUserModule({ name: fileName(b), path: b.path, lang: "ts", code: b.code });
    const found = definitionIn(mod, b);
    if (typeof found === "string") throw Object.assign(new Error(found), { phase: "check" as const });
    return found;
  }

  async function trial(kind: CoreKind, options: SimulatorOptions, blocks: Record<string, string>) {
    if (kind === "simulator") {
      const spec = host.spec();
      if (spec) await trialSim(spec, host.params(), options, blocks);
    } else {
      const rig = host.binding();
      if (rig) trialRetarget(rig, options, blocks, await host.track().catch(() => null));
    }
  }

  function runtimeError(key: string, version: number, err: Error) {
    const l = live.get(key);
    const id = `${key}@${version}`;
    if (!l || l.version !== version || failed.has(id)) return;
    failed.add(id);
    console.error(`labcode: my block ${key} failed, back to the previous block
${userStack(err)}`);
    // After the frame that threw: the page is not rebuilt from inside its own step.
    queueMicrotask(() => fallback(key, err));
  }

  function fallback(key: string, err: Error) {
    const b = find(key);
    const l = live.get(key);
    if (!b || !l) return;
    const kind = b.kind;
    const h = history.get(key);
    const error = errorOf(err, b, "runtime");
    l.undo();
    live.delete(key);
    if (h?.previous) {
      // The version before this one goes back into the slot.
      const prev = h.previous;
      const core = CORES[kind];
      const report = (e: Error) => runtimeError(key, prev.version, e);
      const undo = core.registerBlock(guarded(prev.def, labBlockId(key), report), "user");
      live.set(key, { ...prev, undo });
      history.set(key, { before: h.before, previous: null });
      registerExperiment(kind);
      host.choose(kind, experimentOptions(kind));
      emit({ type: "fallback", kind, key, error, restored: "previous-version" });
      return;
    }
    // No earlier version: the slot gets the base assembly's block back, and the page what ran before.
    const exp = saved.experiments[kind];
    if (exp) delete exp.slots[b.slot];
    if (exp && !Object.keys(exp.slots).length) delete saved.experiments[kind];
    registerExperiment(kind);
    persist();
    const before = h?.before ?? { id: exp?.base ?? base(kind), settings: {} };
    if (before.id !== LAB_ASSEMBLY[kind]) host.choose(kind, { id: before.id, settings: { ...before.settings } });
    else if (saved.experiments[kind]) host.choose(kind, experimentOptions(kind));
    else host.choose(kind, { id: exp?.base ?? base(kind), settings: { ...before.settings } });
    emit({ type: "fallback", kind, key, error, restored: "previous-block" });
  }

  async function apply(key: string): Promise<ApplyResult> {
    const b = find(key);
    if (!b) return { ok: false, error: { phase: "check", message: `no block ${key}`, problems: [] } };
    const kind = b.kind;
    const core = CORES[kind];
    let found: Awaited<ReturnType<typeof load>>;
    try {
      found = await load(b);
    } catch (e) {
      return { ok: false, error: errorOf(e, b, (e as { phase?: LabPhase }).phase ?? "load") };
    }
    const from = base(kind);
    const exp: Experiment = saved.experiments[kind]?.base === from ? saved.experiments[kind]! : { base: from, slots: {} };
    if (!core.blocksOf(from)) return { ok: false, error: { phase: "check", message: `${kind} "${from}" is not registered`, problems: [] } };

    // Off screen first, under a trial id.
    const version = ++versions;
    const trialId = `${labBlockId(key)}-trial${version}`;
    let trialError: Error | null = null;
    const probe = install(b, found, trialId, -1);
    const blocks = { ...experimentBlocks(kind, exp), [b.slot]: trialId };
    try {
      await trial(kind, { id: from, settings: host.current(kind).settings }, blocks);
    } catch (e) {
      trialError = e instanceof Error ? e : new Error(msg(e));
    } finally {
      probe.undo();
    }
    if (trialError) return { ok: false, error: errorOf(trialError, b, "trial") };

    // Into the page.
    const before = host.current(kind);
    const previous = live.get(key) ?? null;
    previous?.undo();
    live.set(key, install(b, found, labBlockId(key), version));
    history.set(key, { before: previous ? (history.get(key)?.before ?? before) : before, previous });
    exp.slots[b.slot] = key;
    // Another of the user's blocks in this slot leaves it.
    for (const k of Object.keys(exp.slots)) if (k !== b.slot && exp.slots[k] === key) delete exp.slots[k];
    saved.experiments[kind] = exp;
    registerExperiment(kind);
    persist();
    host.choose(kind, experimentOptions(kind));
    emit({ type: "applied", kind, key });
    return { ok: true };
  }

  function restore(kind: CoreKind, slot: string) {
    const exp = saved.experiments[kind];
    const key = exp?.slots[slot];
    if (!exp || !key) return;
    delete exp.slots[slot];
    const running = host.current(kind).id === LAB_ASSEMBLY[kind];
    const empty = !Object.keys(exp.slots).length;
    if (empty) delete saved.experiments[kind];
    registerExperiment(kind);
    if (running) host.choose(kind, empty ? { id: exp.base, settings: { ...host.current(kind).settings } } : experimentOptions(kind));
    live.get(key)?.undo();
    live.delete(key);
    persist();
    emit({ type: "changed" });
  }

  /** Load the saved experiments again (no trial: the page may not have its rig yet; the guards still hold). */
  async function restoreSaved() {
    for (const kind of Object.keys(saved.experiments) as CoreKind[]) {
      const exp = saved.experiments[kind]!;
      if (!CORES[kind].blocksOf(exp.base)) {
        delete saved.experiments[kind];
        continue;
      }
      for (const [slot, key] of Object.entries(exp.slots)) {
        const b = find(key);
        try {
          if (!b) throw new Error("missing");
          live.set(key, install(b, await load(b), labBlockId(key), ++versions));
        } catch (e) {
          console.warn(`labcode: my block ${key} did not load again, the slot keeps its built-in block`, e);
          delete exp.slots[slot];
        }
      }
      registerExperiment(kind);
    }
  }

  const ready = restoreSaved().catch((e) => console.warn("labcode: saved experiments", e));

  return {
    ready,
    blocks: (kind) => saved.blocks.filter((b) => !kind || b.kind === kind),
    block: find,
    fork(source, code) {
      const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const dir = source.path.split("/").slice(0, -1).join("/");
      const stem = source.path.split("/").pop()!.replace(/\.ts$/, "");
      const b: UserBlock = {
        key, kind: source.kind, slot: source.slot, path: `${dir}/${stem}.mine-${key}.ts`, from: { id: source.id, path: source.path }, code, updated: Date.now(),
      };
      saved.blocks.push(b);
      persist();
      emit({ type: "changed" });
      return b;
    },
    save(key, code) {
      const b = find(key);
      if (!b) return false;
      b.code = code;
      b.updated = Date.now();
      return persist();
    },
    remove(key) {
      const b = find(key);
      if (!b) return;
      if (saved.experiments[b.kind]?.slots[b.slot] === key) restore(b.kind, b.slot);
      saved.blocks = saved.blocks.filter((x) => x.key !== key);
      live.get(key)?.undo();
      live.delete(key);
      persist();
      emit({ type: "changed" });
    },
    apply,
    restore,
    experiment: (kind) => saved.experiments[kind],
    base,
    nameOf: (key) => live.get(key)?.name ?? null,
    async compare(key, progress) {
      const b = find(key);
      if (!b) throw new Error(`no block ${key}`);
      const kind = b.kind;
      const from = base(kind);
      const exp = saved.experiments[kind];
      const builtinBlocks = CORES[kind].blocksOf(from);
      if (!builtinBlocks) throw new Error(`${kind} "${from}" is not registered`);
      const builtinId = builtinBlocks[b.slot] ?? b.from.id;
      // The other slots as the page runs them: the user's other blocks stay in.
      const rest = exp?.base === from ? experimentBlocks(kind, exp) : { ...builtinBlocks };
      let mineId = labBlockId(key);
      let probe: Live | null = null;
      if (!live.has(key)) {
        // Not applied: load it for the comparison only.
        const found = await load(b);
        mineId = `${labBlockId(key)}-compare`;
        probe = install(b, found, mineId, -1);
      }
      const options = { id: from, settings: host.current(kind).settings };
      try {
        if (kind === "simulator") {
          const spec = host.spec();
          if (!spec) throw new Error("the frog is not loaded yet");
          const params = host.params();
          const a = await measureSim(spec, params, options, { ...rest, [b.slot]: builtinId }, (f) => progress?.(f / 2));
          const m = await measureSim(spec, params, options, { ...rest, [b.slot]: mineId }, (f) => progress?.(0.5 + f / 2));
          return {
            slot: b.slot,
            builtin: { id: builtinId, name: CORES[kind].block(builtinId)?.name ?? { zh: builtinId, en: builtinId }, rows: a },
            mine: { id: mineId, name: probe?.name ?? live.get(key)!.name, rows: m },
            scene: { zh: "自由模式：静止落下，1 秒时戳肚子，2 秒时扔球，之后静置；共 4 秒", en: "Free mode: dropped from rest, a poke on the belly at 1 s, a ball at 2 s, then left to settle; 4 s" },
          };
        }
        const rig = host.binding();
        if (!rig) throw new Error("the frog is not loaded yet");
        const track = await host.track().catch(() => null);
        progress?.(0.1);
        const a = measureRetarget(rig, options, { ...rest, [b.slot]: builtinId }, b.slot, track);
        progress?.(0.5);
        const m = measureRetarget(rig, options, { ...rest, [b.slot]: mineId }, b.slot, track);
        progress?.(1);
        return {
          slot: b.slot,
          builtin: { id: builtinId, name: CORES[kind].block(builtinId)?.name ?? { zh: builtinId, en: builtinId }, rows: a },
          mine: { id: mineId, name: probe?.name ?? live.get(key)!.name, rows: m },
          scene: track
            ? { zh: `舞蹈「${track.name}」，60 fps 播放 6 秒`, en: `The dance "${track.nameEn ?? track.name}", 6 s at 60 fps` }
            : { zh: "程序舞蹈，60 fps 播放 6 秒", en: "A procedural dance, 6 s at 60 fps" },
        };
      } finally {
        probe?.undo();
      }
    },
    persistent: () => persistent,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
