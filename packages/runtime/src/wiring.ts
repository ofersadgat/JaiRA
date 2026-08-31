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
import { createLogger } from "@declarative-ai/log";
import { refusal } from "@jaira/shared";
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
  type EngineEvent,
  type Persistence,
  type ReplaySource,
  type CallCache,
  type WorkflowBundle,
  type WorkflowMetrics,
} from "@declarative-ai/hw";
import { register, type LiveCalls } from "./liveHandles";
import { createPromptExecutor, PromptRouterExecutor } from "@declarative-ai/promptop";
import { createModelRouter, type ModelRouterOptions } from "@declarative-ai/llm";
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
import type { Approver, AskUser, ExecPolicy } from "@declarative-ai/permissions";
import {
  DEFAULT_EXECUTOR,
  resolveExecutorTree,
  namedModelAnswer,
  unnamedModelAnswer,
  type JairaConfig,
  type JairaOperationNode,
  type JairaPromptNode,
} from "@jaira/shared";
import { ScriptedFakeExecutor, type FakeRule } from "./fakeExecutor";
import { buildPromptTree, withSecurityFloor } from "./executorTree";
import { agentPromptRouteNames, agentRouteVendors, usableRouteKeys } from "./modelRoutes";
import type { StackedExecutor } from "./executorStack";
import type { SecretResolver } from "./secrets";

/** Where this module's lines land in the log — see `refusal` for why a library declines out loud. */
const log = createLogger("jaira.runtime.wiring");

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

/**
 * True when some prompt state names NO model — the states a default has to answer for.
 *
 * The complement of {@link modelNamesOf} rather than a count against it: one workflow can do both,
 * and the two questions have different fixes. A named model that nothing serves is refused by name;
 * a state naming none needs a route that picks its own.
 */
export function hasUnnamedPromptModel(bundle: WorkflowBundle): boolean {
  return Object.values(bundle.states).some((def) => {
    const op = def.operation;
    if (op === undefined || op.kind !== "prompt") return false;
    const config = op.config;
    const model =
      config !== null && typeof config === "object" && !Array.isArray(config) ? config.model : undefined;
    return typeof model !== "string" || model === "";
  });
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
  /**
   * Call config every prompt is bounded with — see `withSecurityFloor`.
   *
   * JaiRA puts the scope table compiled into a delegated agent's own permission rules here, which is
   * how a sandbox reaches the agent's BUILT-INS: it bounds them up front in the agent's own gate
   * rather than one callback at a time, and a state cannot drop it by authoring `providerOptions` of
   * its own.
   */
  securityFloor?: Record<string, JsonValue>;
  /**
   * The RESOLVED executor tree — every level, already derived from what is available.
   *
   * Absent ⇒ a bare router, which is what a caller with no configuration at all should get. Its
   * `defaults` are what a state with no model of its own is filled in from, applied BEFORE dispatch
   * (see `executorTree.ts` — a default applied at the leaf cannot influence routing).
   */
  tree?: JairaPromptNode;
  /** Named presets (`config.models.presets`), selected per state by `operation.configRef`. */
  configs?: { get(id: string): Record<string, JsonValue> | undefined };
  /** How each provider route is reached (`config.models.routes`), credentials already resolved. */
  router?: ModelRouterOptions;
  /**
   * Prompt executors reachable by model PREFIX — the configured agents.
   *
   * This is what lets a prompt state run on a `claude` subscription with no API key: the prefix
   * `claude-cli` selects the CLI agent exactly as `anthropic` selects the provider.
   */
  routes?: Record<string, Executor<ExecServices, WorkflowMetrics>>;
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
  /** Where a `memoize` step stores answers. Absent ⇒ that step is skipped and reported. */
  memoCache?: MemoCache;
}

/**
 * The executor a state's `PromptOp` dispatches to — the prompt half of a resolved tree.
 *
 * It used to assemble the tree by hand: a provider leaf, a router over the configured agents, a
 * repair loop and an optional memo, all in a fixed shape nothing could change. Now the SHAPE is the
 * `tree` option, resolved from configuration (`@jaira/shared`'s `resolveExecutorTree`), and this only
 * builds what it was given. What is left here is the one thing that is not configuration: the
 * built-in repair loop, which stays because a schema-invalid draw should be repaired by default and
 * a project that has never opened the settings screen still deserves that.
 */
