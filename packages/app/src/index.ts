/**
 * @jaira/app — the Electron shell (DESIGN §2, phase 3).
 *
 * The service layer is Electron-free and exported here so it can be driven from
 * tests and scripts; `src/main/` holds the Electron entry points and `src/renderer/`
 * the React UI.
 */
export * from "./main/service";
