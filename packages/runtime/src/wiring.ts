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
  type SessionStore,
} from "@declarative-ai/exec";
import {
  createWorkflowExecutor,
  type Persistence,
  type CallCache,
  type WorkflowBundle,
  type WorkflowMetrics,
} from "@declarative-ai/hw";
import { createPromptExecutor } from "@declarative-ai/promptop";
import { createModelRouter } from "@declarative-ai/llm";
import { SchemaValidator } from "@declarative-ai/validate";
import {
  createOperationExecutor,
  withMemoize,
  withRecord,
  withRetry,
  withSessionPosition,
  type MemoCache,
  type RecordStore,
} from "@declarative-ai/exec";
import type { Approver, ExecPolicy } from "@declarative-ai/permissions";
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
  /**
   * Durable memoization of model answers (`config.memo.enabled`).
   *
   * Composed at the PROMPT LEAF rather than over the dispatcher, because this is where the cost and
   * the latency are, and because the key is then the RENDERED prompt operation — the identity actually
   * worth reusing. Memoizing over the dispatcher instead would key whole composite operations, which
   * is a legitimate but much larger claim about when two pieces of work are the same.
   */
  memo?: { cache: MemoCache; namespace: string };
}

/**
 * The executor a state's `PromptOp` dispatches to. Real runs wrap the prompt
 * executor in `withRetry` so a schema-invalid draw is repaired with feedback
 * (DESIGN §7.5) rather than failing the state on the first bad parse; scripted
 * runs need neither retries nor a provider.
 */
export function buildPromptExecutor(options: PromptExecutorOptions = {}): Executor<ExecServices, WorkflowMetrics> {
  const base = options.fakeRules
    ? (new ScriptedFakeExecutor(options.fakeRules) as Executor<ExecServices, WorkflowMetrics>)
    : repairing(
        createPromptExecutor({
          router: createModelRouter(),
          ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
        }) as unknown as Executor<ExecServices, WorkflowMetrics>,
        options.repairTurns ?? DEFAULT_REPAIR_TURNS,
      );
  if (options.memo === undefined) return base;
  // OUTSIDE the repair loop, so the key is the op as ASKED — one entry per logical request, and a
  // later identical request skips the whole loop rather than replaying it. Inside would key each
  // attempt separately: a repair turn rewrites the op with the validation errors appended, so every
  // attempt hashes differently and the entries are of a question nobody asks twice.
  //
  // The fake executor is wrapped too. A scripted run has little to gain from a cache, but silently
  // dropping a configured one is how a wiring bug survives every test that uses the fake.
  return withMemoize(
    { cache: options.memo.cache, namespace: options.memo.namespace },
    base as unknown as Executor,
  ) as unknown as Executor<ExecServices, WorkflowMetrics>;
}

/** Bounded output repair (DESIGN §7.5) — off when `turns` is 0. */
function repairing(core: Executor<ExecServices, WorkflowMetrics>, turns: number): Executor<ExecServices, WorkflowMetrics> {
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
  /**
   * Where the results of CALLS made from expressions are remembered (EXPRESSIONS.md §3).
   *
   * The question a memo answers is "would someone else making the identical call reuse this answer?"
   * — so the key is content-addressed and the STORE decides how far the answer travels. Absent ⇒ hw's
   * in-run default, which answers it only within one run: the same call in a later run pays again.
   */
  callCache?: CallCache;
  abortSignal?: AbortSignal;
  /**
   * The filesystem the run acts within — a task's git worktree, or the project
   * directory for an unbound task (DESIGN §9.2). `root` is the HOST path; the
   * process executors of phase 6 translate it for their execution environment via
   * `pathFor`. `treeHash` is the workspace identity a workspace-mutating op must be
   * memoized under (declarative-ai DESIGN §3.4).
   */
  workspace?: { root: string; treeHash?: string };
  /**
   * The compiled safety policy and the human approver for tool calls
   * (DESIGN §10.1/§10.2). Enforcement follows each executing entry's
   * `policyEnforcement` capability: a composed runtime gates per tool call, a
   * delegated adapter translates the policy into its agent's own config and routes
   * its native prompt back through `approve`.
   */
  policy?: ExecPolicy;
  approve?: Approver;
  /**
   * The conversation seams: where positions resolve, and where records are written.
   *
   * Both, always, or neither. The engine READS the transcript for its preamble and for
   * `{ conversation }` bindings but no longer writes it — a composed session layer
   * does — so a run given neither has no conversations at all rather than merely
   * uncompacted ones. {@link sessionServicesFor} produces the pair.
   *
   * They are composed HERE rather than by each caller because the two halves must be
   * one store: `records` is where a call's payload lands, `sessions` is what reads it
   * back, and pairing a decorated session store with someone else's records would
   * claim positions in a conversation nobody can read.
   */
  session?: { sessions: SessionStore<JsonValue>; records: RecordStore };
}

