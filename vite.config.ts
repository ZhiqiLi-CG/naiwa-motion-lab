import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5180,
    // Model environments, videos and renders live there; watching them exhausts the system's file watchers.
    watch: { ignored: ["**/.cache/**", "**/assets-src/**", "**/tests/e2e/out/**", "**/tools/**"] },
  },
  preview: { host: "127.0.0.1", port: 5181 },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  test: { include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"], environment: "node" },
});
