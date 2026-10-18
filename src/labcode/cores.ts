/** The two numerical cores as the code lab sees them: their slots, registries and register functions. */
import type { SimulatorInfo } from "../contracts";
import type { Text } from "../i18n";
import { SLOTS as RETARGET_SLOTS } from "../motion/api";
import * as motionRegistry from "../motion/registry";
import { SLOTS as SIM_SLOTS } from "../sim/api";
import * as simRegistry from "../sim/registry";
import type { CoreKind } from "./catalog";

/** A block definition of either core, as far as the lab needs to know it. */
export interface AnyBlockDefinition {
  id: string;
  slot: string;
  name: Text;
  summary: Text;
  parameters: { key: string }[];
  create(...args: never[]): unknown;
}

export interface AnyAssembly {
  id: string;
  name: Text;
  summary: Text;
  blocks: Record<string, string>;
}

export interface CoreAdapter {
  kind: CoreKind;
  slots: readonly string[];
  /** The page functions a user's module registers blocks and assemblies with. */
  blockFns: string[];
  assemblyFns: string[];
  registerBlock(def: AnyBlockDefinition, origin: "builtin" | "user"): () => void;
  registerAssembly(def: AnyAssembly, origin: "builtin" | "user"): () => void;
  /** Slot → block id of an assembly (a slot covered by another block is absent); null when it is not registered. */
  blocksOf(assembly: string): Record<string, string> | null;
  assemblies(): SimulatorInfo[];
  block(id: string): { name: Text; origin: "builtin" | "user" } | undefined;
  /** The slot's job, for the slot picker. */
  slotLabel(slot: string): Text;
}

const SIM_SLOT_LABELS: Record<string, Text> = {
  skeleton: { zh: "骨骼", en: "Skeleton" },
  flesh: { zh: "软体求解", en: "Flesh solver" },
  target: { zh: "目标形状", en: "Target shape" },
  coupling: { zh: "骨肉耦合", en: "Coupling" },
  collision: { zh: "碰撞", en: "Collision" },
  interaction: { zh: "交互", en: "Interaction" },
  output: { zh: "输出表面", en: "Output surface" },
  metrics: { zh: "质量指标", en: "Metrics" },
};

const RETARGET_SLOT_LABELS: Record<string, Text> = {
  filter: { zh: "滤波", en: "Filter" },
  constraints: { zh: "身体约束", en: "Constraints" },
  goal: { zh: "目标", en: "Goal" },
  solver: { zh: "求解器", en: "Solver" },
  output: { zh: "输出", en: "Output" },
};

function blocksOf(resolve: (o: { id: string; settings: Record<string, never> }) => Map<string, { def: { id: string } }>, id: string) {
  try {
    return Object.fromEntries([...resolve({ id, settings: {} })].map(([slot, r]) => [slot, r.def.id]));
  } catch {
    return null;
  }
}

export const CORES: Record<CoreKind, CoreAdapter> = {
  simulator: {
    kind: "simulator",
    slots: SIM_SLOTS,
    blockFns: ["registerBlock"],
    assemblyFns: ["registerSimulator"],
    registerBlock: (def, origin) => simRegistry.registerBlock(def as unknown as Parameters<typeof simRegistry.registerBlock>[0], origin),
    registerAssembly: (def, origin) => simRegistry.registerSimulator(def, origin),
    blocksOf: (id) => blocksOf(simRegistry.resolve as never, id),
    assemblies: simRegistry.listSimulators,
    block: (id) => simRegistry.listBlocks().find((b) => b.id === id),
    slotLabel: (slot) => SIM_SLOT_LABELS[slot] ?? { zh: slot, en: slot },
  },
  retargeter: {
    kind: "retargeter",
    slots: RETARGET_SLOTS,
    blockFns: ["registerRetargetBlock"],
    assemblyFns: ["registerRetargeter"],
    registerBlock: (def, origin) => motionRegistry.registerRetargetBlock(def as unknown as Parameters<typeof motionRegistry.registerRetargetBlock>[0], origin),
    registerAssembly: (def, origin) => motionRegistry.registerRetargeter(def as Parameters<typeof motionRegistry.registerRetargeter>[0], origin),
    blocksOf: (id) => blocksOf(motionRegistry.resolve as never, id),
    assemblies: motionRegistry.listRetargeters,
    block: (id) => motionRegistry.listRetargetBlocks().find((b) => b.id === id),
    slotLabel: (slot) => RETARGET_SLOT_LABELS[slot] ?? { zh: slot, en: slot },
  },
};

/** Something a module exported or registered that looks like a block definition. */
export function isBlockDefinition(x: unknown): x is AnyBlockDefinition {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.slot === "string" && typeof d.create === "function";
}

export function isAssembly(x: unknown): x is AnyAssembly {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.blocks === "object" && d.blocks !== null;
}
