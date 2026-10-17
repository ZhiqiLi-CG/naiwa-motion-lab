import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, scanImports } from "./compile";

const same = (s: string) => s;
const ts = (src: string) => compile(src, "ts", same);

/** Every .ts file under dir (tests and declaration files aside). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

describe("compile", () => {
  it("blanks types and keeps every line where it was", () => {
    const src = `class A<T> implements B {\n  private readonly x?: number = 1;\n  declare y: string;\n  f(a: T, b?: number): T { return (a as T)!; }\n}\n`;
    const { code, problems } = ts(src);
    expect(problems).toEqual([]);
    expect(code.split("\n").length).toBe(src.split("\n").length);
    expect(code.replace(/\s+/g, "")).toBe("classA{x=1;f(a,b){return(a);}}");
  });

  it("drops imports that are only used as types and keeps value imports", () => {
    const src = `import { A, B, type C } from "./x";\nimport type { D } from "./y";\nimport * as T from "three";\nconst b: A = new B();\nexport default { b };\n`;
    const { code } = ts(src);
    expect(code).toContain(`import { B } from "./x";`);
    expect(code).not.toContain("./y");
    expect(code).not.toContain("three");
  });

  it("drops interfaces, type aliases and overloads with their export", () => {
    const { code } = ts(`export interface I { a: number }\nexport type N = number;\nexport function f(a: number): void;\nexport function f(a) { return a; }\n`);
    expect(code.replace(/\s+/g, "")).toBe("exportfunctionf(a){returna;}");
  });

  it("reports what it cannot blank", () => {
    expect(ts(`enum E { A }`).problems[0].message.en).toMatch(/enum/);
    expect(ts(`const x = ;`).syntax[0]).toMatchObject({ from: 9, message: { en: "Syntax error" } });
  });

  it("turns parameter properties into assignments", () => {
    const { code, problems } = ts(`class K extends B {\n  constructor(private readonly a: number, b: string) {\n    super();\n  }\n}`);
    expect(problems).toEqual([]);
    expect(code.replace(/\s+/g, "")).toBe("classKextendsB{constructor(a,b){super();this.a=a;}}");
  });

  it("drops inline type names from export groups", () => {
    const { code, problems } = ts(`import { a } from "./a";\nexport { a, type B } from "./x";\nexport { type C, a as d };\n`);
    expect(problems).toEqual([]);
    expect(code.replace(/\s+/g, "")).toBe(`import{a}from"./a";export{a}from"./x";export{ad};`.replace("ad", "a as d").replace(/\s+/g, ""));
  });

  it("rewrites specifiers through resolve", () => {
    const src = `import { a } from "./a";\nexport * from "./b";\nconst m = import("./c");\nconsole.log(a, m);`;
    expect(scanImports(src, "js")).toEqual(["./a", "./b", "./c"]);
    const { code } = compile(src, "js", (s) => `blob:${s}`);
    expect(code).toContain(`from "blob:./a"`);
    expect(code).toContain(`from "blob:./b"`);
    expect(code).toContain(`import("blob:./c")`);
  });

  it("turns every simulation source into JavaScript V8 accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "labcode-"));
    const files = sources(join(__dirname, "../sim"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { code, problems } = ts(readFileSync(file, "utf8"));
      expect(problems, file).toEqual([]);
      const out = join(dir, "check.mjs");
      writeFileSync(out, code);
      try {
        execFileSync(process.execPath, ["--check", out], { stdio: "pipe" });
      } catch (e) {
        throw new Error(`${file}: ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
      }
    }
  });
});
