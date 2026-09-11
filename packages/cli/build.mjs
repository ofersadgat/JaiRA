/**
 * Bundles the CLI with esbuild.
 *
 * declarative-ai and the sibling `@jaira/*` workspaces ship as TypeScript source
 * rather than as published packages, so they are inlined here: the tarball this
 * produces depends on neither. Anything that exists on npm in its own right stays
 * external — `external` is exactly this package's `dependencies`, so declaring a
 * dependency and externalizing it are the same act and cannot drift apart.
 *
 * better-sqlite3 has no choice in the matter: it is a native addon. So does `typescript`, for a less
 * obvious reason: `@declarative-ai/hw` reaches the TS compiler through `import("typescript")` to
 * transpile a `.ts` callee, esbuild follows that dynamic import and inlines the whole compiler, and
 * tsc's own `require("fs")` then throws `Dynamic require of "fs" is not supported` at import time —
 * before the CLI has printed anything. Declaring it as a dependency is what externalizes it.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

await rm("dist", { recursive: true, force: true });

/** @type {import("esbuild").BuildOptions} */
const common = {
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Keeps @license/@preserve headers from the bundled sources in the output.
  legalComments: "eof",
  external: Object.keys(pkg.dependencies),
  // jsonc-parser's `main` is a UMD build whose internal `require("./impl/…")` calls survive into an
  // ESM bundle and throw at import time ("Dynamic require is not supported"). Its `module` entry is
  // real ESM. Alias just that package rather than flipping mainFields for every dependency.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
};

await build({ ...common, entryPoints: { cli: "src/main.ts" } });

// The MCP bridge worker: the one listener every CLI agent run registers on, kept off the main loop
// (see `mcpBridgeWorker.ts` upstream). It is loaded by path — `new Worker(file)` — so inlining the
// adapter into cli.mjs does not carry it along; it is its own entry beside the bundle, which is
// where `cli.ts` looks first.
await build({
  ...common,
  entryPoints: { mcpBridgeWorker: fileURLToPath(import.meta.resolve("@declarative-ai/agents-cli/mcpBridgeWorker")) },
});

console.log("built dist/cli.mjs and dist/mcpBridgeWorker.mjs");
