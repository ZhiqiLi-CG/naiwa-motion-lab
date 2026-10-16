/** What every part of the UI shares, and the shape of a part. */
import type { AppCommands, AppState, DanceInfo, DanceTrack, MaterialPreset } from "../contracts";
import type { Store } from "../store";

/** What the UI needs beyond AppCommands (proposed for the contract): the camera panel's start/stop buttons, so the
 *  webcam opens only when the player asks. Without them the buttons are left out (the integration then starts the
 *  camera when the mode becomes "camera"). */
export interface CameraCommands {
  startCamera(): void;
  stopCamera(): void;
}
export type UICommands = AppCommands & Partial<CameraCommands>;

/** A dance as listed; captured dances may carry their source, which the dance card credits. */
export type UIDance = DanceInfo & Partial<Pick<DanceTrack, "source">>;

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Ctx {
  root: HTMLElement;
  store: Store;
  commands: UICommands;
  presets: MaterialPreset[];
  toast(message: string, kind?: ToastKind): void;
  openHelp(): void;
  /** Phone bottom sheet open/closed (toggles when open is omitted). */
  setSheet(open?: boolean): void;
  /** Feel panel open/closed (toggles when open is omitted). */
  setFeel(open?: boolean): void;
  /** The top dialog, if any (keyboard shortcuts pause while one is open). */
  dialogOpen(): boolean;
  closeDialog(): void;
}

export interface Part {
  update(s: AppState, prev: AppState | null): void;
}

/** True on the first render or when the selected slice changed. */
export function changed<T>(s: AppState, prev: AppState | null, pick: (s: AppState) => T): boolean {
  return prev === null || pick(s) !== pick(prev);
}

/** Restart a one-shot CSS animation class (bounce, wiggle). */
export function replay(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}
