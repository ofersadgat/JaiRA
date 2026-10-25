/**
 * The per-command approval seam (DESIGN §10.2).
 *
 * When policy resolves a tool call to `ask`, the engine (or a delegated adapter's
 * native permission callback) calls `ctx.approve`. This hub parks that call and
 * emits a request the UI answers — the same shape as the workflow-gate
 * {@link InteractionHub}, and deliberately a *separate* channel: DESIGN §10.2
 * distinguishes engine-level command approvals (per-command, provider-initiated,
 * unpredictable) from workflow-level UI gates (authored states). They surface in
 * one inbox but are not the same mechanism.
 *
 * The decision carries a {@link PermissionScope}, so "allow for this run" is a
 * real answer rather than the user being asked the same question forty times.
 * Upstream's `PermissionLedger` applies it; this hub only collects it.
 */
import type { Approver, PermissionDecision, PermissionRequest, PermissionScope } from "@declarative-ai/permissions";
import type { CommandApproval, PermissionAnswer, PermissionFunctionRequest } from "@jaira/shared";
import { CommandGrants, approvalReasonOf, commandDecisionOf, type PolicyAuditEntry } from "./policy";
import { withPermissionFunctions, type PermissionFunctionsOptions } from "./permissionFunctions";
import { mcpCallOf } from "./mcpServers";
import { canonical } from "./hostCalls";
import { forgetRefusal, noteRefusal, rememberDenial } from "./refusals";

/** Why an approval was refused, by the call's own input object — see {@link refusalOf}. */
const REFUSALS = new WeakMap<object, string>();

/**
 * Why the approver refused this call, when it said: an approver that answers `deny` without a person
 * (a CLI run with nobody at a terminal) says why, and what would let the call run.
 *
 * Found by the call's INPUT object, which upstream hands unchanged from the tool to the approver — the
 * same seam `commandDecisionOf` uses. Upstream's own refusal only ever says "denied by permission
 * policy", which is true and tells nobody what to change; `run_command` reads this to say more.
 */
export function refusalOf(input: unknown): string | undefined {
  return input !== null && typeof input === "object" ? REFUSALS.get(input) : undefined;
}

/** A parked approval, as the UI sees it. */
export interface ApprovalRequest {
  requestId: string;
  /** Logical tool name (`shell`, `write_file`). */
  tool: string;
  /** The command line, when the tool takes one — what the user is really judging. */
  command?: string;
  /** Why policy escalated (`pushes publish work`). */
  reason?: string;
  /**
   * A shell line as the REQUESTS it is made of, each with its span, its subject, its verdict and the
   * permission set entry that decided it (decision 0007 §4) — what the approval draws instead of one opaque
   * line. Present whenever the policy took the line apart; a consumer that ignores it sees the
   * request it always saw.
   */
  parts?: CommandApproval;
  /** Tool input as the model produced it, for the details view. */
  input: Record<string, unknown>;
  /** Upstream's approval-scope key — the agent session this call belongs to. */
  sessionId: string;
  /** Which task's run raised it (set by the host that owns the runs). */
  taskId?: string;
  /**
   * Which workflow INSTANCE's operation asked — the engine names it on every request it hands
   * over (`PermissionRequest.instanceId`). What lets a host withdraw exactly the asks a skip
   * interrupted and leave a still-running sibling's. Absent for an ask no instance made (a chat turn).
   */
  instanceId?: string;
  /**
   * The permission FUNCTION that put this call to the person through `approve_tool_call`, when one
   * did (`smart`, unsure) — absent when the policy asked. What a function remembers is its own
   * business (decision 0007, amended 2026-09-22), so its question is answered for this call alone.
   */
  asker?: string;
  at: number;
}

/**
 * Who answered an approval: the person, or — without asking anybody — a stop (the run is winding
 * down), the app closing, or the call that asked ENDING without it (`abandoned`: the agent gave up on
 * the call — the claude CLI ends an MCP call it has heard nothing from in five minutes — so nobody
 * waits on the answer any more). What the conversation's record says of an answer nobody gave.
 */
