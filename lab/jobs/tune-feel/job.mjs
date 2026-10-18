/**
 * 优化手感 / Tune the feel: Codex experiments with the physics parameters and per-region softness on the live page
 * (params.set → probe → screenshot), judges by the probe's numbers and by looking, and hands back the best set as a
 * preset. The page's own settings are put back afterwards; the user applies the preset from its card.
 *
 * input: { goal?: string, budget?: number (experiments, 1–12, default 5), effort?: "low" | "medium" | "high" }
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { naiwa } from "../../lib/naiwa.mjs";

const DEFAULT_GOAL =
  "The belly should wobble visibly when poked and settle within about a second, the head and limbs firmer than the belly, " +
  "no jitter at rest, no limb sinking into the body, volume kept.";

const PARAM_KEYS = ["softness", "bounciness", "gravity", "bellySize", "stubbornness", "regionSoftness"];

/** The probe's numbers for both scenes, prefixed. */
async function measure() {
  const poke = await naiwa("probe", { scene: "poke", region: "belly" });
  const slap = await naiwa("probe", { scene: "slap", region: "belly" });
  const out = {};
  // the numbers only (the probe also echoes its scene and region)
  for (const [k, v] of Object.entries(poke)) if (typeof v === "number") out[`poke.${k}`] = v;
  for (const [k, v] of Object.entries(slap)) if (typeof v === "number") out[`slap.${k}`] = v;
  return out;
}

/** The preset Codex wrote (PowerShell writes a BOM, which trim drops), else the first JSON object with params in its answer. */
function readPreset(file, answer) {
  try {
    return JSON.parse(readFileSync(file, "utf8").trim());
  } catch {
    const m = answer.match(/\{[\s\S]*"params"[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Codex did not write preset.json");
  }
}

export default {
  id: "tune-feel",
  name: { zh: "优化手感", en: "Tune the feel" },
  summary: {
    zh: "Codex 在页面上试验整体与分部位的软度、弹性等参数，用指标和截图判断，交回一组预设。",
    en: "Codex experiments with the physics and per-region softness on the page, judges by metrics and screenshots, and hands back a preset.",
  },
  async run(input, ctx) {
    const budget = Math.max(1, Math.min(12, Math.round(Number(input.budget) || 5)));
    const goal = String(input.goal || DEFAULT_GOAL).slice(0, 1000);
    ctx.log("Reading the page and measuring the current feel…");
    const start = await naiwa("state");
    const original = start.params;
    try {
      const before = await measure();
      ctx.progress(0.1);
      const shot = await naiwa("screenshot");
      ctx.progress(0.15);
      const presetFile = path.join(ctx.workdir, "preset.json");
      const rel = path.relative(ctx.repo, presetFile).split(path.sep).join("/");
      writeFileSync(path.join(ctx.workdir, "start.json"), JSON.stringify({ params: original, simulator: start.simulator, before }, null, 2));
      ctx.log(`Codex runs up to ${budget} experiments…`);
      const answer = await ctx.codex(
        [
          "Task: tune the soft-body feel of 奶蛙 on the live page (read lab/AGENTS.md for the tools).",
          `Goal: ${goal}`,
          `Simulator: ${JSON.stringify(start.simulator)}.`,
          `Starting params: ${JSON.stringify(original)}.`,
          `Starting probe numbers (lower settle/jitter/penetration/volume error is better; peak_mm shows how much it moves): ${JSON.stringify(before)}.`,
          "The attached screenshot shows the start.",
          `Budget: at most ${budget} experiments. One experiment = node lab/bin/naiwa.mjs params.set … then node lab/bin/naiwa.mjs probe scene=poke (and scene=slap if useful);`,
          "take a screenshot (node lab/bin/naiwa.mjs screenshot, then look at the image file) only when the numbers alone do not tell.",
          "Parameters: softness, bounciness, gravity, bellySize, stubbornness in 0..1 (gravity and bellySize around 1), and regionSoftness",
          "{ belly, body, head, arm, hand, leg, foot } each 0..1. Do not edit any source file.",
          `When done, write the best set to ${rel} as JSON: {"name":{"zh":"…","en":"…"},"params":{…},"why":"one sentence"}`,
          `and reply in ${input.lang === "zh" ? "Chinese" : "English"} with two or three sentences on what you changed and why.`,
        ].join("\n"),
        { files: [shot.path] },
      );
      ctx.progress(0.85);
      const preset = readPreset(presetFile, answer);
      const params = Object.fromEntries(Object.entries(preset.params ?? {}).filter(([k]) => PARAM_KEYS.includes(k)));
      if (!Object.keys(params).length) throw new Error("the preset has no parameters");
      ctx.log("Measuring the preset…");
      await naiwa("params.set", { ...original, ...params, replace: true });
      const after = await measure();
      ctx.progress(0.98);
      const name = preset.name?.zh && preset.name?.en ? preset.name : { zh: "Codex 调的手感", en: "Codex-tuned feel" };
      return {
        summary: {
          zh: `${answer.trim().slice(0, 600)}`,
          en: `${answer.trim().slice(0, 600)}`,
        },
        metrics: { before, after },
        artifacts: [{ kind: "preset", data: { name, params: { ...original, ...params }, why: preset.why ?? "" } }],
      };
    } finally {
      // the page keeps what the user had; the preset card applies the result
      await naiwa("params.set", { ...original, replace: true }).catch(() => {});
    }
  },
};
