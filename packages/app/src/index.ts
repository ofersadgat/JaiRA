/**
 * @jaira/app — the Electron shell (DESIGN §2, phase 3).
 *
 * The engine it hosts is `@jaira/service` (decision 0012 §1), Electron-free, and re-exported here for
 * anything that reached it through this package; `src/main/` holds the Electron entry points and
 * `src/renderer/` what the window's UI is drawn FROM — the store, the pure models, and the few DOM
 * components that are islands. The UI itself is `packages/universal`, built by `packages/client`.
 */
export * from "@jaira/service";
