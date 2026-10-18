/** Talking to the local Lab server (lab/server.mjs): its status, its event stream, and plain JSON requests. */
import type { Text } from "../i18n";

export const DEFAULT_SERVER = "http://127.0.0.1:5170";

export interface CodexStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** How it is logged in, e.g. "ChatGPT". */
  how: string | null;
}
export interface ServerStatus {
  codex: CodexStatus;
  page: boolean;
  job: string | null;
}

/** What the page can do with Codex now. */
export type Availability =
  | { state: "ready"; status: ServerStatus }
  | { state: "no-server" }
  | { state: "not-installed"; status: ServerStatus }
  | { state: "logged-out"; status: ServerStatus };

export function availability(status: ServerStatus | null): Availability {
  if (!status) return { state: "no-server" };
  if (!status.codex.installed) return { state: "not-installed", status };
  if (!status.codex.loggedIn) return { state: "logged-out", status };
  return { state: "ready", status };
}

/** The short line the Lab panel shows when Codex cannot be used (null: show nothing, e.g. on the public site). */
export function availabilityNote(a: Availability, dev: boolean): Text | null {
  switch (a.state) {
    case "ready":
      return null;
    case "no-server":
      return dev ? { zh: "用 Codex 优化：在仓库里运行 node lab/server.mjs，再刷新页面。", en: "Optimise with Codex: run node lab/server.mjs in the repository, then reload." } : null;
    case "not-installed":
      return { zh: "没找到 Codex CLI：安装后运行 codex login，再刷新页面。", en: "Codex CLI not found: install it, run codex login, then reload." };
    case "logged-out":
      return { zh: "Codex CLI 还没登录：在终端运行 codex login，再刷新页面。", en: "Codex CLI is not logged in: run codex login in a terminal, then reload." };
  }
}

/** The server's address: ?lab=<port or URL>, else the default. */
export function serverUrl(search: string): string {
  const v = new URLSearchParams(search).get("lab");
  if (!v) return DEFAULT_SERVER;
  return /^\d+$/.test(v) ? `http://127.0.0.1:${v}` : v.replace(/\/$/, "");
}

export interface LabClient {
  readonly base: string;
  /** The status, or null when the server does not answer in time. */
  status(refresh?: boolean): Promise<ServerStatus | null>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  /** A repo file's URL (artefacts). */
  fileUrl(path: string): string;
  /** The event stream; this page runs the tool requests. */
  stream(onMessage: (msg: StreamMessage) => void, onState: (open: boolean) => void): () => void;
}

/** Messages on the stream (see lab/server.mjs). */
export type StreamMessage =
  | ({ ch: "hello"; convs: { id: string; busy: boolean }[] } & ServerStatus)
  | { ch: "tool"; id: string; action: string; args: Record<string, unknown>; owner: string | null }
  | { ch: "chat"; conv: string; ev: ChatEvent }
  | { ch: "job"; run: string; ev: JobEvent }
  | { ch: "artifact"; artifact: Artifact };

export type ToolStatus = "running" | "done" | "failed";
export type ChatEvent =
  | { type: "user"; text: string }
  | { type: "thread"; id: string }
  | { type: "turn"; status: "running" | "done" | "failed"; error?: string }
  | { type: "message"; id: string; role: "assistant"; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; tool: "page" | "shell" | "edit" | "mcp" | "search"; title: string; status: ToolStatus; exitCode: number | null; output: string }
  | { type: "plan"; id: string; items: { text: string; done: boolean }[] }
  | { type: "error"; id?: string; text: string }
  | { type: "artifact"; artifact: Artifact }
  | { type: "end"; ok: boolean; stopped: boolean; error: string | null };

export type JobEvent =
  | { type: "start"; job: string; name: Text; workdir: string }
  | { type: "log"; text: string }
  | { type: "progress"; value: number }
  | { type: "codex"; ev: ChatEvent }
  | { type: "artifact"; artifact: Artifact }
  | { type: "done"; result: JobResult }
  | { type: "failed" | "stopped"; error: string };

export type Artifact =
  | { kind: "preset"; data: Record<string, unknown>; title?: Text | string }
  | { kind: "dance" | "block" | "file"; path: string; title?: Text | string; name?: string; core?: "simulator" | "retargeter"; slot?: string; from?: { id: string; path: string } };

export interface JobResult {
  summary: Text;
  metrics?: { before: Record<string, number>; after: Record<string, number> };
  artifacts: Artifact[];
}

export interface JobInfo {
  id: string;
  name: Text;
  summary: Text;
}

export function createClient(base: string, timeoutMs = 1500): LabClient {
  const req = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const r = await fetch(base + path, init);
    const body = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`);
    return body;
  };
  return {
    base,
    async status(refresh = false) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await req<ServerStatus>(`/api/status${refresh ? "?refresh" : ""}`, { signal: ctrl.signal });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    get: (path) => req(path),
    post: (path, body) => req(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
    fileUrl: (path) => `${base}/api/file?path=${encodeURIComponent(path)}`,
    stream(onMessage, onState) {
      const es = new EventSource(`${base}/api/stream?page=1`);
      es.onopen = () => onState(true);
      es.onerror = () => onState(false);
      es.onmessage = (e) => {
        try {
          onMessage(JSON.parse(e.data as string) as StreamMessage);
        } catch (err) {
          console.warn("lab: bad message", err);
        }
      };
      return () => es.close();
    },
  };
}
