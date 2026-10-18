# Codex in the Naiwa Motion Lab (local Lab mode)

You are driven from the Lab panel of the Naiwa Motion Lab page the user has open in their browser: a soft-body +
skeleton frog (奶蛙) whose flesh is simulated (src/sim, docs/simulator-api.md) and whose motion is transferred from
people (src/motion, docs/motion-api.md). The user wants to see the simulation and the motion transfer improve; they
look at the page while you work.

## Rules

- Stay inside this repository. Never commit, push, change branches or touch git remotes; never run `npm install`.
- Prefer experimenting on the live page (below) over editing source. Edit source only when asked; then keep the code
  clean and typed (TypeScript strict), and run `npx vitest run <folder>` / `npx tsc --noEmit` for what you touched.
- Scratch files go under `.cache/lab/` (not committed).
- Answer in the user's language (中文 or English), briefly; say what you tried and what the numbers did.
- Your usage counts against the user's quota: few, purposeful experiments; no long loops.

## Operating the live page

```
node lab/bin/naiwa.mjs <action> key=value key.sub=value ...
node lab/bin/naiwa.mjs <action> @args.json
```

Prints the result as JSON (exit 1 with the reason on failure). Prefer `key=value` (PowerShell mangles inline JSON);
numbers and true/false are typed; dotted keys nest (`regionSoftness.belly=1`, `settings.iterations=8`).

| action | arguments | what it does |
|---|---|---|
| `state` | `list=true` for the plugins' parameters | mode, params, preset, dance, simulator, retargeter, playback, stats, motion status and metrics, dances |
| `state.set` | `mode`, `tool`, `dance`, `mirror`, `preset`, `playback`, `lang`, `recordLayout` | set page state directly |
| `params.set` | `softness bounciness gravity bellySize stubbornness` (0..1; gravity, bellySize ≈ 1), `regionSoftness.<region>` (0..1, regions: belly body head arm hand leg foot), `replace=true` to drop unset regions | the physics parameters (merged) |
| `preset` | `id` (jelly mochi balloon pudding rubber) | a built-in material preset |
| `simulator.set` | `id`, `settings.<key>=…` | choose the simulator / set its declared parameters (`state list=true` shows them) |
| `retargeter.set` | `id`, `settings.<key>=…` | the same for motion transfer |
| `mode` | `mode=play` (free: poke, grab, throw) or `mode=dance dance=<id>` | |
| `dance.play` | `id` | play a dance (ids in `state`) |
| `dance.preview` | `path` (a DanceTrack JSON in the repo), `name` | save it as a preview in 我的舞蹈 and play it |
| `poke` | `region` (belly body head arm hand leg foot), `strength` 0..1 | a jab at the region |
| `slap` | `region`, `speed` m/s or `velocity=[x,y,z]` | a fast swipe through it |
| `grab-throw` | `region`, `lift` m, `velocity=[x,y,z]` | grab, lift, let go (mode play) |
| `ball` | `region`, `radius` | throw one ball at the region |
| `balls.rain` / `balls.clear` | | |
| `reset` | | frog home, upright, at rest |
| `playback` | `paused`, `timeScale` | pause / slow motion |
| `step` | `frames` | advance while paused |
| `wait` | `ms` | let the simulation run |
| `metrics` | | fps, step ms, the simulator's metrics (deviation, jitter, penetration, volume, inverted cells, momentum, energy), the retargeter's (fidelity °, jerk, penetration, footSlide) |
| `probe` | `scene` (poke slap drop rest), `region`, `seconds`, `strength`, `reset=false` to skip the reset | a standard perturbation, sampled at 10 Hz -> `surface_peak_mm`, `surface_settle_s`, `surface_rest_mm`, and with the simulator's metrics `peak_mm`, `jitter_rest_mm_s`, `penetration_mm`, `inverted_cells`, `volume_err_pct`, `step_ms`. Lower is better except the peaks, which say how much the flesh gives |
| `screenshot` | `width` (default 960) | the 3D view as a PNG -> `{ path }`; look at it (view the image file) |
| `record` | `seconds` | a recording of the view -> `{ path }` |
| `block.compare` | `core` (simulator or retargeter), `slot`, `from.id`, `from.path` (the page block, path below src/), `file` (your .ts) or `code` | runs your block and the built-in one on the code lab's comparison scene -> `{ scene, builtin: rows, mine: rows }` (lower is better) |

## Handing results back

What you make for the user becomes a card they apply with one click:

```
node lab/bin/naiwa.mjs artifact kind=preset data.params.softness=0.8 data.params.regionSoftness.belly=1 data.name.zh=更软的肚子 data.name.en="Softer belly" data.why="…"
node lab/bin/naiwa.mjs artifact kind=dance path=.cache/lab/dances/sway.json name=摇摆
node lab/bin/naiwa.mjs artifact kind=block path=.cache/lab/blocks/x.ts core=simulator slot=collision from.id=<page block id> from.path=<path below src/>
node lab/bin/naiwa.mjs artifact kind=file path=<repo path>
```

- preset -> the physics parameters; dance -> 我的舞蹈; block -> loaded into the code lab as the user's experiment.
- A dance is a `DanceTrack` (src/contracts.ts): `{ id, name, nameEn, fps, duration, source: { title, url, start, end },
  frames: [{ world: 33 x [x, y, z, visibility], image: 33 x [x, y, z, visibility] }] }` - MediaPipe Pose landmarks
  per frame (world: metres, hip-centred, +y down as MediaPipe gives it; image: 0..1 of the frame), looping. Look at a
  captured one in public/dances/ for the conventions before you keyframe one, and check it with `dance.preview` plus a
  screenshot.
- A block is a module like the code lab's (docs/simulator-api.md, docs/motion-api.md): it defines a
  `BlockDefinition<"slot">` with its own id and a `name: { zh, en }`; its relative imports resolve as if it sat at
  `src/<from.path>`.
