#!/usr/bin/env node
/**
 * The local Lab server: `node lab/server.mjs [--port 5170]`, on 127.0.0.1 only. It tells the page whether Codex CLI
 * is installed and logged in, runs chat turns and jobs through `codex exec --json`, and relays Codex's page tools
 * (lab/bin/naiwa.mjs) to the open page. Everything reaches the page over one event stream.
 *
 *   GET  /api/status                      { codex: { installed, version, loggedIn, how }, page, job }
 *   GET  /api/stream?page=1               server-sent events: chat, job, tool requests (page=1: this page runs tools)
 *   POST /api/page/result                 { id, ok, value | error }: the page's answer to a tool request
 *   POST /api/tool                        { action, args }: run a page tool (for scripts and tests)
 *   POST /api/chat                        { conv?, create?, text, context?, effort? } → { conv }
 *   POST /api/chat/<conv>/stop            GET /api/chat/<conv> → its events so far
 *   GET  /api/jobs                        [{ id, name, summary }]
 *   POST /api/jobs/<id>                   { input } → { run }
 *   POST /api/runs/<run>/stop             GET /api/runs/<run> → its state and result
 *   GET  /api/file?path=<repo path>       a file of the repo (artefacts)
 *   POST /api/upload?name=<file name>     raw body → { path } under .cache/lab/uploads
 */
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChat } from "./lib/chat.mjs";
import { createStatus, findCodex, runCodex } from "./lib/codex.mjs";
import { createJobs } from "./lib/jobs.mjs";
import { createRelay } from "./lib/relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 5170;
const MAX_BODY = 64 * 1024 * 1024;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const TYPES = { ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4", ".ts": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

/** A path of the repo, never outside it (nor into .git). */
export function repoPath(repo, p) {
  const abs = path.resolve(repo, String(p ?? ""));
  const rel = path.relative(repo, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0] === ".git") throw new HttpError(403, "outside the repository");
  return abs;
}

/**
 * The server, not yet listening. Tests pass their own `codex` (a fake turn runner) and `status`.
 * @param {{ repo?: string, codex?: Function, status?: { get(force?: boolean): Promise<object> }, effort?: string | null, model?: string | null }} o
 */
