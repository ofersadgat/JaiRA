/**
 * Package the built app into an installer for THIS machine's platform and architecture
 * (decision 0011 §2). Run after `build.mjs` and the renderer build: `npm run dist`.
 *
 *   node package.mjs                 # installer(s) for this platform, into release/<version>/
 *   node package.mjs --dir           # the unpacked app only, no installer: quicker, and what the smoke test needs
 *   node package.mjs --skip-smoke    # do not launch the packaged app afterwards
 *
 * electron-builder never sees this package. It runs over a STAGED directory holding the bundle and a
 * generated `package.json` whose dependencies are only what the bundle loads by name at run time, so
 * nothing the workspace happens to have installed rides along — the two plugins least of all
 * (`@anthropic-ai/claude-agent-sdk`, `node-llama-cpp`): they are downloaded on demand (§6), and a
 * base installer without them is the point.
 *
 * Each architecture is built on its own machine, because an installed native package holds only its
 * own platform's binary; nothing here cross-builds.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "package.json"));
const args = new Set(process.argv.slice(2));

/**
 * What the bundle loads BY NAME at run time, and so must be installed beside it. Anything bundled is
 * not here. Found by reading the bundles for `require("…")`, `import(<constant>)` and
 * `createRequire(…)("…")` (2026-09-26); a new one shows up as the smoke test failing, or worse, as a
 * feature failing only in the packaged app, so keep this list next to the reason for each entry.
 */
const RUNTIME_MODULES = {
  // Native, Node-API: one binary per platform in its own `prebuilds/` (better-sqlite3 13).
  "better-sqlite3": "external in build.mjs",
  // Reads its own `lib.*.d.ts` from disk, so it cannot be bundled (see build.mjs).
  typescript: "external in build.mjs",
  // declarative-ai imports it by a constant specifier: the MCP bridge every CLI agent's approvals go
  // through, host tools served to an in-process agent, and connecting to MCP servers.
  "@modelcontextprotocol/sdk": "import(SDK_SERVER) and friends in agents-cli / agents-api / mcp",
  // `@ai-sdk/provider-utils` requires it through `createRequire` for its guarded fetch.
  undici: "createRequire(…)(\"undici\") in @ai-sdk/provider-utils",
};

const appPackage = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const version = process.env.JAIRA_BUILD_VERSION ?? appPackage.version;
const electronVersion = require("electron/package.json").version;

/**
 * The version the workspace resolved, so the stage installs exactly what the tests ran against.
 *
 * Found by walking the resolution paths rather than `require("<name>/package.json")`: a package whose
 * `exports` map does not list its `package.json` (`@modelcontextprotocol/sdk` maps `./*` into
 * `dist/cjs/`, where a stub `package.json` holds only `type`) answers that request with the wrong
 * file, and a missing `version` then drops the package from the stage without a word.
 */
function installedVersion(name) {
  for (const base of require.resolve.paths(name) ?? []) {
    const file = join(base, name, "package.json");
    if (!existsSync(file)) continue;
    const { version: found } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof found === "string") return found;
  }
  throw new Error(`${name} is not installed in the workspace — the stage needs it (${RUNTIME_MODULES[name]})`);
}

/** Remove what is safe to remove from the stage, leaving the rest of the tree alone. */
function prune(stage) {
  const sqlite = join(stage, "node_modules", "better-sqlite3");
  // Only this platform's prebuilt binary; the package ships all eight. Linux keeps both libc flavours.
  const keep = new Set([`${process.platform}-${process.arch}.node`, `linuxmusl-${process.arch}.node`]);
  for (const file of readdirSync(join(sqlite, "prebuilds"))) {
    if (!keep.has(file)) rmSync(join(sqlite, "prebuilds", file));
  }
  // Its C sources and build file: nothing is compiled here, and a stray `binding.gyp` invites a rebuild.
  for (const part of ["src", "deps", "binding.gyp"]) rmSync(join(sqlite, part), { recursive: true, force: true });
}

function stageApp() {
  const dist = join(here, "dist");
  for (const file of ["main.cjs", "preload.cjs", "tsProjectWorker.cjs", "mcpBridgeWorker.cjs", "renderer/index.html", "builtin"]) {
    if (!existsSync(join(dist, file))) throw new Error(`dist/${file} is missing — run the build first (npm run build)`);
  }

  const stage = mkdtempSync(join(tmpdir(), "jaira-stage-"));
  cpSync(join(here, "entry.cjs"), join(stage, "entry.cjs"));
  cpSync(dist, join(stage, "dist"), {
    recursive: true,
    // `builtin/` ships as a resource instead (see `extraResources`); the snapshot harness's output and
    // the license build's hand-over file are not part of the app.
    filter: (src) => {
      const rel = src.slice(dist.length).replace(/\\/g, "/");
      return !/^\/(builtin|snapshot)(\/|$)/.test(rel) && rel !== "/main-modules.json";
    },
  });

  const dependencies = Object.fromEntries(Object.keys(RUNTIME_MODULES).map((name) => [name, installedVersion(name)]));
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: "jaira",
        productName: "JaiRA",
        version,
        description: appPackage.description ?? "JaiRA",
        author: "JaiRA",
        license: "UNLICENSED",
        private: true,
        main: "entry.cjs",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`staging ${Object.entries(dependencies).map(([n, v]) => `${n}@${v}`).join(", ")} in ${stage}`);
  // `npm` is a `.cmd` on Windows, which `execFileSync` cannot start without a shell.
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: stage,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  for (const name of Object.keys(RUNTIME_MODULES)) {
    if (!existsSync(join(stage, "node_modules", name, "package.json"))) throw new Error(`the stage did not install ${name}`);
  }
  prune(stage);
  return stage;
}

