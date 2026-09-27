/**
 * The packaged app's own check, run by `package.mjs` with the packaged executable in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`) against that executable's `app.asar`:
 *
 * - every module the bundle loads by name at run time resolves from where the bundle sits;
 * - the SQLite addon opens a database;
 * - the compiler's `lib.*.d.ts` are where the compiler looks (electron-builder drops `*.d.ts` from
 *   `node_modules` unless told otherwise, and a compiler without them extracts wrong signatures
 *   rather than failing);
 * - both worker bundles start.
 *
 * `JAIRA_PROBE_MODULES` is the JSON list of module ids to resolve. Exit 0 and one line when all of it
 * holds; otherwise exit 1 with one line per failure on stderr.
 */
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { Worker } = require("node:worker_threads");

const resources = process.platform === "darwin" ? path.join(path.dirname(process.execPath), "..", "Resources") : path.join(path.dirname(process.execPath), "resources");
const app = path.join(resources, "app.asar");
const from = createRequire(path.join(app, "dist", "main.cjs"));
const failures = [];

async function main() {
  for (const id of JSON.parse(process.env.JAIRA_PROBE_MODULES ?? "[]")) {
    try {
      await import(pathToFileURL(from.resolve(id)).href);
    } catch (e) {
      failures.push(`${id}: ${String(e.message).split("\n")[0]}`);
    }
  }

  try {
    const Database = from("better-sqlite3");
    new Database(":memory:").prepare("select 1").get();
  } catch (e) {
    failures.push(`better-sqlite3 could not open a database: ${e.message}`);
  }

  try {
    const ts = from("typescript");
    const lib = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 });
    if (!ts.sys.fileExists(lib)) failures.push(`typescript: its lib file ${lib} is missing`);
  } catch (e) {
    failures.push(`typescript: ${e.message}`);
  }

  for (const file of ["tsProjectWorker.cjs", "mcpBridgeWorker.cjs"]) {
    await new Promise((done) => {
      const worker = new Worker(path.join(app, "dist", file));
      const alive = setTimeout(() => {
        void worker.terminate();
        done();
      }, 1500);
      worker.on("error", (e) => {
        clearTimeout(alive);
        failures.push(`${file} did not start: ${e.message}`);
        done();
      });
    });
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("probe: runtime modules, sqlite, typescript lib files and both workers ok");
}

void main();
