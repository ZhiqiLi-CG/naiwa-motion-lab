/** Things that float over everything: toasts, dialogs, the loading screen, the first-poke hint, the drop target. */
import type { AppState } from "../contracts";
import { MOTION_CHIP, TEXT, type ChipTone } from "./copy";
import { changed, type Ctx, type Part, type ToastKind } from "./ctx";
import { frogMark, h, icon } from "./dom";
import type { IconName } from "./icons";

/* ---------- Toasts ---------- */

const TOAST_ICON: Record<ToastKind, IconName> = { info: "sparkle", success: "sparkle", warning: "help", error: "close" };

export function createToasts(host: HTMLElement): (message: string, kind?: ToastKind) => void {
  const stack = h("div", { class: "nw-toasts", role: "status", "aria-live": "polite" });
  host.append(stack);
  return (message, kind = "info") => {
    const el = h(
      "div",
      { class: `nw-toast nw-toast--${kind}`, role: kind === "error" ? "alert" : null },
      h("span", { class: "nw-toast-icon" }, icon(TOAST_ICON[kind])),
      h("span", { class: "nw-toast-text" }, message),
    );
    const close = () => {
      if (el.classList.contains("is-leaving")) return;
      el.classList.add("is-leaving");
      // removed when its leave animation ends (immediately with reduced motion)
      const done = () => el.remove();
      el.addEventListener("animationend", done, { once: true });
      setTimeout(done, 400);
    };
    el.addEventListener("click", close);
    stack.append(el);
    while (stack.children.length > 3) stack.firstElementChild!.remove();
    setTimeout(close, kind === "error" || kind === "warning" ? 5200 : 3200);
  };
}

/* ---------- Dialogs ---------- */

export interface DialogOpts {
  title: string;
  body: Node[];
  /** Extra class on the dialog, e.g. "nw-dialog--rec". */
  cls?: string;
  onClose?(): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export function createDialogs(host: HTMLElement) {
  const stack: { el: HTMLElement; close(): void }[] = [];
  function open(o: DialogOpts): () => void {
    const before = document.activeElement as HTMLElement | null;
    const id = `nw-dlg-${Math.random().toString(36).slice(2, 8)}`;
    const closeBtn = h("button", { class: "nw-icon-btn nw-dialog-close", "aria-label": TEXT.rec.close }, icon("close"));
    const dialog = h(
      "div",
      { class: `nw-dialog ${o.cls ?? ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": id },
      h("header", { class: "nw-dialog-head" }, h("h2", { id, class: "nw-dialog-title" }, o.title), closeBtn),
      h("div", { class: "nw-dialog-body" }, ...o.body),
    );
    const overlay = h("div", { class: "nw-overlay" }, dialog);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stack.splice(stack.indexOf(entry), 1);
      overlay.classList.add("is-leaving");
      const done = () => overlay.remove();
      overlay.addEventListener("animationend", done, { once: true });
      setTimeout(done, 400);
      o.onClose?.();
      before?.focus?.();
    };
    const entry = { el: overlay, close };
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) close();
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const wrapTo = e.shiftKey ? (document.activeElement === first ? last : null) : document.activeElement === last ? first : null;
      if (wrapTo) {
        wrapTo.focus();
        e.preventDefault();
      }
    });
    host.append(overlay);
    stack.push(entry);
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? closeBtn).focus({ preventScroll: true });
    return close;
  }
  return {
    open,
    isOpen: () => stack.length > 0,
    closeTop: () => stack[stack.length - 1]?.close(),
  };
}

/* ---------- Status chip ---------- */

export function statusChip(): { el: HTMLElement; set(text: string, tone: ChipTone, o?: { live?: boolean; busy?: boolean }): void } {
  const dot = h("span", { class: "nw-status-dot" });
  const text = h("span", {});
  const el = h("span", { class: "nw-status" }, dot, text);
  return {
    el,
    set(t, tone, o = {}) {
      el.className = `nw-status nw-status--${tone}${o.live ? " is-live" : ""}${o.busy ? " is-busy" : ""}`;
      text.textContent = t;
    },
  };
}

export function motionChip() {
  const chip = statusChip();
  return {
    el: chip.el,
    update(m: AppState["motion"]) {
      const d = MOTION_CHIP[m.state];
      const fps = m.state === "tracking" && m.fps ? ` · ${Math.round(m.fps)} fps` : "";
      chip.set(d.text + fps, d.tone, d);
    },
  };
}

/* ---------- Loading screen ---------- */

export function createLoading(host: HTMLElement): Part {
  const msg = h("p", { class: "nw-loading-msg" });
  const el = h(
    "div",
    { class: "nw-loading", role: "progressbar", "aria-label": TEXT.loadingTitle, "aria-busy": "true" },
    h("div", { class: "nw-loading-frog" }, frogMark("nw-mark nw-loading-mark"), h("span", { class: "nw-loading-shadow" })),
    h("p", { class: "nw-loading-title" }, "奶蛙 ", h("span", {}, "Playground")),
    msg,
    h("div", { class: "nw-loading-dots", "aria-hidden": "true" }, h("i", {}), h("i", {}), h("i", {})),
  );
  host.append(el);
  return {
    update(s, prev) {
      if (!changed(s, prev, (x) => x.loading)) return;
      msg.textContent = s.loading.message;
      el.setAttribute("aria-busy", String(s.loading.active));
      if (s.loading.active) {
        el.hidden = false;
        el.classList.remove("is-done");
      } else if (!el.hidden) {
        el.classList.add("is-done");
        const hide = () => {
          if (!el.classList.contains("is-done")) return;
          el.hidden = true;
        };
        el.addEventListener("transitionend", hide, { once: true });
        setTimeout(hide, 700);
      }
    },
  };
}

/* ---------- First-poke hint ---------- */

const HINT_KEY = "naiwa.hint.poked";

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function createPokeHint(host: HTMLElement): Part {
  const el = h(
    "div",
    { class: "nw-hint", "aria-hidden": "true" },
    h("span", { class: "nw-hint-finger" }, icon("hand")),
    h("span", { class: "nw-hint-text" }, TEXT.pokeHint),
  );
  host.append(el);
  let seen = hintSeen();
  return {
    update(s) {
      if (s.stats.pokes > 0 && !seen) {
        seen = true;
        try {
          localStorage.setItem(HINT_KEY, "1");
        } catch {
          /* private mode: the hint simply comes back next visit */
        }
      }
      el.classList.toggle("is-shown", !seen && !s.loading.active && s.mode === "play");
    },
  };
}

/* ---------- Drop a video anywhere ---------- */

export function createDropTarget(ctx: Ctx, host: HTMLElement): void {
  const el = h(
    "div",
    { class: "nw-drop", "aria-hidden": "true" },
    h("div", { class: "nw-drop-box" }, icon("film", "nw-icon nw-drop-icon"), h("p", {}, TEXT.video.dropBig)),
  );
  host.append(el);
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    el.classList.add("is-shown");
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove("is-shown");
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove("is-shown");
    const file = e.dataTransfer?.files[0];
    if (file) pickVideo(ctx, file);
  });
}

export function pickVideo(ctx: Ctx, file: File): void {
  if (!file.type.startsWith("video/")) return ctx.toast(TEXT.video.notVideo, "warning");
  ctx.commands.loadVideo(file);
  ctx.root.dispatchEvent(new CustomEvent("nw:video", { detail: file.name }));
}
