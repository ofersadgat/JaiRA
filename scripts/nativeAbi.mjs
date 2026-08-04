/**
 * Fetch `better-sqlite3`'s native binary for the runtimes this repo uses, and keep them side by
 * side.
 *
 * better-sqlite3 is a V8-ABI addon (not Node-API), so one build cannot serve both: Node 22 wants
 * NODE_MODULE_VERSION 127 and Electron 33 wants 130. The package ships one binary, so this used to
 * SWAP it — which meant remembering to swap before every switch between `vitest` and the app, and
 * finding out you had not by way of "was compiled against a different Node.js version".
 *
 * Now both are cached under `build/abi/<abi>/` and the runtime picks its own at open time
 * (`packages/persistence/src/nativeBinding.ts`). Nothing is swapped, so the app and the tests can
 * run at the same time, and neither has to be preceded by anything.
 *
 *   node scripts/nativeAbi.mjs              # both, which is what `npm install` runs
 *   node scripts/nativeAbi.mjs node         # just one
 *   node scripts/nativeAbi.mjs electron
 *
 * Already-cached ABIs are left alone, so a re-run costs one `existsSync` per runtime. Pass
 * `--refetch` to fetch them again anyway, and `--quiet-fail` to warn instead of failing — which is
 * what the install hook wants, since a machine with no network should still finish `npm install`.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const named = args.filter((a) => !a.startsWith("--"));
const targets = named.length > 0 ? named : ["node", "electron"];
for (const target of targets) {
  if (target !== "node" && target !== "electron") {
    console.error("usage: node scripts/nativeAbi.mjs [node|electron] [--refetch] [--quiet-fail]");
    process.exit(2);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const moduleDir = join(root, "node_modules", "better-sqlite3");
const release = join(moduleDir, "build", "Release", "better_sqlite3.node");

/**
 * The ABI a runtime version loads.
 *
 * `node-abi` is the table `prebuild-install` itself consults to build a download URL, and it arrives
 * as that package's own dependency — so a checkout where this resolves is exactly a checkout where
 * the fetch below can run at all. Asking it beats parsing the answer back out of the prebuild's
 * filename, and beats launching Electron to ask it directly.
 */
const { getAbi } = require("node-abi");
const versionOf = (target) =>
  target === "node" ? process.versions.node : require("electron/package.json").version;
const cacheFile = (abi) => join(moduleDir, "build", "abi", String(abi), "better_sqlite3.node");

/**
 * Fetch one runtime's binary into the cache.
 *
 * `prebuild-install` can only write to `build/Release` — it is the path the package's own build
 * produces — so the fetched file is copied out of there and into the cache. `build/Release` is left
 * holding whichever runtime went last, which no longer decides anything: it is the fallback for an
 * installed copy that has no cache at all.
 */
function fetch(target) {
  const version = versionOf(target);
  const abi = getAbi(version, target);
  const cached = cacheFile(abi);
  if (existsSync(cached) && !flags.has("--refetch")) {
    console.log(`better-sqlite3 for ${target} ${version} (abi ${abi}) is already cached`);
    return { abi, cached };
  }
  console.log(`fetching better-sqlite3 prebuild for ${target} ${version} (abi ${abi})…`);
  // Run prebuild-install's entry point with this Node directly: spawning `npx.cmd` fails with
  // EINVAL on Windows, and going through a shell would be worse.
  execFileSync(process.execPath, [require.resolve("prebuild-install/bin.js"), `--runtime=${target}`, `--target=${version}`], {
    cwd: moduleDir,
    stdio: "inherit",
  });
  mkdirSync(dirname(cached), { recursive: true });
  copyFileSync(release, cached);
  return { abi, cached };
}

let failed = false;
const fetched = [];
for (const target of targets) {
  try {
    fetched.push({ target, ...fetch(target) });
  } catch (e) {
    failed = true;
    const message = `could not fetch the better-sqlite3 prebuild for ${target}: ${e.message}`;
    if (flags.has("--quiet-fail")) console.warn(`warning: ${message}`);
    else throw e;
  }
}

// Leave the package's own default pointing at the Node build. Nothing in this repo reads it once the
// cache is filled, but a bare `require("better-sqlite3")` from a script — or a tool that never heard
// of any of this — should find the binary for the runtime it is being run by.
const forNode = fetched.find((f) => f.target === "node");
if (forNode !== undefined && existsSync(forNode.cached)) copyFileSync(forNode.cached, release);

if (!failed) {
  console.log(`cached: ${fetched.map((f) => `${f.target} (abi ${f.abi})`).join(", ")}`);
}
