/**
 * A permission set line that is a FUNCTION (decision 0007, amended 2026-09-22): `"bash": { "function": "smart" }`.
 *
 * Four pieces, and they are one argument:
 *
 *  1. **Where a function is asked.** {@link withPermissionFunctions} wraps the approver a host hands
 *     the engine. Lowering tells the gate `ask` for every line a function answers — and for the shell,
 *     whatever it says — so every such call reaches the approver with its input in hand; the narrowing
 *     has already taken a shell line apart (`decideCommand`) or noted which function a tool call is
 *     decided by (`functionCallOf`). The wrapper puts each part, or the call, to its function BEFORE
 *     anybody is asked, lets a line every part of which is allowed through, refuses one any part of
 *     which is denied, and hands the rest to the person with the functions' answers on the request.
 *  2. **How a function is run.** A function is anything an expression can call with one argument —
 *     a host function (`smart`, `approve_tool_call`), a prompt or function operation document, a `.ts`
 *     module symbol — or an expression document (`{ "$expr": … }`) that reads `.inputs.request`. It
 *     is run as a one-state workflow whose output calls it, through the engine, with the run's own
 *     registry and prompt executor ({@link permissionFunctionRunner}); the host loads that state the
 *     way the run's workflow was loaded, so a module is held to the same approval as any other.
 *  3. **The approval prompt, as a function.** {@link registerApprovalPrompt}: `approve_tool_call`,
 *     interactive, parked on the host's gate hub like any component — so it is durable, drawn in the
 *     task's conversation, and a person's `allow` or `deny` is its return value. A function that wants
 *     the person asks through it.
 *  4. **`smart`**, the function JaiRA ships ({@link registerSmartFunction}): one model call judges the
 *     request `allow`, `deny` or `unsure`, and `unsure` calls the approval prompt.
 *
 * A function answers `"allow"` or `"deny"` and nothing else. One that returns anything else, throws,
 * or cannot be loaded has not decided: the part asks the person, and the reason says why. Nothing a
 * function says lifts the destructive floor, `.jaira/`, a rule's deny or a line the parser could not
 * read — those are decided before any function is asked (`judgePart`).
 */
import {
  hostFunction,
  promptOp,
  type CapabilityRegistry,
  type ExecServices,
  type Executor,
  type FunctionInputs,
  type FunctionResult,
  type InlineFamily,
  type JsonValue,
  type ResolvedValue,
  type Signature,
} from "@declarative-ai/exec";
import type { WorkflowBundle, WorkflowMetrics } from "@declarative-ai/hw";
import { runFunction } from "@declarative-ai/ops";
import type { Approver, PermissionDecision, PermissionRequest } from "@declarative-ai/permissions";
import { SchemaValidator } from "@declarative-ai/validate";
import {
  APPROVAL_PROMPT_FUNCTION,
  DEFAULT_SMART_PROMPT,
  SMART_FUNCTION,
  VERDICT_RANK,
  approvalRequestKey,
  isPermissionAnswer,
  type CommandApproval,
  type CommandPart,
  type CommandPartVerdict,
  type JairaSmartConfig,
  type PermissionAnswer,
  type PermissionFunctionRequest,
  type PermissionRequestPart,
} from "@jaira/shared";
import { commandDecisionOf, functionCallOf, noteApprovalReason, setCommandDecision, type CommandDecision } from "./policy";
import { INTERACTIVE } from "./scriptedFunctions";
import { executeWorkflow } from "./wiring";


// --- running a function ---------------------------------------------------------

/** Decide one request by one function. Throws when the function did not answer `allow` or `deny`. */
export type PermissionFunctionRunner = (reference: string, request: PermissionFunctionRequest) => Promise<PermissionAnswer>;

/** The id of the one state a function is run as. */
export const PERMISSION_FUNCTION_STATE = "jaira/permission_function";

/**
 * The one state a function is run as — its output CALLS the function with the request (`call`), or,
 * for an expression document, IS the document, reading `.inputs.request` (`value`).
 *
 * The output is typed loosely on purpose: what a function returns is checked here, by
 * {@link answerOf}, where "not `allow` or `deny`" can be said in words — a typed slot would fail the
 * whole load with a wiring error about the function's return type instead.
 */
export function permissionFunctionState(reference: string, form: "call" | "value" = "call"): Record<string, unknown> {
  return {
    label: "permission function",
    description: `decides one tool call by '${reference}'`,
    inputs: { request: { kind: "json", schema: { type: "object" } } },
    outputs: { decision: { kind: "json", binding: form === "call" ? `${reference}(.inputs.request)` : reference } },
  };
}

