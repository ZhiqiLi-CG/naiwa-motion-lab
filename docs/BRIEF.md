# Naiwa Motion Lab — brief for everyone building it

## What it is

The product is called **Naiwa Motion Lab**. It is a page for our **motion transfer + simulation**, not a game: a
person's motion (webcam, an uploaded video, or a preset motion captured from real videos) is transferred onto 奶蛙,
whose body is simulated as soft flesh over a skeleton, and the page shows that simulation clearly and lets you
examine it — set the material per body region, perturb the body (poke, push, drag) to see how the flesh responds,
compare the person and the frog side by side, record the result. Everything runs in the browser.

The user's words (2026-10-16): "我们只是给我们的动作迁移 + simulation 一个页面，不是再做一个小游戏", "3D界面先保持干净",
"我们是做simulation的", "你现在这些有点太游戏了". So: a clean viewport where the simulation is the show (the polka-dot floor and lily-pad stage may
stay — the user likes them — but no comic text, bursts, screen shakes, speech bubbles or extra props); lab-style controls with precise values and units where they exist;
simulation readouts (step time, particles/cells, fps); restrained copy without jokes; sound off by default.
Progressive disclosure (the user: "模拟器阿 模拟器参数阿 这些应该默认是隐藏起来的…有需求的时候才展开"): the first view is the
fun part — the frog moving, the motion choices, touching it; the simulator, its parameters, readouts and the code
editor sit behind one "实验室 / Lab" control, collapsed by default. The
interface switches between 中文 and English (src/i18n.ts: keep every user-visible string as { zh, en } and show it
with tr()).

## The character

奶蛙 as in `assets-src/naiwa/references/` (from the user): a warm-yellow, pear-shaped chubby creature, small head
merging into a huge body, cream belly patch, small green eyes on the sides of the head, wide mouth (big open laugh
with teeth, or grinning with the tongue out), short arms with dark olive-grey hands, short thick legs with dark frog
feet; its signature move is holding its belly and laughing. **Do not turn it into another character.** It is a
**soft body + skeleton** simulation: rigid bones inside, jelly flesh outside. The soft body is the product's
signature feature: volume kept, believable jiggle and decay, smooth local dents, hands sinking into the belly, squash
on landing, nothing passing through it, no jitter at rest.

The 3D model (mesh, skeleton, skin weights, shape keys) is being built in Blender by a Codex session and lands at
`public/models/naiwa.glb` following `docs/character-contract.md` (an early version first, refined later). Until it
exists the character module provides a placeholder that follows the same contract.

## Technology (already installed; do not run npm install)

- Vite 5 + TypeScript (strict), vanilla DOM (no React), Node 18.
- three 0.186.1 (`three/examples/jsm/...` addons available).
- `@dimforge/rapier3d-compat` 0.21.0: has native soft bodies (`SoftBodyDesc.volumetric/sphere/trimesh`, FEM cells,
  `setParticleKinematicTarget`, `attachParticle(i, rigidBody)`, `applyImpulseAtPoint`, `setVolumeFactor`, clusters,
  deformable colliders). Read the typings in `node_modules/@dimforge/rapier3d-compat/dist/**/*.d.ts`; it is new, so
  verify behaviour by running it rather than assuming.
- `@mediapipe/tasks-vision` 1.1.1 (PoseLandmarker).
- Many users are in China: nothing may load from Google at runtime (fonts, model files, wasm). Self-host under
  `public/`.

If you need another package, say so in your report; do not install it yourself.

## How the code is organised

`src/contracts.ts` defines every interface between modules; read it first. Each folder is owned by one module:

| Folder           | Module                                                                 |
|------------------|------------------------------------------------------------------------|
| `src/sim/`       | the simulation core, the plugin API (`api.ts`) and the CPU example (Rapier constraint solver) |
| `src/sim/gpu/`   | the GPU example simulator (MPM / FEM on WebGPU)                         |
| `src/labcode/`   | the in-page simulator code editor (users write and compare their own simulators) |
| `src/session/`   | session export for the Genesis HD render (`tools/genesis-hd/`)          |
| `src/algorithms/motion/` | the library of retargeting and filtering algorithms (blocks for src/motion/api.ts) |
| `src/algorithms/sim/`    | the library of CPU simulation algorithms (blocks for src/sim/api.ts)       |
| `docs/learn/`    | one short learning page per algorithm, zh + en (template: docs/learn/TEMPLATE.md) |
| `src/character/` | GLB loading (+ placeholder), rendering the simulated frog, face and life |
| `src/motion/`    | MediaPipe camera/video pose, retargeting, built-in dances               |
| `src/stage/`     | renderer, lighting, floor, camera, gestures, comic effects              |
| `src/ui/`, `src/styles/` | the DOM interface                                              |
| `src/media/`     | sound effects, recording, sharing, settings links                       |
| `tests/e2e/`     | end-to-end checks and deployment config                                 |

