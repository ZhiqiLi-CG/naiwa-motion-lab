/** What every part of the UI shares, and the shape of a part. */
import type { AppCommands, AppState, MaterialPreset } from "../contracts";
import type { Store } from "../store";

export type RecordLayout = AppState["recordLayout"];

/** Commands the UI offers beyond AppCommands (proposed for the contract); each control is left out without its command:
 *  the camera start/stop (the webcam opens only when asked) and the "Edit code" entry of the simulator selector
 *  (opens the in-page simulator code editor, src/labcode/ mountCodeLab, on that simulator). */
export interface CameraCommands {
  startCamera(): void;
  stopCamera(): void;
}
export interface LabCommands {
  editSimulator(id: string): void;
}
export type UICommands = AppCommands & Partial<CameraCommands & LabCommands>;

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
  /** The top dialog, if any (keyboard shortcuts pause while one is open). */
  dialogOpen(): boolean;
  closeDialog(): void;
}

export interface Part {
  update(s: AppState, prev: AppState | null): void;
  /** Stop timers before the UI is rebuilt (language switch) or unmounted. */
  dispose?(): void;
}

/** True on the first render or when the selected slice changed. */
export function changed<T>(s: AppState, prev: AppState | null, pick: (s: AppState) => T): boolean {
  return prev === null || pick(s) !== pick(prev);
}

