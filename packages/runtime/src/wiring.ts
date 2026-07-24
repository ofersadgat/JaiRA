/**
 * Engine wiring: project config → a capability registry + prompt executor, and
 * one workflow execution through `@declarative-ai/hw`'s workflow executor. Used
 * by both `jaira run` (ad-hoc) and `jaira task start`.
 *
 * Shape of the post-ops-redesign contract (declarative-ai DESIGN §3.1/§7):
 *  - The workflow BUNDLE is held by the executor at construction, not re-supplied
 *    per run — a workflow's identity is its snapshot.
 *  - A run is started by a `FunctionOp` whose bound inputs are the workflow's
 *    inputs; there is no `ExecutionSpec`.
 *  - A state's `PromptOp` dispatches to the injected `prompt` executor; every
 *    other kind of work (host code, interactive UI, delegated agents) is a
 *    `FunctionOp` resolved through `registry.functions`.
 */
import {
  newCapabilityRegistry,
  type CapabilityRegistry,
  type ExecResult,
  type ExecServices,
  type Executor,
  type InlineFamily,
  type JsonValue,
  type Operation,
  type ResolvedValue,
} from "@declarative-ai/exec";
import {
  createWorkflowExecutor,
  type Persistence,
  type WorkflowBundle,
  type WorkflowMetrics,
} from "@declarative-ai/hw";
import { createPromptExecutor } from "@declarative-ai/promptop";
import { createModelRouter } from "@declarative-ai/llm";
import { SchemaValidator } from "@declarative-ai/validate";
import { withRetry } from "@declarative-ai/exec";
import type { JairaConfig } from "@jaira/shared";
import { ScriptedFakeExecutor, type FakeRule } from "./fakeExecutor";

export type WorkflowExecResult = ExecResult<ResolvedValue, WorkflowMetrics>;

/** Model names referenced by `operation.config.model` across a bundle's states. */
export function modelNamesOf(bundle: WorkflowBundle): string[] {
  const names = new Set<string>();
  for (const def of Object.values(bundle.states)) {
    const op = def.operation;
    if (op === undefined || op.kind !== "prompt") continue;
    const config = op.config;
    if (config !== null && typeof config === "object" && !Array.isArray(config) && typeof config.model === "string") {
      names.add(config.model);
    }
  }
  return [...names].sort();
}

/** True when any state runs a `PromptOp` — i.e. when the run needs a model at all. */
export function hasPromptOp(bundle: WorkflowBundle): boolean {
  return Object.values(bundle.states).some((def) => def.operation?.kind === "prompt");
}

/** Function names referenced by `operation.function` across a bundle's states. */
export function functionNamesOf(bundle: WorkflowBundle): string[] {
  const names = new Set<string>();
  for (const def of Object.values(bundle.states)) {
    const op = def.operation;
    if (op !== undefined && op.kind === "function" && typeof op.functionRef === "string") {
      names.add(op.functionRef);
    }
  }
  return [...names].sort();
}

/** Bounded output-repair default for interactive use (DESIGN §7.5). */
export const DEFAULT_REPAIR_TURNS = 2;

export interface PromptExecutorOptions {
  /** Scripted rules ⇒ a fake prompt executor instead of a real provider. */
  fakeRules?: FakeRule[];
  /** Model defaults from project config (`config.models.default`). */
  defaults?: Record<string, JsonValue>;
  repairTurns?: number;
}

/**
 * The executor a state's `PromptOp` dispatches to. Real runs wrap the prompt
 * executor in `withRetry` so a schema-invalid draw is repaired with feedback
 * (DESIGN §7.5) rather than failing the state on the first bad parse; scripted
 * runs need neither retries nor a provider.
 */
export function buildPromptExecutor(options: PromptExecutorOptions = {}): Executor<ExecServices, WorkflowMetrics> {
  if (options.fakeRules) return new ScriptedFakeExecutor(options.fakeRules);
  const core = createPromptExecutor({
    router: createModelRouter(),
    ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
  }) as unknown as Executor<ExecServices, WorkflowMetrics>;
  const turns = options.repairTurns ?? DEFAULT_REPAIR_TURNS;
  return turns > 0
    ? (withRetry({ validation: { turns, feedback: true } }, core) as unknown as Executor<ExecServices, WorkflowMetrics>)
    : core;
}

/** A fresh capability registry — `functions`, `skills`, `tools`. */
export function newRegistry(): CapabilityRegistry<WorkflowMetrics> {
  return newCapabilityRegistry<WorkflowMetrics>();
}

/**
 * The `FunctionOp` that starts a workflow run: its bound inputs are the
 * workflow's declared inputs.
 */
export function workflowStartOp(inputs: Record<string, JsonValue>, label = "jaira-workflow"): Operation<InlineFamily> {
  return {
    kind: "function",
    functionRef: label,
    input: Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [name, { kind: "json" as const, binding: { json: value } }]),
    ),
    output: { name: "output", kind: "json" },
  };
}

export interface WorkflowRunConfig {
  bundle: WorkflowBundle;
  inputs: Record<string, JsonValue>;
  registry: CapabilityRegistry<WorkflowMetrics>;
  prompt: Executor<ExecServices, WorkflowMetrics>;
  persistence?: Persistence;
  abortSignal?: AbortSignal;
}

export async function executeWorkflow(cfg: WorkflowRunConfig): Promise<WorkflowExecResult> {
  const executor = createWorkflowExecutor({
    definition: { rootId: cfg.bundle.rootId, states: cfg.bundle.source ?? {} },
    registry: cfg.registry,
    prompt: cfg.prompt,
    ...(cfg.persistence !== undefined ? { persistence: cfg.persistence } : {}),
  });
  const ctx: ExecServices = {
    validator: new SchemaValidator(),
    ...(cfg.abortSignal !== undefined ? { abortSignal: cfg.abortSignal } : {}),
  };
  return executor.start(workflowStartOp(cfg.inputs), ctx).result;
}

/** Collapse a result into the task-status vocabulary. */
export function statusOfResult(result: WorkflowExecResult): "completed" | "failed" | "canceled" {
  if (!("error" in result) || result.error === undefined) return "completed";
  return result.error.classification === "canceled" ? "canceled" : "failed";
}

/** Provider/model defaults for real (non-fake) runs, from project config. */
export function modelDefaults(config: JairaConfig, bundle: WorkflowBundle, opts?: { fake?: boolean }): Record<string, JsonValue> {
  if (opts?.fake) return {};
  // A workflow made only of function states (host code, UI gates, agents) never
  // calls a model, so demanding one would refuse a perfectly runnable workflow.
  if (!hasPromptOp(bundle)) return {};
  const models = modelNamesOf(bundle);
  // A prompt state naming no model relies on the configured default; with neither,
  // the provider router has nothing to route and the run would fail deep in the
  // engine — so refuse up front with a message naming the fix.
  if (models.length === 0 && config.models.default === undefined) {
    throw new Error(
      "no model configured: set models.default in .jaira/config.json, or give the state an operation.config.model",
    );
  }
  return config.models.default !== undefined ? { model: config.models.default } : {};
}
