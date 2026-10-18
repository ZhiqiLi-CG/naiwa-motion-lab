/**
 * Loading a user's source as a module of the page.
 *
 * The source is compiled (compile.ts) and imported from a Blob URL. Its imports resolve to the page's own modules,
 * the very instances the page runs: `three`, `@dimforge/rapier3d-compat`, and the simulation's and motion's source
 * files by relative path, exactly as the built-in code imports them, so a copy of a built-in block runs unchanged.
 * Each imported module is handed over through a tiny shim module that re-exports its namespace.
 *
 * While a user's module runs, the page's `register…` functions (registerBlock, registerSimulator, registerRetargeter…)
 * collect what it registers instead of registering it: the lab registers it, as the user's own, once it has passed
 * its checks.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { compile, scanImports, type SourceLang, type SourceProblem } from "./compile";

/** The page's modules by path below src/ ("sim/api.ts"), loaded on demand. */
const MODULES = import.meta.glob(["../sim/**/*.ts", "../motion/**/*.ts", "../algorithms/**/*.ts", "../contracts.ts", "../i18n.ts", "!**/*.test.ts"]);
const SOURCES = import.meta.glob(["../sim/**/*.ts", "../motion/**/*.ts", "../algorithms/**/*.ts", "../contracts.ts", "../i18n.ts", "!**/*.test.ts"], {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;
const PACKAGES: Record<string, () => Promise<Record<string, unknown>>> = {
  three: async () => THREE,
  "@dimforge/rapier3d-compat": async () => ({ ...RAPIER, default: RAPIER }),
};

const pathOf = (globKey: string) => globKey.replace(/^\.\.\//, "");
const byPath = new Map(Object.keys(MODULES).map((k) => [pathOf(k), k]));

/** The source text of one of the page's files ("sim/cpu/collision.ts"). */
export function pageSource(path: string): Promise<string> {
  const key = byPath.get(path);
  if (!key) return Promise.reject(new Error(`labcode: no source file ${path}`));
  return SOURCES[key]();
}

/** Every source file of the page below src/ that user code may import or start from. */
export function pageFiles(): string[] {
  return [...byPath.keys()];
}

/** What a user's code registered while it loaded: the function's name and its first argument. */
export interface Registration {
  fn: string;
  def: unknown;
}

export interface LoadedModule {
  exports: Record<string, unknown>;
  registered: Registration[];
}

/** A module that could not be loaded, with where in the source it went wrong when that is known. */
export class LoadError extends Error {
  constructor(
    message: string,
    readonly problems: SourceProblem[],
    /** compile: the source is not valid TypeScript the lab can run; load: an import is missing, or the module threw
     *  while it ran. */
    readonly phase: "compile" | "load",
  ) {
    super(message);
  }
}

export interface UserSource {
  /** Shown in error messages and stack traces, e.g. "my-collision.ts". */
  name: string;
  /** Where it lives among the page's files ("sim/user/my-collision.ts"): relative imports resolve from here. */
  path: string;
  lang: SourceLang;
  code: string;
}

const SHIMS = Symbol.for("naiwa.labcode.modules");
type ShimTable = Map<string, Record<string, unknown>>;
const table: ShimTable = ((globalThis as Record<symbol, unknown>)[SHIMS] ??= new Map()) as ShimTable;
const shimUrls = new Map<string, string>();
/** The registrations of the module loading now (loads run one at a time). */
let capturing: Registration[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Blob URLs of loaded user modules → their names, to show stack traces in the user's terms. */
const userUrls = new Map<string, UserSource>();

/** Load a user's source as a module. Rejects with LoadError. */
export function loadUserModule(src: UserSource): Promise<LoadedModule> {
  const run = queue.then(() => load(src));
  queue = run.catch(() => undefined);
  return run;
}

async function load(src: UserSource): Promise<LoadedModule> {
  const urls = new Map<string, string>();
  for (const spec of scanImports(src.code, src.lang)) {
    const url = await shimFor(spec, src.path).catch((e: Error) => {
      const at = src.code.indexOf(spec);
      throw new LoadError(e.message, [{ from: Math.max(0, at), to: Math.max(0, at) + spec.length, message: { zh: e.message, en: e.message } }], "load");
    });
    urls.set(spec, url);
  }
  const { code, problems, syntax } = compile(src.code, src.lang, (spec) => urls.get(spec) ?? spec);
  if (problems.length) throw new LoadError(problems[0].message.en, problems, "compile");
  const url = moduleUrl(`${code}\n//# sourceURL=${src.name}`);
  userUrls.set(url, src);
  capturing = [];
  try {
    const exports = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    return { exports, registered: capturing };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err instanceof SyntaxError) throw new LoadError(`SyntaxError: ${err.message}`, syntax.slice(0, 1), "compile");
    const at = locate(err);
    throw new LoadError(`${err.name}: ${err.message}`, at && at.source === src ? [lineProblem(src.code, at.line, at.column, err.message)] : [], "load");
  } finally {
    capturing = null;
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/** The page module (or package) a specifier names, as a shim's URL. */
async function shimFor(spec: string, from: string): Promise<string> {
  const id = resolveSpecifier(spec, from);
  const cached = shimUrls.get(id);
  if (cached) return cached;
  const ns = id in PACKAGES ? await PACKAGES[id]() : ((await MODULES[byPath.get(id)!]()) as Record<string, unknown>);
  table.set(id, capture(ns));
  const names = Object.keys(ns).filter((k) => k !== "default");
  const shim =
    `const m = globalThis[Symbol.for("naiwa.labcode.modules")].get(${JSON.stringify(id)});\n` +
    (names.length ? `export const { ${names.join(", ")} } = m;\n` : "") +
    ("default" in ns ? "export default m.default;\n" : "");
  const url = moduleUrl(shim);
  shimUrls.set(id, url);
  return url;
}

/** A URL the module's code can be imported from: a Blob URL in the browser (short, so stack traces stay readable);
 *  Node (the tests) imports only data: URLs. */
function moduleUrl(code: string): string {
  if (typeof window === "undefined") return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  return URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
}

/** A package name, or a page file's path for a relative specifier. */
export function resolveSpecifier(spec: string, from: string): string {
  if (spec in PACKAGES) return spec;
  if (!spec.startsWith(".")) {
    throw new Error(`"${spec}" is not available here: import three, @dimforge/rapier3d-compat or the page's own files by relative path`);
  }
  const dir = from.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") dir.pop();
    else if (part !== ".") dir.push(part);
  }
  const base = dir.join("/");
  for (const p of [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`]) if (byPath.has(p)) return p;
  throw new Error(`"${spec}" is not a file of the page (looked for src/${base}.ts)`);
}

/** The namespace with its register… functions collecting into the current load. */
function capture(ns: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ns };
  for (const [name, value] of Object.entries(ns)) {
    if (!/^register[A-Z]/.test(name) || typeof value !== "function") continue;
    out[name] = (def: unknown) => {
      if (capturing) capturing.push({ fn: name, def });
      else console.warn(`labcode: ${name} called after the module loaded; register at the top level of the module`);
      return () => undefined;
    };
  }
  return out;
}

/** Where an error happened in user code: the first stack frame in a user module. */
export function locate(err: Error): { source: UserSource; line: number; column: number } | null {
  for (const line of (err.stack ?? "").split("\n")) {
    for (const [url, source] of userUrls) {
      const m = line.includes(url) ? line.slice(line.indexOf(url) + url.length).match(/^:(\d+):(\d+)/) : null;
      const n = !m ? line.match(new RegExp(`${escape(source.name)}:(\\d+):(\\d+)`)) : null;
      const hit = m ?? n;
      if (hit) return { source, line: Number(hit[1]), column: Number(hit[2]) };
    }
  }
  return null;
}

/** The error's stack with user modules' URLs replaced by their names. */
export function userStack(err: Error): string {
  let s = err.stack ?? `${err.name}: ${err.message}`;
  for (const [url, source] of userUrls) s = s.split(url).join(source.name);
  return s;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A problem on a line and column (1-based) of the source. */
export function lineProblem(code: string, line: number, column: number, message: string): SourceProblem {
  let from = 0;
  for (let i = 1; i < line && from >= 0; i++) from = code.indexOf("\n", from) + 1;
  const end = code.indexOf("\n", from);
  const lineEnd = end < 0 ? code.length : end;
  const at = Math.min(from + Math.max(0, column - 1), lineEnd);
  return { from: at, to: Math.max(at + 1, lineEnd), message: { zh: message, en: message } };
}