export type ApprovalAnsweredBy = "person" | "stopped" | "closed" | "abandoned";

/**
 * How far the person's answer reached, as they chose it — before the hub narrows what it hands
 * upstream to `once` (a remembered PART is the run's reach, never the whole tool's). What the record
 * says of the answer, and what a run resumed after the app closed remembers again.
 */
export interface ApprovalReach {
  scope: PermissionScope;
  /** The widths of the asking parts the answer covers, when it was given "for this run". */
  remember?: readonly string[];
}

/**
 * An answer given ahead of the call it answers — a question the app closed under, answered when it was
 * found again in the record. The call is made again when the conversation continues, and meets its
 * answer here instead of the person being asked twice (see {@link ApprovalHub.seed}).
 */
export interface SeededApproval {
  tool: string;
  input: unknown;
  decision: "allow" | "deny";
  reach: ApprovalReach;
}

export interface ApprovalHubOptions {
  onRequest?: (request: ApprovalRequest) => void;
  onResolved?: (requestId: string, decision: PermissionDecision, by: ApprovalAnsweredBy, reach: ApprovalReach) => void;
  nextId?: () => string;
  now?: () => number;
  /**
   * Decision used when nothing can answer — a run with no UI attached. Defaults to
   * denying, because an unanswered approval must not become an allow.
   */
  unattended?: PermissionDecision;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (decision: PermissionDecision) => void;
}

export class ApprovalHub {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  /** Reasons captured from the policy audit, keyed by the command they concern. */
  private readonly reasons = new Map<string, string>();
  /** Part answers remembered "for this run", by task — see {@link grants}. */
  private readonly remembered = new Map<string, CommandGrants>();
  /**
   * Tasks whose runs are STOPPING — the gate, held shut.
   *
   * The cheapest boundary a stop has. An agent asks before every tool it is not pre-approved for, so
   * refusing from here means it finishes the tool it is inside, asks for the next one, is told no,
   * and winds down on its own: nothing side-effecting is ever cut in half. It costs at most one more
   * tool call, and it needs no protocol the transport does not already have — which is why it works
   * for every adapter, including the ones that cannot be interrupted at all.
   *
   * A set rather than a flag on the parked requests, because the requests that matter have not been
   * made yet. Denying the parked ones alone unblocked the loop and then let it ask again.
   */
  private readonly stopping = new Set<string>();
  /** Answers given ahead of their calls, by task — see {@link seed}. */
  private readonly seeded = new Map<string, SeededApproval[]>();

  constructor(private readonly options: ApprovalHubOptions = {}) {}

  /**
   * Answer a call before it is made: the next request this task makes for `tool` with exactly this
   * input is answered with it, without anybody being asked. One shot, first in first out.
   *
   * What a question the app closed under needs. The record still holds it, so it is put to the person
   * again on the next open — but the agent that asked is gone, and continuing its conversation makes it
   * ask again. That second asking IS the first one, answered already, and meets the answer here. Kept
   * out of the record as an ask of its own: the answer is written beside the question it answered.
   */
  seed(taskId: string, answer: SeededApproval): void {
    const list = this.seeded.get(taskId) ?? [];
    list.push(answer);
    this.seeded.set(taskId, list);
  }

  /** Forget what was seeded for a task and never asked for — its conversation has stopped. */
  unseed(taskId: string): void {
    this.seeded.delete(taskId);
  }

  /** The seeded answer for this call, taken — or `undefined`. */
  private takeSeed(taskId: string | undefined, tool: string, input: unknown): SeededApproval | undefined {
    if (taskId === undefined) return undefined;
    const list = this.seeded.get(taskId);
    if (list === undefined) return undefined;
    const want = canonical(input);
    const at = list.findIndex((s) => s.tool === tool && canonical(s.input) === want);
    if (at < 0) return undefined;
    const [taken] = list.splice(at, 1);
    if (list.length === 0) this.seeded.delete(taskId);
    return taken;
  }

