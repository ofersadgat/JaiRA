/**
 * @jaira/runtime — the engine harness: project config → a capability registry
 * and a prompt executor, plus one workflow execution through
 * `@declarative-ai/hw`.
 *
 * Shared by the headless CLI and the Electron main process, so both drive runs
 * exactly the same way and neither owns the wiring.
 */
export * from "./wiring";
export * from "./fakeExecutor";
export * from "./scriptedFunctions";
export * from "./interaction";
export * from "./demoWorkflow";
export * from "./componentsWorkflow";
export * from "./paths";
export * from "./exec";
export * from "./git";
export * from "./command";
export * from "./policy";
export * from "./approval";
export * from "./agents";