export async function executeWorkflow(cfg: WorkflowRunConfig): Promise<WorkflowExecResult> {
  // `withSessionPosition` OUTSIDE `withRecord`: the session layer resolves the position a
  // call will claim, and the record layer claims it by writing the stub. Inverted, a
  // record would be written before anything decided where it belongs.
  //
  // exec's position layer rather than promptop's `withSession`, because the engine states
  // a REQUEST on `ctx.sessionRequest` rather than putting a session id in the op's config —
  // it cannot know where a conversation currently is, and deliberately does not. `withSession`
  // reads the op config, so composed here it would find nothing and silently do nothing.
  //
  const prompt =
    cfg.session !== undefined
      ? (withSessionPosition(
          { sessions: cfg.session.sessions },
          withRecord({ records: cfg.session.records }, cfg.prompt as never),
        ) as unknown as Executor<ExecServices, WorkflowMetrics>)
      : cfg.prompt;
  // …and the SAME stack around the DISPATCHER, because a state's prompt op and a state's function op
  // reach the executor by two different routes: a prompt op goes straight to `config.prompt`, while a
  // function op — every DELEGATED AGENT — goes through the dispatcher. With the layer on the prompt
  // side only, the engine stated an agent's session request and nothing answered it: each agent call
  // silently started a new provider conversation while the workflow read as though `session: "review"`
  // had joined them up. Nothing failed; the agent just never remembered.
  //
  // The dispatcher gets the RAW prompt executor, so an embedded prompt CALL passes through exactly one
  // session layer rather than two — two would claim one position twice and fork on every call.
  const operations =
    cfg.session !== undefined
      ? sessionedDispatcher(
          createOperationExecutor({ functions: cfg.registry.functions as never, prompt: cfg.prompt as never }),
          cfg.session,
        )
      : undefined;
  const executor = createWorkflowExecutor({
    // The RESOLVED bundle. This used to pass `bundle.source` — the authored states — which the
    // executor then re-loaded on every start; a pinned snapshot no longer carries a `source` at all
    // (EXPRESSIONS.md §11), and re-evaluating one would defeat the point of pinning it.
    definition: cfg.bundle,
    registry: cfg.registry,
    prompt,
    ...(operations !== undefined ? { operations } : {}),
    ...(cfg.callCache !== undefined ? { callCache: cfg.callCache } : {}),
    ...(cfg.persistence !== undefined ? { persistence: cfg.persistence } : {}),
  });
  const ctx: ExecServices = {
    validator: new SchemaValidator(),
    ...(cfg.abortSignal !== undefined ? { abortSignal: cfg.abortSignal } : {}),
    ...(cfg.workspace !== undefined ? { workspace: cfg.workspace } : {}),
    ...(cfg.policy !== undefined ? { policy: cfg.policy } : {}),
    ...(cfg.approve !== undefined ? { approve: cfg.approve } : {}),
    ...(cfg.session !== undefined ? { sessions: cfg.session.sessions } : {}),
  };
  return executor.start(workflowStartOp(cfg.inputs), ctx).result;
}

/**
 * The dispatcher with a session layer that engages only for a call the engine PLACED in a
 * conversation.
 *
 * `ctx.sessionRequest` is exactly that signal: hw states one for a prompt op and for a runtime that
 * declares `sessionResume`, and for nothing else. Wrapping unconditionally would be wrong in a way
 * that is easy to miss — `withRecord` records every call it sees, keyed by content hash when there is
 * no position, so every pure helper and every embedded call would start writing rows into the store
 * that holds the run's transcripts.
 *
 * `withSessionPosition` already no-ops without a request; this branch is what keeps `withRecord`
 * from doing the opposite.
 */
function sessionedDispatcher(
  dispatcher: Executor,
  session: { sessions: SessionStore<JsonValue>; records: RecordStore },
): Executor<ExecServices, WorkflowMetrics> {
  const sessioned = withSessionPosition(
    { sessions: session.sessions },
    withRecord({ records: session.records }, dispatcher),
  ) as unknown as Executor;
  return {
    capabilities: dispatcher.capabilities,
    metrics: dispatcher.metrics,
    ...(dispatcher.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => dispatcher.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) =>
      (ctx.sessionRequest !== undefined ? sessioned : dispatcher).start(op, ctx),
  } as unknown as Executor<ExecServices, WorkflowMetrics>;
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
