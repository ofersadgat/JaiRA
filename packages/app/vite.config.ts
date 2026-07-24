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
  },
});