/** The electron-builder configuration: same app id and layout on every platform. */
function builderConfig(stage, output) {
  return {
    appId: "com.mistlabs.jaira",
    productName: "JaiRA",
    electronVersion,
    directories: { app: stage, output },
    files: ["entry.cjs", "dist/**", "node_modules/**", "package.json"],
    // electron-builder leaves every `*.d.ts` under `node_modules` out by default, which for
    // `typescript` is its `lib.*.d.ts`: the silent, wrong-not-absent signature failure build.mjs
    // describes. A `files` pattern does not bring them back (the node_modules copier applies its
    // exclusions first); this hook is what it consults before excluding. Checked by the probe.
    onNodeModuleFile: (file) => /[\\/]typescript[\\/]lib[\\/][^\\/]+\.d\.ts$/.test(file),
    // Read with plain `node:fs` from worker threads and by the TypeScript compiler host, so a real
    // directory: `defaultBuiltInDir` looks in `<resources>/builtin` first.
    extraResources: [{ from: join(here, "dist", "builtin"), to: "builtin" }],
    asar: true,
    // The addon must be a real file to be loaded; the compiler reads its lib files off the real disk
    // (from a worker thread too).
    asarUnpack: ["**/*.node", "node_modules/typescript/**"],
    // Nothing to rebuild: the one native module is Node-API and prebuilt.
    npmRebuild: false,
    nodeGypRebuild: false,
    // The updater's feed is written in the updates step (0011 §4); until then there is none.
    publish: null,
    win: { target: [{ target: "nsis", arch: [process.arch] }] },
    nsis: { differentialPackage: true },
    mac: { target: [{ target: "dmg", arch: [process.arch] }, { target: "zip", arch: [process.arch] }], category: "public.app-category.developer-tools" },
    linux: { target: [{ target: "AppImage", arch: [process.arch] }, { target: "deb", arch: [process.arch] }], category: "Development", maintainer: "JaiRA" },
  };
}

/** Where electron-builder put the unpacked app's executable. */
function packagedExecutable(output) {
  const dir = readdirSync(output).map((d) => join(output, d)).find((d) => statSync(d).isDirectory() && /unpacked|\.app$|^mac/.test(d.split(/[\\/]/).pop()));
  if (dir === undefined) throw new Error(`no unpacked app under ${output}`);
  if (process.platform === "win32") return join(dir, "JaiRA.exe");
  if (process.platform === "darwin") return join(dir, "JaiRA.app", "Contents", "MacOS", "JaiRA");
  return join(dir, "jaira");
}

/** Run `packageProbe.cjs` with the packaged executable in Node mode; it says what it checks. */
function probe(exe) {
  const modules = [
    ...Object.keys(RUNTIME_MODULES).filter((m) => m !== "@modelcontextprotocol/sdk"),
    // The entry points declarative-ai actually imports: the package itself has no root export.
    "@modelcontextprotocol/sdk/server/index.js",
    "@modelcontextprotocol/sdk/client/stdio.js",
  ];
  const run = spawnSync(exe, [join(here, "packageProbe.cjs")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", JAIRA_PROBE_MODULES: JSON.stringify(modules) },
    encoding: "utf8",
    timeout: 60_000,
  });
  process.stdout.write(run.stdout ?? "");
  if (run.status !== 0) throw new Error(`probe failed: exit ${run.status ?? run.signal}\n${run.stderr ?? ""}`);
}

/**
 * Probe the packaged app's modules, then launch it against a scratch base root, let it open that
 * project (which opens its SQLite database) and render, and require a screenshot back. A wrong or
 * missing native binary, a runtime module left out of the stage, or a renderer that fails to load all
 * end here rather than on somebody's first launch.
 */
function smoke(output) {
  const exe = packagedExecutable(output);
  probe(exe);
  const home = mkdtempSync(join(tmpdir(), "jaira-smoke-home-"));
  const shot = join(output, "smoke.png");
  rmSync(shot, { force: true });
  console.log(`smoke test: ${exe}`);
  const run = spawnSync(exe, [], {
    env: { ...process.env, JAIRA_HOME: home, JAIRA_CAPTURE: shot, JAIRA_CAPTURE_DELAY_MS: "4000", ELECTRON_ENABLE_LOGGING: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  rmSync(home, { recursive: true, force: true });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status !== 0 || !existsSync(shot)) {
    console.error(out);
    throw new Error(`smoke test failed: exit ${run.status ?? run.signal}, ${existsSync(shot) ? "captured" : "no capture"}`);
  }
  console.log(`smoke test passed: ${shot}`);
}

const output = join(here, "release", version);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const stage = stageApp();
try {
  const { build, Platform } = require("electron-builder");
  const platform = { win32: Platform.WINDOWS, darwin: Platform.MAC, linux: Platform.LINUX }[process.platform];
  await build({
    targets: args.has("--dir") ? platform.createTarget("dir") : platform.createTarget(),
    config: builderConfig(stage, output),
    publish: "never",
  });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (!args.has("--skip-smoke")) smoke(output);
