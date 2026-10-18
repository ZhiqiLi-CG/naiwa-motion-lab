import { defineConfig } from "vitest/config";

/** Cross-origin isolation, so SharedArrayBuffer exists: the GPU simulators' CPU-parallel fallback (Web Workers over
 *  shared memory) needs it. Everything the page loads is same-origin, so require-corp costs nothing. Keep in step with
 *  public/_headers and vercel.json. */
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5180,
    headers: ISOLATION,
    // Model environments, videos and renders live there; watching them exhausts the system's file watchers.
    watch: { ignored: ["**/.cache/**", "**/assets-src/**", "**/tests/e2e/out/**", "**/tools/**"] },
  },
  preview: { host: "127.0.0.1", port: 5181, headers: ISOLATION },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  test: { include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"], environment: "node" },
});