export function buildPromptExecutor(options: PromptExecutorOptions = {}): Executor<ExecServices, WorkflowMetrics> {
  const fake = options.fakeRules
    ? new ScriptedFakeExecutor(options.fakeRules)
    : undefined;
  const tree = options.tree ?? { kind: "router" as const };
  const prompt = buildPromptTree(fake === undefined ? tree : { kind: "router" }, {
    ...(options.router !== undefined ? { router: options.router } : {}),
    ...(options.configs !== undefined ? { configs: options.configs } : {}),
    ...(options.routes !== undefined ? { agents: options.routes as Record<string, StackedExecutor> } : {}),
    ...(options.memoCache !== undefined ? { memoCache: options.memoCache } : {}),
    ...(fake !== undefined ? { fakePrompt: fake } : {}),
  });

  // The project's security floor, folded over every prompt call — INCLUDING a scripted one, so a
  // fake run exercises the same wiring rather than a quieter version of it. Over rather than under
  // the state's config: a floor a state could replace is a default with a misleading name. See
  // `withSecurityFloor`.
  const bounded =
    options.securityFloor === undefined ? (fake ?? prompt) : withSecurityFloor(options.securityFloor, fake ?? prompt);
  const base = repairing(
    bounded,
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
    base,
  );
}

/** Bounded output repair (DESIGN §7.5) — off when `turns` is 0. */
function repairing(core: Executor<ExecServices, WorkflowMetrics>, turns: number): Executor<ExecServices, WorkflowMetrics> {
  return turns > 0
    ? withRetry({ validation: { turns, feedback: true } }, core)
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
  /** Mints instance ids — hw's `EngineConfig.newInstanceId`. UUIDv7 by default; a test that asserts
   *  on ids or on the `#i<id>` fresh-session keys they produce injects a counter here. */
  newInstanceId?: () => string;
  /**
   * What a stopped run already answered — supplying it makes this run a RESUME (hw's `ReplaySource`).
   *
   * The run still starts at the root: every operation this source can answer is taken instead of
   * dispatched, so the engine walks back to where the run stopped without re-executing anything it
   * already did, and the frontier is simply where the answers run out.
   */
  replay?: ReplaySource;
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
   * Where a running agent's mid-run QUESTIONS go — `AskUserQuestion`, put to the person driving the
   * run rather than to the approval gate. Absent ⇒ unattended: the adapter tells the agent to use
   * its own judgment instead of parking on a question nobody will see.
   */
  askUser?: AskUser;
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

/** The two halves of one store: where a call's payload lands, and what reads it back. */
export interface SessionStores {
  sessions: SessionStore<JsonValue>;
  records: RecordStore;
}

/**
 * Put an executor under the session layers.
 *
 * The pairing and the ORDER are the point, and they belong in one place because both are correctness
 * properties that a caller composing them by hand gets to invent independently:
 *
 *  - `withSessionPosition` OUTSIDE `withRecord`: the session layer resolves the position a call will
 *    claim, and the record layer claims it by writing the stub. Inverted, a record would be written
 *    before anything decided where it belongs.
 *  - Both OUTSIDE whatever the executor already is, which is what keeps a memo inside them — the only
 *    legal place for it, since an outer memoize refuses a session layer outright and a hit would
 *    replay a stale position.
 *
 * It is exec's position layer rather than promptop's `withSession` because a caller states a RESOLVED
 * POSITION on `ctx.session` rather than putting a session id in the op's config, and `withSession`
 * reads the op config — composed here it would find nothing and do nothing.
 *
 * Note what this does NOT do: it is not how a conversation is continued. Continuation is the caller
 * resolving a position and handing it over on `ctx.session` (hw does it in `servicesFor`). These
 * layers only enforce what happens to one — fork if the position was taken, and record what the call
 * appended.
 */
export function withSessionLayers(
  stores: SessionStores,
  executor: Executor<ExecServices, WorkflowMetrics>,
): Executor<ExecServices, WorkflowMetrics> {
  // Unconditional — `onlyWhenPlaced` retired (CHANGESETS.md §5.2). The gate existed because
  // wrapping the dispatcher would have written every pure helper and every embedded call into the
  // store that held the run's TRANSCRIPTS. The §5.1 schema dissolves that concern rather than
  // answering it: the store that holds transcripts is now `session_positions`, and an unplaced call
  // never touches it — its record lands in `operation_records` with no position and pollutes
  // nothing. So every operation is recorded, and placement decides only whether a record also
  // claims a seat in a conversation. What remains of the old filter is a retention question
  // (§10.5), answered by the pruning surface.
  return withSessionPosition(
    { sessions: stores.sessions },
    withRecord({ records: stores.records }, executor),
  ) as Executor<ExecServices, WorkflowMetrics>;
}

export async function executeWorkflow(cfg: WorkflowRunConfig): Promise<WorkflowExecResult> {
  const prompt = cfg.session !== undefined ? withSessionLayers(cfg.session, cfg.prompt) : cfg.prompt;
  // ORDERING, since it looks inverted against SESSIONS.md §6's `withMemoize(withSessionPosition(...))`:
  // the memo sits INSIDE both session layers, and that is the only legal place for it. An outer
  // memoize refuses a session layer outright — `withSessionPosition` forces `sessionResume: true` into
  // `capabilitiesFor`, and `withMemoize` answers that with `SESSION_REFUSAL` on every op — because a
  // hit would replay a stale position. Composed inside, it sees the RESOLVED session and keys on it,
  // which is the supported arrangement.
  //
  // The consequence worth knowing: `withRecord` claims the position BEFORE the memo is consulted, so a
  // cache HIT still writes a record — and `withMemoize` strips the session outcome from a replay, so
  // that record holds no messages. That is coherent rather than broken: the provider never saw the
  // call, so the conversation gains no turns, and the record marks a position that was consumed. It
  // does mean a memoized turn reads as a gap in the transcript, which is the honest depiction of a
  // turn that never happened.
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
          createOperationExecutor({ functions: cfg.registry.functions, prompt: cfg.prompt }),
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
    // The store as ENGINE config, because the engine is what resolves each operation's position now —
    // it used to be published on every child's services and looked up by a layer below. Nothing below
    // needs the store: what reaches an executor is the position it resolved to.
    ...(cfg.session !== undefined ? { sessions: cfg.session.sessions } : {}),
    ...(cfg.callCache !== undefined ? { callCache: cfg.callCache } : {}),
    ...(cfg.newInstanceId !== undefined ? { newInstanceId: cfg.newInstanceId } : {}),
    ...(cfg.replay !== undefined ? { replay: cfg.replay } : {}),
    ...(cfg.persistence !== undefined ? { persistence: cfg.persistence } : {}),
  });
  const ctx: ExecServices = {
    validator: new SchemaValidator(),
    ...(cfg.abortSignal !== undefined ? { abortSignal: cfg.abortSignal } : {}),
    ...(cfg.workspace !== undefined ? { workspace: cfg.workspace } : {}),
    ...(cfg.policy !== undefined ? { policy: cfg.policy } : {}),
    ...(cfg.approve !== undefined ? { approve: cfg.approve } : {}),
    ...(cfg.askUser !== undefined ? { askUser: cfg.askUser } : {}),
  };
  return executor.start(workflowStartOp(cfg.inputs), ctx).result;
}

