/**
 * 让 Codex 改进这个模块 / Improve this block with Codex: Codex reads the code-lab block the user selected (and the
 * slot's API), writes an improved version, tries it against the built-in block on the page's comparison scene
 * (block.compare), and hands back the file for the code lab to load as the user's experiment. The metrics are the
 * comparison's numbers for the block as it was (before) and as Codex left it (after).
 *
 * input: {
 *   core: "simulator" | "retargeter", slot: string,
 *   code: string,                       the block's source as the user sees it
 *   from: { id: string, path: string }, the page block it comes from (path below src/: relative imports resolve there)
 *   name?: string, goal?: string, budget?: number (comparisons, 1–6, default 3), lang?: "zh" | "en", effort?: string
 * }
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { naiwa } from "../../lib/naiwa.mjs";

const API_DOC = { simulator: "docs/simulator-api.md", retargeter: "docs/motion-api.md" };

/** The comparison's rows as numbers (the user's block column). */
const numbers = (r) => Object.fromEntries(r.mine.map((row) => [row.key, row.value]));

export default {
  id: "improve-block",
  name: { zh: "让 Codex 改进这个模块", en: "Improve this block with Codex" },
  summary: {
    zh: "Codex 读这个模块和它的接口，写一个改进版，在对比场景里和内置模块比指标，交回一个文件，载入代码实验室作为你的实验。",
    en: "Codex reads the block and its slot's API, writes an improved version, compares it with the built-in block on the metrics, and hands back a file the code lab loads as your experiment.",
  },
  async run(input, ctx) {
    const { core, slot, code, from } = input;
    if (core !== "simulator" && core !== "retargeter") throw new Error('input.core must be "simulator" or "retargeter"');
    if (!slot || typeof code !== "string" || !from?.id || !from?.path) throw new Error("input needs slot, code and from { id, path }");
    const budget = Math.max(1, Math.min(6, Math.round(Number(input.budget) || 3)));
    const rel = (f) => path.relative(ctx.repo, f).split(path.sep).join("/");
    const original = path.join(ctx.workdir, "original.ts");
    const improved = path.join(ctx.workdir, "improved.ts");
    writeFileSync(original, code);

    ctx.log("Comparing the block as it is with the built-in one…");
    const compareArgs = { core, slot, from };
    const first = await naiwa("block.compare", { ...compareArgs, file: rel(original) }, { timeoutMs: 180000 });
    const before = numbers(first);
    ctx.progress(0.15);

    const goal = input.goal ? `The user's goal: ${String(input.goal).slice(0, 1000)}` : "Goal: better numbers on the comparison (every row: lower is better) without making any row clearly worse, and clean, readable code.";
    ctx.log(`Codex improves the block (up to ${budget} comparisons)…`);
    const answer = await ctx.codex(
      [
        `Task: improve a ${core} block of the Naiwa Motion Lab code lab (slot "${slot}"). Read lab/AGENTS.md for the tools,`,
        `${API_DOC[core]} for the slot's interface, and src/${from.path} (the page block it comes from).`,
        `The block as the user has it is ${rel(original)}. ${goal}`,
        `Its comparison against the built-in block now: ${JSON.stringify(first)}.`,
        `Write the improved block to ${rel(improved)}: a complete module like the original (its imports resolve as if the file sat at`,
        `src/${from.path}), defining a BlockDefinition<"${slot}"> with a new id ending in "-codex" and a name { zh, en } that says what changed.`,
        `Try it with: node lab/bin/naiwa.mjs block.compare core=${core} slot=${slot} from.id=${from.id} from.path=${from.path} file=${rel(improved)}`,
        `(at most ${budget} comparisons). Edit no other file. Then reply in ${input.lang === "zh" ? "Chinese" : "English"} with two or three sentences: what you changed and how the numbers moved.`,
      ].join("\n"),
    );
    if (!existsSync(improved)) throw new Error(`Codex did not write ${rel(improved)}`);
    ctx.progress(0.85);
    ctx.log("Comparing the improved block…");
    const last = await naiwa("block.compare", { ...compareArgs, file: rel(improved) }, { timeoutMs: 180000 });
    const after = numbers(last);
    const summary = answer.trim().slice(0, 800);
    return {
      summary: { zh: summary, en: summary },
      metrics: { before, after },
      // core, slot and from tell the code lab where the block goes (extra fields of a block artefact)
      artifacts: [{ kind: "block", path: rel(improved), core, slot, from }],
    };
  },
};
