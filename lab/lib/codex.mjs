/**
 * The Codex CLI: find it, ask whether it is installed and logged in, and run `codex exec --json` turns (new or resumed
 * threads) whose JSONL events stream to a callback. Windows-safe: the executable is spawned directly (a .cmd shim
 * through cmd.exe), the prompt goes through stdin (no quoting, CRLF or length limits), paths may contain spaces, and
 * stopping kills the whole process tree.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";

/** The codex executable: $NAIWA_CODEX, else the first codex on PATH, else the desktop installer's location. */
export function findCodex(env = process.env) {
  if (env.NAIWA_CODEX) return existsSync(env.NAIWA_CODEX) ? env.NAIWA_CODEX : null;
  const names = WIN ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (WIN && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"));
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir.replace(/^"|"$/g, ""), n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Spawn the executable with args. A .cmd/.bat shim needs cmd.exe; its args are simple flags here (the prompt goes
 *  through stdin), quoted for cmd. */
export function spawnCodex(exe, args, opts = {}) {
  if (WIN && /\.(cmd|bat)$/i.test(exe)) {
    const q = (s) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return spawn([q(exe), ...args.map(q)].join(" "), { ...opts, shell: true, windowsHide: true });
  }
  return spawn(exe, args, { ...opts, windowsHide: true, detached: !WIN });
}

/** Kill a process and everything it started (codex runs shells that run node…). */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

/** Run a short command and collect its output. */
export function runQuick(exe, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawnCodex(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out, err: String(e) });
      return;
    }
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** "codex-cli 0.155.1" → "0.155.1". */
export function parseVersion(text) {
  const m = String(text).match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
  return m ? m[1] : null;
}

/** `codex login status` prints "Logged in using ChatGPT" / "Logged in using an API key - sk-…" (exit 0) or
 *  "Not logged in" (exit 1), on stdout or stderr depending on the version. */
export function parseLoginStatus(code, out, err) {
  const text = `${out}\n${err}`.replace(/\r/g, "");
  const line = text.split("\n").map((l) => l.trim()).find((l) => /logged in/i.test(l)) ?? null;
  const loggedIn = code === 0 && line !== null && !/not logged in/i.test(line);
  // never pass a key fragment on
  const how = loggedIn ? line.replace(/\s*-\s*\S*$/, "").replace(/^Logged in using\s*/i, "").trim() || line : null;
  return { loggedIn, how };
}

/** Is Codex installed and logged in? Cached for a few seconds. */
export function createStatus({ ttlMs = 10000, env = process.env } = {}) {
  let cached = null;
  let at = 0;
  let pending = null;
  async function probe() {
    const exe = findCodex(env);
    if (!exe) return { installed: false, version: null, loggedIn: false, how: null, path: null };
    const v = await runQuick(exe, ["--version"]);
    const version = v.code === 0 ? parseVersion(v.out || v.err) : null;
    if (!version) return { installed: false, version: null, loggedIn: false, how: null, path: exe, error: (v.err || v.out).trim().slice(0, 300) };
    const s = await runQuick(exe, ["login", "status"]);
    return { installed: true, version, path: exe, ...parseLoginStatus(s.code, s.out, s.err) };
  }
  return {
    async get(force = false) {
      if (!force && cached && Date.now() - at < ttlMs) return cached;
      pending ??= probe().then((r) => {
        cached = r;
        at = Date.now();
        pending = null;
        return r;
      });
      return pending;
    },
  };
}

/** Lines of a stream as they arrive (LF or CRLF). */
export function lineSplitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    },
    end() {
      if (buf.trim()) onLine(buf.replace(/\r$/, ""));
      buf = "";
    },
  };
}

/** TOML string literal for -c overrides. */
const toml = (s) => JSON.stringify(String(s));

/**
 * The argv of one `codex exec --json` turn. A new thread gets the repo as its root and the workspace-write sandbox
 * (edits inside the repo, nothing outside, no network for its commands); a resumed one gets the same sandbox through
 * -c (resume takes no -s/-C) and runs with the repo as its working directory.
 */
export function execArgs({ repo, threadId = null, images = [], effort = null, model = null, env = {} }) {
  const config = ["-c", `sandbox_mode=${toml("workspace-write")}`];
  if (effort) config.push("-c", `model_reasoning_effort=${toml(effort)}`);
  for (const [k, v] of Object.entries(env)) config.push("-c", `shell_environment_policy.set.${k}=${toml(v)}`);
  const pre = threadId ? ["exec", "resume", "--json"] : ["exec", "--json", "-s", "workspace-write", "-C", repo, "--skip-git-repo-check"];
  const m = model ? ["-m", model] : [];
  // the prompt ("-") is read from stdin; images go last (-i takes several values)
  return [...pre, ...config, ...m, ...(threadId ? [threadId] : []), "-", ...images.flatMap((f) => ["-i", f])];
}

/**
 * Run one Codex turn. onEvent gets every parsed JSONL event. Resolves with the thread id, the last agent message,
 * the token usage and how it ended; rejects only when Codex could not start. An aborted signal kills the tree.
 */
export function runCodex({ exe, repo, prompt, threadId = null, images = [], effort = null, model = null, env = {}, onEvent = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    const args = execArgs({ repo, threadId, images, effort, model, env });
    let child;
    try {
      child = spawnCodex(exe, args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (e) {
      reject(e);
      return;
    }
    let thread = threadId;
    let last = "";
    let usage = null;
    let failed = null;
    let errTail = "";
    const lines = lineSplitter((line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === "thread.started") thread = e.thread_id;
      if (e.type === "item.completed" && e.item?.type === "agent_message") last = e.item.text ?? last;
      if (e.type === "turn.completed") usage = e.usage ?? null;
      if (e.type === "turn.failed") failed = e.error?.message ?? "turn failed";
      if (e.type === "error") failed = e.message ?? "error";
      onEvent(e);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => lines.push(d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (errTail = (errTail + d).slice(-4000)));
    const onAbort = () => killTree(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      lines.end();
      signal?.removeEventListener("abort", onAbort);
      const stopped = signal?.aborted ?? false;
      const ok = code === 0 && !failed && !stopped;
      const stderr = errTail.split(/\r?\n/).filter((l) => l.trim() && !/^Reading additional input from stdin/.test(l)).slice(-6).join("\n");
      resolve({ threadId: thread, lastMessage: last, usage, code, stopped, ok, error: ok || stopped ? null : failed ?? (stderr || `codex exited with ${code}`) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}
