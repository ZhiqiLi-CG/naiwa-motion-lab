/**
 * The learning pages' Markdown, rendered simply as DOM (never as HTML strings): headings, paragraphs, lists, code
 * blocks, tables, inline code, bold, italics, links, and formulas shown as their TeX source in a formula style
 * (there is no math typesetter on the page).
 */

type Inline = Node | string;

const INLINE = /(`[^`]+`)|(\$[^$\n]+\$)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | null, ...children: Inline[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}

function link(text: Inline[], href: string): Node {
  // Only web links open; links between the docs' files stay text (there is no page for them here).
  if (!/^https?:\/\//.test(href)) return el("span", "nw-md-ref", ...text);
  const a = el("a", null, ...text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const [s] = m;
    if (m[1]) out.push(el("code", null, s.slice(1, -1)));
    else if (m[2]) out.push(el("span", "nw-md-math", s.slice(1, -1)));
    else if (m[3]) out.push(el("strong", null, ...inline(s.slice(2, -2))));
    else if (m[4]) out.push(el("em", null, ...inline(s.slice(1, -1))));
    else if (m[5]) {
      const close = s.indexOf("](");
      out.push(link(inline(s.slice(1, close)), s.slice(close + 2, -1)));
    } else out.push(link([s], s));
    at = m.index! + s.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The page as a fragment of elements. */
export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      out.append(el("pre", "nw-md-code", el("code", null, body.join("\n"))));
      continue;
    }
    if (line.trim().startsWith("$$")) {
      const first = line.trim().slice(2);
      const body: string[] = [];
      if (first.includes("$$")) {
        body.push(first.slice(0, first.indexOf("$$")));
        i++;
      } else {
        body.push(first);
        for (i++; i < lines.length && !lines[i].includes("$$"); i++) body.push(lines[i]);
        if (i < lines.length) body.push(lines[i++].split("$$")[0]);
      }
      out.append(el("pre", "nw-md-math nw-md-display", body.join("\n").trim()));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1) as 2 | 3 | 4;
      out.append(el(`h${level}`, "nw-md-h", ...inline(heading[2])));
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.match(/^\s*\|?\s*:?-{2,}/)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      const table = el(
        "table",
        "nw-md-table",
        el("thead", null, el("tr", null, ...head.map((c) => el("th", null, ...inline(c))))),
        el("tbody", null, ...rows.map((r) => el("tr", null, ...r.map((c) => el("td", null, ...inline(c)))))),
      );
      out.append(el("div", "nw-md-scroll", table));
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+/;
    if (item.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? "ol" : "ul", "nw-md-list");
      while (i < lines.length && item.test(lines[i])) {
        let text = lines[i].replace(item, "");
        // Continuation lines are indented.
        for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]) && !item.test(lines[i]); i++) text += " " + lines[i].trim();
        list.append(el("li", null, ...inline(text)));
      }
      out.append(list);
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*\$\$|\s*(?:[-*]|\d+\.)\s)/.test(lines[i]) && !lines[i].trim().startsWith("|"); i++) {
      para.push(lines[i].trim());
    }
    if (!para.length) {
      // A line no rule took (a stray table row): show it as it is.
      para.push(lines[i].trim());
      i++;
    }
    out.append(el("p", null, ...inline(para.join(" "))));
  }
  return out;
}
