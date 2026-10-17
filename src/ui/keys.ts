/** Keyboard shortcuts (listed in the help dialog: copy.ts SHORTCUT_KEYS). */
import { SOURCES, SPEEDS, TOOLS } from "./copy";
import type { Ctx } from "./ctx";

/** Keys a focused control uses itself (Space presses a button, arrows move a slider). */
const OWN_KEYS = new Set([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function bindKeys(ctx: Ctx, theme: () => "light" | "dark"): () => void {
  const { store, commands } = ctx;
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key === "Escape") {
      if (ctx.dialogOpen()) ctx.closeDialog();
      else ctx.setSheet(false);
      return;
    }
    if (ctx.dialogOpen()) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"));
    const control = !!t && t !== document.body && /^(BUTTON|INPUT|A)$/.test(t.tagName);
    if (typing || (control && OWN_KEYS.has(e.key))) return;
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const s = store.get();
    const pb = s.playback;
    const speed = SPEEDS.indexOf(pb.timeScale);
    const source = SOURCES.find((x) => x.key === k);
    const tool = TOOLS.find((x) => x.key === k);
    const lab = ctx.root.dataset.lab === "open";
    if (k === " " && (lab || pb.paused)) store.set({ playback: { ...pb, paused: !pb.paused } });
    else if (k === "." && lab) {
      if (pb.paused) commands.stepSim();
    } else if ((k === "[" || k === "]") && lab) {
      const i = Math.min(SPEEDS.length - 1, Math.max(0, (speed < 0 ? SPEEDS.length - 1 : speed) + (k === "]" ? 1 : -1)));
      store.set({ playback: { ...pb, timeScale: SPEEDS[i]! } });
    } else if (source) store.set({ mode: source.id });
    else if (tool) store.set({ tool: tool.id });
    else if (k === "X") commands.resetFrog();
    else if (k === "R") {
      if (s.recording.active) commands.stopRecording();
      else commands.startRecording();
    } else if (k === "M") store.set({ mirror: !s.mirror });
    else if (k === "T") store.set({ theme: theme() === "dark" ? "light" : "dark" });
    else if (k === "L") ctx.setLab();
    else if (k === "?") ctx.openHelp();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