/** What a function answered, or why that was no answer. */
export function answerOf(reference: string, result: unknown): PermissionAnswer {
  const record = result as { value?: unknown; error?: { reason?: string } } | undefined;
  if (record?.error !== undefined) throw new Error(`'${reference}' failed: ${record.error.reason ?? "no reason given"}`);
  const value = (record?.value as { decision?: unknown } | undefined)?.decision;
  if (isPermissionAnswer(value)) return value;
  throw new Error(`'${reference}' returned ${JSON.stringify(value) ?? "nothing"}, which is not allow or deny`);
}

export interface PermissionFunctionRunnerOptions {
  /**
   * The state {@link permissionFunctionState} builds, for a reference, LOADED — the way the run's own
   * workflow was loaded, so a name resolves along the same path and a module is held to the same
   * approval. Throws when it does not load. Asked once per reference; the answer is kept.
   */
  load: (reference: string) => WorkflowBundle | Promise<WorkflowBundle>;
  /** The run's registry: its host functions, the approval prompt, the modules it has prepared. */
  registry: CapabilityRegistry<WorkflowMetrics>;
  /** What answers a prompt the function makes — a prompt operation document's, or `smart`'s. */
  prompt: Executor<ExecServices, WorkflowMetrics>;
  /** The run's signal: a stop ends a function mid-question too. */
  abortSignal?: AbortSignal | undefined;
}

/**
 * Run a function as a one-state workflow, through the engine — so every kind of callee the language
 * has is one kind here, and a callee that parks (the approval prompt) parks exactly as a gate does.
 */
export function permissionFunctionRunner(options: PermissionFunctionRunnerOptions): PermissionFunctionRunner {
  const loaded = new Map<string, Promise<WorkflowBundle>>();
  return async (reference, request) => {
    let bundle = loaded.get(reference);
    if (bundle === undefined) {
      bundle = Promise.resolve().then(() => options.load(reference));
      loaded.set(reference, bundle);
      // A reference that did not load is asked again next time: a module approved in between should
      // not stay refused for the rest of the run.
      bundle.catch(() => loaded.delete(reference));
    }
    const result = await executeWorkflow({
      bundle: await bundle,
      inputs: { request: request as unknown as JsonValue },
      registry: options.registry,
      prompt: options.prompt,
      ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    });
    return answerOf(reference, result);
  };
}

// --- asking the functions, before the person ------------------------------------

/** One function's answer, as the host writes it down. */
export interface PermissionFunctionDecision {
  request: PermissionFunctionRequest;
  /** What it answered; absent when it could not answer, and `failure` says why. */
  answer?: PermissionAnswer;
  failure?: string;
}

export interface PermissionFunctionsOptions {
  /** How a function is run. Absent ⇒ nothing here can run one, and every such part asks the person. */
  run?: PermissionFunctionRunner | undefined;
  /** The task the calls belong to — what a function is told. */
  task?: string | undefined;
  /** The state an asking instance is of, by the instance id the engine stamps on the request. */
  stateOf?: ((instanceId: string) => string | undefined) | undefined;
  /** The state, when the caller knows it without an instance — a conversation turn's. */
  state?: string | undefined;
  /** Told every answer (and every failure) — the audit. */
  onDecided?: ((decision: PermissionFunctionDecision) => void) | undefined;
}

/** A shell part, as a function is handed it. */
export function requestPartOf(part: CommandPart): PermissionRequestPart {
  return {
    text: part.text,
    kind: part.kind,
    subject: part.subject,
    span: { ...part.span },
    ...(part.command !== undefined
      ? {
          program: part.command.program,
          ...(part.command.subcommand !== undefined ? { subcommand: part.command.subcommand } : {}),
          args: [...part.command.args],
          flags: [...part.command.flags],
        }
      : {}),
    ...(part.paths !== undefined ? { paths: [...part.paths] } : {}),
    ...(part.url !== undefined ? { url: part.url } : {}),
    ...(part.via !== undefined ? { via: [...part.via] } : {}),
  };
}

/** A line's verdict, from its parts. */
function lineVerdict(parts: readonly CommandPart[], fallback: CommandPartVerdict): CommandPartVerdict {
  let worst: CommandPartVerdict | undefined;
  for (const part of parts) if (worst === undefined || VERDICT_RANK[part.verdict] > VERDICT_RANK[worst]) worst = part.verdict;
  return worst ?? fallback;
}

