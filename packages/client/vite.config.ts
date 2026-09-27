import { fileURLToPath } from "node:url";
import type { Plugin, PluginOption, UserConfig } from "vite";
import { one } from "one/vite";

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
 * The One app (decision 0013).
 *
 * SPA only, and no loaders: Electron serves `dist/client` from its `app://` protocol, where there is
 * no server to render or load anything. The aliases are the app's own (`packages/app/vite.config.ts`),
 * for the same reason — a workspace junction can point into another checkout — plus `@jaira/ui`, which
 * is today's renderer where it stands. It is not moved during the spike; see 0013, S1.
 */
export default {
  plugins: [oneWithJsonFix({ web: { defaultRenderMode: "spa" } })],
  resolve: {
    alias: [
      { find: "@jaira/ui", replacement: local("../app/src/renderer") },
      { find: "@jaira/shared/browser", replacement: local("../shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("../shared/src/index.ts") },
    ],
  },
  build: {
    target: "chrome122",
    chunkSizeWarningLimit: 7168,
  },
} satisfies UserConfig;