/**
 * The dispatcher under the same session layers as the prompt path.
 *
 * It used to be gated on `ctx.session` (only calls the engine PLACED in a conversation were
 * recorded); the §5.1 schema retired the gate — see {@link withSessionLayers}. A function op with no
 * position still resolves none and claims none; it is merely recorded now, which is what makes a
 * changeset gate's inputs and decisions recoverable (§5.3).
 */
function sessionedDispatcher(
  dispatcher: Executor<ExecServices, WorkflowMetrics>,
  session: SessionStores,
): Executor<ExecServices, WorkflowMetrics> {
  return withSessionLayers(session, dispatcher);
}

/** Collapse a result into the task-status vocabulary. */
export function statusOfResult(result: WorkflowExecResult): "completed" | "failed" | "canceled" {
  if (!("error" in result) || result.error === undefined) return "completed";
  return result.error.classification === "canceled" ? "canceled" : "failed";
}

/** One thing that actually went wrong, and the state it went wrong in. */
export interface RunCause {
  stateId: string;
  reason: string;
}

/**
 * The operation-level reasons a run failed, innermost first.
 *
 * A composite workflow reports the PARENT's view of a failure — "child 'requirements' terminated with
 * error and no transition handled it" — which names the state that noticed and says nothing about
 * what broke. The reason is in the event stream, and this is how it is got out of one.
 *
 * The rows are `Persistence`'s, so an `InMemoryPersistence` handed to {@link executeWorkflow} can be
 * read directly. `@jaira/persistence`'s `runCauses` answers the same question over the SQLite journal
 * a task run writes; this is for a run that keeps no journal, which is every run the app starts
 * outside a task.
 */