/** The answers {@link withPermissionFunctions} gave itself — see {@link answeredWithoutAsking}. */
const UNASKED = new WeakSet<PermissionDecision>();

const ONCE = (decision: PermissionAnswer): PermissionDecision => {
  const answered: PermissionDecision = { decision, scope: "once" };
  UNASKED.add(answered);
  return answered;
};

/**
 * Whether this decision was given without anybody being asked — by what a line's parts came to, or by
 * the functions it names. What lets a probe that holds a HOST's whole approver (`handedToClaude` with
 * `run`) tell a call a function answered from one a person was asked about.
 */
export function answeredWithoutAsking(decision: PermissionDecision): boolean {
  return UNASKED.has(decision);
}

/**
 * The approver a host hands the engine, with the functions put first — see the module header.
 *
 * Every answer a function gives is `once`: a function is asked per call, and a ledger entry at any
 * wider scope would answer the next call without it. What a PERSON answers afterwards keeps the reach
 * they gave it, as before.
 */
export function withPermissionFunctions(approve: Approver, options: PermissionFunctionsOptions = {}): Approver {
  const where = (req: PermissionRequest): { state?: string; task?: string } => {
    const state = (req.instanceId !== undefined ? options.stateOf?.(req.instanceId) : undefined) ?? options.state;
    return { ...(state !== undefined ? { state } : {}), ...(options.task !== undefined ? { task: options.task } : {}) };
  };
  /** Ask one function; a failure is the reason, never an answer. */
  const ask = async (reference: string, request: PermissionFunctionRequest): Promise<{ answer?: PermissionAnswer; failure?: string }> => {
    if (options.run === undefined) {
      const failure = `nothing here can run the function '${reference}'`;
      options.onDecided?.({ request, failure });
      return { failure };
    }
    try {
      const answer = await options.run(reference, request);
      options.onDecided?.({ request, answer });
      return { answer };
    } catch (e) {
      const failure = (e as Error).message;
      options.onDecided?.({ request, failure });
      return { failure };
    }
  };

  return async (req) => {
    const input = (req.input ?? {}) as Record<string, JsonValue>;
    const cwd = typeof input["cwd"] === "string" && input["cwd"] !== "" ? input["cwd"] : undefined;

    // A tool call — not a shell line — whose line names a function.
    const call = functionCallOf(req.input);
    if (call !== undefined) {
      const request: PermissionFunctionRequest = {
        tool: req.tool,
        subject: call.subject,
        function: call.function,
        input,
        ...(cwd !== undefined ? { cwd } : {}),
        ...where(req),
        ...(call.permissionSet !== undefined ? { permissionSet: call.permissionSet } : {}),
      };
      const { answer, failure } = await ask(call.function, request);
      if (answer !== undefined) return ONCE(answer);
      noteApprovalReason(req.input, `the function '${call.function}' could not decide: ${failure}`);
      return approve(req);
    }

    // A shell line, taken apart by the narrowing a moment ago.
    const decided = commandDecisionOf(req.input);
    if (decided === undefined) return approve(req);
    // The gate asks the host about EVERY line a permission set judges — `ask` is what the shell lowers to, so
    // that no line runs unread. What the parts came to is the answer, and a person is asked only when
    // one of them asks.
    if (decided.action === "allow") return ONCE("allow");
    if (decided.action === "deny") return ONCE("deny");
    const parts = [...decided.parts.parts];
    let changed = false;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (part.verdict !== "function" || part.decidedBy.function === undefined) continue;
      const reference = part.decidedBy.function;
      const entry = part.decidedBy.entry;
      const request: PermissionFunctionRequest = {
        tool: req.tool,
        subject: entry ?? part.subject,
        function: reference,
        input,
        line: decided.parts.line,
        part: requestPartOf(part),
        ...(cwd !== undefined ? { cwd } : {}),
        ...where(req),
        ...(decided.parts.permissionSet !== undefined ? { permissionSet: decided.parts.permissionSet } : {}),
      };
      const { answer, failure } = await ask(reference, request);
      changed = true;
      parts[index] = {
        ...part,
        verdict: answer === "allow" ? "allowed" : answer === "deny" ? "denied" : "asks",
        decidedBy: {
          source: "function",
          ...(entry !== undefined ? { entry } : {}),
          function: reference,
          reason: answer !== undefined ? `'${reference}' ${answer === "allow" ? "allowed" : "denied"} it` : `'${reference}' could not decide: ${failure}`,
        },
      };
      // One part refused refuses the line; the functions after it are not asked.
      if (answer === "deny") break;
    }
    const verdict = lineVerdict(parts, decided.parts.verdict);
    const approval: CommandApproval = { ...decided.parts, parts, verdict };
    const worst = parts.find((part) => part.verdict === verdict);
    const updated: CommandDecision = {
      ...decided,
      action: verdict === "denied" ? "deny" : verdict === "allowed" ? "allow" : "require_approval",
      reason: worst?.decidedBy.reason ?? decided.reason,
      parts: approval,
    };
    if (changed) setCommandDecision(req.input, updated);
    if (verdict === "denied") return ONCE("deny");
    if (verdict === "allowed") return ONCE("allow");
    return approve(req);
  };
}

