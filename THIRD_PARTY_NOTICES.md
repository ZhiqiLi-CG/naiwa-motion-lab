# Third-party notices

Naiwa Motion Lab's own code and documentation are licensed under the Apache License 2.0 (`LICENSE`). The page also
ships the following third-party software and data, each under its own license.

## Software bundled into the page

| Package | Version | License | Used for |
|---|---|---|---|
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | 3D rendering |
| [@dimforge/rapier3d-compat](https://github.com/dimforge/rapier.js) | 0.21.0 | Apache-2.0 | rigid and soft-body physics |
| [@mediapipe/tasks-vision](https://github.com/google-ai-edge/mediapipe) | 1.1.1 | Apache-2.0 | pose detection (camera, uploaded videos) |
| [codemirror](https://codemirror.net/), @codemirror/*, @lezer/* | 6.x / 1.x | MIT | the in-page code editor |
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 | compiling and type-checking code in the code lab (loaded on demand) |

Their full license texts are in each package's folder under `node_modules/` (e.g. `node_modules/three/LICENSE`).

## Models and data

| File(s) | Source | License |
|---|---|---|
| `public/mediapipe/wasm/*` | `@mediapipe/tasks-vision` 1.1.1, unchanged copies | Apache-2.0 |
| `public/mediapipe/pose_landmarker_{full,lite}.task` | MediaPipe pose landmarker models (see `public/mediapipe/SOURCES.md`) | Apache-2.0 |
| `public/dances/*.json` | body poses extracted from public videos; the videos themselves are not included. Sources and time ranges: `tools/dances/SOURCES.md` | pose data only; credited to the original performers and channels |
| `tests/e2e/media/*` | Wikimedia Commons clips used only by the tests (see `tests/e2e/media/SOURCES.md`) | CC BY (attribution in that file) |

## Not licensed

The character 奶蛙 (Naiwa) and the files depicting it (`public/models/`, `assets-src/naiwa/`, including the reference
images in `assets-src/naiwa/references/`) derive from a third party's intellectual property. They are not covered by
the Apache License, and no rights to them are granted.
