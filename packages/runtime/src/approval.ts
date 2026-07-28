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
import type { PolicyAuditEntry } from "./policy";

/** A parked approval, as the UI sees it. */
export interface ApprovalRequest {
  requestId: string;
  /** Logical tool name (`bash`, `write_file`). */
  tool: string;
  /** The command line, when the tool takes one — what the user is really judging. */
  command?: string;
  /** Why policy escalated (`pushes publish work`). */
  reason?: string;
  /** Tool input as the model produced it, for the details view. */
  input: Record<string, unknown>;
  /** Upstream's approval-scope key — the agent session this call belongs to. */
  sessionId: string;
  /** Which task's run raised it (set by the host that owns the runs). */
  taskId?: string;
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

  /** The `Approver` to place on `ctx.approve`. */
  approver(context: { taskId?: string } = {}): Approver {
    return (req: PermissionRequest) => this.park(req, context.taskId);
  }

  private park(req: PermissionRequest, taskId?: string): Promise<PermissionDecision> {
    const requestId = this.options.nextId?.() ?? `approval-${++this.counter}`;
    const input = req.input as Record<string, unknown>;
    const command = typeof input["command"] === "string" ? (input["command"] as string) : undefined;
    const request: ApprovalRequest = {
      requestId,
      tool: req.tool,
      ...(command !== undefined ? { command } : {}),
      ...(command !== undefined && this.reasons.has(command) ? { reason: this.reasons.get(command)! } : {}),
      input,
      sessionId: req.sessionId,
      ...(taskId !== undefined ? { taskId } : {}),
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

  /** Answer a parked approval. Returns false for an unknown or already-answered id. */
  decide(requestId: string, decision: "allow" | "deny", scope: PermissionScope = "once"): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
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
