/**
 * @jaira/runtime — the engine harness: project config → a capability registry
 * and a prompt executor, plus one workflow execution through
 * `@declarative-ai/hw`.
 *
 * Shared by the headless CLI and the Electron main process, so both drive runs
 * exactly the same way and neither owns the wiring.
 */
export * from "./wiring";
// Who answers a prompt state, from config: provider routes with credentials resolved, the agent
// executors a model prefix can name, and the default id chosen when nothing names one.
export * from "./modelRoutes";
export * from "./fakeExecutor";
export * from "./scriptedFunctions";
export * from "./interaction";
export * from "./followUp";
export * from "./demoWorkflow";
export * from "./componentsWorkflow";
export * from "./conformanceWorkflow";
export * from "./syncWorkflow";
export * from "./paths";
export * from "./exec";
export * from "./git";
export * from "./command";
export * from "./policy";
export * from "./approval";
export * from "./questions";
export * from "./agents";
export * from "./agentTools";
// What a claude agent is handed under one effective environment, MEASURED through the real chain —
// the proof a list-to-toolset migration is held to (decision 0007 step 7).
export * from "./agentHanded";
export * from "./tools";
export * from "./sessionServices";
// The agent's own on-disk session file, captured into the record at operation close — the lines
// (attachments, toolUseResult, threading) that never ride the stream and outlive nothing.
export * from "./nativeCapture";
export * from "./genericAgent";
export * from "./artifactPath";
export * from "./artifacts";
export * from "./fileTools";
export * from "./searchTools";
export * from "./webTools";
export * from "./artifactSink";
export * from "./secrets";
// Connections to forges, and the providers behind them (decision 0004 §1).
export * from "./forge";
export * from "./remote";
export * from "./remoteWatch";
export * from "./remoteReview";
export * from "./remoteEvents";
export * from "./executors";
export * from "./executorStack";
export * from "./executorTree";
export * from "./chatOperation";
export * from "./chatTurn";
export * from "./liveHandles";
export * from "./changesets";
export * from "./changesetGate";
export * from "./userEvents";
// A workflow's own TypeScript functions, as ordinary registry entries (SPEC §7.5).
export * from "./userFunctions";
