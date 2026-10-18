/**
 * The tool relay: `node lab/bin/naiwa.mjs <action> …` (run by Codex in its sandbox, or by a job) drops a request file
 * in .cache/lab/relay/; the server picks it up, answers the actions it owns itself (an artefact, help) and sends the
 * others to the open page over its event stream; the page runs them and posts the result back, and the server writes
 * the answer file the CLI is waiting for. Files rather than HTTP, because Codex's sandbox has no network.
 *
 * Results may carry files (a canvas screenshot, a recording) as { $file: { ext, base64, name? } }: the server writes
 * them under .cache/lab/media/ and puts the repo-relative path in their place.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const relayPaths = (repo) => {
  const root = path.join(repo, ".cache", "lab");
  return { root, relay: path.join(root, "relay"), media: path.join(root, "media"), heartbeat: path.join(root, "server.json") };
};

/** Write a file so that a reader never sees it half written. */
export function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const rel = (repo, p) => path.relative(repo, p).split(path.sep).join("/");

/** Replace every { $file } in a page result by the path of the file written for it. */
export function materialise(value, { repo, mediaDir, stamp = Date.now().toString(36) }) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    if (v.$file && typeof v.$file.base64 === "string") {
      const ext = String(v.$file.ext ?? "bin").replace(/[^\w]/g, "") || "bin";
      const name = String(v.$file.name ?? "file").replace(/[^\w-]/g, "_").slice(0, 40);
      mkdirSync(mediaDir, { recursive: true });
      const file = path.join(mediaDir, `${stamp}-${n++}-${name}.${ext}`);
      writeFileSync(file, Buffer.from(v.$file.base64, "base64"));
      return rel(repo, file);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
}

/**
 * @param {object} o
 * @param {string} o.repo
 * @param {(msg: object) => boolean} o.toPage  delivers a tool request to the open page; false when none is open
 * @param {Record<string, (args: any, owner: string | null) => any>} o.serverActions  actions the server answers itself
 */
export function createRelay({ repo, toPage, serverActions = {}, timeoutMs = 60000, pollMs = 60 }) {
  const paths = relayPaths(repo);
  mkdirSync(paths.relay, { recursive: true });
  const pending = new Map();
  let seq = 0;
  let timer = null;
  let beat = null;

  /** Run an action and resolve with its value (rejects with the page's error, or when nothing answers in time). */
  function request(action, args = {}, owner = null, wait = timeoutMs) {
    if (serverActions[action]) return Promise.resolve().then(() => serverActions[action](args, owner));
    const id = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the page did not answer "${action}" within ${Math.round(wait / 1000)} s`));
      }, wait);
      pending.set(id, { resolve, reject, timer, action });
      if (!toPage({ type: "tool", id, action, args, owner })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error("no page is open: open the Naiwa Motion Lab page (npx vite, http://localhost:5180/) with the Lab server running"));
      }
    });
  }

  /** The page's answer to request id. */
  function resolve(id, ok, value, error) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(materialise(value, { repo, mediaDir: paths.media }));
    else p.reject(new Error(error || `${p.action} failed`));
    return true;
  }

  /** Pick up the CLI's request files. */
  function poll() {
    let names;
    try {
      names = readdirSync(paths.relay);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".req.json")) continue;
      const file = path.join(paths.relay, name);
      const taken = file.replace(/\.req\.json$/, ".taken");
      let req;
      try {
        renameSync(file, taken);
        req = JSON.parse(readFileSync(taken, "utf8"));
      } catch {
        continue;
      }
      const answer = (body) => {
        try {
          writeAtomic(path.join(paths.relay, `${req.id}.res.json`), JSON.stringify(body));
        } finally {
          rmSync(taken, { force: true });
        }
      };
      request(String(req.action), req.args ?? {}, req.owner ?? null, Number(req.timeoutMs) || timeoutMs).then(
        (value) => answer({ ok: true, value }),
        (e) => answer({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  return {
    request,
    resolve,
    paths,
    start(port) {
      const heartbeat = () => writeAtomic(paths.heartbeat, JSON.stringify({ pid: process.pid, port, at: Date.now() }));
      heartbeat();
      beat = setInterval(heartbeat, 2000);
      timer = setInterval(poll, pollMs);
    },
    stop() {
      clearInterval(timer);
      clearInterval(beat);
      rmSync(paths.heartbeat, { force: true });
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the Lab server stopped"));
      }
      pending.clear();
    },
  };
}
