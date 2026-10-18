/** "用 Codex 优化 / Optimise with Codex" entry points, next to what they optimise. They show only while the local Lab
 *  (src/lab, lab/server.mjs) says Codex CLI can be used; the Lab sets the hooks with setCodexHooks. Without it the
 *  page shows none of them (the public site). */
import { tr, type Text } from "../i18n";
import { h, icon } from "./dom";

export type CodexTarget =
  | { kind: "chat" }
  /** the physics parameters and per-region softness */
  | { kind: "feel" }
  /** the retargeter in use and its parameters */
  | { kind: "retargeter" }
  /** a captured or saved dance */
  | { kind: "dance"; id: string }
  /** the analysed uploaded video */
  | { kind: "video" }
  | { kind: "new-dance" };

export interface CodexHooks {
  /** Codex can be used now. */
  available: boolean;
  /** The Lab panel's short line when it cannot (how to start the server or log in); null shows nothing. */
  note: Text | null;
  /** Whether this entry has something to run (e.g. a job that is present). */
  supports(t: CodexTarget): boolean;
  run(t: CodexTarget): void;
}

let hooks: CodexHooks | null = null;
const shown = new Set<{ el: HTMLElement; refresh(): void }>();

export function setCodexHooks(next: CodexHooks | null): void {
  hooks = next;
  for (const s of [...shown]) {
    if (s.el.isConnected) s.refresh();
    else shown.delete(s);
  }
}

function track(el: HTMLElement, refresh: () => void) {
  refresh();
  shown.add({ el, refresh });
  return el;
}

/** A small button that runs target with Codex; hidden unless Codex is available for it. */
export function codexButton(target: CodexTarget, label: Text, opts: { compact?: boolean; cls?: string } = {}): HTMLButtonElement {
  const text = tr(label);
  const btn = h(
    "button",
    {
      class: `nw-btn nw-btn--ghost nw-btn--sm nw-codex-btn${opts.compact ? " nw-codex-btn--icon" : ""} ${opts.cls ?? ""}`,
      type: "button",
      "aria-label": opts.compact ? text : null,
      "data-tip": opts.compact ? text : null,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        hooks?.run(target);
      },
    },
    icon("sparkle"),
    opts.compact ? null : text,
  );
  track(btn, () => (btn.hidden = !(hooks?.available && hooks.supports(target))));
  return btn;
}

/** The Lab panel's line on how to make Codex available (empty and hidden when there is nothing to say). */
export function codexNote(): HTMLElement {
  const el = h("p", { class: "nw-note nw-codex-note" });
  return track(el, () => {
    const note = hooks && !hooks.available ? hooks.note : null;
    el.hidden = note === null;
    el.textContent = note ? tr(note) : "";
  });
}