// --- the approval prompt, as a function ------------------------------------------

/** What a permission function — and the approval prompt, and `smart` — takes: the request, and returns allow or deny. */
export const PERMISSION_FUNCTION_SIGNATURE: Signature<InlineFamily> = {
  input: {
    /** What the call is — see `PermissionFunctionRequest`. */
    request: { kind: "json", index: 0, schema: { type: "object" } },
  },
  output: { name: "decision", kind: "text", schema: { type: "string", enum: ["allow", "deny"] } },
};

/** The approval prompt's signature: the request, and optionally the sentence over it. */
export const APPROVAL_PROMPT_SIGNATURE: Signature<InlineFamily> = {
  input: {
    request: { kind: "json", index: 0, schema: { type: "object" } },
    /** The sentence over the request — `smart is unsure — allow this?`. Absent ⇒ the component's own. */
    prompt: { kind: "text", index: 1, optional: true, schema: { type: "string" } },
  },
  output: PERMISSION_FUNCTION_SIGNATURE.output,
};

/**
 * Park a question on the host's gate hub — `InteractionHub.ask` — and get back what was submitted.
 * Resolves with the engine's contract: a value, or an error as data.
 */
export type ParkQuestion = (component: string, inputs: Record<string, JsonValue>) => Promise<FunctionResult<ResolvedValue, WorkflowMetrics>>;

const metrics = (): WorkflowMetrics => ({ startMs: Date.now(), durationMs: 0, costUsd: 0, costSource: "unknown" });

/**
 * `approve_tool_call` — the approval prompt, registered as a function.
 *
 * Parked through `park` — the host's gate hub, for this task — so it is exactly as durable as any
 * gate: written down, drawn in the task's conversation, and after a restart answerable from the row,
 * the answer seeded into the run that resumes. A seeded answer names the request it answered
 * (`about`), and a resumed run that asks about a DIFFERENT call is asked again rather than handed an
 * answer to a question it never put: a resumed agent is not bound to repeat the call it died in.
 */
export function registerApprovalPrompt(registry: CapabilityRegistry<WorkflowMetrics>, park: ParkQuestion): void {
  registry.functions.set(
    APPROVAL_PROMPT_FUNCTION,
    hostFunction(
      async (inputs: FunctionInputs): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        const given: Record<string, JsonValue> = {
          request: (inputs["request"] ?? {}) as JsonValue,
          ...(typeof inputs["prompt"] === "string" ? { prompt: inputs["prompt"] } : {}),
        };
        const key = approvalRequestKey(given["request"]);
        for (let round = 0; round < 2; round++) {
          const result = await park(APPROVAL_PROMPT_FUNCTION, given);
          if ("error" in result && result.error !== undefined) return result;
          const answer = result.value as { decision?: unknown; about?: unknown } | undefined;
          if (answer?.about !== undefined && answer.about !== key) continue; // an answer to another call
          if (isPermissionAnswer(answer?.decision)) return { value: answer.decision, metrics: metrics() };
          return { error: { classification: "permanent", reason: `the approval prompt answered ${JSON.stringify(answer)}` }, metrics: metrics() };
        }
        return { error: { classification: "permanent", reason: "the approval prompt was answered about another call twice" }, metrics: metrics() };
      },
      INTERACTIVE,
      { signature: APPROVAL_PROMPT_SIGNATURE },
    ),
  );
}

// --- smart ----------------------------------------------------------------------

/** What the judge returns. */
export const SMART_OUTPUT_SCHEMA: JsonValue = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["allow", "deny", "unsure"], description: "allow, deny, or unsure — unsure asks the person." },
    reason: { type: "string", description: "One sentence: why." },
  },
};

