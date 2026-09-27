/**
 * The `jaira` command the installer ships (decision 0011 §7): the CLI, run on the app's own Electron in
 * Node mode (`ELECTRON_RUN_AS_NODE=1`), so the command and the app share one better-sqlite3, one plugin
 * store and one version, and no Node install is needed. Used by `package.mjs`.
 *
 *  - `stageCli(stage, externals)` bundles the CLI into `<stage>/cli/` with the APP's externals — the
 *    npm CLI's bundle leaves its own dependencies to npm, and the installed app ships only the few
 *    modules the bundles load by name (`RUNTIME_MODULES`) — plus the MCP bridge worker, the plugin
 *    manifest and a launcher. It lands inside `app.asar`, whose `node_modules` it resolves from.
 *  - `commandFiles(stage, platform)` writes the wrapper(s) that go to `<resources>/bin` and what puts
 *    the command on the PATH: on Windows an NSIS include that drops `jaira.cmd` into
 *    `%LOCALAPPDATA%\Microsoft\WindowsApps` (already on every user's PATH, so the PATH itself is never
 *    edited — NSIS's string limit is how installers truncate it), on Linux the `.deb`'s install scripts
 *    that link `/usr/bin/jaira`. macOS and the AppImage get the About page's "Install the jaira
 *    command" instead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..", "cli");

/** An installed package's directory, found along Node's search paths (its `exports` may hide package.json). */
function packageDir(name) {
  for (const base of createRequire(join(here, "package.json")).resolve.paths(name) ?? []) {
    if (existsSync(join(base, name, "package.json"))) return join(base, name);
  }
  throw new Error(`${name} is not installed`);
}

/** Bundle the CLI for the installed app into `<stage>/cli/`. */
export async function stageCli(stage, externals) {
  const out = join(stage, "cli");
  const common = {
    outdir: out,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    legalComments: "eof",
    // Only what the installed app ships beside its bundles; everything else is inlined.
    external: [...externals, "electron"],
    // As the CLI's own build.mjs: jsonc-parser's UMD `main` breaks an ESM bundle.
    alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
    define: { "process.env.NODE_ENV": '"production"' },
    // An ESM bundle has no `require`, and a few inlined CommonJS packages still call it.
    banner: { js: 'import { createRequire as __jairaCreateRequire } from "node:module"; const require = __jairaCreateRequire(import.meta.url);' },
    logLevel: "warning",
    absWorkingDir: cliDir,
  };
  await build({ ...common, entryPoints: { cli: join(cliDir, "src", "main.ts") } });
  await build({ ...common, entryPoints: { mcpBridgeWorker: fileURLToPath(import.meta.resolve("@declarative-ai/agents-cli/mcpBridgeWorker")) } });
  // The plugin manifest, beside the bundle where `startPlugins` looks — the app's copy, sizes and all.
  copyFileSync(join(here, "dist", "plugins.json"), join(out, "plugins.json"));
  writeFileSync(
    join(out, "jaira.mjs"),
    [
      "// The installed app's `jaira` (packageCli.mjs): what the wrappers in <resources>/bin run, in Node mode.",
      "process.setSourceMapsEnabled(true);",
      'const { main } = await import("./cli.mjs");',
      "process.exitCode = await main(process.argv.slice(2));",
      "",
    ].join("\n"),
  );
}

/**
 * The wrappers and install hooks for one platform, written under `<stage>/command/`. Returns what the
 * electron-builder configuration needs: the directory shipped as `<resources>/bin`, and the platform's
 * install hooks.
 */
export function commandFiles(stage, platform = process.platform) {
  const dir = join(stage, "command");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  if (platform === "win32") {
    writeFileSync(
      join(bin, "jaira.cmd"),
      [
        "@echo off",
        "rem The installed JaiRA's command line: the CLI on the app's own Electron, in Node mode.",
        "setlocal",
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"%~dp0..\\..\\JaiRA.exe" "%~dp0..\\app.asar\\cli\\jaira.mjs" %*',
        "exit /b %ERRORLEVEL%",
        "",
      ].join("\r\n"),
    );
    // electron-builder's NSIS hooks. The forwarding script names the install directory, so a second
    // install elsewhere repoints it; the uninstaller removes it only while it still points here.
    const include = join(dir, "installer.nsh");
    writeFileSync(
      include,
      [
        "!macro customInstall",
        '  CreateDirectory "$LOCALAPPDATA\\Microsoft\\WindowsApps"',
        '  FileOpen $0 "$LOCALAPPDATA\\Microsoft\\WindowsApps\\jaira.cmd" w',
        '  FileWrite $0 "@echo off$\\r$\\n"',
        '  FileWrite $0 "rem Installed by JaiRA: the jaira command.$\\r$\\n"',
        '  FileWrite $0 "$\\"$INSTDIR\\resources\\bin\\jaira.cmd$\\" %*$\\r$\\n"',
        "  FileClose $0",
        "!macroend",
        "",
        "!macro customUnInstall",
        '  Delete "$LOCALAPPDATA\\Microsoft\\WindowsApps\\jaira.cmd"',
        "!macroend",
        "",
      ].join("\r\n"),
    );
    return { bin, nsisInclude: include };
  }
  // POSIX: follow the link /usr/bin/jaira (or /usr/local/bin/jaira) back to where the app is.
  const app = platform === "darwin" ? '"$HERE/../../MacOS/JaiRA"' : '"$HERE/../../jaira-app"';
  writeFileSync(
    join(bin, "jaira"),
    [
      "#!/bin/sh",
      "# The installed JaiRA's command line: the CLI on the app's own Electron, in Node mode.",
      'SELF="$0"',
      'while [ -L "$SELF" ]; do',
      '  LINK="$(readlink "$SELF")"',
      '  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac',
      "done",
      'HERE="$(cd "$(dirname "$SELF")" && pwd)"',
      `ELECTRON_RUN_AS_NODE=1 exec ${app} "$HERE/../app.asar/cli/jaira.mjs" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  if (platform !== "linux") return { bin };
  // The .deb: electron-builder's own install scripts (they link the app, set chrome-sandbox, load the
  // AppArmor profile) with the command's link added — templates, so `${…}` is filled in by it.
  const templates = join(packageDir("app-builder-lib"), "templates", "linux");
  const afterInstall = join(dir, "after-install.tpl");
  const afterRemove = join(dir, "after-remove.tpl");
  writeFileSync(
    afterInstall,
    `${readFileSync(join(templates, "after-install.tpl"), "utf8")}\n# The jaira command (decision 0011 §7).\nln -sf '/opt/\${sanitizedProductName}/resources/bin/jaira' '/usr/bin/jaira'\n`,
  );
  writeFileSync(
    afterRemove,
    `${readFileSync(join(templates, "after-remove.tpl"), "utf8")}\n# The jaira command (decision 0011 §7).\nrm -f '/usr/bin/jaira'\n`,
  );
  return { bin, afterInstall, afterRemove };
}
