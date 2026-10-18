/**
 * Type errors in the user's code, shown inline while they edit (not needed to run it: compile.ts only blanks the
 * types). The TypeScript compiler runs in a worker, off the page's frame loop, loaded the first time it is needed:
 * a classic worker made of typescript.js (it defines the global `ts`) and the checker, which checks the user's file
 * against the page's own sources and the declarations of three, Rapier and the standard library.
 */
import type { Text } from "../i18n";
import { scanImports } from "./compile";
import { pageSource, resolveSpecifier } from "./loader";

export interface TypeProblem {
  from: number;
  to: number;
  message: Text;
}

const LIBS = import.meta.glob(
  [
    "/node_modules/typescript/lib/lib.es5.d.ts",
    "/node_modules/typescript/lib/lib.es20*.d.ts",
    "/node_modules/typescript/lib/lib.decorators*.d.ts",
    "/node_modules/typescript/lib/lib.dom.d.ts",
    "/node_modules/typescript/lib/lib.dom.iterable.d.ts",
  ],
  { query: "?raw", import: "default", exhaustive: true },
) as Record<string, () => Promise<string>>;

/** The packages user code may import, as declaration files: three's and Rapier's (one chunk each, loaded once). */
const PACKAGE_TYPES: Record<string, { entry: string; load: () => Promise<Record<string, string>> }> = {
  three: { entry: "/node_modules/@types/three/index.d.ts", load: () => import("./types/three").then((m) => m.files) },
  "@dimforge/rapier3d-compat": { entry: "/node_modules/@dimforge/rapier3d-compat/dist/rapier.d.ts", load: () => import("./types/rapier").then((m) => m.files) },
};

/** The worker's global, from typescript.js. */
declare const ts: typeof import("typescript");

/** The checker, as the worker's source (it runs there, so it uses nothing from this module). */
function checker() {
  const files = new Map<string, string>();
  const cache = new Map<string, { text: string; sf: import("typescript").SourceFile }>();
  const entries: Record<string, string> = {};
  let program: import("typescript").Program | undefined;
  const options: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
    skipLibCheck: true, noEmit: true, isolatedModules: true, types: [], lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const exists = (f: string) => files.has(f);
  function resolve(spec: string, from: string): import("typescript").ResolvedModuleFull | undefined {
    if (entries[spec]) return { resolvedFileName: entries[spec], extension: ts.Extension.Dts, isExternalLibraryImport: true };
    if (!spec.startsWith(".")) return undefined;
    const dir = from.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "..") dir.pop();
      else if (part !== ".") dir.push(part);
    }
    const base = dir.join("/");
    const external = base.includes("/node_modules/");
    for (const f of [base, `${base}.ts`, `${base}.d.ts`, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".d.ts"), `${base}/index.ts`, `${base}/index.d.ts`]) {
      if (exists(f)) return { resolvedFileName: f, extension: f.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts, isExternalLibraryImport: external };
    }
    return undefined;
  }
  const host: import("typescript").CompilerHost = {
    getSourceFile(name, lang) {
      const text = files.get(name);
      if (text === undefined) return undefined;
      const hit = cache.get(name);
      if (hit && hit.text === text) return hit.sf;
      const sf = ts.createSourceFile(name, text, lang, true);
      cache.set(name, { text, sf });
      return sf;
    },
    getDefaultLibFileName: () => "/lib/lib.d.ts",
    getDefaultLibLocation: () => "/lib",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: exists,
    readFile: (f) => files.get(f),
    directoryExists: () => true,
    resolveModuleNameLiterals: (literals, containing) => literals.map((l) => ({ resolvedModule: resolve(l.text, containing) })),
  };
  self.onmessage = (e: MessageEvent) => {
    const m = e.data as { files?: [string, string][]; entries?: Record<string, string>; check?: { id: number; path: string; code: string } };
    for (const [path, text] of m.files ?? []) files.set(path, text);
    Object.assign(entries, m.entries ?? {});
    if (!m.check) return;
    const { id, path, code } = m.check;
    files.set(path, code);
    try {
      program = ts.createProgram({ rootNames: [path], options, host, oldProgram: program });
      const sf = program.getSourceFile(path)!;
      const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
      const problems = diags.map((d) => ({ from: d.start ?? 0, to: (d.start ?? 0) + Math.max(1, d.length ?? 1), message: ts.flattenDiagnosticMessageText(d.messageText, "\n"), code: d.code }));
      self.postMessage({ id, problems });
    } catch (err) {
      self.postMessage({ id, error: String(err) });
    }
  };
}

let worker: Worker | null = null;
let ids = 0;
const waiting = new Map<number, (r: { problems?: { from: number; to: number; message: string; code: number }[]; error?: string }) => void>();
/** Files already sent to the worker. */
const sent = new Set<string>();

async function start(): Promise<Worker> {
  if (worker) return worker;
  const compiler = (await import("typescript/lib/typescript.js?raw")).default;
  const w = new Worker(URL.createObjectURL(new Blob([compiler, `\n;(${checker.toString()})();`], { type: "text/javascript" })));
  w.onmessage = (e) => {
    const { id, ...rest } = e.data as { id: number };
    waiting.get(id)?.(rest);
    waiting.delete(id);
  };
  const libs = await Promise.all(Object.entries(LIBS).map(async ([k, load]) => [`/lib/${k.split("/").pop()}`, await load()] as [string, string]));
  w.postMessage({ files: libs });
  return (worker = w);
}

/** The page files (and package declarations) a source needs, transitively; those not sent to the worker yet. */
async function closure(path: string, code: string): Promise<{ files: [string, string][]; entries: Record<string, string> }> {
  const files: [string, string][] = [];
  const entries: Record<string, string> = {};
  const queue: [string, string][] = [[path, code]];
  const seen = new Set([path]);
  while (queue.length) {
    const [from, text] = queue.pop()!;
    for (const spec of scanImports(text, "ts")) {
      const pkg = PACKAGE_TYPES[spec];
      if (pkg) {
        entries[spec] = pkg.entry;
        if (!sent.has(pkg.entry)) {
          sent.add(pkg.entry);
          files.push(...Object.entries(await pkg.load()));
        }
        continue;
      }
      let target: string;
      try {
        target = resolveSpecifier(spec, from);
      } catch {
        continue; // the compiler reports it
      }
      if (seen.has(target)) continue;
      seen.add(target);
      const source = await pageSource(target);
      if (!sent.has(target)) {
        sent.add(target);
        files.push([`/src/${target}`, source]);
      }
      queue.push([target, source]);
    }
  }
  return { files, entries };
}

/** Type problems of the user's source at `path` (a path below src/, as the loader takes it). */
export async function checkTypes(path: string, code: string): Promise<TypeProblem[]> {
  const w = await start();
  const { files, entries } = await closure(path, code);
  const id = ++ids;
  const result = new Promise<{ problems?: { from: number; to: number; message: string; code: number }[]; error?: string }>((r) => waiting.set(id, r));
  w.postMessage({ files, entries, check: { id, path: `/src/${path}`, code } });
  const r = await result;
  if (r.error) throw new Error(r.error);
  return (r.problems ?? []).map((p) => ({ from: p.from, to: p.to, message: { zh: `类型 TS${p.code}：${p.message}`, en: `Type TS${p.code}: ${p.message}` } }));
}
