/**
 * What the code lab can open: the block definitions in the page's own source files (built-in blocks, the library's
 * algorithms and the docs' examples), found by reading the sources, so a new built-in block shows up without being
 * listed here; and the learning pages and API documents that go with them.
 */
import type { Lang, Text } from "../i18n";
import { pageFiles, pageSource } from "./loader";

export type CoreKind = "simulator" | "retargeter";

/** A block definition found in a source file. */
export interface BlockSource {
  kind: CoreKind;
  slot: string;
  /** The block's id as registered by the page. */
  id: string;
  /** The file below src/ ("sim/examples/smoothSurface.ts"). */
  path: string;
  /** Its name as the source declares it. */
  name: Text | null;
}

/** The directories whose files define blocks of each core. */
const ROOTS: Record<CoreKind, string[]> = { simulator: ["sim/", "algorithms/sim/"], retargeter: ["motion/", "algorithms/motion/"] };

const DEFINITION = /BlockDefinition<"(\w+)">\s*=\s*\{[\s\S]*?\bid:\s*"([^"]+)"/g;

const NAME = /\bname:\s*\{\s*zh:\s*"([^"]*)",\s*en:\s*"([^"]*)"\s*\}/;

/** The block definitions in a source text (`const x: BlockDefinition<"slot"> = { id: "…", name: { zh, en }, … }`). */
export function definitionsIn(source: string): { slot: string; id: string; name: Text | null }[] {
  return [...source.matchAll(DEFINITION)].map((m) => ({ slot: m[1], id: m[2], name: nameIn(source.slice(m.index! + m[0].length)) }));
}

/** The first `name: { zh: "…", en: "…" }` in a source text. */
export function nameIn(source: string): Text | null {
  const m = source.match(NAME);
  return m ? { zh: m[1], en: m[2] } : null;
}

let scanned: Promise<BlockSource[]> | null = null;

/** Every block definition in the page's sources (read once). */
export function blockSources(): Promise<BlockSource[]> {
  return (scanned ??= Promise.all(
    pageFiles().map(async (path) => {
      const kind = (Object.keys(ROOTS) as CoreKind[]).find((k) => ROOTS[k].some((r) => path.startsWith(r)));
      if (!kind) return [];
      return definitionsIn(await pageSource(path)).map((d) => ({ kind, path, ...d }));
    }),
  ).then((all) => all.flat()));
}

const LEARN = import.meta.glob("../../docs/learn/**/*.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const API = import.meta.glob(["../../docs/simulator-api.md", "../../docs/motion-api.md"], { query: "?raw", import: "default" }) as Record<
  string,
  () => Promise<string>
>;

const LEARN_DIR: Record<CoreKind, string> = { simulator: "sim", retargeter: "motion" };

/** The block's learning page (docs/learn/<core>/<id>.<lang>.md) in this language, else the other one; null without. */
export async function learnPage(kind: CoreKind, id: string, lang: Lang): Promise<string | null> {
  for (const l of [lang, lang === "zh" ? "en" : "zh"]) {
    const load = LEARN[`../../docs/learn/${LEARN_DIR[kind]}/${id}.${l}.md`];
    if (load) return load();
  }
  return null;
}

/** The core's plugin API document. */
export function apiPage(kind: CoreKind): Promise<string> {
  return API[kind === "simulator" ? "../../docs/simulator-api.md" : "../../docs/motion-api.md"]();
}
