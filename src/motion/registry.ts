/** The retargeting blocks and retargeters (assemblies of blocks) the page can choose from: built-in ones register when
 *  the motion module starts, users' own from the code editor. */
import type { RetargeterInfo, RetargeterOptions, SimParameter } from "../contracts";
import type { Text } from "../i18n";
import { SLOTS, type BlockDefinition, type RetargeterDefinition, type Settings, type Slot } from "./api";

type Origin = RetargeterInfo["origin"];
const blocks = new Map<string, { def: BlockDefinition; origin: Origin }>();
const assemblies = new Map<string, { def: RetargeterDefinition; origin: Origin }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((cb) => cb());

/** What the page shows about a block. */
export interface RetargetBlockInfo {
  id: string;
  slot: Slot;
  name: Text;
  summary: Text;
  parameters: SimParameter[];
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
export function registerRetargetBlock<S extends Slot>(def: BlockDefinition<S>, origin: Origin = "user"): () => void {
  return register(blocks, def as unknown as BlockDefinition, origin);
}

/** Add (or replace, by id) a retargeter, an assembly of registered blocks. */
export function registerRetargeter(def: RetargeterDefinition, origin: Origin = "user"): () => void {
  return register(assemblies, def, origin);
}

export function onRetargetersChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listRetargetBlocks(): RetargetBlockInfo[] {
  return [...blocks.values()].map(({ def, origin }) => ({ id: def.id, slot: def.slot, name: def.name, summary: def.summary, parameters: def.parameters, origin }));
}

/** The retargeters, each with the parameters of all its blocks. */
export function listRetargeters(): RetargeterInfo[] {
  return [...assemblies.values()].map(({ def, origin }) => {
    const missing = SLOTS.map((s) => def.blocks[s]).filter((id) => !blocks.has(id));
    return {
      id: def.id, name: def.name, summary: def.summary, origin, device: "cpu",
      unavailable: missing.length ? { zh: `缺少模块：${missing.join("、")}`, en: `missing blocks: ${missing.join(", ")}` } : null,
      parameters: SLOTS.flatMap((s) => blocks.get(def.blocks[s])?.def.parameters ?? []),
    };
  });
}

export interface ResolvedBlock {
  def: BlockDefinition;
  settings: Settings;
}

/** The blocks of a retargeter, slot by slot, with their settings: every declared parameter from options.settings or
 *  its default. `blocks` swaps blocks in by slot (comparing one block against another in the same assembly). */
export function resolve(options: RetargeterOptions & { blocks?: Partial<Record<Slot, string>> }): Map<Slot, ResolvedBlock> {
  const assembly = assemblies.get(options.id)?.def;
  if (!assembly) throw new Error(`motion: no retargeter "${options.id}" (registered: ${[...assemblies.keys()].join(", ")})`);
  const out = new Map<Slot, ResolvedBlock>();
  for (const slot of SLOTS) {
    const id = options.blocks?.[slot] ?? assembly.blocks[slot];
    const def = blocks.get(id)?.def;
    if (!def) throw new Error(`motion: no block "${id}" for slot ${slot}`);
    if (def.slot !== slot) throw new Error(`motion: block "${id}" is a ${def.slot} block, not ${slot}`);
    const settings: Settings = {};
    for (const p of def.parameters) settings[p.key] = options.settings[p.key] ?? p.default;
    out.set(slot, { def, settings });
  }
  return out;
}

export function hasRetargeter(id: string): boolean {
  return assemblies.has(id);
}
