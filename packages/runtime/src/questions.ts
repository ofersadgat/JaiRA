/**
 * The mid-run user-question seam — `AskUserQuestion` and its kin.
 *
 * The shape of {@link ApprovalHub}, deliberately, because the lifecycle is the same: an agent parks,
 * a request surfaces, a human answers, the agent resumes. What differs is the PAYLOAD — an approval
 * answers "may this call run?" where this answers "which way do you want it?" — and that difference
 * is why it is a second hub rather than a flag on the first. Routed through the approvals channel,
 * the person was asked to approve the act of being asked, and the question itself never reached
 * them: the agent's call resolved with no answers at all.
 *
 * The upstream adapter (`AgentExecutor`) reads this off `ctx.askUser` and carries the answers back
 * to the agent as `updatedInput.answers`, which is the documented contract for answering the tool.
 */
import type { UserAnswers, UserQuestion, UserQuestionRequest, AskUser } from "@declarative-ai/permissions";

/** A parked question batch, as the UI sees it. */
export interface QuestionRequest {
  requestId: string;
  questions: UserQuestion[];
  /** Upstream's approval-scope key — the agent session this question belongs to. */
  sessionId: string;
  /** Which task's run raised it (set by the host that owns the runs). */
  taskId?: string;
  /** Which workflow instance's agent asked — see `ApprovalRequest.instanceId`. */
  instanceId?: string;
  /**
   * The asking `AskUserQuestion` call's own id, when the transport reported it — the same id the
   * call carries in the agent's transcript, so an answer given for the person is drawn on exactly
   * that call.
   */
  toolCallId?: string;
  at: number;
}

export interface QuestionHubOptions {
  onRequest?: (request: QuestionRequest) => void;
  onResolved?: (requestId: string, answers: UserAnswers | undefined) => void;
  nextId?: () => string;
  now?: () => number;
}

interface Pending {
  request: QuestionRequest;
  resolve: (answers: UserAnswers | undefined) => void;
}

export class QuestionHub {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly options: QuestionHubOptions = {}) {}

  list(): QuestionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  /** The `AskUser` to place on `ctx.askUser`. */
  asker(context: { taskId?: string } = {}): AskUser {
    return (req: UserQuestionRequest) => this.park(req, context.taskId);
  }

  private park(req: UserQuestionRequest, taskId?: string): Promise<UserAnswers | undefined> {
    if (this.options.onRequest === undefined) {
      // Nobody is listening — an unattended run. `undefined` is the real answer here ("decide
      // yourself"), which the adapter turns into "use your own best judgment and continue";
      // parking would hang the agent's tool loop on a question nobody will ever see.
      return Promise.resolve(undefined);
    }
    const requestId = this.options.nextId?.() ?? `question-${++this.counter}`;
    const request: QuestionRequest = {
      requestId,
      questions: req.questions,
      sessionId: req.sessionId,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(req.instanceId !== undefined ? { instanceId: req.instanceId } : {}),
      ...(req.toolCallId !== undefined ? { toolCallId: req.toolCallId } : {}),
      at: this.options.now?.() ?? Date.now(),
    };
    return new Promise<UserAnswers | undefined>((resolve) => {
      this.pending.set(requestId, { request, resolve });
      this.options.onRequest?.(request);
    });
  }

  /**
   * Answer a parked question. `answers` maps question text → chosen label(s) or free text;
   * `undefined` dismisses it — the agent proceeds on its own judgment. Returns false for an unknown
   * or already-answered id.
   */
  answer(requestId: string, answers: UserAnswers | undefined): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(answers);
    this.options.onResolved?.(requestId, answers);
    return true;
  }

  /**
   * Dismiss every parked question — when a run is canceled or the window closes, so an agent never
   * waits forever on a question nobody will answer.
   */
  dismissAll(): void {
    for (const requestId of [...this.pending.keys()]) this.answer(requestId, undefined);
  }

  /** Dismiss the parked questions raised by one task — the cancel path's half of {@link dismissAll}. */
  dismissFor(taskId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.request.taskId === taskId) this.answer(requestId, undefined);
    }
  }
}
