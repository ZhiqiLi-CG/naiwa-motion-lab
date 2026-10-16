/** A tiny element builder: h("button", { class: "nw-btn", onclick }, icon("hand"), "手"). */
import { ICONS, type IconName } from "./icons";

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: never) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
}

const SVG = "http://www.w3.org/2000/svg";

export function icon(name: IconName, cls = "nw-icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

/** The 奶蛙 mark: pear body, cream belly, side eyes, hands on the belly (its signature pose). */
export function frogMark(cls = "nw-mark"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = FROG;
  return svg;
}

const FROG = `
<path class="f-body" d="M20 3.5c-5.6 0-9 4.4-9 9.6 0 1.8-1.6 3.4-3.2 6.4C5.2 24.6 5.4 36.5 20 36.5s14.8-11.9 12.2-17c-1.6-3-3.2-4.6-3.2-6.4 0-5.2-3.4-9.6-9-9.6z"/>
<ellipse class="f-belly" cx="20" cy="26.5" rx="8.6" ry="7.6"/>
<circle class="f-eye" cx="12.6" cy="11.6" r="3.1"/><circle class="f-pupil" cx="12.2" cy="11.8" r="1.45"/>
<circle class="f-eye" cx="27.4" cy="11.6" r="3.1"/><circle class="f-pupil" cx="27.8" cy="11.8" r="1.45"/>
<path class="f-mouth" d="M15.2 15.6c2.8 2.6 6.8 2.6 9.6 0"/>
<ellipse class="f-hand" cx="12.6" cy="26.4" rx="2.4" ry="1.7" transform="rotate(-35 12.6 26.4)"/>
<ellipse class="f-hand" cx="27.4" cy="26.4" rx="2.4" ry="1.7" transform="rotate(35 27.4 26.4)"/>`;
