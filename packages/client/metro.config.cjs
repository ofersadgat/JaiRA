/**
 * Metro for the native build (decision 0015): One's Metro config, plus what a monorepo whose engine
 * semantics live in a sibling checkout needs.
 *
 * A FUNCTION of the config One hands Metro, not a config of its own. Metro lets the file on disk win,
 * and a file starting from `expo/metro-config`'s defaults replaced One's transformer (the native
 * worker that inlines the router's root into `one/metro-entry`) and One's resolver with Expo's — the
 * bundle then fails on `require.context(process.env.ONE_ROUTER_APP_ROOT_RELATIVE_TO_ENTRY)`.
 *
 * - `watchFolders`: the repository root (the workspace packages) and `../declarative-ai`, which the
 *   shared package imports as TypeScript source over `file:` links.
 * - The aliases `vite.config.ts` carries (`@jaira/ui` is the renderer where it stands).
 * - One React: `react`, `react-dom` and `react-native` always resolve from the root (One issue #752).
 * - Monaco's external diff computer is stubbed (`native-stubs/`): see the stub for why.
 */
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "../..");

/** Exact names map to a file; a directory alias also takes subpaths (`@jaira/ui/board`). */
const aliases = [
  ["@jaira/shared/browser", join(root, "packages/shared/src/browser.ts")],
  ["@jaira/shared", join(root, "packages/shared/src/index.ts")],
  ["@jaira/universal", join(root, "packages/universal/src/index.ts")],
  ["@jaira/ui", join(root, "packages/app/src/renderer")],
];
const single = new Set(["react", "react-dom", "react-native"]);
/**
 * Packages whose `main` Metro cannot use, sent to their ES-module entry (what Vite and esbuild pick).
 * jsonc-parser's `main` is a UMD build whose requires sit inside a factory Metro does not see, so on a
 * device it threw `Unknown named module: "./impl/format"` the moment @jaira/shared's schemas loaded.
 */
const esmEntries = { "jsonc-parser": "lib/esm/main.js" };
/**
 * What Metro must not crawl or watch under the repository root: build output and scratch worlds.
 * Watching the root is what makes the workspace packages visible, and it also made a `npm run app:dist`
 * (which rewrites `packages/app/release/`) crash the dev server mid-bundle ("ENOENT … watch").
 */
// Anchored to THIS repository: a sibling's build output is not ours to ignore — `@declarative-ai/json`
// resolves to `declarative-ai/packages/json/dist/index.js`.
const here = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, "[\\\\/]");
const ignored = [
  new RegExp(`^${here}[\\\\/]packages[\\\\/]app[\\\\/](release|dist|shots)[\\\\/].*`),
  new RegExp(`^${here}[\\\\/]packages[\\\\/]client[\\\\/](dist|dist-island|\\.native-graph)[\\\\/].*`),
  new RegExp(`^${here}[\\\\/]packages[\\\\/](cli|shared|persistence|runtime|service|universal)[\\\\/]dist[\\\\/].*`),
  new RegExp(`^${here}[\\\\/]\\.git[\\\\/].*`),
  // The native projects `one prebuild` writes and Gradle builds into, here and inside each native
  // package: no JavaScript is in them, and a `./gradlew assembleDebug` writes tens of thousands of
  // files there. On 2026-09-30 the shared dev server stopped answering (a core pegged, its heap at the
  // limit) while one ran, and did not come back; not proved to be the cause, but nothing here is needed.
  new RegExp(`^${here}[\\\\/]packages[\\\\/]client[\\\\/](android|ios)[\\\\/].*`),
  new RegExp(`^${here}[\\\\/]node_modules[\\\\/].*[\\\\/]android[\\\\/](build|\\.cxx|\\.gradle)[\\\\/].*`),
];
const stubs = { "externalLinesDiffComputer.js": join(__dirname, "native-stubs/externalLinesDiffComputer.js") };
/**
 * react-native-gesture-handler (the frame's pinch, `DesktopFrame`) tries `require("react-native-reanimated")`
 * and drives its gestures through it when it is there. It is there — One installs Reanimated 4 and its
 * worklets, and autolinking links them — but not set up (no worklets Babel plugin), and the moment its
 * JavaScript loads, the worklets runtime aborts the app natively (`installUnpacker`: `assertion
 * "isObject()" failed`). Gesture handler is handed an empty module and uses its own JavaScript
 * callbacks, as it does in an app without Reanimated.
 */
const withoutReanimated = /[\\/]react-native-gesture-handler[\\/]/;

module.exports = (one) => {
  const upstream = one.resolver.resolveRequest;
  const next = (context, name, platform) => (upstream ?? context.resolveRequest)(context, name, platform);
  return {
    ...one,
    watchFolders: [...(one.watchFolders ?? []), root, resolve(root, "../declarative-ai")],
    resolver: {
      ...one.resolver,
      blockList: [...[one.resolver.blockList ?? []].flat(), ...ignored],
      nodeModulesPaths: [...(one.resolver.nodeModulesPaths ?? []), join(__dirname, "node_modules"), join(root, "node_modules")],
      resolveRequest: (context, name, platform) => {
        const stub = stubs[name.split("/").pop()];
        if (stub !== undefined && /[\\/]monaco-editor[\\/]/.test(context.originModulePath)) return { type: "sourceFile", filePath: stub };
        if (name === "react-native-reanimated" && withoutReanimated.test(context.originModulePath)) return { type: "empty" };
        for (const [alias, target] of aliases) {
          if (name === alias) return next(context, target, platform);
          if (name.startsWith(`${alias}/`) && !/\.tsx?$/.test(target)) return next(context, join(target, name.slice(alias.length + 1)), platform);
        }
        if (single.has(name)) return next({ ...context, originModulePath: join(root, "package.json") }, name, platform);
        if (name in esmEntries) {
          const dir = require("node:path").dirname(require.resolve(`${name}/package.json`, { paths: [root] }));
          return { type: "sourceFile", filePath: join(dir, esmEntries[name]) };
        }
        return next(context, name, platform);
      },
    },
  };
};
