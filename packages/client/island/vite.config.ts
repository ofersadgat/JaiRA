import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const local = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Monaco's workers, inlined as `blob:` URLs (`?worker` → `?worker&inline`).
 *
 * On native the island page loads from `file://`, and a page there cannot start a worker from a file
 * (Android refuses it outright). A blob worker needs no file. `ISLAND_WORKERS=file` builds them as
 * files instead, to measure the other side: Monaco then falls back to the main thread.
 */
function inlineWorkers(): Plugin {
  return {
    name: "jaira-island-inline-workers",
    enforce: "pre",
    transform(code, id) {
      // Monaco's workers are started from codeview's setup, which JaiRA shares with topodiff.
      if (process.env["ISLAND_WORKERS"] === "file" || !id.replaceAll("\\", "/").endsWith("/codeview/src/monaco/setup.ts")) return null;
      return code.replace(/\?worker"/g, '?worker&inline"');
    },
  };
}

/**
 * Classic scripts, not modules. A page on `file://` is an opaque origin, and the browser refuses it
 * module scripts, `crossorigin` stylesheets and web fonts from other files unless the WebView is told
 * to allow file access from file URLs (`allowFileAccessFromFileURLs`, deprecated on Android). Measured
 * in Chrome (`shots/islands.mts --strict`): as modules, nothing loads at all. So the island is one
 * IIFE with its lazy chunks inlined, a `defer`red plain script, no `crossorigin`, and its fonts in
 * the stylesheet as data URIs; Monaco's workers are blobs already (above).
 */
function classicPage(): Plugin {
  return {
    name: "jaira-island-classic-page",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.replace(/<script type="module" crossorigin/g, "<script defer").replace(/ crossorigin/g, ""),
    },
  };
}

/** Which island this build is: `ISLAND=markdown|diff|markdownEditor|code|schemaText|artifact|canvas` (`build.mjs` runs them all). */
const ISLAND = process.env["ISLAND"] ?? "markdown";

/**
 * The islands that frame a grant at the engine's HTTP route (decision 0020 §4): a published page, and a
 * canvas's artboards. The engine is wherever the phone reaches it - its tailnet name, or the loopback
 * port of the phone's own proxy - so these two pages may frame any http(s) address; every other island
 * frames nothing (`index.html`'s `default-src 'none'`).
 */
const FRAMING = new Set(["artifact", "canvas"]);

/** The page's one script names this build's island (`%ISLAND%` in `index.html`), and what it may frame (`%FRAMES%`). */
function whichIsland(): Plugin {
  return {
    name: "jaira-island-entry",
    transformIndexHtml: { order: "pre", handler: (html) => html.replace("%ISLAND%", ISLAND).replace("%FRAMES%", FRAMING.has(ISLAND) ? "; frame-src http: https:" : "") },
  };
}

/**
 * An island page (decision 0015, S5), built on its own: `base: "./"` so every asset resolves beside
 * `index.html`, which is how a WebView loads it from the app bundle's asset folder. One page per
 * component, in `dist-island/<component>/`.
 */
export default defineConfig({
  root: local("."),
  base: "./",
  plugins: [whichIsland(), inlineWorkers(), react(), classicPage()],
  resolve: {
    alias: [
      { find: "@jaira/ui", replacement: local("../../app/src/renderer") },
      { find: "@jaira/shared/browser", replacement: local("../../shared/src/browser.ts") },
      { find: "@jaira/shared", replacement: local("../../shared/src/index.ts") },
    ],
    // codeview, the editors shared with topodiff, is linked from beside this checkout with copies of its
    // own for its tests; the page must hold one React and one Monaco.
    dedupe: ["react", "react-dom", "monaco-editor"],
  },
  build: {
    outDir: local(`../dist-island/${ISLAND}`),
    emptyOutDir: true,
    target: "chrome111",
    chunkSizeWarningLimit: 65536,
    // Fonts (and every other asset) inlined: a web font from another file is a cross-origin fetch.
    assetsInlineLimit: 16 * 1024 * 1024,
    modulePreload: false,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
