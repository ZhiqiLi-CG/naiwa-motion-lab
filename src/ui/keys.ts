/** Keyboard shortcuts (listed in the help dialog, copy.ts SHORTCUTS). */
import { MODES, TOOLS } from "./copy";
import type { Ctx } from "./ctx";

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
    if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range"))) return;
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const s = store.get();
    const tool = TOOLS.find((x) => x.key === k);
    const mode = MODES.find((x) => x.key === k);
    if (tool) store.set({ mode: "play", tool: tool.id });
    else if (mode) store.set({ mode: mode.id });
    else if (k === "B") commands.rainBalls();
    else if (k === "X") commands.resetFrog();
    else if (k === "R") s.recording.active ? commands.stopRecording() : commands.startRecording();
    else if (k === "F") ctx.setFeel();
    else if (k === "M") store.set({ mirror: !s.mirror });
    else if (k === "S") store.set({ sound: !s.sound });
    else if (k === "T") store.set({ theme: theme() === "dark" ? "light" : "dark" });
    else if (k === "?" || k === "H") ctx.openHelp();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
