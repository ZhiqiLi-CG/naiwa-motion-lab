/**
 * Call a page tool from Node: what lab/bin/naiwa.mjs runs, and what a job imports to read or drive the live page.
 *
 *   import { naiwa } from "../../lib/naiwa.mjs";
 *   const m = await naiwa("metrics");
 *   await naiwa("params.set", { softness: 0.8 });
 *
 * Talks to the Lab server through request files in .cache/lab/relay/ (see relay.mjs).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relayPaths, writeAtomic } from "./relay.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A scalar from the command line: number, boolean, null, JSON, else the text itself. */
function scalar(s) {
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return Number(s);
  if (s === "true" || s === "false") return s === "true";
  if (s === "null") return null;
  if (/^[[{"]/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      // a plain word that starts with a bracket
    }
  }
  return s;
}

/** JSON as PowerShell 5.1 passes it to native programs: the inner double quotes stripped ({region:belly}). */
function relaxedJson(s) {
  const quoted = s
    .replace(/([{,]\s*)([A-Za-z_$][\w$.-]*)\s*:/g, '$1"$2":')
    .replace(/:\s*([A-Za-z_][\w./-]*)(?=\s*[,}\]])/g, (m, w) => (w === "true" || w === "false" || w === "null" ? `:${w}` : `:"${w}"`))
    .replace(/([[,]\s*)([A-Za-z_][\w./-]*)(?=\s*[,\]])/g, (m, pre, w) => (w === "true" || w === "false" || w === "null" ? `${pre}${w}` : `${pre}"${w}"`));
  return JSON.parse(quoted);
}

function setPath(obj, key, value) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] && typeof o[p] === "object" ? o[p] : (o[p] = {});
  o[parts.at(-1)] = value;
}

/** The arguments after the action: one JSON object (strict, or with PowerShell's stripped quotes), key=value pairs
 *  (dotted keys nest: params.softness=0.8), or @file.json. */
export function parseToolArgs(argv) {
  const args = {};
  for (const a of argv) {
    // PowerShell writes JSON files with a BOM (trim drops it)
    if (a.startsWith("@")) Object.assign(args, JSON.parse(readFileSync(a.slice(1), "utf8").trim()));
    else if (a.trim().startsWith("{")) {
      let v;
      try {
        v = JSON.parse(a);
      } catch {
        v = relaxedJson(a);
      }
      Object.assign(args, v);
    } else {
      const i = a.indexOf("=");
      if (i <= 0) throw new Error(`cannot read the argument "${a}": use key=value, a JSON object or @file.json`);
      setPath(args, a.slice(0, i), scalar(a.slice(i + 1)));
    }
  }
  return args;
}

/** Is the Lab server up (its heartbeat file is fresh)? */
export function serverAlive(repo = REPO) {
  const { heartbeat } = relayPaths(repo);
  try {
    const h = JSON.parse(readFileSync(heartbeat, "utf8"));
    return Date.now() - h.at < 10000 ? h : null;
  } catch {
    return null;
  }
}

/** Run a page tool and return its value; throws with the page's error. */
export async function naiwa(action, args = {}, { owner = process.env.NAIWA_LAB_OWNER ?? null, timeoutMs = 60000, repo = REPO } = {}) {
  if (!serverAlive(repo)) throw new Error("the Lab server is not running (start it with: node lab/server.mjs)");
  const { relay } = relayPaths(repo);
  mkdirSync(relay, { recursive: true });
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  writeAtomic(path.join(relay, `${id}.req.json`), JSON.stringify({ id, action, args, owner, timeoutMs }));
  const res = path.join(relay, `${id}.res.json`);
  const deadline = Date.now() + timeoutMs + 5000;
  while (Date.now() < deadline) {
    if (existsSync(res)) {
      let body;
      try {
        body = JSON.parse(readFileSync(res, "utf8"));
      } catch {
        await sleep(30);
        continue;
      }
      rmSync(res, { force: true });
      if (!body.ok) throw new Error(body.error);
      return body.value;
    }
    await sleep(40);
  }
  rmSync(path.join(relay, `${id}.req.json`), { force: true });
  throw new Error(`no answer to "${action}" (is the Lab server running?)`);
}
