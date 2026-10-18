/** three's declaration files for the type checker (typecheck.ts), keyed by their path in node_modules. */
export const files = import.meta.glob(["/node_modules/@types/three/index.d.ts", "/node_modules/@types/three/src/**/*.d.ts"], {
  eager: true,
  query: "?raw",
  import: "default",
  exhaustive: true,
}) as Record<string, string>;
