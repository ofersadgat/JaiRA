/**
 * Picking the SQLite addon this runtime can load.
 *
 * The behaviour worth pinning is the MISS. A cache entry for another ABI, or no cache at all, must
 * return `undefined` so the caller falls back to the package's own binary — that fallback is what
 * keeps an ordinary `npm install` of the CLI working, where there is no cache and never will be.
 * Returning a path that happens to exist for the wrong ABI would turn a working install into the
 * exact crash this module exists to prevent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abiAdvice, abiBindingPath, cachedBinding, sqliteBinding } from "../src/nativeBinding";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-abi-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put a stand-in addon in the cache, the way `scripts/nativeAbi.mjs` does. */
function cache(abi: string): string {
  const file = abiBindingPath(dir, abi);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "not really an addon", "utf8");
  return file;
}

describe("cachedBinding", () => {
  it("finds the addon built for this ABI", () => {
    const file = cache("127");
    expect(cachedBinding(dir, "127")).toBe(file);
  });

  it("keeps the two runtimes apart", () => {
    cache("130");
    // The whole point: an Electron build present must not be offered to Node. Handing it over is
    // precisely the failure this replaced.
    expect(cachedBinding(dir, "127")).toBeUndefined();
    expect(cachedBinding(dir, "130")).toBe(abiBindingPath(dir, "130"));
  });

  it("reports nothing when nothing is cached", () => {
    expect(cachedBinding(dir, "127")).toBeUndefined();
  });

  it("keeps the cache inside the package, so a reinstall clears it", () => {
    // `build/` is what npm replaces when better-sqlite3 is reinstalled or upgraded — which is what
    // stops a binary built for an old version of the package surviving into a new one.
    expect(abiBindingPath("/pkg", "127").replace(/\\/g, "/")).toBe("/pkg/build/abi/127/better_sqlite3.node");
  });
});

describe("sqliteBinding", () => {
  it("answers for the runtime it is asked in, or not at all", () => {
    const found = sqliteBinding();
    // Environment-dependent by nature: a checkout that has run `npm install` has the cache, one that
    // skipped install hooks does not. Both are valid — what must hold is that any answer it DOES
    // give is for this runtime's ABI.
    if (found !== undefined) {
      expect(found.split(/[\\/]/).slice(-2)).toEqual([process.versions.modules, "better_sqlite3.node"]);
    }
  });
});

describe("abiAdvice", () => {
  it("turns the loader's two version numbers into the command that fixes them", () => {
    const advice = abiAdvice(
      new Error(
        "The module '\\\\?\\C:\\x\\better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 130. This version of Node.js requires NODE_MODULE_VERSION 127.",
      ),
    );
    expect(advice).toContain("npm run abi");
    expect(advice).toContain(process.versions.modules);
    // The original is kept: the numbers say which two runtimes were involved.
    expect(advice).toContain("NODE_MODULE_VERSION 130");
  });

  it("stays out of the way of every other failure", () => {
    // A corrupt database or a missing directory is not about the developer's toolchain, and telling
    // them to refetch an addon would send them somewhere with nothing wrong in it.
    expect(abiAdvice(new Error("unable to open database file"))).toBeUndefined();
    expect(abiAdvice("SQLITE_CORRUPT")).toBeUndefined();
  });
});
