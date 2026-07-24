/**
 * `@jaira/shared/browser` — the browser-safe half of the shared surface.
 *
 * The renderer imports from here, never from the package root: the root barrel
 * also exports Node-only helpers (`readJsonFile`, the `.jaira/` path layout), and
 * pulling those into the renderer's graph breaks the bundle — a `node:fs` import
 * has no meaning in Chromium. Splitting the entry makes that a build-time
 * impossibility instead of a warning nobody reads.
 *
 * Everything here is types plus pure functions: task/view/IPC shapes, the UI
 * component contracts, and BOM-tolerant JSON parsing.
 */
export * from "./task";
export * from "./view";
export * from "./ipc";
export * from "./components";
export * from "./json";
