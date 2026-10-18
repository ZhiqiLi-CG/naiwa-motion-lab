# Lab jobs

A job is a Codex-driven optimisation the page offers next to what it optimises (优化手感 next to the physics
parameters, 让 Codex 改进这个模块 in the code lab, 优化这段动作 next to a dance…). The Lab server (`node lab/server.mjs`)
lists every job in this folder, runs one at a time, streams its log, progress and Codex's events to the page, and
shows its result as a card the user applies.

## The contract

A job is `lab/jobs/<id>/job.mjs`:

```js
export default {
  id: "<id>",                         // the folder's name
  name: { zh: "优化这段动作", en: "Improve this motion" },
  summary: { zh: "…", en: "…" },      // one or two sentences, shown before it runs
  run: async (input, ctx) => result,
};
```

`input` is the JSON the page posts (`POST /api/jobs/<id> { input }`); it may include uploaded JSON, e.g. a
`DanceTrack` (src/contracts.ts). The page always adds `lang: "zh" | "en"` (reply in it) and may add `effort`.

`ctx`:

| field | |
|---|---|
| `repo` | absolute path of the repository |
| `workdir` | a fresh directory for this run, `.cache/lab/jobs/<run>/` (inside the repo, so Codex may write there) |
| `log(text)` | a line in the job's log on the page |
| `progress(p)` | 0..1 |
| `codex(prompt, { files? })` | a `codex exec` run (new thread, repo as root, workspace-write sandbox) whose events stream into the job's log; resolves with Codex's final message, rejects when it fails or the job is stopped. `files`: paths (absolute or repo-relative) listed in the prompt; images among them are attached |
| `signal` | an `AbortSignal`, aborted when the user stops the job (the running Codex is killed) |

`result`:

```ts
{
  summary: { zh: string, en: string },
  metrics?: { before: Record<string, number>, after: Record<string, number> },   // shown as a table, lower is better
  artifacts: (
    | { kind: "dance", path }    // a DanceTrack JSON → 我的舞蹈
    | { kind: "preset", data }   // { name?: { zh, en }, params: PhysicsParams } → the physics parameters
    | { kind: "block", path }    // a code-lab block (.ts) → loaded as the user's experiment
    | { kind: "file", path }     // anything else, opened as a file
  )[]
}
```

`path`: absolute, or relative to `workdir` (if it exists there) else to the repo; it must be inside the repo. An
artefact may carry extra fields the page uses when present: `title` ({ zh, en } or text) on any kind; for a dance,
`name`; for a block, `core` ("simulator" | "retargeter"), `slot` and `from: { id, path }` (the page block it was
forked from, path below src/). Throw to fail the job with a message.

## Reaching the live page

A job (and Codex inside it) operates the open page with the same tools Codex uses in chat (lab/AGENTS.md):

```js
import { naiwa } from "../../lib/naiwa.mjs";
const state = await naiwa("state");
await naiwa("params.set", { softness: 0.8 });
const shot = await naiwa("screenshot");        // { path, width, height }
```

## The jobs here

- `tune-feel` — 优化手感: experiments with the physics parameters and per-region softness, returns a preset.
- `improve-block` — 让 Codex 改进这个模块: improves a code-lab block, returns a block file, compared on metrics.
- `motion-coherence` — 优化这段动作: makes a video-derived dance temporally coherent (written separately).

Try one without the page: `POST http://127.0.0.1:5170/api/jobs/<id>` with `{ "input": {…} }`, then follow
`GET /api/stream` or `GET /api/runs/<run>`.
