/**
 * Which copy of the SQLite addon this runtime can actually load.
 *
 * `better-sqlite3` is a V8-ABI addon rather than a Node-API one, so one build cannot serve both
 * runtimes we run it in: Node 22 loads `NODE_MODULE_VERSION 127` and Electron 33 loads 130, and each
 * refuses the other's binary outright. The package ships ONE binary at `build/Release`, so the
 * obvious answer was to swap that file whenever you changed which runtime you were about to use —
 * which meant remembering, every time, and discovering you had not by way of a stack trace. It also
 * made running the app and the tests at the same time impossible.
 *
 * So both binaries are kept, side by side, under `build/abi/<abi>/`, and the runtime picks its own:
 * `better-sqlite3` takes a `nativeBinding` path, and `process.versions.modules` is exactly the key to
 * look it up by. Nothing is swapped, nothing has to be remembered, and the two runtimes stop
 * contending for one file.
 *
 * Two properties keep this honest:
 *
 *  - **The cache lives inside the package it belongs to.** Reinstalling or upgrading
 *    `better-sqlite3` replaces that directory, so a stale binary for an old version cannot survive
 *    into a new one. `scripts/nativeAbi.mjs` fills it; `npm install` runs that.
 *  - **A miss is not an error.** With no cached copy for this ABI the caller falls back to the
 *    package's own default, which is right for anyone who installed JaiRA normally: `npm install`
 *    built one binary, for the runtime they are using. The cache is a development convenience, and
 *    it must not become a thing the published CLI depends on.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the addon for one ABI lives, relative to the `better-sqlite3` package directory. */
export function abiBindingPath(moduleDir: string, abi: string): string {
  return join(moduleDir, "build", "abi", abi, "better_sqlite3.node");
}

/** That path if it exists, `undefined` otherwise — the caller then uses the package's default. */
export function cachedBinding(moduleDir: string, abi: string): string | undefined {
  const file = abiBindingPath(moduleDir, abi);
  return existsSync(file) ? file : undefined;
}

/**
 * Where `better-sqlite3` is installed, as seen from here.
 *
 * The base for resolution has to work in three shapes this module is run in: TypeScript source under
 * vitest and tsx (ESM, so `import.meta.url`), the CLI bundle (ESM), and the Electron main bundle
 * (CJS, where esbuild replaces `import.meta` with nothing and `__filename` is what exists). `typeof`
 * on an identifier that was never declared is safe, which is what lets one expression cover both.
 *
 * Undefined when resolution fails at all — a bundle that moved the package, or an environment
 * without one. That is a miss, not a failure; see the module comment.
 */
function betterSqliteDir(): string | undefined {
  try {
    const from = typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
    return dirname(createRequire(from).resolve("better-sqlite3/package.json"));
  } catch {
    return undefined;
  }
}

/** The addon this runtime should load, or `undefined` to let the package find its own. */
export function sqliteBinding(): string | undefined {
  const dir = betterSqliteDir();
  return dir === undefined ? undefined : cachedBinding(dir, process.versions.modules);
}

/**
 * The ABI mismatch, restated as something you can act on.
 *
 * Node's own message names two numbers and no remedy, and the remedy is one command. Recognised by
 * the message rather than by a code because the loader throws a plain `Error` — matched on the two
 * halves that are stable across Node versions.
 */
export function abiAdvice(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(message)) return undefined;
  return (
    `${message}\n\n` +
    `This runtime needs the SQLite addon built for ABI ${process.versions.modules}, and there is no ` +
    "cached copy of it. Run `npm run abi` in the JaiRA checkout to fetch one for both Node and Electron."
  );
}