export function causesOfEvents(rows: readonly { event: EngineEvent }[]): RunCause[] {
  // Per INSTANCE, last word wins. A failure a transition handled is not a cause of anything: an
  // authored retry that fails once and then succeeds would otherwise be named in the run's reason
  // alongside whatever actually went wrong, blaming a state that recovered.
  //
  // A `blocked` child never became an instance, so its event carries no `instanceId` — it is keyed
  // by its MOUNT instead, which is also the retry semantics a block actually has: re-entering the
  // same mount and resolving clears the earlier block at that mount.
  const byInstance = new Map<string, RunCause | undefined>();
  const order: string[] = [];
  for (const { event } of rows) {
    const at =
      event.type === "instance.blocked"
        ? `blocked:${event.parentInstanceId ?? ""}:${event.childKey ?? event.stateId}`
        : (event as { instanceId?: string }).instanceId;
    if (at === undefined) continue;
    if (!byInstance.has(at)) order.push(at);
    if (event.type === "operation.failed") byInstance.set(at, { stateId: event.stateId, reason: event.failure.reason });
    else if (event.type === "instance.blocked") byInstance.set(at, { stateId: event.stateId, reason: event.reason });
    // A later success on the same instance CLEARS it — the state was retried and got there.
    else if (event.type === "operation.completed") byInstance.set(at, undefined);
  }
  return order.map((at) => byInstance.get(at)).filter((cause): cause is RunCause => cause !== undefined);
}

/**
 * A run's failure, said in terms of what broke rather than of what noticed.
 *
 * The parent's reason is kept as the fallback and only as the fallback: it is the one message that is
 * always present and never informative, so it appears when the journal offered nothing better.
 */
export function failureMessage(causes: readonly RunCause[], fallback: string): string {
  if (causes.length === 0) return fallback;
  return causes.map((c) => `${c.stateId}: ${c.reason}`).join("; ");
}

/**
 * The RESOLVED default executor tree for a project — and the refusal when nothing can answer.
 *
 * This replaced `modelDefaults`, which returned `{ model }` for a chosen id. That shape was the
 * problem: a single default model could not route to an agent, because the prompt router dispatches
 * on `op.config.model` while a leaf's defaults are applied after routing. What a state with no model
 * needs is a default EXECUTOR, and `resolveExecutorTree` derives one from what is actually usable.
 *
 * The one refusal worth keeping is kept: a prompt-bearing workflow on a machine where nothing can
 * answer fails at START, with both fixes named, rather than at its first prompt.
 */
