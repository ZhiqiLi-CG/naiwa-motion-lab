/**
 * Conversations with Codex: one Codex thread per conversation, each user message one `codex exec` turn (the first
 * starts the thread, later ones resume it), its events streamed to the page as they come. A turn can be stopped.
 */
import { mapCodexEvent } from "./events.mjs";

const HISTORY = 600;

/** The first turn's instructions: who Codex is here, where its tools are documented, the page it is looking at. */
export function firstPrompt(text, context) {
  return [
    "You are Codex, working in the Naiwa Motion Lab repository (your working directory), driven from the Lab chat panel",
    "in the user's browser while they look at the live page. Read lab/AGENTS.md before acting: it lists the tools that",
    "operate the live page (node lab/bin/naiwa.mjs <action> …), how to hand results back as artefacts, and the rules",
    "(stay inside this repository, never commit, push or touch git remotes). Answer in the user's language, briefly.",
    context ? `\nThe page now: ${JSON.stringify(context)}` : "",
    `\nThe user: ${text}`,
  ].join("\n");
}

export function laterPrompt(text, context) {
  return `${context ? `The page now: ${JSON.stringify(context)}\n\n` : ""}${text}`;
}

/**
 * @param {object} o
 * @param {(opts: object) => Promise<object>} o.codex  runs one Codex turn (lib/codex.mjs runCodex with the executable bound)
 * @param {(conv: string, ev: object) => void} o.emit
 */
export function createChat({ codex, emit, effort = null }) {
  const convs = new Map();
  let seq = 0;

  const push = (c, ev) => {
    c.history.push(ev);
    if (c.history.length > HISTORY) c.history.splice(0, c.history.length - HISTORY);
    emit(c.id, ev);
  };

  /** Send a message; resolves when the turn ends. */
  async function send({ conv, text, context = null, images = [], effort: e = null }) {
    if (!text || !String(text).trim()) throw Object.assign(new Error("empty message"), { status: 400 });
    let c = conv ? convs.get(conv) : null;
    if (conv && !c) throw Object.assign(new Error(`no conversation "${conv}"`), { status: 404 });
    if (!c) {
      c = { id: `c${Date.now().toString(36)}${(seq++).toString(36)}`, threadId: null, busy: false, controller: null, history: [] };
      convs.set(c.id, c);
    }
    if (c.busy) throw Object.assign(new Error("Codex is still answering"), { status: 409 });
    c.busy = true;
    c.controller = new AbortController();
    push(c, { type: "user", text: String(text) });
    const done = codex({
      prompt: c.threadId ? laterPrompt(text, context) : firstPrompt(text, context),
      threadId: c.threadId,
      images,
      effort: e ?? effort,
      env: { NAIWA_LAB_OWNER: `chat:${c.id}` },
      signal: c.controller.signal,
      onEvent: (raw) => {
        const ev = mapCodexEvent(raw);
        if (ev?.type === "thread") c.threadId = ev.id;
        if (ev) push(c, ev);
      },
    }).then(
      (r) => {
        if (r.threadId) c.threadId = r.threadId;
        push(c, { type: "end", ok: r.ok, stopped: r.stopped, error: r.error, usage: r.usage ?? null });
        return r;
      },
      (err) => {
        push(c, { type: "end", ok: false, stopped: false, error: err instanceof Error ? err.message : String(err) });
        return null;
      },
    ).finally(() => {
      c.busy = false;
      c.controller = null;
    });
    return { conv: c.id, done };
  }

  return {
    send,
    stop(conv) {
      const c = convs.get(conv);
      if (!c?.busy) return false;
      c.controller.abort();
      return true;
    },
    /** A conversation's events so far (the page replays them after reconnecting). */
    history: (conv) => convs.get(conv)?.history ?? null,
    /** Show an event in a conversation (an artefact Codex handed back). */
    note(conv, ev) {
      const c = convs.get(conv);
      if (c) push(c, ev);
      return Boolean(c);
    },
    list: () => [...convs.values()].map((c) => ({ id: c.id, busy: c.busy, threadId: c.threadId })),
  };
}
