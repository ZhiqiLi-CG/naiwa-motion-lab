/**
 * The comparison tables of docs/learn/motion-index.md: every algorithm through the same harness (bench.ts) on
 * naiwa.glb, one block swapped into the default retargeter at a time. Prints the tables as Markdown.
 */
import { expect, it } from "vitest";
import type { Slot } from "../../motion/api";
import { measureFilter, measureRetargeter } from "./bench";
import { loadTrack } from "./rigs";
import { setup } from "./testSupport";

const DANCES = ["gouxiong", "naenae", "kemusan"];
const per = (xs: number[], digits: number) => xs.map((x) => x.toFixed(digits)).join(" / ");

it("compares the algorithms on three dances", async () => {
  const b = await setup();
  const tracks = DANCES.map(loadTrack);
  const rows: [string, Partial<Record<Slot, string>>][] = [
    ["direction copy (built-in)", {}],
    ["foot-plant", { output: "foot-plant" }],
    ["ccd-ik", { solver: "ccd-ik" }],
    ["fabrik-ik", { solver: "fabrik-ik" }],
    ["dls-ik", { solver: "dls-ik" }],
    ["penalty-opt", { solver: "penalty-opt" }],
  ];
  const lines = [
    `| ${DANCES.join(" / ")} | fidelity ° | jerk m/s³ | penetration mm | foot slide cm/s | solve + output ms |`,
    "|---|---|---|---|---|---|",
  ];
  for (const [name, blocks] of rows) {
    const r = tracks.map((t) => measureRetargeter(b, { id: "direction-copy", blocks }, t));
    lines.push(`| ${name} | ${per(r.map((x) => x.fidelity), 1)} | ${per(r.map((x) => x.jerk), 0)} | ${per(r.map((x) => x.penetration * 1000), 1)} | ${per(r.map((x) => x.footSlide * 100), 1)} | ${per(r.map((x) => x.solveMs + x.outputMs), 2)} |`);
    for (const x of r) expect(x.solveMs + x.outputMs).toBeLessThan(2);
  }
  console.log(lines.join("\n"));

  const filters = [["one-euro (built-in)", "one-euro"], ["kalman-cv", "kalman-cv"], ["savitzky-golay", "savitzky-golay"]];
  const flines = [
    `| ${DANCES.join(" / ")} | RMSE live mm | RMSE recorded mm | jerk live m/s³ | jerk recorded m/s³ | live ms |`,
    "|---|---|---|---|---|---|",
  ];
  for (const [name, filter] of filters) {
    const r = tracks.map((t) => measureFilter(b, { id: "direction-copy", blocks: { filter } }, t));
    flines.push(`| ${name} | ${per(r.map((x) => x.rmseLive), 1)} | ${per(r.map((x) => x.rmseRecorded), 1)} | ${per(r.map((x) => x.jerkLive), 0)} | ${per(r.map((x) => x.jerkRecorded), 0)} | ${per(r.map((x) => x.liveMs), 3)} |`);
  }
  console.log(flines.join("\n"));
}, 120000);
