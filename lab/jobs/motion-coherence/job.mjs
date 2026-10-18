/**
 * 优化这段动作 / Make this motion coherent: a dance analysed from a video (an upload or a saved dance) made temporally
 * coherent — the camera's pans, zooms and cuts taken out of the person's motion, cuts re-anchored without a jump,
 * flipped and stretched joints repaired, zero-phase smoothing, feet pinned while they stand, a seamless loop.
 *
 * 1. The deterministic algorithm (src/algorithms/motion/coherence, DEFAULTS) runs first and is measured: landmark
 *    jerk, travel jerk, foot slide, hip speed at cuts, bone-length variation, distance from the camera-compensated
 *    person, and the frog's own jerk, foot slide and direction error when the track plays through the retargeter.
 * 2. With Codex (ctx.codex), Codex gets those numbers, the algorithm's parameters and the worst stretches in a brief
 *    (brief.md in the run's folder) and a tool to try parameter sets and per-segment fixes (try.mjs, a small budget);
 *    it writes its best set to params.json. The job re-measures it and keeps whichever scores better.
 *    Without ctx.codex the deterministic result is returned (so the job is testable: selftest.mjs).
 *
 * input: { track: DanceTrack, lang?: "zh" | "en", budget?: number (Codex's tries, 1–8, default 4),
 *          retargeter?: string (default "direction-copy") }
 * result: { summary, metrics: { before, after } (lower is better), artifacts: [{ kind: "dance", path: "dance.json", name }] }
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Bundle engine.ts (the page's own TypeScript) for Node into the run's folder and load it. */
export async function loadEngine(workdir) {
  const require = createRequire(import.meta.url);
  const { build } = require("esbuild");
  const outfile = path.join(workdir, "engine.mjs");
  await build({
    entryPoints: [path.join(HERE, "engine.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    logLevel: "silent",
    define: { "import.meta.env": "{}" },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

/** Codex's parameter set, kept to the parameters the algorithm has and to sane ranges. */
export function sanitise(raw, DEFAULTS, frames) {
  const out = {};
  const ranges = {
    minCameraMotion: [0, 0.2], panFov: [0, 120], boneTolerance: [0.1, 1], spike: [2, 10], accel: [5, 300], noise: [0.001, 0.1],
    window: [0.05, 1.5], order: [0, 6], visibility: [0, 1], contactHeight: [0.02, 0.5], contactSpeed: [0.05, 2], pin: [0, 1], loop: [0, 2],
  };
  for (const [k, v] of Object.entries(raw?.params ?? raw ?? {})) {
    if (!(k in DEFAULTS) || k === "segments") continue;
    if (typeof DEFAULTS[k] === "boolean" && typeof v === "boolean") out[k] = v;
    else if (k === "smooth" && ["none", "rts", "savgol"].includes(v)) out[k] = v;
    else if (typeof DEFAULTS[k] === "number" && Number.isFinite(Number(v))) {
      const [lo, hi] = ranges[k] ?? [-Infinity, Infinity];
      out[k] = Math.min(hi, Math.max(lo, Number(v)));
    }
  }
  const segs = Array.isArray(raw?.segments) ? raw.segments : [];
  out.segments = segs
    .filter((s) => ["outlier", "cut", "noPin", "still"].includes(s?.fix))
    .map((s) => ({ from: Math.max(0, Math.round(Number(s.from))), to: Math.min(frames, Math.round(Number(s.to))), fix: s.fix }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from)
    .slice(0, 20);
  return out;
}

const round = (n) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, Math.round(v * 100) / 100]));

/** The change of a number in percent, as text. */
const pct = (a, b) => (a > 1e-9 ? `${Math.round(((b - a) / a) * 100)}%` : "—");

function describe(e, track) {
  const r = e.report, b = e.before, a = e.after;
  const undone = track.cameraUndone;
  const zh = [
    undone ? "镜头运动在上传分析时已去掉" : r.movingShots ? `去掉了 ${r.movingShots} 个镜头里的相机运动` : track.camera ? "镜头基本没动" : null,
    r.cuts.length ? `${r.cuts.length} 处剪辑接上了（不再跳）` : null,
    r.flips ? `纠正了 ${r.flips} 段左右腿/手臂互换` : null,
    `抖动 ${pct(b["jerk m/s³"], a["jerk m/s³"])}，脚滑 ${pct(b["foot slide cm/s"], a["foot slide cm/s"])}，奶蛙的抖动 ${pct(b["frog jerk m/s³"], a["frog jerk m/s³"])}`,
    r.looped ? "首尾接成了无缝循环" : null,
  ].filter(Boolean).join("；");
  const en = [
    undone ? "the camera was already taken out when the video was analysed" : r.movingShots ? `camera motion removed from ${r.movingShots} shot(s)` : track.camera ? "the camera hardly moved" : null,
    r.cuts.length ? `${r.cuts.length} cut(s) joined without a jump` : null,
    r.flips ? `${r.flips} left/right swaps undone` : null,
    `jitter ${pct(b["jerk m/s³"], a["jerk m/s³"])}, foot slide ${pct(b["foot slide cm/s"], a["foot slide cm/s"])}, the frog's jitter ${pct(b["frog jerk m/s³"], a["frog jerk m/s³"])}`,
    r.looped ? "a seamless loop" : null,
  ].filter(Boolean).join("; ");
  return { zh: zh + "。", en: en.charAt(0).toUpperCase() + en.slice(1) + "." };
}

/** The brief Codex reads (brief.md). */
function brief(track, first, hot, budget, lang) {
  return `# Make this motion coherent

A dance track analysed from a video by MediaPipe (per frame, in the picture), ${track.frames.length} frames at ${track.fps} fps,
aspect ${track.aspect ?? 1}. It has ${track.camera ? "a camera estimate (camera, cuts)" : "no camera estimate"}${track.cameraUndone ? " already taken out of the image landmarks" : ""}.

The deterministic coherence algorithm (src/algorithms/motion/coherence/index.ts; read it and its files) has run
with its DEFAULTS. Its report:

\`\`\`json
${JSON.stringify(first.report, null, 1)}
\`\`\`

Numbers (lower is better), the track as it came → after the algorithm, and the score (lower is better; see score() in
lab/jobs/motion-coherence/engine.ts — coherence relative to the input, penalties for moving more than 3 cm away from
the person or making the frog copy them worse):

| | before | after |
|---|---|---|
${Object.keys(first.after).map((k) => `| ${k} | ${first.before[k].toFixed(2)} | ${first.after[k].toFixed(2)} |`).join("\n")}

score: ${first.score.toFixed(3)}

The stretches where the hips move most jerkily after the algorithm (frame ranges, picture heights/s³ and /s):

${hot.map((h) => `- frames ${h.from}–${h.to}: travel jerk ${h.travelJerk.toFixed(1)}, peak speed ${h.peakSpeed.toFixed(2)}`).join("\n")}

## Your task

Find parameters (CoherenceParams) and, if they help, per-segment fixes that lower the score without making the dance
less like the person. Segments: { from, to, fix } with fix "outlier" (the detector is wrong there: interpolate over
it), "cut" (a cut the estimate missed, at \`from\`), "noPin" (the feet really slide there, e.g. a moonwalk), "still"
(the person stands in place there; the travel is the camera's).

Try a set with: node ${"<workdir>"}/try.mjs <file.json>  (the file: { "params": {...}, "segments": [...] }; it prints
the numbers and the score). You have ${budget} tries. Then write your best set to <workdir>/params.json and reply in
${lang === "zh" ? "Chinese" : "English"} with two or three sentences: what you changed and how the numbers moved.
Edit no source file.
`;
}

/** Codex's tool: try a parameter set on the input track (budgeted). */
const TRY = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const budgetFile = path.join(dir, "tries.json");
const state = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, "utf8")) : { left: Number(process.env.TRIES ?? 4) };
if (state.left <= 0) { console.log("No tries left: write your best set to params.json now."); process.exit(0); }
const job = await import(pathToFileURL(path.join(dir, "job-link.mjs")).href);
const engine = await import(pathToFileURL(path.join(dir, "engine.mjs")).href);
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const raw = JSON.parse(readFileSync(path.resolve(process.argv[2] ?? path.join(dir, "params.json")), "utf8"));
const params = job.sanitise(raw, engine.DEFAULTS, input.frames.length);
const e = await engine.evaluate(input, params, process.env.RETARGETER ?? "direction-copy");
state.left--;
writeFileSync(budgetFile, JSON.stringify(state));
console.log(JSON.stringify({ params, score: e.score, after: e.after, report: { ...e.report, anchors: undefined }, triesLeft: state.left }, null, 1));
`;

export default {
  id: "motion-coherence",
  name: { zh: "优化这段动作", en: "Make this motion coherent" },
  summary: {
    zh: "去掉视频里镜头的平移、缩放和剪辑对动作的影响，修正左右互换和跳点，平滑、脚踩实、首尾无缝；有 Codex 时再按指标调参数，保留更好的结果。",
    en: "Takes the camera's pans, zooms and cuts out of the person's motion, repairs swapped and jumping joints, smooths it, pins the standing feet and makes the loop seamless; with Codex, then tunes the parameters on the numbers and keeps the better result.",
  },
  async run(input, ctx) {
    const track = typeof input?.track === "string" ? JSON.parse(input.track) : input?.track;
    if (!track || !Array.isArray(track.frames) || !(track.fps > 0)) throw new Error("input.track must be a DanceTrack (frames, fps)");
    if (track.frames.filter((f) => f?.world?.length >= 33).length < 10) throw new Error("the track has too few frames with a person");
    const lang = input.lang === "en" ? "en" : "zh";
    const retargeter = typeof input.retargeter === "string" ? input.retargeter : "direction-copy";
    const budget = Math.max(1, Math.min(8, Math.round(Number(input.budget) || 4)));
    const log = (t) => ctx.log?.(t);
    const progress = (p) => ctx.progress?.(p);

    log("Preparing the coherence algorithm…");
    const engine = await loadEngine(ctx.workdir);
    progress(0.1);
    log("Running the deterministic pass (camera, cuts, outliers, smoothing, feet, loop)…");
    const first = await engine.evaluate(track, {}, retargeter);
    log(`Deterministic: score ${first.score.toFixed(3)}; ${JSON.stringify(round(first.after))}`);
    progress(0.35);

    let best = first, by = "deterministic", answer = "";
    if (typeof ctx.codex === "function" && !ctx.signal?.aborted) {
      writeFileSync(path.join(ctx.workdir, "input.json"), JSON.stringify(track));
      writeFileSync(path.join(ctx.workdir, "job-link.mjs"), `export * from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};\n`);
      writeFileSync(path.join(ctx.workdir, "try.mjs"), TRY.replace('process.env.TRIES ?? 4', String(budget)).replace('process.env.RETARGETER ?? "direction-copy"', JSON.stringify(retargeter)));
      writeFileSync(path.join(ctx.workdir, "brief.md"), brief(track, first, engine.hotspots(first.track), budget, lang).replaceAll("<workdir>", path.relative(ctx.repo, ctx.workdir).split(path.sep).join("/")));
      const rel = (f) => path.relative(ctx.repo, path.join(ctx.workdir, f)).split(path.sep).join("/");
      log(`Codex tunes the parameters (up to ${budget} tries)…`);
      try {
        answer = await ctx.codex(
          [
            `Task: make a video-derived dance track more coherent by tuning the coherence algorithm. Read ${rel("brief.md")} first; it has the numbers,`,
            `the parameters and the tool (node ${rel("try.mjs")} <file.json>, ${budget} tries). Write your best set to ${rel("params.json")}`,
            `({ "params": {...}, "segments": [...] }). Edit no source file. Reply in ${lang === "zh" ? "Chinese" : "English"} with two or three sentences.`,
          ].join("\n"),
          { files: [rel("brief.md")] },
        );
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        log(`Codex failed (${e?.message ?? e}); keeping the deterministic result.`);
      }
      progress(0.8);
      const file = path.join(ctx.workdir, "params.json");
      if (existsSync(file)) {
        try {
          const params = sanitise(JSON.parse(readFileSync(file, "utf8")), engine.DEFAULTS, track.frames.length);
          log(`Measuring Codex's set: ${JSON.stringify(params)}`);
          const tuned = await engine.evaluate(track, params, retargeter);
          log(`Codex: score ${tuned.score.toFixed(3)} (deterministic ${first.score.toFixed(3)})`);
          if (tuned.score < first.score) (best = tuned), (by = "codex");
        } catch (e) {
          log(`Codex's params.json could not be used (${e?.message ?? e}).`);
        }
      } else log("Codex wrote no params.json; keeping the deterministic result.");
    }
    progress(0.9);

    const name = lang === "zh" ? `${track.name ?? "舞蹈"}·连贯` : `${track.nameEn ?? track.name ?? "Dance"} (coherent)`;
    const out = { ...best.track, id: `${track.id ?? "dance"}-coherent`, name: `${track.name ?? "舞蹈"}·连贯`, nameEn: `${track.nameEn ?? track.name ?? "Dance"} (coherent)` };
    writeFileSync(path.join(ctx.workdir, "dance.json"), JSON.stringify(out));
    writeFileSync(path.join(ctx.workdir, "report.json"), JSON.stringify({ by, report: best.report, before: best.before, after: best.after, score: best.score, deterministic: { score: first.score, after: first.after } }, null, 1));
    const summary = describe(best, track);
    if (by === "codex" && answer.trim()) {
      const extra = answer.trim().slice(0, 600);
      summary.zh += ` Codex：${extra}`;
      summary.en += ` Codex: ${extra}`;
    } else if (answer.trim()) {
      summary.zh += "（Codex 的参数没有更好，保留了确定性算法的结果。）";
      summary.en += " (Codex's parameters scored no better; the deterministic result is kept.)";
    }
    progress(1);
    return {
      summary,
      metrics: { before: round(best.before), after: round(best.after) },
      artifacts: [{ kind: "dance", path: "dance.json", name, title: { zh: "连贯的动作", en: "Coherent motion" } }],
    };
  },
};
