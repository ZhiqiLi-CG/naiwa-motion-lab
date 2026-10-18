// Server pieces that run without Codex: status parsing, event mapping, argument parsing, the job framework with a
// fake job, the tool relay through request files, and the HTTP server with a fake page. Run: node --test lab/test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { execArgs, lineSplitter, parseLoginStatus, parseVersion } from "../lib/codex.mjs";
import { cleanCommand, mapCodexEvent, pageToolOf } from "../lib/events.mjs";
import { createJobs, normaliseResult } from "../lib/jobs.mjs";
import { naiwa, parseToolArgs } from "../lib/naiwa.mjs";
import { createRelay, materialise } from "../lib/relay.mjs";
import { createLabServer, repoPath } from "../server.mjs";

const tmpRepo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "naiwa lab "));
  mkdirSync(path.join(dir, "lab", "jobs"), { recursive: true });
  return dir;
};

describe("codex status", () => {
  it("reads the version", () => {
    assert.equal(parseVersion("codex-cli 0.155.1\r\n"), "0.155.1");
    assert.equal(parseVersion("nothing"), null);
  });
  it("reads login status from stdout or stderr", () => {
    assert.deepEqual(parseLoginStatus(0, "", "Logged in using ChatGPT\r\n"), { loggedIn: true, how: "ChatGPT" });
    assert.deepEqual(parseLoginStatus(0, "Logged in using an API key - sk-proj-***abc\n", ""), { loggedIn: true, how: "an API key" });
    assert.deepEqual(parseLoginStatus(1, "Not logged in\n", ""), { loggedIn: false, how: null });
    assert.deepEqual(parseLoginStatus(0, "", ""), { loggedIn: false, how: null });
  });
  it("builds new and resumed turns with the workspace-write sandbox, the prompt on stdin", () => {
    const fresh = execArgs({ repo: "C:\\My Repo", images: ["a b.png"], env: { NAIWA_LAB_OWNER: "chat:c1" } });
    assert.deepEqual(fresh.slice(0, 6), ["exec", "--json", "-s", "workspace-write", "-C", "C:\\My Repo"]);
    assert.ok(fresh.includes('shell_environment_policy.set.NAIWA_LAB_OWNER="chat:c1"'));
    assert.deepEqual(fresh.slice(-3), ["-", "-i", "a b.png"]);
    const resumed = execArgs({ repo: "/r", threadId: "abc", effort: "low" });
    assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
    assert.ok(resumed.includes('sandbox_mode="workspace-write"') && resumed.includes('model_reasoning_effort="low"'));
    assert.deepEqual(resumed.slice(-2), ["abc", "-"]);
  });
  it("splits CRLF lines across chunks", () => {
    const got = [];
    const s = lineSplitter((l) => got.push(l));
    s.push('{"a":1}\r\n{"b"');
    s.push(":2}\r\n\r\n");
    s.end();
    assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  });
});

describe("codex events", () => {
  it("unwraps the shell and recognises page tools", () => {
    const cmd = `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'node lab/bin/naiwa.mjs poke region=belly'`;
    assert.equal(cleanCommand(cmd), "node lab/bin/naiwa.mjs poke region=belly");
    assert.equal(cleanCommand(`/bin/bash -lc "ls -la"`), "ls -la");
    assert.deepEqual(pageToolOf(cmd), { action: "poke", args: "region=belly" });
  });
  it("maps items", () => {
    assert.deepEqual(mapCodexEvent({ type: "thread.started", thread_id: "t1" }), { type: "thread", id: "t1" });
    assert.deepEqual(mapCodexEvent({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "hi" } }), { type: "message", id: "i0", role: "assistant", text: "hi" });
    const tool = mapCodexEvent({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "bash -lc 'node lab/bin/naiwa.mjs probe scene=poke'", aggregated_output: "{}", exit_code: 0, status: "completed" } });
    assert.equal(tool.tool, "page");
    assert.equal(tool.title, "probe scene=poke");
    assert.equal(tool.status, "done");
    assert.equal(mapCodexEvent({ type: "item.started", item: { id: "i2", type: "agent_message" } }), null);
    assert.equal(mapCodexEvent({ type: "turn.failed", error: { message: "quota" } }).error, "quota");
  });
});

describe("tool arguments", () => {
  it("reads key=value, dotted keys, JSON and PowerShell-mangled JSON", () => {
    assert.deepEqual(parseToolArgs(["region=belly", "strength=0.7", "params.regionSoftness.belly=1", "on=true"]), {
      region: "belly",
      strength: 0.7,
      params: { regionSoftness: { belly: 1 } },
      on: true,
    });
    assert.deepEqual(parseToolArgs(['{"softness":0.8,"regionSoftness":{"head":0.2}}']), { softness: 0.8, regionSoftness: { head: 0.2 } });
    assert.deepEqual(parseToolArgs(["{softness:0.8,region:belly,v:[0,1.5,2],x:true}"]), { softness: 0.8, region: "belly", v: [0, 1.5, 2], x: true });
    assert.throws(() => parseToolArgs(["oops"]));
  });
});

