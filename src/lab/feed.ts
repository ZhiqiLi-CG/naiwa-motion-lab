/**
 * The conversation as a list of items, built from the server's events: the user's messages, Codex's messages, its
 * tool calls (one compact line each, updated in place from running to done), its plan, the artefacts it hands back,
 * and jobs (progress, log, Codex's steps inside, then the result). Pure: the panel renders whatever this holds.
 */
import type { Text } from "../i18n";
import type { Artifact, ChatEvent, JobEvent, JobResult, ToolStatus } from "./client";

export type StepItem =
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; tool: string; title: string; status: ToolStatus; output: string }
  | { kind: "plan"; key: string; items: { text: string; done: boolean }[] }
  | { kind: "artifact"; key: string; artifact: Artifact }
  | { kind: "error"; key: string; text: string };

export type FeedItem =
  | StepItem
  | { kind: "user"; key: string; text: string }
  | {
      kind: "job";
      key: string;
      run: string;
      name: Text | null;
      status: "running" | "done" | "failed" | "stopped";
      progress: number;
      log: string[];
      steps: StepItem[];
      result: JobResult | null;
      error: string | null;
    };

export interface Feed {
  items: FeedItem[];
  /** A chat turn is running. */
  busy: boolean;
  /** Counts turns, so Codex's per-turn item ids stay unique. */
  turn: number;
  seq: number;
}

export const emptyFeed = (): Feed => ({ items: [], busy: false, turn: 0, seq: 0 });

/** Put an item in (replacing the one with its key) and return the list. */
function upsert<T extends { key: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.key === item.key);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** A Codex event as a step, or null (thread/turn bookkeeping). */
function step(ev: ChatEvent, prefix: string, seq: number): StepItem | null {
  switch (ev.type) {
    case "message":
      return { kind: "assistant", key: `${prefix}${ev.id}`, text: ev.text };
    case "tool":
      return { kind: "tool", key: `${prefix}${ev.id}`, tool: ev.tool, title: ev.title, status: ev.status, output: ev.output };
    case "plan":
      return { kind: "plan", key: `${prefix}${ev.id}`, items: ev.items };
    case "artifact":
      return { kind: "artifact", key: `${prefix}a${seq}`, artifact: ev.artifact };
    case "error":
      return { kind: "error", key: `${prefix}e${seq}`, text: ev.text };
    case "turn":
      return ev.status === "failed" ? { kind: "error", key: `${prefix}f${seq}`, text: ev.error ?? "failed" } : null;
    default:
      return null;
  }
}

export function applyChat(feed: Feed, ev: ChatEvent): Feed {
  const seq = feed.seq + 1;
  if (ev.type === "user") {
    const turn = feed.turn + 1;
    return { ...feed, seq, turn, busy: true, items: [...feed.items, { kind: "user", key: `u${turn}`, text: ev.text }] };
  }
  if (ev.type === "end") {
    const items = ev.ok || ev.stopped || !ev.error ? feed.items : [...feed.items, { kind: "error" as const, key: `t${feed.turn}end`, text: ev.error }];
    // tools still marked running when the turn ended were cut off
    return { ...feed, seq, busy: false, items: items.map((x) => (x.kind === "tool" && x.status === "running" ? { ...x, status: "failed" as const } : x)) };
  }
  const s = step(ev, `t${feed.turn}:`, seq);
  return s ? { ...feed, seq, items: upsert(feed.items, s) } : { ...feed, seq };
}

const LOG_LINES = 200;

export function applyJob(feed: Feed, run: string, ev: JobEvent): Feed {
  const seq = feed.seq + 1;
  const key = `job:${run}`;
  const found = feed.items.find((x) => x.key === key);
  const job =
    found?.kind === "job"
      ? found
      : { kind: "job" as const, key, run, name: null, status: "running" as const, progress: 0, log: [], steps: [], result: null, error: null };
  let next: typeof job = job;
  switch (ev.type) {
    case "start":
      next = { ...job, name: ev.name };
      break;
    case "log":
      next = { ...job, log: [...job.log, ev.text].slice(-LOG_LINES) };
      break;
    case "progress":
      next = { ...job, progress: ev.value };
      break;
    case "codex": {
      const s = step(ev.ev, "", seq);
      next = s ? { ...job, steps: upsert(job.steps, s) } : job;
      break;
    }
    case "artifact":
      next = { ...job, steps: [...job.steps, { kind: "artifact", key: `a${seq}`, artifact: ev.artifact }] };
      break;
    case "done":
      next = { ...job, status: "done", progress: 1, result: ev.result, steps: job.steps.map((x) => (x.kind === "tool" && x.status === "running" ? { ...x, status: "failed" as const } : x)) };
      break;
    case "failed":
    case "stopped":
      next = { ...job, status: ev.type, error: ev.error, steps: job.steps.map((x) => (x.kind === "tool" && x.status === "running" ? { ...x, status: "failed" as const } : x)) };
      break;
  }
  return { ...feed, seq, items: upsert(feed.items, next) };
}

/** Before → after for each metric both sides have: the change and whether it got better (lower is better). */
export function metricRows(m: NonNullable<JobResult["metrics"]>): { key: string; before: number | null; after: number | null; verdict: "better" | "worse" | "same" | null }[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // numbers only: a job may pass other things along
  const keys = [...new Set([...Object.keys(m.before), ...Object.keys(m.after)])].filter((k) => n(m.before[k]) !== null || n(m.after[k]) !== null);
  return keys.map((key) => {
    const b = n(m.before[key]);
    const a = n(m.after[key]);
    if (b === null || a === null) return { key, before: b, after: a, verdict: null };
    const tol = Math.max(Math.abs(a), Math.abs(b)) * 0.02 + 1e-9;
    // how much it gives is a choice, not a score
    const neutral = /peak/.test(key);
    const verdict = Math.abs(a - b) <= tol || neutral ? "same" : a < b ? "better" : "worse";
    return { key, before: b, after: a, verdict: neutral ? null : verdict };
  });
}
