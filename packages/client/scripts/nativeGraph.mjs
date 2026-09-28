/**
 * What the native app pulls in (decision 0015): the import graph from every route file (Metro bundles
 * all of `app/` for native, whichever platform a page is for), resolved the
 * way Metro resolves it for a phone (`.android`/`.native` files first, the client's aliases), checked
 * for packages that cannot run there. Needs no device and no Android SDK.
 *
 *   node packages/client/scripts/nativeGraph.mjs
 *
 * A DOM-only package reachable from native code is either a crash at startup or, like Monaco, a module
 * Metro cannot even transform. Each one found is printed with the chain of imports that reaches it,
 * so the fix is to cut that chain (move the pure part into its own module, or put the DOM part behind a
 * `.web` file).
 */
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(client, "../..");

/**
 * Monaco's COMMON layer is allowed: VS Code's layering keeps `vs/base/common` and `vs/editor/common` free
 * of DOM and Node, and the shared package's diff strategies use its line-diff algorithm from there. The
 * rest of Monaco is not.
 */
const ALLOWED = [/node_modules\/monaco-editor\/esm\/vs\/(base|editor)\/common\//];
/** Modules both bundlers replace for native (see `metro.config.cjs` and `native-stubs/`). */
const STUBS = { "externalLinesDiffComputer.js": join(client, "native-stubs/externalLinesDiffComputer.js") };

/** Packages that must never reach the native bundle. */
const FORBIDDEN = [/^monaco-editor\b/, /^@codemirror\//, /^@lezer\//, /^shiki\b/, /^@shikijs\//, /^react-dom\b/, /^@jaira\/ui\/(monacoDiff|markdownEditor|textmate|monacoTokens)/];
/** Native-only or runtime-provided: left out of the graph, as Metro would supply them. */
const EXTERNAL = ["react-native", "react-native-webview", "expo-*", "@expo/*", "react", "react/*", "@tamagui/*", "one", "one/*"];

const aliases = [
  ["@jaira/shared/browser", join(root, "packages/shared/src/browser.ts")],
  ["@jaira/shared", join(root, "packages/shared/src/index.ts")],
  ["@jaira/universal", join(root, "packages/universal/src/index.ts")],
  ["@jaira/ui", join(root, "packages/app/src/renderer")],
];

const result = await build({
  entryPoints: readdirSync(join(client, "app"))
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
    .map((f) => join(client, "app", f)),
  // Nothing is written (`write: false`); esbuild wants a directory for several entries all the same.
  outdir: join(client, ".native-graph"),
  bundle: true,
  write: false,
  metafile: true,
  logLevel: "silent",
  platform: "neutral",
  format: "esm",
  mainFields: ["react-native", "browser", "module", "main"],
  conditions: ["react-native", "import"],
  resolveExtensions: [".android.tsx", ".android.ts", ".native.tsx", ".native.ts", ".tsx", ".ts", ".android.js", ".native.js", ".js", ".json"],
  external: EXTERNAL,
  loader: { ".css": "empty", ".woff2": "empty", ".ttf": "empty", ".wasm": "empty" },
  plugins: [
    {
      name: "aliases-and-queries",
      setup(b) {
        // `?worker` and the like: a bundler feature, recorded under its bare path.
        b.onResolve({ filter: /\?/ }, (args) => ({ path: args.path, external: true }));
        // As Metro does (`metro.config.cjs`): Monaco's external diff computer is a stub on native.
        b.onResolve({ filter: /externalLinesDiffComputer\.js$/ }, (args) =>
          /monaco-editor/.test(args.importer) ? { path: STUBS["externalLinesDiffComputer.js"] } : undefined,
        );
        b.onResolve({ filter: /^@jaira\// }, async (args) => {
          for (const [alias, target] of aliases) {
            if (args.path === alias) return b.resolve(target, { kind: args.kind, resolveDir: root });
            if (args.path.startsWith(`${alias}/`) && !/\.tsx?$/.test(target)) {
              return b.resolve(join(target, args.path.slice(alias.length + 1)), { kind: args.kind, resolveDir: root });
            }
          }
          return undefined;
        });
      },
    },
  ],
}).catch((e) => ({ errors: e.errors ?? [e], metafile: undefined }));

if (result.metafile === undefined) {
  console.error("could not walk the graph:", result.errors.map((e) => e.text ?? e.message).join("\n"));
  process.exit(2);
}

// Who imports whom, and every external (bare) specifier with its importer.
const inputs = result.metafile.inputs;
const importers = new Map();
const bare = [];
for (const [file, info] of Object.entries(inputs)) {
  for (const imp of info.imports) {
    if (imp.external) bare.push({ from: file, path: imp.path });
    else (importers.get(imp.path) ?? importers.set(imp.path, []).get(imp.path)).push(file);
  }
}
const entry = relative(process.cwd(), join(client, "app")).split("\\").join("/") + "/*";
const chainTo = (file) => {
  const chain = [file];
  const seen = new Set([file]);
  let at = file;
  while (!/[\\/]app[\\/][^\\/]+$/.test(at)) {
    const up = (importers.get(at) ?? []).find((f) => !seen.has(f));
    if (up === undefined) break;
    chain.unshift(up);
    seen.add(up);
    at = up;
  }
  return chain;
};

const offenders = [];
for (const file of Object.keys(inputs)) {
  const pkg = file.replace(/\\/g, "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
  const local = file.replace(/\\/g, "/").match(/packages\/app\/src\/renderer\/([^/.]+)/)?.[1];
  const name = pkg ?? (local !== undefined ? `@jaira/ui/${local}` : undefined);
  if (ALLOWED.some((re) => re.test(file.replace(/\\/g, "/")))) continue;
  if (name !== undefined && FORBIDDEN.some((re) => re.test(name))) offenders.push({ name, file });
}
for (const { from, path } of bare) if (FORBIDDEN.some((re) => re.test(path.replace(/\?.*$/, "")))) offenders.push({ name: path, file: from, via: true });

const byName = new Map();
for (const o of offenders) if (!byName.has(o.name.split("/").slice(0, o.name.startsWith("@") ? 2 : 1).join("/"))) byName.set(o.name.split("/").slice(0, o.name.startsWith("@") ? 2 : 1).join("/"), o);

console.log(`native graph from ${entry}: ${Object.keys(inputs).length} modules`);
if (byName.size === 0) {
  console.log("no DOM-only package is reachable from native");
} else {
  console.log(`${byName.size} DOM-only package(s) reachable from native:`);
  for (const [name, o] of byName) {
    console.log(`\n  ${name}`);
    for (const step of chainTo(o.file)) console.log(`    ${step}`);
    if (o.via) console.log(`    → imports ${o.name}`);
  }
  process.exitCode = 1;
}
