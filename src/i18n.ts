/**
 * The page language (中文 / English), shared by every module. A module keeps its own strings as { zh, en } pairs and
 * picks with tr() when it shows them; the UI switches with setLang (the store's lang follows) and modules that keep
 * text on screen re-render on onLang.
 */
export type Lang = "zh" | "en";
export const LANGS: Lang[] = ["zh", "en"];
export type Text = Record<Lang, string>;

const KEY = "naiwa.lang";
const listeners = new Set<(lang: Lang) => void>();
let current: Lang = detectLang();

/** The saved choice, else the browser's language (Chinese → zh, anything else → en). */
export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Storage can be blocked (private windows); the browser language decides then.
  }
  const prefs = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  return prefs.some((l) => l?.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // Not remembered across visits then; the page still switches.
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const l of listeners) l(lang);
}

export function onLang(cb: (lang: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The text in the current language. */
export function tr(text: Text): string {
  return text[current];
}