describe("relay", () => {
  let repo;
  before(() => (repo = tmpRepo()));
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("writes files a page result carries", () => {
    const v = materialise({ shot: { $file: { ext: "png", base64: Buffer.from("PNG").toString("base64"), name: "shot" } }, n: 1 }, { repo, mediaDir: path.join(repo, ".cache", "lab", "media"), stamp: "s" });
    assert.equal(v.n, 1);
    assert.equal(v.shot, ".cache/lab/media/s-0-shot.png");
    assert.equal(readFileSync(path.join(repo, v.shot), "utf8"), "PNG");
  });

  it("answers a CLI request through the page, and says when no page is open", async () => {
    let page = null;
    const relay = createRelay({ repo, toPage: (msg) => (page ? (page(msg), true) : false), serverActions: { echo: (a, owner) => ({ a, owner }) }, timeoutMs: 3000, pollMs: 10 });
    relay.start(0);
    try {
      await assert.rejects(naiwa("state", {}, { repo, timeoutMs: 2000 }), /no page is open/);
      page = (msg) => setTimeout(() => relay.resolve(msg.id, true, { action: msg.action, args: msg.args }), 5);
      assert.deepEqual(await naiwa("poke", { region: "belly" }, { repo, timeoutMs: 2000 }), { action: "poke", args: { region: "belly" } });
      assert.deepEqual(await naiwa("echo", { x: 1 }, { repo, owner: "chat:c1", timeoutMs: 2000 }), { a: { x: 1 }, owner: "chat:c1" });
      page = (msg) => relay.resolve(msg.id, false, null, "no such region");
      await assert.rejects(naiwa("poke", { region: "tail" }, { repo, timeoutMs: 2000 }), /no such region/);
    } finally {
      relay.stop();
    }
    await assert.rejects(naiwa("state", {}, { repo, timeoutMs: 500 }), /not running/);
  });
});