export function defaultExecutorTree(
  config: JairaConfig,
  bundle: WorkflowBundle,
  opts?: {
    fake?: boolean;
    secrets?: SecretResolver;
    /**
     * Agents a health check has shown to work here.
     *
     * Absent ⇒ every enabled agent is a candidate, which is the CLI's position: it takes no probes
     * and must not refuse over a check it never ran.
     */
    available?: ReadonlySet<string>;
    /**
     * Throw when nothing here can serve this bundle's prompts. Absent ⇒ true.
     *
     * The refusal belongs to STARTING a run, not to building a tree, and the two have different
     * callers. A screen rendering the routes on offer — the composer's model picker, a settings
     * page — asks for the same tree and must never be the thing that raises "no route serves
     * 'planner'": it is not about to call anything, and a chat panel that cannot open because a
     * workflow names a model it cannot reach has turned a run-time refusal into a UI outage.
     */
    refuse?: boolean;
  },
): JairaOperationNode {
  const agents = Object.keys(agentPromptRouteNames(config.agents)).filter(
    (name) => opts?.available === undefined || opts.available.has(name),
  );
  const providers = opts?.fake ? [] : usableRouteKeys(config.models, opts?.secrets);
  // `vendors` is what makes a BARE model id routable: it says which agent answers for whose models,
  // so `claude-sonnet-5` reaches `claude-cli` and never reaches `codex-cli`.
  const tree = resolveExecutorTree(config.executors[DEFAULT_EXECUTOR], {
    providers,
    agents,
    vendors: agentRouteVendors(config.agents),
  });

  // A scripted run answers every prompt itself, and a workflow of only function states never calls a
  // model — neither has anything to refuse over. Nor does a caller that only wants to READ the tree.
  if (opts?.fake || opts?.refuse === false || !hasPromptOp(bundle)) return tree;
  // Every model a state NAMES has to be one something here can serve. This used to read "any state
  // naming a model is a complete answer on its own" and return — which skipped the whole check for
  // any bundle in which one state named one model. A workflow naming `anthropic/…` on a machine with
  // no Anthropic key therefore started, and failed permanently at its first prompt with an API-key
  // error from inside a provider SDK. Naming a model answers *which model*; it never answered
  // *and can anything here serve it*.
  //
  // Checked against a tree built from every CONFIGURED agent, not the probed ones — which is the
  // same call `registerAgentRuntimes` already makes for the function path, where codex is registered
  // whether or not its binary is present so that a state naming it fails with codex's own "could not
  // be started". A missing binary is a fact about this moment; a route with no credential is a fact
  // about the configuration. Only the second is worth refusing a whole run over, and refusing one
  // because an optional lens's binary is not installed today would stop seven phases that never
  // reach it.
  const configured = resolveExecutorTree(config.executors[DEFAULT_EXECUTOR], {
    providers,
    agents: Object.keys(agentPromptRouteNames(config.agents)),
    vendors: agentRouteVendors(config.agents),
  });
  const unserved = modelNamesOf(bundle)
    .map((model) => namedModelAnswer(configured.prompt, model))
    .filter((answer): answer is { answers: false; reason: string } => !answer.answers);
  if (unserved.length > 0) {
    throw refusal(log, 
      unserved.length === 1
        ? unserved[0]!.reason
        : `these states name models nothing here serves — ${unserved.map((u) => u.reason).join("; also, ")}`,
    );
  }
  // What is left is a state naming NO model, which is how JaiRA's own workflows are written,
  // deliberately, so they run on whatever this machine has. A bundle with none has nothing left to
  // refuse over.
  if (!hasUnnamedPromptModel(bundle)) return tree;
  // Whether anything here answers a state that names NO model. That is the failure worth catching at
  // the start: unanswered, the call lands in the provider fallback and is reported as an empty model
  // from inside the SDK, several layers under the state that asked.
  const answer = unnamedModelAnswer(tree.prompt);
  if (answer.answers) return tree;
  if (answer.pinned !== undefined) {
    throw refusal(log, 
      `the default executor is pinned to '${answer.pinned}', which names no model, and these states name none ` +
        "either. Give it a model, or unpin it so a route that picks its own can answer.",
    );
  }
  throw refusal(log, 
    answer.routes.length === 0
      ? "nothing can answer a prompt here: enable an agent executor (claude-cli needs no API key), or " +
        "add a provider key under models.routes — in Settings, or in .jaira/settings.json"
      : `no default model: ${answer.routes.map((r) => `'${r}'`).join(", ")} serve only the models a state names, ` +
        "and these states name none. Give one of those routes a model, set one on the default executor, or " +
        "enable an agent executor — an agent picks its own.",
  );
}

/** One live delta — a fragment of the answer, or a whole entry that is not answer text. */
export interface TurnDelta {
  /** The conversation position the call is claiming, when it runs in one. */
  session?: { id: string; seq: number };
  /** The state that is speaking, recovered from the request's seed. */
  stateId?: string;
  /** When this delta reached the host, host clock. The transports stamp nothing, so this is the
   *  finest time granularity the system has — what "started thinking at" and "answered at" are
   *  measured from. */
  at?: number;
  /** A fragment of the answer being written. Exactly one of `text` / `thinking` / `entry` is present. */
  text?: string;
  /** A fragment of the model's reasoning, while it is still thinking — never part of the answer. */
  thinking?: string;
  /**
   * A whole conversation ENTRY that is not answer text, in stream order with the fragments.
   *
   * The same word the record uses, because it is the same thing at an earlier moment: what arrives
   * here is what `entries` will hold. It used to be called an "item" on the way in and an "entry"
   * once stored, which made a translation out of what should be an append (RECORDS.md).
   *
   * `{ kind: "message", role, content }` is a finished turn — content carries the provider's own
   * parts, tool calls and results included. Anything else is forwarded as
   * `{ kind: "event", event }` with the executor's event verbatim: the viewer's contract is that
   * EVERYTHING on the stream reaches it in order, understood or not — an event dropped here is a
   * stretch of an hour-long run the person watching cannot account for.
   */
  entry?: JsonValue;
}

