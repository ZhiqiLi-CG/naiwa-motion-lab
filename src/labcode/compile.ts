/**
 * A user's source → a JavaScript module the browser can import.
 *
 * TypeScript is turned into JavaScript by blanking its types: annotations, type-only declarations and modifiers become
 * spaces, so every line and column of the JavaScript is where the user wrote it and an error points at their code.
 * Imports whose names are only used as types are dropped, as the bundler drops them. What would need real code
 * generation (enums, namespaces, constructor parameter properties) is reported instead of being guessed at.
 *
 * Import specifiers are rewritten by the caller's `resolve` (the lab maps them to the page's own modules).
 */
import { javascriptLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import type { SyntaxNode } from "@lezer/common";
import type { Text } from "../i18n";

export type SourceLang = "ts" | "js";

export interface SourceProblem {
  from: number;
  to: number;
  message: Text;
}

export interface Compiled {
  code: string;
  /** What cannot be compiled (the module is not loaded). */
  problems: SourceProblem[];
  /** Where the editor's parser lost its way. Only a hint: it also stumbles on some valid code, so the browser decides
   *  whether there is a syntax error and these say where. */
  syntax: SourceProblem[];
}

const parserFor = (lang: SourceLang) => (lang === "ts" ? typescriptLanguage : javascriptLanguage).parser;

/** Every module specifier the source imports or re-exports (static and literal dynamic imports), in order. */
export function scanImports(source: string, lang: SourceLang): string[] {
  const out = new Set<string>();
  const tree = parserFor(lang).parse(source);
  tree.iterate({
    enter(n) {
      if (n.name === "ImportDeclaration" || n.name === "ExportDeclaration" || n.name === "DynamicImport") {
        const s = n.node.getChild("String");
        if (s) out.add(unquote(source.slice(s.from, s.to)));
        return n.name === "DynamicImport";
      }
    },
  });
  return [...out];
}

/** Compile the source; `resolve` gives the specifier each import should load instead. */
export function compile(original: string, lang: SourceLang, resolve: (specifier: string) => string): Compiled {
  const source = lang === "ts" ? blankExportedTypes(original) : original;
  const tree = parserFor(lang).parse(source);
  const problems: SourceProblem[] = [];
  const syntax: SourceProblem[] = [];
  const edits: { from: number; to: number; insert?: string }[] = [];
  const blank = (from: number, to: number) => edits.push({ from, to });
  const unsupported = (n: SyntaxNode, zh: string, en: string) => problems.push({ from: n.from, to: n.to, message: { zh, en } });
  const imports: SyntaxNode[] = [];
  const exportsFrom: SyntaxNode[] = [];
  const dynamicImports: SyntaxNode[] = [];
  /** Names read as values outside imports, to tell value imports from type-only ones. */
  const used = new Set<string>();
  const text = (n: SyntaxNode) => source.slice(n.from, n.to);
  const kids = (n: SyntaxNode) => {
    const out: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
    return out;
  };
  /** Names a local `export { a, b as c }` reads. */
  const exportGroup = (group: SyntaxNode) => {
    for (let c = group.firstChild; c; c = c.nextSibling) {
      if (c.name === "VariableName" && c.prevSibling?.name !== "as") used.add(text(c));
    }
  };
  /** A declaration to drop, with its `export` when it has one. */
  const dropDeclaration = (n: SyntaxNode) => {
    const target = n.parent?.name === "ExportDeclaration" ? n.parent : n;
    blank(target.from, target.to);
  };

  tree.iterate({
    enter(ref) {
      const n = ref.node;
      if (ref.type.isError) {
        // An error node is often empty (something is missing here): mark the character before it.
        const from = n.from < n.to ? n.from : Math.max(0, n.from - 1);
        syntax.push({ from, to: Math.max(n.to, from + 1), message: { zh: "语法错误", en: "Syntax error" } });
        return false;
      }
      switch (ref.name) {
        case "ImportDeclaration":
          imports.push(n);
          return false;
        case "ExportDeclaration": {
          if (n.getChild("from")) exportsFrom.push(n);
          // `export type { A }`: types only.
          if (kids(n)[1]?.name === "type") {
            blank(n.from, n.to);
            return false;
          }
          const group = n.getChild("ExportGroup");
          if (group) {
            exportGroup(group);
            return false;
          }
          return;
        }
        case "DynamicImport":
          dynamicImports.push(n);
          return;
        case "VariableName":
          used.add(text(n));
          return;
        case "Property": {
          // Shorthand `{ name }` reads the variable `name`.
          const parts = kids(n);
          if (parts.length === 1 && parts[0].name === "PropertyDefinition") used.add(text(parts[0]));
          return;
        }
      }
      if (lang !== "ts") return;
      switch (ref.name) {
        case "TypeAnnotation":
        case "TypePredicate":
        case "TypeParamList":
        case "TypeArgList":
        case "Optional":
          blank(n.from, n.to);
          return false;
        case "TypeAliasDeclaration":
        case "InterfaceDeclaration":
        case "AmbientDeclaration":
          dropDeclaration(n);
          return false;
        case "EnumDeclaration":
          unsupported(n, "不支持 enum：请改用对象常量", "enum is not supported: use a constant object");
          return false;
        case "NamespaceDeclaration":
          unsupported(n, "不支持 namespace：请改用模块", "namespace is not supported: use a module");
          return false;
        case "FunctionDeclaration":
          // An overload signature (no body).
          if (!n.getChild("Block")) {
            dropDeclaration(n);
            return false;
          }
          return;
        case "ClassDeclaration":
        case "ClassExpression": {
          const impl = n.getChild("implements");
          const body = n.getChild("ClassBody");
          if (impl && body) blank(impl.from, body.from);
          const abs = n.getChild("abstract");
          if (abs) blank(abs.from, abs.to);
          return;
        }
        case "PropertyDeclaration":
        case "MethodDeclaration": {
          const parts = kids(n);
          const declared = parts.some((c) => c.name === "declare" || c.name === "abstract");
          if (declared || (ref.name === "MethodDeclaration" && !n.getChild("Block"))) {
            blank(n.from, n.to);
            return false;
          }
          for (const c of parts) {
            if (c.name === "Privacy" || c.name === "readonly" || c.name === "override") blank(c.from, c.to);
            // Definite assignment `x!: T`.
            if (c.name === "LogicOp" && text(c) === "!") blank(c.from, c.to);
          }
          return;
        }
        case "ParamList": {
          const props: string[] = [];
          for (const c of kids(n)) {
            if (c.name === "Privacy" || c.name === "readonly") {
              // A parameter property `constructor(readonly a: T)`: the modifier goes, an assignment comes in.
              blank(c.from, c.to);
              let name = c.nextSibling;
              while (name && name.name !== "VariableDefinition") name = name.nextSibling;
              if (name && !props.includes(text(name))) props.push(text(name));
            }
            if (c.name === "this") {
              // `this: T` declares the receiver's type only.
              const ann = c.nextSibling;
              const comma = ann?.nextSibling;
              blank(c.from, comma?.name === "," ? comma.to : (ann?.to ?? c.to));
            }
          }
          if (props.length) {
            const body = n.parent?.getChild("Block");
            if (!body) {
              unsupported(n, "参数属性只能用在有函数体的构造函数里", "Parameter properties need a constructor with a body");
              return;
            }
            // After `super(...)` when the class extends another (this is not usable before it), else first.
            const first = body.firstChild?.nextSibling;
            const callsSuper = first?.name === "ExpressionStatement" && first.firstChild?.firstChild?.name === "super";
            const at = callsSuper ? first.to : body.firstChild!.to;
            edits.push({ from: at, to: at, insert: props.map((p) => ` this.${p} = ${p};`).join("") });
          }
          return;
        }
        case "BinaryExpression": {
          const op = kids(n).find((c) => c.name === "as" || c.name === "satisfies");
          if (op) {
            blank(op.from, n.to);
            // The left side may still read variables.
            return;
          }
          return;
        }
        case "PostfixExpression": {
          const op = n.lastChild;
          if (op?.name === "LogicOp" && text(op) === "!") blank(op.from, op.to);
          return;
        }
        case "PrefixCast": {
          const close = kids(n).find((c) => c.name === ">");
          if (close) blank(n.from, close.to);
          return;
        }
      }
    },
  });

  const quote = (spec: string) => JSON.stringify(resolve(spec));
  for (const n of imports) edits.push({ from: n.from, to: n.to, insert: rewriteImport(n, source, lang, used, quote) });
  for (const n of [...exportsFrom, ...dynamicImports]) {
    const s = n.getChild("String");
    if (s) edits.push({ from: s.from, to: s.to, insert: quote(unquote(source.slice(s.from, s.to))) });
  }
  return { code: applyEdits(source, edits), problems, syntax };
}

/** An import with its type-only and unused names removed and its specifier resolved; nothing (blank lines) when no
 *  value is left to import. */
function rewriteImport(n: SyntaxNode, source: string, lang: SourceLang, used: Set<string>, quote: (s: string) => string): string {
  const text = (c: SyntaxNode) => source.slice(c.from, c.to);
  const spec = n.getChild("String");
  const lines = "\n".repeat(text(n).split("\n").length - 1);
  if (!spec) return " ".repeat(n.to - n.from);
  const parts: SyntaxNode[] = [];
  for (let c = n.firstChild; c; c = c.nextSibling) parts.push(c);
  if (parts[1]?.name === "type") return lines;
  // TypeScript keeps a value import only when a value uses it; JavaScript keeps every import.
  const keep = (local: string) => lang === "js" || used.has(local);
  let defaultName: string | null = null;
  let namespace: string | null = null;
  const named: string[] = [];
  let bindings = 0;
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i];
    if (c.name === "VariableDefinition") {
      bindings++;
      if (parts[i - 1].name === "as") namespace = keep(text(c)) ? text(c) : null;
      else defaultName = keep(text(c)) ? text(c) : null;
    } else if (c.name === "ImportGroup") {
      const g: SyntaxNode[] = [];
      for (let k = c.firstChild; k; k = k.nextSibling) g.push(k);
      for (let k = 0; k < g.length; k++) {
        if (g[k].name !== "VariableName" && g[k].name !== "VariableDefinition" && g[k].name !== "type") continue;
        if (g[k].name === "type") {
          // `type Name` (or `type Name as Alias`): types only.
          bindings++;
          while (k + 1 < g.length && g[k + 1].name !== "," && g[k + 1].name !== "}") k++;
          continue;
        }
        bindings++;
        const imported = text(g[k]);
        let local = imported;
        if (g[k + 1]?.name === "as") {
          local = text(g[k + 2]);
          k += 2;
        }
        if (keep(local)) named.push(imported === local ? imported : `${imported} as ${local}`);
      }
    }
  }
  const from = quote(unquote(text(spec)));
  if (bindings === 0) return `import ${from};${lines}`;
  const clauses = [defaultName, namespace && `* as ${namespace}`, named.length ? `{ ${named.join(", ")} }` : null].filter(Boolean);
  if (!clauses.length) return lines;
  // `import A, * as B` is valid; `import * as B, { c }` is not, so a namespace and names become two imports.
  if (namespace && named.length) return `import ${[defaultName, `* as ${namespace}`].filter(Boolean).join(", ")} from ${from}; import { ${named.join(", ")} } from ${from};${lines}`;
  return `import ${clauses.join(", ")} from ${from};${lines}`;
}

