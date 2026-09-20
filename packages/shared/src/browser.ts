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
export * from "./mime";
export * from "./operationVocabulary";
export * from "./schemas";
export * from "./view";
export * from "./operationRecords";
export * from "./ipc";
export * from "./components";
export * from "./reviewNotes";
export * from "./componentGallery";
export * from "./json";
export * from "./settings";
export * from "./executors";
export * from "./executorStack";
export * from "./executorTree";
export * from "./configSchema";
export * from "./forge";
export * from "./remoteSettlement";
export * from "./slotTypes";
export * from "./references";
export * from "./changeset";
export * from "./diffStrategies";
export * from "./typeNames";
export * from "./valueViews";
export * from "./structured";
export * from "./unifiedDiff";
export * from "./grammars";
export * from "./userEvents";
export * from "./toolVocabulary";
export * from "./scopes";
export * from "./hiddenPaths";
export * from "./refusal";
