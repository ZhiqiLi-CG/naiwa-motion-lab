/**
 * The local Lab mode: when `node lab/server.mjs` runs on this machine and Codex CLI is logged in, the page offers
 * Codex-driven optimisation next to what it optimises (src/ui/codex.ts entries, the code lab's "让 Codex 改进"), a
 * conversation panel, and runs Codex's page tools. Without the server (the public site) nothing extra shows.
 *
 *   const lab = mountLab({ store, codeLab, toast: ui.toast, videoTrack: () => source?.track?.() ?? null });
 *   lab.onInsets(frameStage);           // the open panel covers the right edge, as the code lab does
 *   await lab.available;                // true when Codex can be used
 */
import "./lab.css";
import type { DanceTrack, MaterialPreset, Stage } from "../contracts";
import { getLang, onLang, tr } from "../i18n";
import { openCodeLab, setCodexImprove, type CodeLab, type CodexBlockTarget } from "../labcode";
import type { NaiwaMotion } from "../motion";
import { loadSaved } from "../motion/saved";
import type { LabFrogSim } from "../sim";
import { MATERIAL_PRESETS, type Store } from "../store";
import type { UICommands } from "../ui";
import { setCodexHooks, type CodexTarget } from "../ui/codex";
import { availability, availabilityNote, createClient, serverUrl, type Artifact, type JobInfo, type StreamMessage } from "./client";
import { L, newDancePrompt, transferPrompt } from "./copy";
import { applyChat, applyJob, emptyFeed, type Feed } from "./feed";
import { createPanel, type Insets } from "./panel";
import { createTools, type PageHost } from "./tools";

export type { Insets } from "./panel";

export interface LabOptions {
  store: Store;
  /** The code lab (block comparisons, loading improved blocks). */
  codeLab?: CodeLab | null;
  toast?(message: string, kind?: "info" | "success" | "warning" | "error"): void;
  /** The analysed uploaded video's motion, for "优化这段动作" on a video. */
  videoTrack?(): DanceTrack | null;
  /** The rest default to what the page publishes as window.__naiwa once it has booted. */
  commands?: UICommands;
  stage?: Stage;
  motion?: NaiwaMotion;
  sim?(): LabFrogSim | null;
  presets?: MaterialPreset[];
  /** Where the panel mounts (document.body). */
  host?: HTMLElement;
  /** The Lab server (default http://127.0.0.1:5170, or ?lab=<port|url>). */
  server?: string;
}

export interface MountedLab {
  /** Resolves true when the server answers and Codex CLI is logged in. */
  readonly available: Promise<boolean>;
  open(): void;
  close(): void;
  run(target: CodexTarget): void;
  /** The part of the window the open panel covers (frame the stage in the rest). */
  insets(): Insets;
  onInsets(cb: (i: Insets) => void): () => void;
  dispose(): void;
}

interface Naiwa {
  store: Store;
  sim: LabFrogSim | null;
  stage: Stage;
  motion: NaiwaMotion;
  commands: UICommands;
}

