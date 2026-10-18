/** Rapier's declaration files for the type checker (typecheck.ts), keyed by their path in node_modules. */
export const files = import.meta.glob("/node_modules/@dimforge/rapier3d-compat/dist/**/*.d.ts", {
  eager: true,
  query: "?raw",
  import: "default",
  exhaustive: true,
}) as Record<string, string>;
