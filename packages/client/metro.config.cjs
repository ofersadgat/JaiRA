/**
 * Metro for the native build (decision 0013): One's Metro config, plus what a monorepo whose engine
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
const stubs = { "externalLinesDiffComputer.js": join(__dirname, "native-stubs/externalLinesDiffComputer.js") };

module.exports = (one) => {
  const upstream = one.resolver.resolveRequest;
  const next = (context, name, platform) => (upstream ?? context.resolveRequest)(context, name, platform);
  return {
    ...one,
    watchFolders: [...(one.watchFolders ?? []), root, resolve(root, "../declarative-ai")],
    resolver: {
      ...one.resolver,
      nodeModulesPaths: [...(one.resolver.nodeModulesPaths ?? []), join(__dirname, "node_modules"), join(root, "node_modules")],
      resolveRequest: (context, name, platform) => {
        const stub = stubs[name.split("/").pop()];
        if (stub !== undefined && /[\\/]monaco-editor[\\/]/.test(context.originModulePath)) return { type: "sourceFile", filePath: stub };
        for (const [alias, target] of aliases) {
          if (name === alias) return next(context, target, platform);
          if (name.startsWith(`${alias}/`) && !/\.tsx?$/.test(target)) return next(context, join(target, name.slice(alias.length + 1)), platform);
        }
        if (single.has(name)) return next({ ...context, originModulePath: join(root, "package.json") }, name, platform);
        return next(context, name, platform);
      },
    },
  };
};