/**
 * Forward a call's partial output as it arrives.
 *
 * Persistence happens once, when the record closes — which is correct (a half-written answer is not a
 * turn) and leaves a long agent run showing nothing at all while it works. The transports already
 * stream: the CLI is launched with `--include-partial-messages` and `AgentExecutor` pushes each delta
 * onto the handle's event queue. Nothing consumed it. hw does not drain the prompt handle's `events`,
 * so this is the single consumer that contract requires, and taking it steals nothing.
 *
 * Composed INSIDE the session layers, deliberately: by the time this runs, `ctx.session` is the
 * resolved position, so a delta can name the conversation it belongs to rather than being attributed
 * by guesswork. The seed carries the state id for the same reason.
 *
 * Draining is a floating promise. Awaiting it would hold `result` open until the stream closed, which
 * would make watching a run slower than not watching one.
 */
export function withTurnStream(
  sink: (delta: TurnDelta) => void,
  inner: Executor<ExecServices, WorkflowMetrics>,
  /**
   * Where to register the call while it runs, so a person can talk back to it.
   *
   * The same interception, surfacing one more thing from it. A second wrapper would have read the
   * same `ctx.session` off the same call and wrapped the same handle to learn when it settled —
   * "observe a live turn and tell the app about it" is one job, and the deltas were only ever the
   * first half of it. See {@link LiveCalls}.
   */
  live?: LiveCalls,
): Executor<ExecServices, WorkflowMetrics> {
  const executor = inner;
  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? { capabilitiesFor: (op: Operation<InlineFamily>) => executor.capabilitiesFor!(op) }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      const handle = executor.start(op, ctx);
      const at = (ctx as { session?: { at?: { id: string; seq: number } } }).session?.at;
      // The seed rides on the RESOLUTION now — hw resolves each operation's position before dispatch,
      // so there is no request left to read it off.
      const seed = (ctx as { session?: { seed?: string } }).session?.seed;
      // Split on the FIRST colon. A state id is a path and contains none; an authored session name may
      // (`session: "review:draft"`), so taking the LAST one would fold half the session name into the
      // state id — and `lastIndexOf` returns -1 for a seed with no colon at all, which `slice(0, -1)`
      // turns into a silently truncated id rather than an absent one.
      const cut = seed === undefined ? -1 : seed.indexOf(":");
      const stateId = cut > 0 ? seed!.slice(0, cut) : undefined;
      void (async () => {
        try {
          for await (const event of handle.events) {
            // Everything on the stream is forwarded, in order. Text fragments go as `text`; a
            // finished turn goes whole (tool calls and results ride on it); anything else —
            // progress, command decisions, provider events, drop notices — goes opaquely, because
            // the viewer's job is to show what happened and "we had no name for it" is not a
            // reason a person watching an hour-long run should see a gap.
            const delta: Omit<TurnDelta, "text" | "entry"> = {
              ...(at !== undefined ? { session: { id: at.id, seq: at.seq } } : {}),
              ...(stateId !== undefined ? { stateId } : {}),
              at: Date.now(),
            };
            let payload: TurnDelta;
            if (event.type === "output_partial") {
              if (event.text.length === 0) continue;
              payload = { ...delta, text: event.text };
            } else if (event.type === "thinking_partial") {
              if (event.text.length === 0) continue;
              payload = { ...delta, thinking: event.text };
            } else if (event.type === "message") {
              payload = {
                ...delta,
                entry: {
                  kind: "message",
                  role: event.role,
                  content: event.content,
                  // A subagent's turn keeps its attribution: untagged it would render into the main
                  // thread, which is the exact confusion the tag exists to prevent.
                  ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
                } as JsonValue,
              };
            } else {
              payload = { ...delta, entry: { kind: "event", event: event as unknown as JsonValue } as JsonValue };
            }
            try {
              sink(payload);
            } catch {
              // A consumer that throws costs ONE delta, not the stream. The sink is an IPC send, which
              // throws on a window that has gone away — and a single closed window used to silence
              // streaming for the rest of the run, indistinguishably from an agent with nothing to say.
            }
          }
        } catch {
          // A stream that ends badly must not fail the call it was narrating.
        }
      })();
      return live === undefined ? handle : register(live, ctx, handle);
    },
  };
}
