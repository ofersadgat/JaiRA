/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Both are emitted as CJS: a sandboxed-ish preload must be CJS, and keeping main
 * on the same format avoids ESM/CJS interop surprises with `electron`. Workspace
 * and declarative-ai packages are bundled in (they ship as TypeScript source);
 * `electron` and native modules stay external.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outdir = "dist";
// Remove only this build's own artifacts. Clearing all of `dist/` would delete
// `dist/renderer/` (Vite's output), making the build order load-bearing.
await Promise.all(
  ["main.cjs", "main.cjs.map", "preload.cjs", "preload.cjs.map"].map((f) =>
    rm(`${outdir}/${f}`, { force: true }).catch(() => {}),
  ),
);

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
  // better-sqlite3 is a native addon and electron is provided by the runtime.
  external: ["electron", "better-sqlite3"],
  define: { "process.env.NODE_ENV": '"production"' },
};

await build({
  ...common,
  entryPoints: { main: "src/main/index.ts" },
  outdir,
  outExtension: { ".js": ".cjs" },
});

await build({
  ...common,
  entryPoints: { preload: "src/main/preload.ts" },
  outdir,
  outExtension: { ".js": ".cjs" },
});

console.log("built dist/main.cjs and dist/preload.cjs");
