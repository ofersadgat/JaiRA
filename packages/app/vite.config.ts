import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { thirdPartyLicensesPlugin } from "./licenses/thirdPartyLicenses";

/** This checkout's own packages, by name. */
const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Renderer bundle. `base: "./"` matters: the window is loaded with `loadFile`,
 * so assets must resolve relative to the HTML rather than a server root.
 */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [
    react(),
    // The Licenses page's manifest, `dist/renderer/third-party-licenses.json`: this build's chunks
    // (`window`), the main build's inputs (`main`, listed by build.mjs, which runs first), and
    // whatever else the app's production dependencies install (`installed`) — see the plugin.
    thirdPartyLicensesPlugin({
      bundleName: "window",
      configFile: new URL("./licenses/config.json", import.meta.url),
      packageManifests: [{ bundle: "installed", path: new URL("./package.json", import.meta.url), fallback: true }],
      moduleLists: [{ bundle: "main", file: new URL("./dist/main-modules.json", import.meta.url) }],
    }),
  ],
  resolve: {
    // The same aliases `vitest.config.ts` carries, and for the same reason. The workspace junctions
    // live in the repository root's `node_modules` and point at the MAIN checkout's packages — so
    // inside a git worktree a bare `@jaira/shared` import crossed into another checkout's code, and
    // the renderer was BUILT against sources this branch had not changed. It surfaced as
    // "X is not exported by shared/browser.ts" for something plainly exported right here.
    //
    // Order matters: the subpath entry must precede its package, or the package alias swallows it.
    alias: [
      { find: "@jaira/shared/browser", replacement: local("../shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("../shared/src/index.ts") },
      { find: "@jaira/runtime", replacement: local("../runtime/src/index.ts") },
      { find: "@jaira/persistence", replacement: local("../persistence/src/index.ts") },
    ],
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // The declarative-ai/@jaira packages ship as TS source, so let Vite transpile
    // them like first-party code rather than trying to pre-bundle them.
    target: "chrome122",
    // The 500 kB warning is a network-payload heuristic, and this renderer loads from
    // disk. The big chunks are Monaco's own weight (its ts worker is ~7 MB minified),
    // already lazy-loaded behind the review pane and not splittable any further.
    chunkSizeWarningLimit: 7168,
  },
});
