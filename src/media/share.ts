/** Saving a clip: the system share sheet with the file on phones, a download elsewhere. */
import type { Recording } from "../contracts";
import { tr } from "../i18n";

/**
 * Call from a user gesture (the share sheet needs one). Rejects with an AbortError when the user closes the share
 * sheet without sharing (nothing to do then).
 */
export async function shareRecording(rec: Recording): Promise<"shared" | "downloaded"> {
  // The bare type ("video/mp4"): share targets match on it, codec parameters confuse some of them.
  const file = new File([rec.blob], rec.fileName, { type: rec.mimeType.split(";")[0] });
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Naiwa Motion Lab", text: tr(SHARE_TEXT) });
      return "shared";
    } catch (e) {
      if ((e as DOMException).name === "AbortError") throw e;
      // NotAllowedError (gesture expired) and the like: the download below still saves the clip.
    }
  }
  const a = document.createElement("a");
  a.href = rec.url;
  a.download = rec.fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  return "downloaded";
}

const SHARE_TEXT = { zh: "看我的奶蛙！", en: "Look at my Naiwa!" };
