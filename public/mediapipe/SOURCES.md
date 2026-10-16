# MediaPipe files (self-hosted: nothing is fetched from Google at runtime)

Loaded by `src/motion/tracker.ts` from `mediapipe/` next to the page.

| File | From | License |
|------|------|---------|
| `wasm/vision_wasm_internal.js`, `wasm/vision_wasm_internal.wasm` | npm `@mediapipe/tasks-vision@1.1.1`, `node_modules/@mediapipe/tasks-vision/wasm/` (unchanged copies) | Apache-2.0 |
| `wasm/vision_wasm_nosimd_internal.js`, `wasm/vision_wasm_nosimd_internal.wasm` | same package; used only by browsers without WebAssembly SIMD | Apache-2.0 |
| `pose_landmarker_full.task` | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task (downloaded 2026-10-16, 9398198 bytes, md5 `g4eWidNz0UO+CUyXI1Xkjg==` as published, sha256 `5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1`) | Apache-2.0 (MediaPipe model card) |
| `pose_landmarker_lite.task` | https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task (downloaded 2026-10-16, 5777746 bytes, md5 `BKdd33yBGsehpFIyZt19iA==`, sha256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`) | Apache-2.0 |

The full model is used on desktops, the lite one on phones.

`@mediapipe/tasks-vision` 1.1.1 posts usage statistics to `https://odml.pa.googleapis.com/v1/log` once a minute
(hard-coded in the bundle, no option to turn it off). Pages that load the pose model should block it with
`<meta http-equiv="Content-Security-Policy" content="connect-src 'self' blob: data:">` (dev/motion.html does).