/** The one model call `smart` makes about one request. */
export function smartJudgeOperation(request: PermissionFunctionRequest, config: JairaSmartConfig = {}): ReturnType<typeof promptOp> {
  const user = [
    config.prompt ?? DEFAULT_SMART_PROMPT,
    "",
    "## The call",
    "",
    "```json",
    JSON.stringify(request, null, 2),
    "```",
    "",
    "Answer with `verdict` — allow, deny or unsure — and `reason`, one sentence.",
  ].join("\n");
  return promptOp({
    user,
    ...(config.model !== undefined ? { config: { model: config.model } } : {}),
    output: { name: "smart", schema: SMART_OUTPUT_SCHEMA as never },
  });
}

/** The judge's verdict, or `unsure` for anything that is not a clean `allow` or `deny`. */
export function smartVerdictOf(value: unknown): { verdict: "allow" | "deny" | "unsure"; reason?: string } {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const verdict = record["verdict"];
  const reason = typeof record["reason"] === "string" && record["reason"].trim().length > 0 ? record["reason"].trim() : undefined;
  return { verdict: verdict === "allow" || verdict === "deny" ? verdict : "unsure", ...(reason !== undefined ? { reason } : {}) };
}

export interface SmartFunctionOptions {
  /** What answers the judge's call — the run's default executor. */
  prompt: Executor<ExecServices, WorkflowMetrics>;
  /** `functions.smart.model` and `.prompt`, from Settings → Tools → smart. Read at every call. */
  config: () => JairaSmartConfig;
}

/**
 * `smart` — the permission function JaiRA ships.
 *
 * One model call judges the request; `allow` and `deny` are its answer, and `unsure` — or a judge
 * that failed, or said something that is neither — is put to the person through the approval prompt,
 * called as the function it is: the entry registered under `approve_tool_call` on the same registry,
 * so a host that parks it durably makes `smart`'s question durable too. With no approval prompt on
 * the registry, an unsure call is refused: an unanswered question must not become an allow.
 */
export function registerSmartFunction(registry: CapabilityRegistry<WorkflowMetrics>, options: SmartFunctionOptions): void {
  registry.functions.set(
    SMART_FUNCTION,
    hostFunction(
      async (inputs: FunctionInputs, ctx: ExecServices): Promise<FunctionResult<ResolvedValue, WorkflowMetrics>> => {
        const request = (inputs["request"] ?? {}) as unknown as PermissionFunctionRequest;
        let judged: { verdict: "allow" | "deny" | "unsure"; reason?: string };
        try {
          const services: ExecServices = { validator: new SchemaValidator(), ...(ctx?.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}) };
          const result = await options.prompt.start(smartJudgeOperation(request, options.config()), services).result;
          judged = "error" in result && result.error !== undefined ? { verdict: "unsure", reason: `the judge failed: ${result.error.reason}` } : smartVerdictOf(result.value);
        } catch (e) {
          judged = { verdict: "unsure", reason: `the judge failed: ${(e as Error).message}` };
        }
        if (judged.verdict !== "unsure") return { value: judged.verdict, metrics: metrics() };
        const prompt = registry.functions.get(APPROVAL_PROMPT_FUNCTION);
        if (prompt === undefined) return { value: "deny", metrics: metrics() };
        const sentence = judged.reason !== undefined ? `smart is unsure — ${judged.reason}` : "smart is unsure — allow this?";
        return runFunction(prompt, { request: request as unknown as JsonValue, prompt: sentence } as FunctionInputs, ctx);
      },
      // Not memoizable: the same call on another day, or under another prompt, may be judged anew — and
      // an unsure one parks a person's question, which is never a cached answer.
      { interactive: true, readOnly: true, memoizable: false },
      { signature: PERMISSION_FUNCTION_SIGNATURE },
    ),
  );
}

/**
 * The declarations of the two functions, for a loader that has to resolve `smart(…)` and
 * `approve_tool_call(…)` without running anything — see `hostCalleeSignatures`.
 */
export function registerPermissionFunctionSignatures(registry: CapabilityRegistry<WorkflowMetrics>): void {
  registerApprovalPrompt(registry, async () => ({ error: { classification: "permanent", reason: "declared, not run" } }));
  registerSmartFunction(registry, {
    prompt: { start: () => ({ result: Promise.resolve({ error: { classification: "permanent", reason: "declared, not run" } }) }) } as never,
    config: () => ({}),
  });
}
