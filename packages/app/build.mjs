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
  //
  // `typescript` MUST stay external, and not because it is big. Signature extraction (SPEC §7.5.2)
  // reads TypeScript's own `lib.*.d.ts` off the real disk, and the only address it has for them is
  // `ts.getDefaultLibFilePath()` — which is `dirname(__filename)` of the typescript module. Bundled,
  // that is `packages/app/dist/`, which holds no lib files, so `hw`'s compiler host (signature.ts's
  // `createProgram`) reads none: the program loses every global. The failure is silent and it is
  // WRONG rather than absent — a `.ts` function returning `string[]` extracts as `{}`, whose wire
  // schema is `{"type":"object"}`, and every state binding that return to an array slot fails
  // §6.2's check with "producer type 'object' not allowed by consumer array". Nothing else in the
  // app notices, because the app is the only surface that bundled the compiler: the CLI derives
  // `external` from its own `dependencies`, which is what kept it correct.
  external: ["electron", "better-sqlite3", "typescript"],
  // jsonc-parser's `main` is a UMD build whose internal `require("./impl/…")` calls survive
  // bundling and throw at load ("Cannot find module './impl/format'"). Its `module` entry is real
  // ESM, which esbuild folds into a CJS bundle cleanly. Same alias the CLI's build.mjs carries.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
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
