/** How much of each window edge the UI covers right now, so the stage can keep the frog in the free middle (on a
 *  phone the open bottom sheet would otherwise sit on its belly). Also exposed to CSS as --inset-top/right/bottom/left. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const shown = (el: Element | null): el is HTMLElement => !!el && el.getClientRects().length > 0;

export function measureInsets(root: HTMLElement): Insets {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const rect = (sel: string) => {
    const el = root.querySelector(sel);
    return shown(el) ? el.getBoundingClientRect() : null;
  };
  // on a phone the sheet is a real box; on a desktop it only groups the floating panels
  const phone = getComputedStyle(root.querySelector(".nw-sheet")!).display !== "contents";
  const bottom = rect(phone ? ".nw-sheet" : ".nw-transport");
  const left = phone ? null : rect(".nw-panel--motion");
  const right = phone ? null : rect(".nw-panel--sim");
  return {
    top: Math.round(rect(".nw-topbar")?.bottom ?? 0),
    bottom: Math.round(bottom ? h - bottom.top : 0),
    left: Math.round(left?.right ?? 0),
    right: Math.round(right ? w - right.left : 0),
  };
}

export function watchInsets(root: HTMLElement, cb: (i: Insets) => void): { now(): Insets; refresh(): void; dispose(): void } {
  let last: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let raf = 0;
  const refresh = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = measureInsets(root);
      if (i.top === last.top && i.bottom === last.bottom && i.left === last.left && i.right === last.right) return;
      last = i;
      for (const side of ["top", "right", "bottom", "left"] as const) root.style.setProperty(`--inset-${side}`, `${i[side]}px`);
      cb(i);
    });
  };
  const ro = new ResizeObserver(refresh);
  for (const el of root.querySelectorAll(".nw-topbar, .nw-sheet, .nw-panel, .nw-transport")) ro.observe(el);
  window.addEventListener("resize", refresh);
  // panels slide in with a transform, which a ResizeObserver does not see
  root.addEventListener("animationend", refresh);
  refresh();
  return {
    now: () => last,
    refresh,
    dispose() {
      ro.disconnect();
      window.removeEventListener("resize", refresh);
      root.removeEventListener("animationend", refresh);
      cancelAnimationFrame(raf);
    },
  };
}
