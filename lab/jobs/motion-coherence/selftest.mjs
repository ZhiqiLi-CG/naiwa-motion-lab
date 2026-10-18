// The motion-coherence job without the Lab server: a preset dance filmed through a synthetic moving camera with a cut
// (src/algorithms/motion/coherence/synthetic.ts), run deterministically (no ctx.codex), then with a stand-in for Codex
// that writes a parameter set, so both paths are exercised. Exit code 1 when the numbers do not improve.
// usage: node lab/jobs/motion-coherence/selftest.mjs [dance id, default kemusan]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import job, { loadEngine } from "./job.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
process.chdir(repo);
const id = process.argv[2] ?? "kemusan";
const workdir = (name) => {
  const d = path.join(repo, ".cache", "coherence", `selftest-${name}-${Date.now().toString(36)}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const w0 = workdir("synthetic");
const engine = await loadEngine(w0);
const truth = engine.looped(JSON.parse(readFileSync(`public/dances/${id}.json`, "utf8")), 10);
const { raw, cut } = engine.film(truth);
writeFileSync(path.join(w0, "filmed.json"), JSON.stringify(raw));
console.log(`${id}: ${raw.frames.length} frames, cut at ${cut}, camera pans, tilts, zooms; detector noise`);

const table = (r) => {
  for (const k of Object.keys(r.metrics.before)) console.log(`  ${k.padEnd(30)} ${String(r.metrics.before[k]).padStart(9)} → ${String(r.metrics.after[k]).padStart(9)}`);
};
let failed = false;
const check = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  failed ||= !ok;
};

const t0 = performance.now();
const a = await job.run({ track: raw, lang: "en" }, { repo, workdir: workdir("deterministic"), log: (t) => console.log(`  · ${t}`), progress() {} });
console.log(`deterministic (${((performance.now() - t0) / 1000).toFixed(1)} s): ${a.summary.en}`);
table(a);
const b = a.metrics.before, f = a.metrics.after;
check(f["jerk m/s³"] < 0.5 * b["jerk m/s³"], "landmark jerk at least halved");
check(f["foot slide cm/s"] < 0.5 * b["foot slide cm/s"], "foot slide at least halved");
check(f["speed at cuts m/s"] < 0.2 * b["speed at cuts m/s"], "no jump at the cut");
check(f["frog jerk m/s³"] < b["frog jerk m/s³"], "the frog moves more smoothly");

const w2 = workdir("codex-standin");
const c = await job.run({ track: raw, lang: "en", budget: 2 }, {
  repo, workdir: w2, log: (t) => console.log(`  · ${t}`), progress() {},
  // Stands in for Codex: writes a parameter set as Codex would (a firmer pin, a gentler smoother).
  codex: async () => {
    writeFileSync(path.join(w2, "params.json"), JSON.stringify({ params: { pin: 0.8, accel: 20, bogus: 1 }, segments: [{ from: 10, to: 20, fix: "noPin" }, { fix: "nonsense" }] }));
    return "Firmer pinning and a gentler smoother.";
  },
});
console.log(`with a Codex stand-in: ${c.summary.en}`);
check(JSON.parse(readFileSync(path.join(w2, "report.json"), "utf8")).by !== undefined, "the Codex path measured its set and chose");
check(Array.isArray(c.artifacts) && c.artifacts[0].kind === "dance", "returns the dance");
process.exit(failed ? 1 : 0);