export function createLabServer({ repo = path.resolve(HERE, ".."), codex, status, log = () => {}, effort = process.env.NAIWA_LAB_EFFORT ?? null, model = process.env.NAIWA_LAB_MODEL ?? null } = {}) {
  const codexStatus = status ?? createStatus();
  const turn =
    codex ??
    (async (opts) => {
      const exe = findCodex();
      if (!exe) throw new Error("Codex CLI is not installed");
      return runCodex({ exe, repo, model, ...opts });
    });

  /* ---- the event stream ---- */
  const clients = new Set();
  let pageClient = null;
  const write = (res, msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  const broadcast = (msg) => clients.forEach((c) => write(c.res, msg));

  const chat = createChat({ codex: turn, effort, emit: (conv, ev) => broadcast({ ch: "chat", conv, ev }) });
  const jobs = createJobs({ repo, codex: turn, effort, emit: (run, ev) => broadcast({ ch: "job", run, ev }) });

  const relay = createRelay({
    repo,
    toPage(msg) {
      if (!pageClient) return false;
      write(pageClient.res, { ch: "tool", ...msg });
      return true;
    },
    serverActions: {
      /** Codex hands a result back: shown as a card in its conversation or job. */
      artifact(args, owner) {
        const a = { ...args };
        if (!["dance", "preset", "block", "file"].includes(a.kind)) throw new Error("kind must be dance, preset, block or file");
        if (a.kind === "preset" && (!a.data || typeof a.data !== "object")) throw new Error("a preset carries data (the physics params)");
        if (a.kind !== "preset") {
          if (typeof a.path !== "string") throw new Error(`a ${a.kind} carries a path`);
          const abs = repoPath(repo, a.path);
          if (!existsSync(abs)) throw new Error(`${a.path} does not exist`);
          a.path = path.relative(repo, abs).split(path.sep).join("/");
        }
        const [kind, id] = String(owner ?? "").split(":");
        if (kind === "chat" && chat.note(id, { type: "artifact", artifact: a })) return { shown: "chat" };
        if (kind === "job") {
          broadcast({ ch: "job", run: id, ev: { type: "artifact", artifact: a } });
          return { shown: "job" };
        }
        broadcast({ ch: "artifact", artifact: a });
        return { shown: "page" };
      },
    },
  });

  async function statusBody(force = false) {
    const s = await codexStatus.get(force);
    return { codex: { installed: s.installed, version: s.version, loggedIn: s.loggedIn, how: s.how }, page: pageClient !== null, job: jobs.active() };
  }

  async function route(req, res, url) {
    const { pathname } = url;
    const json = (body, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && pathname === "/api/status") return json(await statusBody(url.searchParams.has("refresh")));

    if (req.method === "GET" && pathname === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const client = { res, page: url.searchParams.get("page") === "1" };
      clients.add(client);
      if (client.page) {
        pageClient = client;
        log(`page connected (${req.headers.origin ?? "no origin"})`);
      }
      write(res, { ch: "hello", ...(await statusBody()), convs: chat.list() });
      const keep = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      res.on("close", () => {
        clearInterval(keep);
        clients.delete(client);
        if (pageClient === client) {
          pageClient = [...clients].reverse().find((c) => c.page) ?? null;
          log(pageClient ? "page disconnected; another page is open" : "page disconnected");
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/page/result") {
      const b = await readJson(req);
      return json({ ok: relay.resolve(String(b.id), Boolean(b.ok), b.value, b.error) });
    }
    if (req.method === "POST" && pathname === "/api/tool") {
      const b = await readJson(req);
      try {
        return json({ ok: true, value: await relay.request(String(b.action), b.args ?? {}, b.owner ?? null) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const b = await readJson(req);
      const s = await codexStatus.get();
      if (!codex && !s.loggedIn) throw new HttpError(503, "Codex CLI is not logged in");
      const { conv } = await chat.send({ conv: b.conv ?? null, create: Boolean(b.create), text: b.text, context: b.context ?? null, effort: b.effort ?? null });
      log(`chat ${conv}: ${String(b.text).slice(0, 60)}`);
      return json({ conv });
    }
    let m = pathname.match(/^\/api\/chat\/([\w-]+)(\/stop)?$/);
    if (m) {
      if (req.method === "POST" && m[2]) return json({ stopped: chat.stop(m[1]) });
      if (req.method === "GET" && !m[2]) {
        const h = chat.history(m[1]);
        if (!h) throw new HttpError(404, "no such conversation");
        return json({ conv: m[1], events: h });
      }
    }

    if (req.method === "GET" && pathname === "/api/jobs") return json(await jobs.list());
    m = pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (m && req.method === "POST") {
      const b = await readJson(req);
      const s = await codexStatus.get();
      if (!codex && !s.loggedIn) throw new HttpError(503, "Codex CLI is not logged in");
      const run = await jobs.start(m[1], b.input ?? {});
      log(`job ${run}`);
      return json({ run });
    }
    m = pathname.match(/^\/api\/runs\/([\w-]+)(\/stop)?$/);
    if (m) {
      if (req.method === "POST" && m[2]) return json({ stopped: jobs.stop(m[1]) });
      if (req.method === "GET" && !m[2]) {
        const r = jobs.get(m[1]);
        if (!r) throw new HttpError(404, "no such run");
        return json(r);
      }
    }

    if (req.method === "GET" && pathname === "/api/file") {
      const abs = repoPath(repo, url.searchParams.get("path"));
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, "no such file");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream" });
      res.end(readFileSync(abs));
      return;
    }
    if (req.method === "POST" && pathname === "/api/upload") {
      const name = String(url.searchParams.get("name") ?? "upload.bin").replace(/[^\w.-]/g, "_").slice(-80);
      const dir = path.join(repo, ".cache", "lab", "uploads");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
      writeFileSync(file, await readBody(req));
      return json({ path: path.relative(repo, file).split(path.sep).join("/") });
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    } else if (origin) {
      // only pages served from this machine may drive it
      res.writeHead(403).end();
      return;
    }
    // the page is cross-origin isolated (COEP require-corp)
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    route(req, res, url).catch((e) => {
      if (res.headersSent) return res.end();
      res.writeHead(e instanceof HttpError ? e.status : (e?.status ?? 500), { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    });
  });

  return {
    server,
    relay,
    chat,
    jobs,
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const p = server.address().port;
          relay.start(p);
          resolve(p);
        });
      });
    },
    close() {
      relay.stop();
      for (const c of clients) c.res.end();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.NAIWA_LAB_PORT ?? DEFAULT_PORT);
  const lab = createLabServer({ log: (m) => console.log(`${new Date().toLocaleTimeString()} ${m}`) });
  const p = await lab.listen(port);
  const s = await createStatus().get();
  console.log(`Naiwa Lab server on http://127.0.0.1:${p}/  (repo ${path.resolve(HERE, "..")})`);
  console.log(s.installed ? `Codex CLI ${s.version}: ${s.loggedIn ? `logged in (${s.how})` : "not logged in — run: codex login"}` : "Codex CLI not found — install it, then: codex login");
  const stop = () => lab.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
