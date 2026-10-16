# Naiwa Motion Lab — brief for everyone building it

## What it is

The product is called **Naiwa Motion Lab** (the user's name for it; 奶蛙 is the character).

A web page. Someone opens the link and plays with 奶蛙: pokes and slaps its big soft belly, squeezes it, grabs it and
throws it, changes how soft and bouncy it is, makes it dance with their webcam or an uploaded dance video (or one of
the built-in dances), and records a funny clip to share. No install, no server GPU, no training: everything runs in
the browser. **Fun comes first**: every touch should feel squishy and get a reaction (wobble, sound, comic "DUANG~"
text, a face). The interface switches between 中文 and English (src/i18n.ts: keep every user-visible string as
{ zh, en } and show it with tr()).

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
| `src/sim/`       | Rapier world: rigid skeleton, soft-body flesh, interactions, balls      |
| `src/character/` | GLB loading (+ placeholder), rendering the simulated frog, face and life |
| `src/motion/`    | MediaPipe camera/video pose, retargeting, built-in dances               |
| `src/stage/`     | renderer, lighting, floor, camera, gestures, comic effects              |
| `src/ui/`, `src/styles/` | the DOM interface                                              |
| `src/media/`     | sound effects, recording, sharing, settings links                       |
| `tests/e2e/`     | end-to-end checks and deployment config                                 |

`src/main.ts`, `src/store.ts` and `src/contracts.ts` belong to the integrator. If the contract does not fit what you
need, build what you need behind your module's own exports and say exactly what should change in your report; do not
edit files outside your folder.

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
clear type scale on a 4 px grid, compact precise controls, a dark media viewport with scrims for text over it,
status chips, toasts, keyboard shortcuts, restrained motion that respects reduced-motion. Do **not** copy its heavy
workbench (page sidebars, data tables, React/Radix). This is a toy: warm 奶蛙-yellow accent, rounded friendly
shapes, bouncy micro-interactions, playful copy.

## Reporting

End with: what you built (files), the API others call, how you verified it (commands, screenshot paths, numbers),
and what is missing or uncertain.
