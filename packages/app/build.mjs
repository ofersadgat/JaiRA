/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Both are emitted as CJS: a sandboxed-ish preload must be CJS, and keeping main
 * on the same format avoids ESM/CJS interop surprises with `electron`. Workspace
 * and declarative-ai packages are bundled in (they ship as TypeScript source);
 * `electron` and native modules stay external.
 */
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outdir = "dist";
// Remove only this build's own artifacts. Clearing all of `dist/` would delete
// `dist/renderer/` (Vite's output), making the build order load-bearing.
await Promise.all(
  [
    "main.cjs",
    "main.cjs.map",
    "preload.cjs",
    "preload.cjs.map",
    "tsProjectWorker.cjs",
    "tsProjectWorker.cjs.map",
    "mcpBridgeWorker.cjs",
    "mcpBridgeWorker.cjs.map",
  ].map((f) => rm(`${outdir}/${f}`, { force: true }).catch(() => {})),
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

/**
 * `import.meta.url` for the MAIN bundle, which is CJS and so has no `import.meta` of its own.
 *
 * esbuild empties it and warns, and empty is the dangerous half: `createRequire(import.meta.url)`
 * already crashed the `sdk` executor probe this way (see `executors.ts`), and `agents-cli`'s bridge
 * host still defaults its worker file with `new URL(…, import.meta.url)` — dead here only because
 * `service.ts` names the file. So rather than silence the warning, every read gets the bundle's own
 * URL, which is what an ES module in its place would have seen. Main only: a sandboxed preload has no
 * `node:url` to require, and nothing it bundles reads `import.meta`.
 */
const importMetaUrl = {
  define: { ...common.define, "import.meta.url": "__jairaImportMetaUrl" },
  banner: { js: 'const __jairaImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
};

await build({
  ...common,
  ...importMetaUrl,
  entryPoints: { main: "src/main/index.ts" },
  outdir,
  outExtension: { ".js": ".cjs" },
});

await build({
  ...common,
  entryPoints: { preload: "src/main/preload.ts" },
  outdir,
  outExtension: { ".js": ".cjs" },
  // The preload imports two constants from `@jaira/shared`, whose index also re-exports `paths.ts`
  // — and `defaultBuiltInDir` there reads `import.meta.url` on its ESM branch. esbuild warns while
  // PARSING the module and then tree-shakes all of it away (the bundle holds no `node:` require at
  // all), so the warning describes code that is not in the output. Silenced here and only here: the
  // main and worker bundles below keep the code and get a real URL instead.
  logOverride: { "empty-import-meta": "silent" },
});

// The type-check worker: its own bundle because `new Worker(file)` needs a file. It lands beside
// main.cjs, which is what `tsCheck.ts` resolves it against, and it keeps `typescript` external for
// exactly the reason the note above gives — a bundled compiler cannot find its own `lib.*.d.ts`.
await build({
  ...common,
  entryPoints: { tsProjectWorker: "src/main/tsProjectWorker.ts" },
  outdir,
  outExtension: { ".js": ".cjs" },
  // As for the preload: `paths.ts` is parsed on the way to a constant and shaken out entirely.
  logOverride: { "empty-import-meta": "silent" },
});

// The MCP bridge worker: the one listener every CLI agent run registers on, kept off the main loop
// (see `mcpBridgeWorker.ts` upstream). Loaded by path, so it is its own entry, resolved through the
// package's export rather than a hand-written path into `node_modules` — beside main.cjs, which is
// where `service.ts` looks for it.
await build({
  ...common,
  entryPoints: { mcpBridgeWorker: fileURLToPath(import.meta.resolve("@declarative-ai/agents-cli/mcpBridgeWorker")) },
  outdir,
  outExtension: { ".js": ".cjs" },
});

// The built-in layer (`$SYSTEM`, decision 0006) — see the same step in `packages/cli/build.mjs`. It
// lands beside main.cjs, which is where `defaultBuiltInDir` looks from inside this bundle, under
// `electron .` and in a packaged app alike. A packager that wraps `dist/` in an asar should ship this
// directory as an extra resource instead (`<resources>/builtin`, the first place that function
// looks): the layer is read with plain `node:fs` from worker threads and by the TypeScript compiler
// host, and a real directory is the one thing all of them can read.
//
// Removed first, and only it: a file deleted from the layer must not live on in `dist/`, and
// clearing the rest of `dist/` is what the note at the top of this file is about.
const builtIn = fileURLToPath(new URL("../shared/builtin", import.meta.url));
await rm(`${outdir}/builtin`, { recursive: true, force: true });
if (existsSync(builtIn)) await cp(builtIn, `${outdir}/builtin`, { recursive: true });

console.log("built dist/main.cjs, dist/preload.cjs, dist/tsProjectWorker.cjs, dist/mcpBridgeWorker.cjs and dist/builtin/");