  /**
   * Remember again, for a task's run, what the person answered "for this run" about the parts of shell
   * lines — read back from the record when the run resumes in a new process. The answers are the
   * record's own: each was given about these parts, at these widths.
   */
  rememberAgain(taskId: string, answers: ReadonlyArray<{ parts: CommandApproval; decision: "allow" | "deny"; remember: readonly string[] }>): void {
    for (const answer of answers) this.grants(taskId).rememberParts(answer.parts, answer.decision, answer.remember.length > 0 ? answer.remember : undefined);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Feed a policy decision in, so a subsequent `ask` can explain *why* it is
   * asking. Wire this to `compilePolicy`'s `onDecision`.
   */
  readonly noteDecision = (entry: PolicyAuditEntry): void => {
    if (entry.command !== undefined && entry.action === "require_approval") {
      this.reasons.set(entry.command, entry.reason);
    }
  };

  /**
   * Shut the gate for a task, and refuse whatever is already waiting at it.
   *
   * Idempotent, and deliberately not cleared here: a stop stays stopped until a new run opens the
   * gate again ({@link allow}), so an approval arriving late — from a tool call already in flight
   * when the stop was requested — meets the same answer as one arriving early.
   */
  stop(taskId: string): void {
    this.stopping.add(taskId);
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.request.taskId === taskId) this.decide(requestId, "deny", "once", undefined, undefined, "stopped");
    }
  }

  /** Open it again — a new run for this task may ask for tools. What the last run remembered about parts goes with it. */
  allow(taskId: string): void {
    this.stopping.delete(taskId);
    this.remembered.get(taskId)?.clear();
  }

  /**
   * The part answers remembered for one task's run — hand this to `compilePolicy({ grants })`, so
   * what {@link decide} remembers is what the next shell line is judged with.
   *
   * One object per task for the life of the hub, emptied when a new run opens the gate: "for this
   * run" is a reach, and a run that ended takes its answers with it.
   */
  grants(taskId: string): CommandGrants {
    let grants = this.remembered.get(taskId);
    if (grants === undefined) this.remembered.set(taskId, (grants = new CommandGrants()));
    return grants;
  }

  /** Is this task's gate shut? */
  stopped(taskId: string): boolean {
    return this.stopping.has(taskId);
  }

  /**
   * The `Approver` to place on `ctx.approve`.
   *
   * Every call reaches a person only through {@link withPermissionFunctions}: a permission set's shell is
   * lowered as `ask` so that no line runs unread (decision 0007, amended 2026-09-22), and what a line
   * came to decides it here first — a line every part of which the permission set allows runs without anybody
   * being asked, one with a denied part is refused, and the parts a FUNCTION decides are put to it.
   * `functions` is how those are run; without it such a part is put to the person, with the reason.
   */
  approver(context: { taskId?: string; functions?: Omit<PermissionFunctionsOptions, "task"> } = {}): Approver {
    const park: Approver = (req: PermissionRequest) => this.park(req, context.taskId);
    const decide = withPermissionFunctions(park, { ...context.functions, ...(context.taskId !== undefined ? { task: context.taskId } : {}) });
    // A stopping run's gate is shut before any function is asked: a judge's model call, or a function's
    // own question, about a run that is winding down is one nobody should pay for or answer.
    return async (req: PermissionRequest) => {
      // Who refused an earlier call with the same input is not who refuses this one (`refusals.ts`).
      forgetRefusal(req.input);
      if (context.taskId !== undefined && this.stopping.has(context.taskId)) {
        noteRefusal(req.input, { kind: "nobody", why: "stopped" });
        return { decision: "deny", scope: "once" };
      }
      return decide(req);
    };
  }

  private park(req: PermissionRequest, taskId?: string): Promise<PermissionDecision> {
    // The gate is shut: answer without asking anybody. Parking here would put a question on screen
    // about a run that is stopping, and the only honest answer to it is the one given here.
    if (taskId !== undefined && this.stopping.has(taskId)) {
      noteRefusal(req.input, { kind: "nobody", why: "stopped" });
      return Promise.resolve({ decision: "deny", scope: "once" });
    }
    const requestId = this.options.nextId?.() ?? `approval-${++this.counter}`;
    const input = req.input as Record<string, unknown>;
    // The policy judged this very call a moment ago and kept what it found against the input.
    const decided = commandDecisionOf(req.input);
    // A call to a tool of an MCP server is judged by name, as a line of one part — the tool's name
    // (`mcp__figma__get_code`) is what the person reads, and is the tool, even where the gate was
    // asked about it by its server's line.
    const mcp = decided?.parts.parts[0]?.kind === "mcp" ? decided.parts.line : undefined;
    const command = typeof input["command"] === "string" ? (input["command"] as string) : mcp;
    // The decision kept against the call is the freshest word — after the functions a line names have
    // answered, its reason is theirs, not the escalation the policy audited on the way in.
    const reason = decided?.reason ?? (command !== undefined ? this.reasons.get(command) : undefined) ?? approvalReasonOf(req.input);
    const request: ApprovalRequest = {
      requestId,
      tool: mcpCallOf(req.input) ?? req.tool,
      ...(command !== undefined ? { command } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(decided !== undefined ? { parts: decided.parts } : {}),
      input,
      sessionId: req.sessionId,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      at: this.options.now?.() ?? Date.now(),
    };
    const seeded = this.takeSeed(taskId, request.tool, req.input);
    if (seeded !== undefined) return Promise.resolve(this.answerSeeded(request, seeded));
    return this.hold(request);
  }

  /** A seeded answer, given to the call it was given for — remembering its parts as the person said. */
  private answerSeeded(request: ApprovalRequest, seeded: SeededApproval): PermissionDecision {
    const { parts, taskId } = request;
    if (seeded.reach.remember !== undefined && parts !== undefined && taskId !== undefined) {
      this.grants(taskId).rememberParts(parts, seeded.decision, seeded.reach.remember.length > 0 ? seeded.reach.remember : undefined);
      return { decision: seeded.decision, scope: "once" };
    }
    return { decision: seeded.decision, scope: seeded.reach.scope };
  }

  /**
   * `approve_tool_call`, called by a permission FUNCTION: the request it was handed, put to the person
   * the way the policy puts one — the same parking, the same prompt, the same place on screen. There
   * is ONE approval prompt; a function reaching it is a caller, not a second kind of question.
   * `prompt` is the function's own sentence (`smart is unsure — …`), shown as the reason.
   */
  askFor(request: PermissionFunctionRequest, context: { taskId?: string; prompt?: string } = {}): Promise<PermissionAnswer> {
    if (context.taskId !== undefined && this.stopping.has(context.taskId)) {
      noteRefusal(request.input, { kind: "nobody", why: "stopped" });
      return Promise.resolve("deny");
    }
    const command = request.line ?? request.part?.text;
    // The line as the policy took it apart, kept against the call's own input — the same breakdown
    // the policy's ask draws, the function's part among the rest. Absent when a function document
    // handed on a copy of the request rather than the call's input.
    const decided = commandDecisionOf(request.input);
    const parked: ApprovalRequest = {
      requestId: this.options.nextId?.() ?? `approval-${++this.counter}`,
      tool: request.tool,
      ...(command !== undefined ? { command } : {}),
      ...(context.prompt !== undefined ? { reason: context.prompt } : {}),
      ...(decided !== undefined ? { parts: decided.parts } : {}),
      input: request.input as Record<string, unknown>,
      sessionId: "",
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
      asker: request.function,
      at: this.options.now?.() ?? Date.now(),
    };
    const seeded = this.takeSeed(context.taskId, parked.tool, request.input);
    if (seeded !== undefined) return Promise.resolve(this.answerSeeded(parked, seeded).decision);
    return this.hold(parked).then((decided) => decided.decision);
  }

  /** Park one request until it is answered — or refuse it, when nothing is listening to ask. */
  private hold(request: ApprovalRequest): Promise<PermissionDecision> {
    if (this.options.onRequest === undefined) {
      // Nobody is listening: refuse rather than hang the agent's tool loop.
      const unattended = this.options.unattended ?? { decision: "deny", scope: "once" };
      if (unattended.decision === "deny") noteRefusal(request.input, { kind: "nobody", why: "unattended" });
      return Promise.resolve(unattended);
    }
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, { request, resolve });
      this.options.onRequest?.(request);
    });
  }

  /**
   * Answer a parked approval. Returns false for an unknown or already-answered id.
   *
   * `remember` is the "for this run" reach of an answer about a shell line: the widths chosen for
   * its asking PARTS (`["git commit"]`, or `["git"]` to cover the program). It is the parts that are
   * remembered, never the line — so the answer handed upstream is `once` whatever `scope` said: a
   * wider scope there would remember the whole shell tool. `[]` remembers each asking part at its
   * narrowest width.
   */
  decide(
    requestId: string,
    decision: "allow" | "deny",
    scope: PermissionScope = "once",
    remember?: readonly string[],
    /** Why a `deny` was given, when it was not a person's plain no — found again by {@link refusalOf}. */
    why?: string,
    by: ApprovalAnsweredBy = "person",
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (decision === "deny" && why !== undefined) REFUSALS.set(entry.request.input, why);
    const { parts, taskId } = entry.request;
    if (decision === "deny") {
      // Who said no, for the words the agent reads (`refusals.ts`): a person's plain no, or nobody — a
      // stop, the app closing, the call ending first, or a host answering for nobody there (`why`).
      noteRefusal(entry.request.input, by !== "person" ? { kind: "nobody", why: by } : why !== undefined ? { kind: "nobody", why: "unattended", reason: why } : { kind: "person" });
      // A no for longer than this call is the ledger's to remember, and its next refusal is this answer's.
      if (by === "person" && why === undefined && scope !== "once" && remember === undefined) rememberDenial(entry.request.sessionId, entry.request.tool);
    }
    // What the person chose, before it is narrowed for upstream — the record keeps THIS.
    const reach: ApprovalReach = { scope, ...(remember !== undefined ? { remember: [...remember] } : {}) };
    if (remember !== undefined && parts !== undefined && taskId !== undefined) {
      this.grants(taskId).rememberParts(parts, decision, remember.length > 0 ? remember : undefined);
      scope = "once";
    }
    const resolved: PermissionDecision = { decision, scope };
    entry.resolve(resolved);
    this.options.onResolved?.(requestId, resolved, by, reach);
    return true;
  }

  /**
   * Refuse what one task's agent is waiting on, as STOPPED — without shutting its gate. A chat turn's
   * stop: the conversation goes on with the next message, which must be free to ask.
   */
  denyFor(taskId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.request.taskId === taskId) this.decide(requestId, "deny", "once", undefined, undefined, "stopped");
    }
  }

  /**
   * Let go of a parked approval whose call has ended without it — see `abandoned` on
   * {@link ApprovalAnsweredBy}. Refused, so the tool that was waiting unwinds, but nobody reads the
   * refusal: the agent already has the call's end. Returns false for an unknown or answered id.
   */
  abandon(requestId: string): boolean {
    return this.decide(requestId, "deny", "once", undefined, undefined, "abandoned");
  }

  /**
   * Deny every parked approval — used when a run is canceled or the window closes,
   * so an agent never waits forever on a question nobody will answer.
   */
  denyAll(by: ApprovalAnsweredBy = "closed"): void {
    for (const requestId of [...this.pending.keys()]) this.decide(requestId, "deny", "once", undefined, undefined, by);
  }
}
