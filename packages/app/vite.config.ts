import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Renderer bundle. `base: "./"` matters: the window is loaded with `loadFile`,
 * so assets must resolve relative to the HTML rather than a server root.
 */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
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
