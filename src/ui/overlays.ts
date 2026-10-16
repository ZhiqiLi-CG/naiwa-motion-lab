/** Things that float over everything: toasts, dialogs, the loading screen, the drop target for a video file. */
import { copy } from "./copy";
import { changed, type Ctx, type Part, type ToastKind } from "./ctx";
import { frogMark, h, icon } from "./dom";
import type { IconName } from "./icons";

/* ---------- Toasts ---------- */

const TOAST_ICON: Record<ToastKind, IconName> = { info: "help", success: "check", warning: "alert", error: "alert" };

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
  /** A little picture before the title. */
  badge?: Element;
  onClose?(): void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

export function createDialogs(host: HTMLElement) {
  const stack: { el: HTMLElement; close(): void }[] = [];
  function open(o: DialogOpts): () => void {
    const T = copy();
    const before = document.activeElement as HTMLElement | null;
    const id = `nw-dlg-${Math.random().toString(36).slice(2, 8)}`;
    const closeBtn = h("button", { class: "nw-icon-btn nw-dialog-close", "aria-label": T.rec.close }, icon("close"));
    const dialog = h(
      "div",
      { class: `nw-dialog ${o.cls ?? ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": id },
      h("header", { class: "nw-dialog-head" }, o.badge ?? null, h("h2", { id, class: "nw-dialog-title" }, o.title), closeBtn),
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

/* ---------- Loading screen ---------- */

export function createLoading(host: HTMLElement): Part {
  const T = copy();
  const msg = h("p", { class: "nw-loading-msg" });
  const el = h(
    "div",
    { class: "nw-loading", role: "progressbar", "aria-label": T.product, "aria-busy": "true" },
    frogMark("nw-mark nw-loading-mark"),
    h("p", { class: "nw-loading-title" }, T.product),
    msg,
    h("div", { class: "nw-loading-bar", "aria-hidden": "true" }, h("i", {})),
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
          if (el.classList.contains("is-done")) el.hidden = true;
        };
        el.addEventListener("transitionend", hide, { once: true });
        setTimeout(hide, 500);
      }
    },
  };
}

/* ---------- Drop a video anywhere ---------- */

export function createDropTarget(ctx: Ctx, host: HTMLElement): () => void {
  const T = copy();
  const el = h(
    "div",
    { class: "nw-drop", "aria-hidden": "true" },
    h("div", { class: "nw-drop-box" }, icon("film", "nw-icon nw-drop-icon"), h("p", {}, T.video.dropBig)),
  );
  host.append(el);
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  const on: Record<"dragenter" | "dragleave" | "dragover" | "drop", (e: DragEvent) => void> = {
    dragenter(e) {
      if (!hasFiles(e)) return;
      depth++;
      el.classList.add("is-shown");
    },
    dragleave(e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) el.classList.remove("is-shown");
    },
    dragover(e) {
      if (hasFiles(e)) e.preventDefault();
    },
    drop(e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.classList.remove("is-shown");
      const file = e.dataTransfer?.files[0];
      if (file) pickVideo(ctx, file);
    },
  };
  const names = Object.keys(on) as (keyof typeof on)[];
  for (const n of names) window.addEventListener(n, on[n]);
  return () => names.forEach((n) => window.removeEventListener(n, on[n]));
}

export function pickVideo(ctx: Ctx, file: File): void {
  const T = copy();
  if (!file.type.startsWith("video/")) return ctx.toast(T.video.notVideo, "warning");
  ctx.commands.loadVideo(file);
  // kept on the root so a rebuilt video panel (language switch) still shows it
  ctx.root.dataset.videoName = file.name;
  ctx.root.dispatchEvent(new CustomEvent("nw:video", { detail: file.name }));
}
