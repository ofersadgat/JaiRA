/**
 * @jaira/app — the Electron shell (DESIGN §2, phase 3).
 *
 * The engine it hosts is `@jaira/service` (decision 0012 §1), Electron-free, and re-exported here for
 * anything that reached it through this package; `src/main/` holds the Electron entry points and
 * `src/renderer/` the React UI.
 */
export * from "@jaira/service";