describe("jobs", () => {
  let repo;
  before(() => {
    repo = tmpRepo();
    const job = (id, body) => {
      mkdirSync(path.join(repo, "lab", "jobs", id), { recursive: true });
      writeFileSync(path.join(repo, "lab", "jobs", id, "job.mjs"), body);
    };
    job(
      "fake",
      `import { writeFileSync } from "node:fs"; import path from "node:path";
export default { id: "fake", name: { zh: "假", en: "Fake" }, summary: { zh: "测试", en: "Test" },
  async run(input, ctx) {
    ctx.log("hello " + input.who); ctx.progress(0.5);
    const said = await ctx.codex("do it", { files: ["shot.png", "notes.txt"] });
    writeFileSync(path.join(ctx.workdir, "d.json"), "{}");
    return { summary: { zh: said, en: said }, metrics: { before: { a: 2 }, after: { a: 1 } },
      artifacts: [{ kind: "dance", path: "d.json" }, { kind: "preset", data: { params: { softness: 0.5 } } }] };
  } };`,
    );
    job("slow", `export default { id: "slow", name: { zh: "慢", en: "Slow" }, summary: { zh: "", en: "" },
  async run(input, ctx) { await ctx.codex("wait"); return { summary: { zh: "", en: "" }, artifacts: [] }; } };`);
    job("broken", `export default { id: "other" };`);
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  const until = (events, type) =>
    new Promise((resolve) => {
      const t = setInterval(() => {
        const e = events.find((x) => x.type === type);
        if (e) {
          clearInterval(t);
          resolve(e);
        }
      }, 5);
    });

  it("lists valid jobs and runs one with ctx and a fake codex", async () => {
    const events = [];
    const calls = [];
    const jobs = createJobs({
      repo,
      emit: (run, ev) => events.push(ev),
      codex: async (o) => {
        calls.push(o);
        o.onEvent({ type: "item.completed", item: { id: "i", type: "agent_message", text: "done it" } });
        return { ok: true, lastMessage: "done it", stopped: false, error: null };
      },
    });
    assert.deepEqual((await jobs.list()).map((j) => j.id), ["fake", "slow"]);
    const run = await jobs.start("fake", { who: "frog" });
    const done = await until(events, "done");
    assert.ok(events.some((e) => e.type === "log" && e.text === "hello frog"));
    assert.ok(events.some((e) => e.type === "progress" && e.value === 0.5));
    assert.ok(events.some((e) => e.type === "codex" && e.ev.type === "message"));
    assert.deepEqual(calls[0].images, [path.join(repo, "shot.png")]);
    assert.match(calls[0].prompt, /Files for this task:\n- shot\.png\n- notes\.txt/);
    assert.equal(calls[0].env.NAIWA_LAB_OWNER, `job:${run}`);
    assert.equal(done.result.summary.en, "done it");
    assert.equal(done.result.artifacts[0].path, `.cache/lab/jobs/${run}/d.json`);
    assert.equal(jobs.get(run).status, "done");
    await assert.rejects(jobs.start("nope"), /no job/);
  });

  it("stops a running job, one job at a time", async () => {
    const events = [];
    const jobs = createJobs({
      repo,
      emit: (run, ev) => events.push(ev),
      codex: (o) => new Promise((resolve) => o.signal.addEventListener("abort", () => resolve({ ok: false, stopped: true, lastMessage: "", error: null }))),
    });
    const run = await jobs.start("slow", {});
    await assert.rejects(jobs.start("slow", {}), /already running/);
    assert.equal(jobs.stop(run), true);
    await until(events, "stopped");
    assert.equal(jobs.get(run).status, "stopped");
    assert.equal(jobs.active(), null);
  });

  it("checks results", () => {
    const workdir = path.join(repo, "w");
    assert.throws(() => normaliseResult({ artifacts: [] }, { repo, workdir }), /summary/);
    assert.throws(() => normaliseResult({ summary: { zh: "", en: "" }, artifacts: [{ kind: "dance", path: "missing.json" }] }, { repo, workdir }), /does not exist/);
    assert.throws(() => normaliseResult({ summary: { zh: "", en: "" }, artifacts: [{ kind: "video" }] }, { repo, workdir }), /kind/);
  });
});

describe("server", () => {
  let repo;
  let lab;
  let base;
  before(async () => {
    repo = tmpRepo();
    writeFileSync(path.join(repo, "note.txt"), "hi");
    lab = createLabServer({
      repo,
      status: { get: async () => ({ installed: true, version: "0.155.1", loggedIn: true, how: "ChatGPT" }) },
      codex: async (o) => {
        o.onEvent({ type: "thread.started", thread_id: "th1" });
        o.onEvent({ type: "item.completed", item: { id: "i0", type: "agent_message", text: o.threadId ? "again" : "first" } });
        return { ok: true, threadId: "th1", lastMessage: "x", stopped: false, error: null };
      },
    });
    base = `http://127.0.0.1:${await lab.listen(0)}`;
  });
  after(async () => {
    await lab.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports status with CORS for local pages only", async () => {
    const r = await fetch(`${base}/api/status`, { headers: { Origin: "http://localhost:5180" } });
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:5180");
    assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual((await r.json()).codex, { installed: true, version: "0.155.1", loggedIn: true, how: "ChatGPT" });
    assert.equal((await fetch(`${base}/api/status`, { headers: { Origin: "https://evil.example" } })).status, 403);
  });

  it("serves repo files only", async () => {
    assert.equal(await (await fetch(`${base}/api/file?path=note.txt`)).text(), "hi");
    assert.equal((await fetch(`${base}/api/file?path=../outside.txt`)).status, 403);
    assert.throws(() => repoPath(repo, ".git/config"));
  });

  it("streams chat turns of one resumed thread and relays tools to the page", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream?page=1`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const msgs = [];
    let buf = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) return;
        buf += Buffer.from(value).toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) {
            const m = JSON.parse(block.slice(6));
            msgs.push(m);
            if (m.ch === "tool") void fetch(`${base}/api/page/result`, { method: "POST", body: JSON.stringify({ id: m.id, ok: true, value: { did: m.action } }) });
          }
        }
      }
    })();
    const wait = (pred) => new Promise((r) => { const t = setInterval(() => { const m = msgs.find(pred); if (m) { clearInterval(t); r(m); } }, 5); });
    await wait((m) => m.ch === "hello");
    const { conv } = await (await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "hello" }) })).json();
    await wait((m) => m.ch === "chat" && m.ev.type === "end");
    await (await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ conv, text: "more" }) })).json();
    await wait((m) => m.ch === "chat" && m.ev.type === "message" && m.ev.text === "again");
    const tool = await (await fetch(`${base}/api/tool`, { method: "POST", body: JSON.stringify({ action: "reset" }) })).json();
    assert.deepEqual(tool, { ok: true, value: { did: "reset" } });
    const art = await (await fetch(`${base}/api/tool`, { method: "POST", body: JSON.stringify({ action: "artifact", owner: `chat:${conv}`, args: { kind: "file", path: "note.txt" } }) })).json();
    assert.deepEqual(art.value, { shown: "chat" });
    await wait((m) => m.ch === "chat" && m.ev.type === "artifact");
    ctrl.abort();
    await pump;
  });
});
