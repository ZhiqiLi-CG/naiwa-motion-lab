// Components use only the colour tokens, so text contrast is a property of the tokens: every text token meets WCAG AA
// (4.5:1) on every surface it can sit on, in both themes, including the translucent floating panels with any stage
// (white or black) behind them.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Rgba = [number, number, number, number];

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) tokens.set(m[1]!, m[2]!.trim());
  return tokens;
}

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = "1"] = rgba[1]!.split(",").map((p) => p.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`unsupported colour ${value}`);
}

const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
};

function luminance([r, g, b]: Rgba): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");
const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];
const TEXT = [
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "accent-text",
  "leaf-text",
  "danger-text",
  "success-text",
  "warning-text",
  "info-text",
  "neutral-text",
];
const SOFT_PAIRS = [
  ["accent-soft", "accent-text"],
  ["leaf-soft", "leaf-text"],
  ["danger-soft", "danger-text"],
  ["success-soft", "success-text"],
  ["warning-soft", "warning-text"],
  ["info-soft", "info-text"],
  ["neutral-soft", "neutral-text"],
] as const;

for (const [theme, selector] of [
  ["light", '[data-theme="light"] {'],
  ["dark", '[data-theme="dark"] {'],
] as const) {
  describe(`${theme} theme`, () => {
    const tokens = block(css, selector);
    const color = (name: string) => {
      const v = tokens.get(name);
      if (!v) throw new Error(`missing --${name} in ${theme}`);
      return parse(v);
    };
    // Opaque surfaces, and the floating panel over a white or a black stage.
    const surfaces: { name: string; rgba: Rgba }[] = [
      ...["bg-surface", "bg-raised", "bg-sunken"].map((n) => ({ name: n, rgba: color(n) })),
      { name: "bg-float over white", rgba: over(color("bg-float"), WHITE) },
      { name: "bg-float over black", rgba: over(color("bg-float"), BLACK) },
    ];
    const backgrounds = surfaces.flatMap((s) => [
      s,
      ...["bg-hover", "bg-active", "bg-selected"].map((o) => ({ name: `${o} on ${s.name}`, rgba: over(color(o), s.rgba) })),
    ]);

    it("every text token meets 4.5:1 on every surface and selection state", () => {
      const failures: string[] = [];
      for (const t of TEXT)
        for (const b of backgrounds) {
          const r = contrast(color(t), b.rgba);
          if (r < 4.5) failures.push(`--${t} on ${b.name}: ${r.toFixed(2)}`);
        }
      expect(failures).toEqual([]);
    });

    it("chip text meets 4.5:1 on its own soft tint", () => {
      const failures: string[] = [];
      for (const [soft, text] of SOFT_PAIRS)
        for (const s of surfaces) {
          const r = contrast(color(text), over(color(soft), s.rgba));
          if (r < 4.5) failures.push(`--${text} on --${soft} over ${s.name}: ${r.toFixed(2)}`);
        }
      expect(failures).toEqual([]);
    });

    it("text on the filled buttons meets 4.5:1", () => {
      for (const fill of ["accent", "accent-hover", "accent-press"])
        expect(contrast(color("on-accent"), color(fill)), fill).toBeGreaterThanOrEqual(4.5);
      for (const fill of ["danger", "danger-hover"])
        expect(contrast(color("on-danger"), color(fill)), fill).toBeGreaterThanOrEqual(4.5);
    });
  });
}

describe("media surfaces (dark in both themes)", () => {
  const tokens = block(css, ":root {");
  const color = (name: string) => parse(tokens.get(name)!);
  it("labels on the scrim stay readable over any picture", () => {
    for (const behind of [WHITE, BLACK]) {
      const scrim = over(color("media-scrim"), behind);
      for (const t of ["media-text", "media-text-secondary", "media-accent"])
        expect(contrast(color(t), scrim), t).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("placeholder text on the bare preview meets 4.5:1", () => {
    for (const t of ["media-text", "media-text-secondary"])
      expect(contrast(color(t), color("media-bg")), t).toBeGreaterThanOrEqual(4.5);
  });
  it("dance-card glyph ink reads on every candy disc", () => {
    for (const c of ["candy-1", "candy-2", "candy-3", "candy-4", "candy-5"])
      expect(contrast(color("candy-ink"), color(c)), c).toBeGreaterThanOrEqual(4.5);
  });
});

describe("colour usage", () => {
  it("no stylesheet or UI source outside tokens.css writes a raw colour", () => {
    const roots = [resolve(__dirname), resolve(__dirname, "../ui")];
    const files: string[] = [];
    for (const root of roots)
      for (const e of readdirSync(root, { withFileTypes: true }))
        if (e.isFile() && /\.(css|ts)$/.test(e.name) && !e.name.endsWith(".test.ts") && e.name !== "tokens.css")
          files.push(resolve(root, e.name));
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\(\s*\d/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map(({ line, i }) => `${file}:${i + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
