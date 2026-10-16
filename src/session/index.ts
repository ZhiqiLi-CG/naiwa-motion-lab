/**
 * Session export for the Genesis HD render (tools/genesis-hd): record what is played while the browser records its
 * video, download it next to the video, render it in high quality with Genesis.
 */
import type * as THREE from "three";
import { EXPRESSIONS, type ExpressionWeights } from "../contracts";
import { SESSION_FORMAT, SESSION_VERSION, type SessionFile } from "./format";

export { SESSION_FORMAT, SESSION_VERSION } from "./format";
export type { PackedArray, SessionEvent, SessionFile } from "./format";
export { SessionRecorder, type SessionFrame, type SessionRecorderOptions, type SessionStart } from "./recorder";
export { SessionPlayer, type SessionSample } from "./player";

/** Expression weights as the character shows them: the largest influence of each expression over its meshes. */
export function readExpressions(object: THREE.Object3D): ExpressionWeights {
  const out: ExpressionWeights = {};
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const dict = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
    if (!dict || !inf) return;
    for (const e of EXPRESSIONS) {
      const i = dict[e];
      if (i !== undefined) out[e] = Math.max(out[e] ?? 0, inf[i]);
    }
  });
  return out;
}

export function sessionBlob(file: SessionFile): Blob {
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

/** "naiwa-20261016-153000.mp4" → "naiwa-20261016-153000.session.json" (the pair downloads side by side). */
export function sessionFileName(videoFileName: string): string {
  return `${videoFileName.replace(/\.[^.]*$/, "")}.session.json`;
}

export function parseSession(text: string): SessionFile {
  const file = JSON.parse(text) as SessionFile;
  if (file.format !== SESSION_FORMAT || file.version !== SESSION_VERSION) {
    throw new Error(`not a ${SESSION_FORMAT} v${SESSION_VERSION} file`);
  }
  return file;
}
