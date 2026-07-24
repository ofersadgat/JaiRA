/**
 * Switch `better-sqlite3`'s native binary between the Node and Electron ABIs.
 *
 * better-sqlite3 is a V8-ABI addon (not Node-API), so one build cannot serve both
 * runtimes: Node 22 wants NODE_MODULE_VERSION 127 and Electron 33 wants 130.
 * There is a single copy in `node_modules`, so the binary is swapped rather than
 * duplicated — and because prebuilds are downloaded (no compiler needed) it takes
 * a second.
 *
 *   node scripts/nativeAbi.mjs electron   # before running the Electron app
 *   node scripts/nativeAbi.mjs node       # before running vitest / the CLI
 *
 * Getting this wrong is loud, not subtle: the mismatched runtime throws
 * "was compiled against a different Node.js version" on the first DB open.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const target = process.argv[2];
if (target !== "node" && target !== "electron") {
  console.error("usage: node scripts/nativeAbi.mjs <node|electron>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const moduleDir = join(root, "node_modules", "better-sqlite3");

const version =
  target === "node" ? process.versions.node : require("electron/package.json").version;

// Run prebuild-install's entry point with this Node directly: spawning `npx.cmd`
// fails with EINVAL on Windows, and going through a shell would be worse.
const prebuildInstall = require.resolve("prebuild-install/bin.js");

console.log(`fetching better-sqlite3 prebuild for ${target} ${version}…`);
execFileSync(process.execPath, [prebuildInstall, `--runtime=${target}`, `--target=${version}`], {
  cwd: moduleDir,
  stdio: "inherit",
});
console.log(`better-sqlite3 now targets ${target} ${version}`);
