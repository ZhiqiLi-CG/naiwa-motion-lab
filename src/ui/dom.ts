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

let marks = 0;

/** The 奶蛙 mark, as in assets-src/naiwa/references (the same drawing as public/icons/naiwa.svg): a laughing face
 *  with the tongue out over the huge cream belly, hands on the belly, in a round sticker. */
export function frogMark(cls = "nw-mark"): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = frogArt(`nwm${++marks}`);
  return svg;
}

const stop = (o: number, token: string) => `<stop offset="${o}" style="stop-color:var(--frog-${token})"/>`;
const fill = (token: string) => `style="fill:var(--frog-${token})"`;

function frogArt(id: string): string {
  return `<defs>
<radialGradient id="${id}b" cx="50%" cy="38%" r="70%">${stop(0, "bg-1")}${stop(1, "bg-2")}</radialGradient>
<radialGradient id="${id}s" gradientUnits="userSpaceOnUse" cx="215" cy="190" r="400">${stop(0, "skin-1")}${stop(0.5, "skin-2")}${stop(1, "skin-3")}</radialGradient>
<radialGradient id="${id}y" cx="45%" cy="35%" r="70%">${stop(0, "belly-1")}${stop(1, "belly-2")}</radialGradient>
<radialGradient id="${id}i" cx="45%" cy="40%" r="60%">${stop(0, "iris-1")}${stop(1, "iris-2")}</radialGradient>
<g id="${id}h" stroke-linecap="round"><path fill="none" stroke-width="46" style="stroke:var(--frog-arm)" d="M114 300C92 344 104 394 146 420"/><circle cx="150" cy="424" r="25" ${fill("hand")}/><path fill="none" stroke-width="15" style="stroke:var(--frog-hand)" d="M160 410L188 400M166 425L197 422M162 440L190 448M144 408L152 390"/></g>
<clipPath id="${id}c"><circle cx="256" cy="256" r="256"/></clipPath>
</defs>
<g clip-path="url(#${id}c)">
<rect width="512" height="512" fill="url(#${id}b)"/>
<g fill="url(#${id}s)"><path d="M256 84C320 84 356 126 362 180C368 236 448 290 458 388C466 466 452 540 436 600H76C60 540 46 466 54 388C64 290 144 236 150 180C156 126 192 84 256 84Z"/><circle cx="170" cy="168" r="40"/><circle cx="342" cy="168" r="40"/></g>
<ellipse cx="256" cy="452" rx="152" ry="122" fill="url(#${id}y)"/>
<use href="#${id}h"/><use href="#${id}h" transform="translate(512 0) scale(-1 1)"/>
<g class="nw-mark-eyes">
<circle cx="170" cy="166" r="30" fill="url(#${id}i)" stroke-width="3" style="stroke:var(--frog-iris-edge)"/><circle cx="342" cy="166" r="30" fill="url(#${id}i)" stroke-width="3" style="stroke:var(--frog-iris-edge)"/>
<circle cx="174" cy="168" r="14" ${fill("pupil")}/><circle cx="338" cy="168" r="14" ${fill("pupil")}/>
<circle cx="168" cy="160" r="5" ${fill("glint")}/><circle cx="332" cy="160" r="5" ${fill("glint")}/>
</g>
<path ${fill("mouth")} d="M184 214C220 226 292 226 328 214C330 268 300 300 256 300C212 300 182 268 184 214Z"/>
<path ${fill("teeth")} d="M188 216C222 228 290 228 324 216L322 234C290 244 222 244 190 234Z"/>
<path class="nw-mark-tongue" ${fill("tongue")} d="M222 266C232 252 280 252 290 266C298 280 296 312 280 324C268 334 244 334 232 324C216 312 214 280 222 266Z"/>
<path fill="none" stroke-width="3" stroke-linecap="round" style="stroke:var(--frog-tongue-line)" d="M256 272V310"/>
</g>`;
}
