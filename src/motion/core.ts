/**
 * The retargeting core: builds a retargeter's blocks (api.ts) in slot order and runs them, frame by frame:
 *
 *   person frame ─ filter ─ goal ─┐                     (live; a recording is filtered once, before it plays)
 *                                 ├─ solver ─ output ─→ PoseFrame, and the metrics
 *   procedural dance ─────────────┘
 *
 * One pipeline per motion source: blocks keep state (the filter's past, the heading's unwrapping, faces easing in).
 */
import type { PoseFrame, RetargeterOptions } from "../contracts";
import { SLOTS, type Goal, type PersonFrame, type Recording, type RetargetMetrics, type Scene, type Settings, type Slot, type SlotBlocks } from "./api";
import { MetricsWindow } from "./metrics";
import { mirrorPose } from "./pose";
import { resolve, type ResolvedBlock } from "./registry";
import type { Binding } from "./rig";

export interface RetargetPipeline {
  readonly options: RetargeterOptions;
  readonly scene: Scene;
  /** A live person frame at time t (s), dt after the previous one: filtered, then turned into a goal (null: nobody
   *  usable). `mirror`: a selfie view, the person's left drives the frog's right. */
  live(frame: PersonFrame, t: number, dt: number, mirror: boolean): Goal | null;
  /** A whole recording, filtered (before it plays). */
  recorded(frames: PersonFrame[], fps: number): PersonFrame[];
  /** A frame of an already filtered recording, dt after the previous one. */
  goal(frame: PersonFrame, dt: number, mirror: boolean): Goal | null;
  /** The frog's pose target for a goal, shown dt after the previous one. */
  pose(goal: Goal, dt: number): PoseFrame;
  /** New values for the parameters, applied live; false when a block cannot take them so (rebuild the pipeline). */
  setSettings(settings: Settings): boolean;
  /** The person was lost or the source restarted: every block forgets the past. */
  reset(): void;
  /** Quality over the last two seconds (null before the first frame). */
  metrics(): RetargetMetrics | null;
}

/**
 * Build a retargeter for the bound rig. options.blocks swaps blocks by slot; settings are matched to the blocks'
 * declared parameters by key. `recording`: what a recorded source knows of the whole take.
 */
export function createRetargetPipeline(
  rig: Binding,
  options: RetargeterOptions & { blocks?: Partial<Record<Slot, string>> },
  recording: Recording | null = null,
): RetargetPipeline {
  let resolved = resolve(options);
  const blocks: Partial<SlotBlocks> = {};
  const block = <S extends Slot>(slot: S): SlotBlocks[S] => {
    const b = blocks[slot];
    if (!b) throw new Error(`motion: no ${slot} block yet (blocks are built in slot order)`);
    return b as SlotBlocks[S];
  };
  const scene: Scene = {
    rig,
    recording,
    get filter() { return block("filter"); },
    get constraints() { return block("constraints"); },
    get goal() { return block("goal"); },
    get solver() { return block("solver"); },
  };
  for (const slot of SLOTS) {
    const r = resolved.get(slot)!;
    (blocks as Record<Slot, unknown>)[slot] = r.def.create(scene, r.settings);
  }
  const b = blocks as SlotBlocks;
  const metrics = new MetricsWindow(rig);
  const view = (goal: Goal | null, mirror: boolean) => (goal && mirror ? mirrorPose(goal) : goal);
  let current: RetargeterOptions = { id: options.id, settings: { ...options.settings } };

  return {
    get options() { return current; },
    scene,
    live: (frame, t, dt, mirror) => view(b.goal.goal(b.filter.live(frame, t), dt), mirror),
    recorded: (frames, fps) => b.filter.recorded(frames, fps),
    goal: (frame, dt, mirror) => view(b.goal.goal(frame, dt), mirror),
    pose(goal, dt) {
      const frog = b.solver.solve(goal);
      const frame = b.output.pose(frog);
      metrics.add(goal, frog, frame, dt, b.constraints);
      return frame;
    },
    setSettings(settings) {
      const next = resolve({ ...options, settings });
      const changed = SLOTS.filter((s) => !sameSettings(resolved.get(s)!, next.get(s)!.settings));
      const live = changed.every((s) => {
        const r = resolved.get(s)!;
        return b[s].setSettings && !r.def.parameters.some((p) => p.rebuild && r.settings[p.key] !== next.get(s)!.settings[p.key]);
      });
      if (!live) return false;
      for (const s of changed) b[s].setSettings!(next.get(s)!.settings);
      resolved = next;
      current = { id: options.id, settings: { ...settings } };
      return true;
    },
    reset() {
      for (const s of SLOTS) b[s].reset?.();
      metrics.reset();
    },
    metrics: () => metrics.read(),
  };
}

function sameSettings(a: ResolvedBlock, next: Settings): boolean {
  return a.def.parameters.every((p) => a.settings[p.key] === next[p.key]);
}
