/**
 * Bundles the CLI with esbuild.
 *
 * declarative-ai and the sibling `@jaira/*` workspaces ship as TypeScript source
 * rather than as published packages, so they are inlined here: the tarball this
 * produces depends on neither. Anything that exists on npm in its own right stays
 * external — `external` is exactly this package's `dependencies`, so declaring a
 * dependency and externalizing it are the same act and cannot drift apart.
 *
 * better-sqlite3 has no choice in the matter: it is a native addon.
 */
import { build } from "esbuild";
import { copyFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: { cli: "src/main.ts" },
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
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

// declarative-ai is MIT and we inline ~100 of its modules; MIT wants its notice
// carried along. Copied from the source we just bundled, so it cannot describe a
// version we did not ship.
await copyFile("../../../declarative-ai/LICENSE", "dist/LICENSE-declarative-ai");

console.log("built dist/cli.mjs");
