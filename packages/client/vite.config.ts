import { fileURLToPath } from "node:url";
import type { Plugin, PluginOption, UserConfig } from "vite";
import { one } from "one/vite";
import { commercialUseProblem } from "../app/licenses/commercialUse";
import { thirdPartyLicensesPlugin } from "../app/licenses/thirdPartyLicenses";

/** This checkout's own packages, by name. */
const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * One's plugins, with its client tree-shake taught that `.json` is not `.js`.
 *
 * `one-client-tree-shake` filters with `/\.(js|jsx|ts|tsx)/` on `extname(id)`, unanchored, so `.json`
 * passes and is parsed as a module ("Expected a semicolon…"). `@jaira/shared` imports vendored JSON
 * schemas, so the build fails. The wrapper skips JSON and leaves every other file to One (1.27.1).
 */
function oneWithJsonFix(options: Parameters<typeof one>[0]): PluginOption[] {
  return (one(options) as PluginOption[]).map((plugin) => {
    const p = plugin as Plugin | null;
    if (p?.name !== "one-client-tree-shake" || typeof p.transform !== "object" || p.transform === null) return plugin;
    const { handler } = p.transform;
    return {
      ...p,
      transform: {
        ...p.transform,
        handler(this: unknown, code: string, id: string, ...rest: unknown[]) {
          if (/\.json(?:$|\?)/.test(id)) return;
          return (handler as (...a: unknown[]) => unknown).call(this, code, id, ...rest);
        },
      },
    } as Plugin;
  });
}

/**
 * The Licenses page's manifest, `dist/client/third-party-licenses.json` (the desktop's main reads it on
 * `licenses:read`): this build's client chunks (`window`), the main build's inputs (`main`, listed by
 * `packages/app/build.mjs`, which runs first), and whatever else the app's production dependencies
 * install (`installed`) — see the plugin. The window's bundle only: One also builds the pages for Node,
 * to read their exports, and what that build holds is not shipped.
 *
 * Every entry must also be one a closed, commercial product may ship (`commercialUse.ts`), and this is
 * where that is asked of what only the window holds — react-native-web, Tamagui, One. The suite's check
 * (`thirdPartyLicenses.test.ts`) walks the app's own dependencies with no build to read, and those
 * packages are the client's.
 */
function licenses(): Plugin {
  const plugin = thirdPartyLicensesPlugin({
    bundleName: "window",
    configFile: new URL("../app/licenses/config.json", import.meta.url),
    packageManifests: [{ bundle: "installed", path: new URL("../app/package.json", import.meta.url), fallback: true }],
    moduleLists: [{ bundle: "main", file: new URL("../app/dist/main-modules.json", import.meta.url) }],
  });
  return {
    name: plugin.name,
    apply: plugin.apply,
    applyToEnvironment: (environment) => environment.name === "client",
    async generateBundle(outputOptions, bundle) {
      await plugin.generateBundle.call(
        {
          emitFile: (file) => {
            const { entries } = JSON.parse(file.source) as { entries: { name: string; version: string | null; license: string }[] };
            const problems = entries.flatMap((entry) => {
              const problem = commercialUseProblem(entry.license, entry.name);
              return problem === null ? [] : [`- ${entry.name}${entry.version !== null ? `@${entry.version}` : ""}: ${problem}`];
            });
            if (problems.length > 0) throw new Error(`The app would ship ${problems.length} package(s) under a license that does not allow it:\n${problems.join("\n")}`);
            return this.emitFile(file);
          },
        },
        outputOptions,
        bundle,
      );
    },
  };
}

/**
 * The One app (decision 0015).
 *
 * SPA only, and no loaders: Electron serves `dist/client` from its `app://` protocol, where there is
 * no server to render or load anything. The aliases name this checkout's own packages — a workspace
 * junction can point into another checkout, and a bare `@jaira/shared` then builds against sources
 * this branch had not changed — plus `@jaira/ui`, the renderer's modules where they stand
 * (`packages/app/src/renderer`). Order matters: a subpath entry precedes its package.
 */
export default {
  // Metro for native (0015: "native is stable in Metro mode"); `metro.config.js` carries the monorepo.
  plugins: [
    oneWithJsonFix({
      web: { defaultRenderMode: "spa" },
      native: { bundler: "metro" },
      // Off: One rewrites path-mapped imports itself, against this folder rather than the tsconfig`s
      // `baseUrl`, so `@jaira/universal` became `../packages/…` under packages/client. Both bundlers
      // carry the aliases explicitly instead (here, and `metro.config.cjs`).
      config: { tsConfigPaths: false },
    }),
    licenses(),
  ],
  resolve: {
    alias: [
      { find: "@jaira/ui", replacement: local("../app/src/renderer") },
      { find: "@jaira/universal", replacement: local("../universal/src/index.ts") },
      { find: "@jaira/shared/browser", replacement: local("../shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("../shared/src/index.ts") },
    ],
  },
  build: {
    target: "chrome122",
    chunkSizeWarningLimit: 7168,
  },
} satisfies UserConfig;
