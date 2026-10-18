/** The blocks and simulators (assemblies of blocks) the page can choose from: built-in ones register at load, users'
 *  own from the code editor. */
import type { SimParameter, SimulatorInfo, SimulatorOptions } from "../contracts";
import type { Text } from "../i18n";
import { SLOTS, type AssemblyDefinition, type BlockDefinition, type Settings, type Slot } from "./api";

type Origin = SimulatorInfo["origin"];
const blocks = new Map<string, { def: BlockDefinition; origin: Origin }>();
const assemblies = new Map<string, { def: AssemblyDefinition; origin: Origin }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((cb) => cb());

/** What the page shows about a block. */
export interface BlockInfo {
  id: string;
  slot: Slot;
  name: Text;
  summary: Text;
  device: "cpu" | "gpu";
  parameters: SimParameter[];
  covers: Slot[];
  unavailable: Text | null;
  origin: Origin;
}

function register<T extends { id: string }>(map: Map<string, { def: T; origin: Origin }>, def: T, origin: Origin) {
  const entry = { def, origin };
  map.set(def.id, entry);
  changed();
  return () => {
    if (map.get(def.id) !== entry) return;
    map.delete(def.id);
    changed();
  };
}

/** Add (or replace, by id) a block. Returns a function that removes it again. */
export function registerBlock<S extends Slot>(def: BlockDefinition<S>, origin: Origin = "user"): () => void {
  return register(blocks, def as unknown as BlockDefinition, origin);
}

/** Add (or replace, by id) a simulator, an assembly of registered blocks. */
export function registerSimulator(def: AssemblyDefinition, origin: Origin = "user"): () => void {
  return register(assemblies, def, origin);
}

export function onSimulatorsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listBlocks(): BlockInfo[] {
  return [...blocks.values()].map(({ def, origin }) => ({
    id: def.id, slot: def.slot, name: def.name, summary: def.summary, device: def.device, parameters: def.parameters,
    covers: def.covers ?? [], unavailable: def.available?.() ?? null, origin,
  }));
}

/** The simulators, each with the parameters of all its blocks (their keys are unique within an assembly). */
export function listSimulators(): SimulatorInfo[] {
  return [...assemblies.values()].map(({ def, origin }) => {
    const used = SLOTS.map((s) => def.blocks[s]).filter((id): id is string => !!id).map((id) => blocks.get(id)?.def);
    const missing = SLOTS.map((s) => def.blocks[s]).filter((id) => id && !blocks.has(id));
    const unavailable: Text | null = missing.length
      ? { zh: `缺少模块：${missing.join("、")}`, en: `missing blocks: ${missing.join(", ")}` }
      : used.map((b) => b?.available?.() ?? null).find((u) => u) ?? null;
    return {
      id: def.id, name: def.name, summary: def.summary, origin, unavailable,
      backend: used.map((b) => b?.backend?.() ?? null).find((b) => b) ?? null,
      device: used.some((b) => b?.device === "gpu") ? "gpu" : "cpu",
      parameters: used.flatMap((b) => b?.parameters ?? []),
    };
  });
}

export interface ResolvedBlock {
  def: BlockDefinition;
  settings: Settings;
}

/** The blocks of a simulator, slot by slot (a slot covered by an earlier block is absent), with their settings: every
 *  declared parameter from options.settings or its default. `blocks` swaps blocks in by slot. */
export function resolve(options: SimulatorOptions & { blocks?: Partial<Record<Slot, string>> }): Map<Slot, ResolvedBlock> {
  const assembly = assemblies.get(options.id)?.def;
  if (!assembly) throw new Error(`sim: no simulator "${options.id}" (registered: ${[...assemblies.keys()].join(", ")})`);
  const out = new Map<Slot, ResolvedBlock>();
  const covered = new Set<Slot>();
  for (const slot of SLOTS) {
    if (covered.has(slot)) continue;
    const id = options.blocks?.[slot] ?? assembly.blocks[slot];
    if (!id) throw new Error(`sim: simulator "${assembly.id}" has no ${slot} block`);
    const def = blocks.get(id)?.def;
    if (!def) throw new Error(`sim: no block "${id}" for slot ${slot}`);
    if (def.slot !== slot) throw new Error(`sim: block "${id}" is a ${def.slot} block, not ${slot}`);
    const settings: Settings = {};
    for (const p of def.parameters) settings[p.key] = options.settings[p.key] ?? p.default;
    out.set(slot, { def, settings });
    for (const c of def.covers ?? []) covered.add(c);
  }
  return out;
}
