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
import type { CommandApproval } from "@jaira/shared";
import { CommandGrants, approvalReasonOf, commandDecisionOf, type PolicyAuditEntry } from "./policy";
import { withPermissionFunctions, type PermissionFunctionsOptions } from "./permissionFunctions";

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
  /** Logical tool name (`bash`, `write_file`). */
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
  at: number;
}

export interface ApprovalHubOptions {
  onRequest?: (request: ApprovalRequest) => void;
  onResolved?: (requestId: string, decision: PermissionDecision) => void;
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

  constructor(private readonly options: ApprovalHubOptions = {}) {}

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
      if (entry.request.taskId === taskId) this.decide(requestId, "deny", "once");
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
    return async (req: PermissionRequest) =>
      context.taskId !== undefined && this.stopping.has(context.taskId) ? { decision: "deny", scope: "once" } : decide(req);
  }

  private park(req: PermissionRequest, taskId?: string): Promise<PermissionDecision> {
    // The gate is shut: answer without asking anybody. Parking here would put a question on screen
    // about a run that is stopping, and the only honest answer to it is the one given here.
    if (taskId !== undefined && this.stopping.has(taskId)) {
      return Promise.resolve({ decision: "deny", scope: "once" });
    }
    const requestId = this.options.nextId?.() ?? `approval-${++this.counter}`;
    const input = req.input as Record<string, unknown>;
    const command = typeof input["command"] === "string" ? (input["command"] as string) : undefined;
    // The policy judged this very call a moment ago and kept what it found against the input.
    const decided = commandDecisionOf(req.input);
    // The decision kept against the call is the freshest word — after the functions a line names have
    // answered, its reason is theirs, not the escalation the policy audited on the way in.
    const reason = decided?.reason ?? (command !== undefined ? this.reasons.get(command) : undefined) ?? approvalReasonOf(req.input);
    const request: ApprovalRequest = {
      requestId,
      tool: req.tool,
      ...(command !== undefined ? { command } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(decided !== undefined ? { parts: decided.parts } : {}),
      input,
      sessionId: req.sessionId,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      at: this.options.now?.() ?? Date.now(),
    };
    if (this.options.onRequest === undefined) {
      // Nobody is listening: refuse rather than hang the agent's tool loop.
      return Promise.resolve(this.options.unattended ?? { decision: "deny", scope: "once" });
    }
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, { request, resolve });
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
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (decision === "deny" && why !== undefined) REFUSALS.set(entry.request.input, why);
    const { parts, taskId } = entry.request;
    if (remember !== undefined && parts !== undefined && taskId !== undefined) {
      this.grants(taskId).rememberParts(parts, decision, remember.length > 0 ? remember : undefined);
      scope = "once";
    }
    const resolved: PermissionDecision = { decision, scope };
    entry.resolve(resolved);
    this.options.onResolved?.(requestId, resolved);
    return true;
  }

  /**
   * Deny every parked approval — used when a run is canceled or the window closes,
   * so an agent never waits forever on a question nobody will answer.
   */
  denyAll(): void {
    for (const requestId of [...this.pending.keys()]) this.decide(requestId, "deny", "once");
  }
}