`src/main.ts`, `src/store.ts` and `src/contracts.ts` belong to the integrator. If the contract does not fit what you
need, build what you need behind your module's own exports and say exactly what should change in your report; do not
edit files outside your folder.

## The simulator is a lab

The user (2026-10-16): the simulator is written around a small core with modular parts around it and exposed
interfaces, so users change the simulator code to test their own algorithms; "所以这就要求了你现在的simulation的代码要干净".
And by block: "simulation的代码要模块化，比如碰撞处理阿、simulation的核心阿……要尽量干净，让别人可以将某一个板块做成自己的，也
容易接进来" — a small core loop over named block slots (skeleton, flesh solver, collision, coupling, interaction,
output), each block replaceable on its own. The CPU example is a constraint solver, the GPU example MPM/FEM. Clean, readable, documented code
(docs/simulator-api.md) is a requirement, not a nicety.

## Motion transfer is a lab too

The user: "retarget的算法也应该做成那种用户可以自己编辑的（如果是数值算法的话）". The two numerical cores are motion
transfer and simulation. Motion transfer is built the same way as the simulator: a small core loop over replaceable
blocks (pose source, filtering, the retargeting solver — an optimisation / IK under the frog's constraints —,
constraints such as limbs outside the body and planted feet, output), interfaces in src/motion/api.ts, parameters
declared, users edit and compare blocks in the code lab, metrics (fidelity to the person, smoothness, limbs inside the
body, foot sliding).

## Algorithm library and learning pages

The user: "我们提供一些常用的retarget的算法的示例，还有对应的简洁的学习文档", "simulation也是 要提供很多的算法 以及对应的简洁的学习文档".
Both cores ship several well-known algorithms as blocks, each with a short page in docs/learn/ (zh and en, the
template in docs/learn/TEMPLATE.md) that the code lab shows next to its code.

## Working

- Work only in your folder (and `dev/<module>*.html` / `public/<module>/` if you need them).
- Try your module in isolation with a page `dev/<module>.html` that imports it, served by your own
  `npx vite --port <your port>` (sim 5191, character 5192, motion 5193, stage 5194, ui 5195, media 5196, qa 5197).
  Stop your server when you finish.
- See it: `node tests/tools/shot.mjs <url> <out.png> [--wait ms] [--size WxH] [--eval "js"] [--fake-video f.y4m]`
  opens the page in headless Chrome with the GPU (WebGL2 works), prints the console and saves a screenshot. Look at
  your screenshots. Put them under `.cache/<module>/` (not committed).
- Unit tests: vitest, `src/<module>/*.test.ts` (`npx vitest run src/<module>`). `npx tsc --noEmit` must stay clean
  for your files.
- Commit small working steps of your own paths only: `git add <your paths> && git commit -m "<module>: ..."`. Never
  add Co-Authored-By or "Generated with" lines. If git's index is locked by someone else, wait and retry.
- Budget: 60 fps on an ordinary laptop with everything on; physics ≤ 4 ms per frame; it must work on a phone
  (touch, small screen).
- Match the surrounding code: short comments that say why, strict types, no dead code, no speculative fallbacks.

## UI look

Learn from RobotGen Studio (`/home/zhiqili/robotgen-studio/apps/studio/src/styles/`, live at http://127.0.0.1:8960):
colours only through tokens with a light and a dark theme, every text token readable (WCAG AA) on its surfaces, a
clear type scale on a 4 px grid, compact precise controls, a clean media viewport with scrims for text over it,
status chips, toasts, keyboard shortcuts, restrained motion that respects reduced-motion. Do not copy its heavy
workbench (page sidebars, data tables, React/Radix): one page, the viewport first. A simulation tool's look, with
the 奶蛙 yellow as a restrained accent.

## Reporting

End with: what you built (files), the API others call, how you verified it (commands, screenshot paths, numbers),
and what is missing or uncertain.