const CONV_KEY = "naiwa.lab.conv";
const session = {
  get: () => {
    try {
      return sessionStorage.getItem(CONV_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem(CONV_KEY, v);
      else sessionStorage.removeItem(CONV_KEY);
    } catch {
      // the conversation is not resumed after a reload then
    }
  },
};

export function mountLab(opts: LabOptions): MountedLab {
  const { store } = opts;
  const client = createClient(opts.server ?? serverUrl(location.search));
  const naiwa = () => (window as unknown as { __naiwa?: Naiwa }).__naiwa;
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`the page has not booted yet (${what})`);
    return v;
  };
  const toast = (m: string, k?: "info" | "success" | "warning" | "error") => opts.toast?.(m, k);

  const host: PageHost = {
    store,
    get commands() {
      return opts.commands ?? need(naiwa()?.commands, "commands");
    },
    sim: () => (opts.sim ? opts.sim() : (naiwa()?.sim ?? null)),
    get stage() {
      return opts.stage ?? need(naiwa()?.stage, "stage");
    },
    get motion() {
      return opts.motion ?? need(naiwa()?.motion, "motion");
    },
    codeLab: opts.codeLab ?? null,
    presets: opts.presets ?? MATERIAL_PRESETS,
    fetchFile: (path) => fetch(client.fileUrl(path)),
  };
  const tools = createTools(host);

  /* ---------------- state ---------------- */
  let feed: Feed = emptyFeed();
  let conv: string | null = session.get();
  let jobs: JobInfo[] = [];
  let ready = false;
  let stopStream: (() => void) | null = null;
  let codexLine = "";

  const makePanel = () => createPanel(opts.host ?? document.body, {
    send: (text) => void send(text),
    stop: () => conv && void client.post(`/api/chat/${conv}/stop`).catch(() => {}),
    newChat() {
      if (feed.busy) return toast(tr(L.busy), "warning");
      conv = null;
      session.set(null);
      feed = emptyFeed();
      panel.render(feed);
    },
    apply: (a) => applyArtifact(a),
    stopJob: (run) => void client.post(`/api/runs/${run}/stop`).catch(() => {}),
    fileUrl: (p) => client.fileUrl(p),
    rightEdge() {
      const lab = opts.codeLab?.insets().right ?? 0;
      const sim = document.querySelector<HTMLElement>(".nw-ui[data-lab='open'] .nw-panel--sim");
      const simEdge = sim && sim.offsetParent !== null ? innerWidth - sim.getBoundingClientRect().left : 0;
      return Math.max(lab, simEdge);
    },
  });
  let panel = makePanel();
  const offCodeLab = opts.codeLab?.onInsets(() => panel.place());
  // the Lab panel shows or hides with the page's "实验室" toggle
  const uiRoot = document.querySelector(".nw-ui");
  const watch = uiRoot ? new MutationObserver(() => panel.place()) : null;
  watch?.observe(uiRoot!, { attributes: true, attributeFilter: ["data-lab", "data-sheet"] });

  const render = () => panel.render(feed);
  const context = () => {
    const s = store.get();
    return { lang: s.lang, mode: s.mode, dance: s.dance, params: s.params, simulator: s.simulator, retargeter: s.retargeter, stats: { fps: s.stats.fps, stepMs: s.stats.stepMs } };
  };

  async function send(text: string) {
    if (feed.busy) return toast(tr(L.busy), "warning");
    panel.open();
    try {
      const r = await client.post<{ conv: string }>("/api/chat", { conv, text, context: context() });
      conv = r.conv;
      session.set(conv);
    } catch (e) {
      // a conversation the server no longer knows (it restarted): start a new one
      if (conv && /no conversation/.test(String(e))) {
        conv = null;
        session.set(null);
        return send(text);
      }
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function startJob(id: string, input: Record<string, unknown>) {
    panel.open();
    try {
      await client.post(`/api/jobs/${id}`, { input: { lang: getLang(), ...input } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  /* ---------------- artefacts ---------------- */
  async function applyArtifact(a: Artifact): Promise<boolean> {
    try {
      if (a.kind === "file") {
        window.open(client.fileUrl(a.path), "_blank", "noopener");
        return true;
      }
      if (a.kind === "preset") {
        const params = ((a.data.params as object | undefined) ?? a.data) as Record<string, unknown>;
        store.set({ params: { ...store.get().params, ...params } });
        toast(tr(L.appliedPreset), "success");
        return true;
      }
      const res = await host.fetchFile(a.path);
      if (!res.ok) throw new Error(`${a.path}: ${res.status}`);
      if (a.kind === "dance") {
        const track = (await res.json()) as DanceTrack;
        const info = await host.motion.saveDance(track, a.name ?? track.nameEn ?? track.name ?? "Codex");
        store.set({ mode: "dance", dance: info.id });
        toast(tr(L.savedDance(info.name)), "success");
        return true;
      }
      const lab = opts.codeLab?.lab;
      if (!lab || !a.core || !a.slot || !a.from) {
        window.open(client.fileUrl(a.path), "_blank", "noopener");
        return true;
      }
      const b = lab.fork({ kind: a.core, slot: a.slot, id: a.from.id, path: a.from.path, name: null }, await res.text());
      const r = await lab.apply(b.key);
      openCodeLab({ kind: a.core, slot: a.slot });
      if (!r.ok) throw new Error(r.error.message);
      toast(tr(L.loadedBlock), "success");
      return true;
    } catch (e) {
      toast(`${tr(L.applyFailed)}: ${e instanceof Error ? e.message : String(e)}`, "error");
      return false;
    }
  }

  /* ---------------- the entry points ---------------- */
  const hasJob = (id: string) => jobs.some((j) => j.id === id);

  async function danceTrack(id: string): Promise<DanceTrack> {
    const mine = (await loadSaved()).find((t) => t.id === id);
    if (mine) return mine;
    const base = new URL(import.meta.env.BASE_URL, document.baseURI);
    const index = (await (await fetch(new URL("dances/index.json", base))).json()) as { id: string; file: string }[];
    const entry = index.find((e) => e.id === id);
    if (!entry) throw new Error(`no captured motion for "${id}"`);
    return (await (await fetch(new URL(entry.file, base))).json()) as DanceTrack;
  }

  function improveMotion(get: () => Promise<{ track: DanceTrack; dance: { id: string; name: string } }>) {
    const job = jobs.find((j) => j.id === "motion-coherence");
    if (!job) return;
    panel.open();
    panel.compose({
      title: job.name,
      summary: job.summary,
      text: { label: L.goal },
      start: ({ text }) =>
        void get().then(
          ({ track, dance }) => startJob(job.id, { track, dance, ...(text ? { goal: text } : {}) }),
          (e) => toast(e instanceof Error ? e.message : String(e), "error"),
        ),
    });
  }

  function run(t: CodexTarget) {
    if (!ready) return;
    const s = store.get();
    switch (t.kind) {
      case "chat":
        panel.open();
        return;
      case "feel": {
        const job = jobs.find((j) => j.id === "tune-feel");
        if (!job) return;
        panel.open();
        panel.compose({ title: job.name, summary: job.summary, text: { label: L.goal, hint: L.suggestions[0] }, budget: { min: 1, max: 12, value: 4 }, start: ({ text, budget }) => void startJob(job.id, { budget, ...(text ? { goal: text } : {}) }) });
        return;
      }
      case "retargeter": {
        const dance = s.dances.find((d) => d.id === s.dance);
        panel.open();
        panel.prefill(tr(transferPrompt(s.retargeter.id, dance ? (getLang() === "zh" ? dance.name : (dance.nameEn ?? dance.name)) : s.dance)));
        return;
      }
      case "new-dance":
        panel.open();
        panel.compose({ title: L.jobs.newDance, summary: L.newDanceSummary, text: { label: L.describe, hint: L.describeHint, required: true }, start: ({ text }) => void send(tr(newDancePrompt(text))) });
        return;
      case "dance": {
        const d = s.dances.find((x) => x.id === t.id);
        improveMotion(async () => ({ track: await danceTrack(t.id), dance: { id: t.id, name: d?.name ?? t.id } }));
        return;
      }
      case "video":
        improveMotion(async () => {
          const track = opts.videoTrack?.();
          if (!track) throw new Error(tr(L.noVideoTrack));
          return { track, dance: { id: track.id, name: track.name } };
        });
        return;
    }
  }

  function improveBlock(b: CodexBlockTarget) {
    const job = jobs.find((j) => j.id === "improve-block");
    if (!job || !ready) return;
    panel.open();
    panel.compose({
      title: job.name,
      summary: job.summary,
      text: { label: L.goal },
      budget: { min: 1, max: 6, value: 2 },
      start: ({ text, budget }) => void startJob(job.id, { core: b.core, slot: b.slot, code: b.code, from: b.from, name: b.name, budget, ...(text ? { goal: text } : {}) }),
    });
  }

  const publish = (available: boolean, note: ReturnType<typeof availabilityNote>) => {
    setCodexHooks({
      available,
      note,
      supports: (t) =>
        t.kind === "feel" ? hasJob("tune-feel") : t.kind === "dance" || t.kind === "video" ? hasJob("motion-coherence") : true,
      run,
    });
    setCodexImprove(available && hasJob("improve-block") ? improveBlock : null);
  };

  /* ---------------- the stream ---------------- */
  async function onMessage(msg: StreamMessage) {
    switch (msg.ch) {
      case "hello": {
        const a = availability(msg);
        if (a.state === "ready") codexLine = tr(L.connected(msg.codex.version, msg.codex.how));
        panel.setStatus(codexLine, true);
        if (conv && feed.items.length === 0 && msg.convs.some((c) => c.id === conv)) {
          const h = await client.get<{ events: Parameters<typeof applyChat>[1][] }>(`/api/chat/${conv}`).catch(() => null);
          if (h) {
            feed = h.events.reduce(applyChat, emptyFeed());
            render();
          }
        }
        return;
      }
      case "tool": {
        const fn = tools[msg.action];
        let body: { id: string; ok: boolean; value?: unknown; error?: string };
        try {
          if (!fn) throw new Error(`unknown action "${msg.action}" (see lab/AGENTS.md)`);
          body = { id: msg.id, ok: true, value: (await fn(msg.args ?? {})) ?? null };
        } catch (e) {
          body = { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        await client.post("/api/page/result", body).catch((e) => console.warn("lab: result not delivered", e));
        return;
      }
      case "chat":
        if (msg.conv !== conv) return;
        feed = applyChat(feed, msg.ev);
        render();
        return;
      case "job":
        feed = applyJob(feed, msg.run, msg.ev);
        panel.open();
        render();
        return;
      case "artifact":
        feed = applyChat(feed, { type: "artifact", artifact: msg.artifact });
        render();
        return;
    }
  }

  async function connect(): Promise<boolean> {
    const status = await client.status();
    const a = availability(status);
    if (a.state !== "ready") {
      publish(false, availabilityNote(a, import.meta.env.DEV));
      return false;
    }
    jobs = await client.get<JobInfo[]>("/api/jobs").catch(() => []);
    ready = true;
    codexLine = tr(L.connected(a.status.codex.version, a.status.codex.how));
    panel.setStatus(codexLine, true);
    publish(true, null);
    stopStream = client.stream(
      (m) => void onMessage(m),
      (open) => {
        if (!open) panel.setStatus(tr(L.disconnected), false);
        publish(open, open ? null : availabilityNote({ state: "no-server" }, import.meta.env.DEV));
      },
    );
    render();
    return true;
  }

  const available = connect();
  // the panel's words are built in one language: rebuild it in the other, keeping the conversation
  const offLang = onLang(() => {
    const wasOpen = panel.isOpen();
    panel.dispose();
    panel = makePanel();
    panel.setStatus(codexLine, ready);
    render();
    if (wasOpen) panel.open();
    if (ready) publish(true, null);
  });

  return {
    available,
    open: () => ready && panel.open(),
    close: () => panel.close(),
    run,
    insets: () => panel.insets(),
    onInsets: (cb) => panel.onInsets(cb),
    dispose() {
      stopStream?.();
      offCodeLab?.();
      offLang();
      watch?.disconnect();
      setCodexHooks(null);
      setCodexImprove(null);
      panel.dispose();
    },
  };
}
