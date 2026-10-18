/**
 * The user's blocks and experiments, kept in this browser (localStorage). Storage can be blocked or full (private
 * windows, quotas): the lab keeps working for the visit and says that nothing is remembered.
 */
import type { CoreKind } from "./catalog";

/** A block the user wrote (forked from a page source). */
export interface UserBlock {
  /** Stable key; the block registers as `mine-<key>`. */
  key: string;
  kind: CoreKind;
  slot: string;
  /** Where it sits among the page's files ("sim/examples/smoothSurface.mine-x1.ts"): relative imports resolve from
   *  here, as they did in the file it was forked from. */
  path: string;
  /** The block it was forked from and that file. */
  from: { id: string; path: string };
  code: string;
  updated: number;
}

/** The user's experiment for one core: a registered assembly with some slots holding the user's blocks. */
export interface Experiment {
  /** The assembly the experiment starts from. */
  base: string;
  /** Slot → user block key. */
  slots: Record<string, string>;
}

export interface Saved {
  blocks: UserBlock[];
  experiments: Partial<Record<CoreKind, Experiment>>;
}

const KEY = "naiwa.labcode.v1";

export interface LabStorage {
  load(): Saved;
  /** false when it could not be saved. */
  save(s: Saved): boolean;
}

export const browserStorage: LabStorage = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      const s = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
      return { blocks: Array.isArray(s.blocks) ? s.blocks : [], experiments: s.experiments ?? {} };
    } catch {
      return { blocks: [], experiments: {} };
    }
  },
  save(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
      return true;
    } catch {
      return false;
    }
  },
};

/** Storage that forgets (tests, and pages that must not remember). */
export function memoryStorage(initial: Saved = { blocks: [], experiments: {} }): LabStorage {
  let s = structuredClone(initial);
  return { load: () => structuredClone(s), save: (next) => ((s = structuredClone(next)), true) };
}
