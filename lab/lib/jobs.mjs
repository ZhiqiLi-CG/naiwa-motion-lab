/**
 * The job framework (contract: lab/jobs/README.md). A job is lab/jobs/<id>/job.mjs exporting
 * { id, name, summary, run(input, ctx) }; the server lists them, runs one at a time with a fresh work directory, streams
 * its log, progress and Codex events to the page, and hands the result (summary, metrics, artefacts) back.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mapCodexEvent } from "./events.mjs";

const isText = (t) => t && typeof t === "object" && typeof t.zh === "string" && typeof t.en === "string";
const ARTIFACT_KINDS = new Set(["dance", "preset", "block", "file"]);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** Load lab/jobs/<id>/job.mjs (again when it changed: another agent may be writing it). */
async function loadJob(dir, id) {
  const file = path.join(dir, id, "job.mjs");
  if (!existsSync(file)) return null;
  const mod = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  const job = mod.default;
  if (!job || job.id !== id || !isText(job.name) || !isText(job.summary) || typeof job.run !== "function") {
    throw new Error(`lab/jobs/${id}/job.mjs: export default { id: "${id}", name: { zh, en }, summary: { zh, en }, run }`);
  }
  return job;
}

/** Check a job's result and resolve its artefacts' paths (relative ones from the work directory, else the repo). */
export function normaliseResult(result, { repo, workdir }) {
  if (!result || !isText(result.summary)) throw new Error("the job's result needs summary: { zh, en }");
  const artifacts = (result.artifacts ?? []).map((a, i) => {
    if (!a || !ARTIFACT_KINDS.has(a.kind)) throw new Error(`artifact ${i}: kind must be dance, preset, block or file`);
    if (a.kind === "preset") {
      if (!a.data || typeof a.data !== "object") throw new Error(`artifact ${i}: a preset carries data`);
      return a;
    }
    if (typeof a.path !== "string") throw new Error(`artifact ${i}: a ${a.kind} carries a path`);
    const abs = path.isAbsolute(a.path) ? a.path : existsSync(path.join(workdir, a.path)) ? path.join(workdir, a.path) : path.join(repo, a.path);
    if (!existsSync(abs)) throw new Error(`artifact ${i}: ${a.path} does not exist`);
    const rel = path.relative(repo, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`artifact ${i}: ${a.path} is outside the repo`);
    return { ...a, path: rel.split(path.sep).join("/") };
  });
  const metrics = result.metrics && typeof result.metrics === "object" ? { before: result.metrics.before ?? {}, after: result.metrics.after ?? {} } : undefined;
  return { summary: result.summary, ...(metrics ? { metrics } : {}), artifacts };
}

/**
 * @param {object} o
 * @param {string} o.repo
 * @param {string} [o.jobsDir]  lab/jobs
 * @param {(opts: object) => Promise<{ ok: boolean, lastMessage: string, error: string | null, stopped: boolean }>} o.codex  runs one Codex turn (lib/codex.mjs runCodex with the executable bound)
 * @param {(run: string, ev: object) => void} o.emit
 */
export function createJobs({ repo, jobsDir = path.join(repo, "lab", "jobs"), codex, emit, effort = null }) {
  const runs = new Map();
  const runsDir = path.join(repo, ".cache", "lab", "jobs");
  // the last runs of earlier sessions (their results), so a restarted server still shows them
  if (existsSync(runsDir)) {
    for (const d of readdirSync(runsDir).sort().slice(-3)) {
      try {
        const r = JSON.parse(readFileSync(path.join(runsDir, d, "run.json"), "utf8"));
        runs.set(r.id, { ...r, controller: new AbortController() });
      } catch {
        // a run that never finished
      }
    }
  }
  let active = null;

  async function list() {
    const ids = existsSync(jobsDir) ? readdirSync(jobsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    const out = [];
    for (const id of ids.sort()) {
      try {
        const job = await loadJob(jobsDir, id);
        if (job) out.push({ id: job.id, name: job.name, summary: job.summary });
      } catch (e) {
        console.warn(`lab: job ${id} skipped: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  async function start(id, input = {}) {
    if (active) throw Object.assign(new Error("a job is already running"), { status: 409 });
    const job = await loadJob(jobsDir, id);
    if (!job) throw Object.assign(new Error(`no job "${id}"`), { status: 404 });
    const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${id}`;
    const workdir = path.join(repo, ".cache", "lab", "jobs", runId);
    mkdirSync(workdir, { recursive: true });
    const controller = new AbortController();
    const run = { id: runId, job: id, name: job.name, status: "running", progress: 0, started: Date.now(), result: null, error: null, controller };
    runs.set(runId, run);
    active = run;
    const send = (ev) => emit(runId, ev);
    send({ type: "start", job: id, name: job.name, workdir: path.relative(repo, workdir).split(path.sep).join("/") });

    const ctx = {
      repo,
      workdir,
      signal: controller.signal,
      log(text) {
        send({ type: "log", text: String(text) });
      },
      progress(p) {
        run.progress = Math.max(0, Math.min(1, Number(p) || 0));
        send({ type: "progress", value: run.progress });
      },
      async codex(prompt, { files = [] } = {}) {
        if (controller.signal.aborted) throw new Error("stopped");
        const abs = files.map((f) => (path.isAbsolute(f) ? f : path.join(repo, f)));
        const images = abs.filter((f) => IMAGE.test(f));
        const listed = abs.length ? `\n\nFiles for this task:\n${abs.map((f) => `- ${path.relative(repo, f).split(path.sep).join("/")}`).join("\n")}` : "";
        const r = await codex({
          prompt: prompt + listed,
          images,
          effort: input.effort ?? effort,
          env: { NAIWA_LAB_OWNER: `job:${runId}` },
          signal: controller.signal,
          onEvent: (e) => {
            const ev = mapCodexEvent(e);
            if (ev) send({ type: "codex", ev });
          },
        });
        if (r.stopped || controller.signal.aborted) throw new Error("stopped");
        if (!r.ok) throw new Error(`codex: ${r.error}`);
        return r.lastMessage;
      },
    };

    // runs in the background; the page follows its events
    void (async () => {
      try {
        const result = normaliseResult(await job.run(input, ctx), { repo, workdir });
        run.status = "done";
        run.result = result;
        run.progress = 1;
        send({ type: "done", result });
      } catch (e) {
        run.status = controller.signal.aborted ? "stopped" : "failed";
        run.error = e instanceof Error ? e.message : String(e);
        send({ type: run.status, error: run.error });
      } finally {
        if (active === run) active = null;
        const { controller: _, ...saved } = run;
        writeFileSync(path.join(workdir, "run.json"), JSON.stringify(saved, null, 2));
      }
    })();
    return runId;
  }

  return {
    list,
    start,
    stop(runId) {
      const run = runs.get(runId);
      if (!run || run.status !== "running") return false;
      run.controller.abort();
      return true;
    },
    get(runId) {
      const r = runs.get(runId);
      if (!r) return null;
      const { controller, ...rest } = r;
      return rest;
    },
    active: () => (active ? active.id : null),
    /** The last runs, newest last (a page that reloads shows them again). */
    recent: (n = 3) => [...runs.keys()].slice(-n),
  };
}