/**
 * `export { a, type B }`: the parser does not know an inline `type` in an export list (it loses its way there), so
 * those names are blanked, with their comma, before parsing. Export lists are found from the statements' starts, so
 * text in strings and comments is left alone.
 */
function blankExportedTypes(source: string): string {
  let out = source;
  typescriptLanguage.parser.parse(source).iterate({
    enter(n) {
      if (n.name !== "ExportDeclaration") return n.name === "Script";
      const open = source.indexOf("{", n.from);
      const close = source.indexOf("}", open);
      if (open < 0 || close < 0 || source.slice(n.from + 6, open).trim() !== "") return false;
      const group = source.slice(open + 1, close);
      const kept = group.split(",").map((item) => (/^\s*type\s/.test(item) ? null : item));
      if (kept.every((k) => k !== null)) return false;
      // Blank each type item with the comma after it (or before it, for the last one).
      let rebuilt = "";
      group.split(",").forEach((item, i, all) => {
        const last = i === all.length - 1;
        if (kept[i] === null) {
          rebuilt += " ".repeat(item.length);
          if (!last) rebuilt += " ";
          else if (rebuilt.length) {
            const lastComma = rebuilt.lastIndexOf(",");
            if (lastComma >= 0) rebuilt = rebuilt.slice(0, lastComma) + " " + rebuilt.slice(lastComma + 1);
          }
        } else rebuilt += item + (last ? "" : ",");
      });
      out = out.slice(0, open + 1) + rebuilt + out.slice(close);
      return false;
    },
  });
  return out;
}

function unquote(s: string): string {
  return s.slice(1, -1);
}

/** Apply edits (blank when there is no insert, keeping newlines); overlapping edits inside a larger one are dropped. */
function applyEdits(source: string, edits: { from: number; to: number; insert?: string }[]): string {
  edits.sort((a, b) => a.from - b.from || b.to - a.to);
  let out = "";
  let at = 0;
  for (const e of edits) {
    if (e.from < at) continue;
    out += source.slice(at, e.from);
    out += e.insert ?? source.slice(e.from, e.to).replace(/[^\n]/g, " ");
    at = e.to;
  }
  return out + source.slice(at);
}
