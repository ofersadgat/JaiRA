import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** This checkout's own packages, by name. */
const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * The specimen page (`snapshot/`), built the same way the renderer is.
 *
 * A second config rather than a second input on the first: the renderer's `root` is
 * `src/renderer`, and the specimens sit outside it. Everything else is copied deliberately — the
 * same aliases, the same target, the same `base: "./"` — because a specimen built differently from
 * the app is a photograph of the build, not of the app.
 */
export default defineConfig({
  root: "snapshot",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@jaira/shared/browser", replacement: local("../shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("../shared/src/index.ts") },
      { find: "@jaira/runtime", replacement: local("../runtime/src/index.ts") },
      { find: "@jaira/persistence", replacement: local("../persistence/src/index.ts") },
    ],
  },
  build: {
    outDir: "../dist/snapshot",
    emptyOutDir: true,
    target: "chrome122",
    chunkSizeWarningLimit: 7168,
  },
});
