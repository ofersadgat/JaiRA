/**
 * The fast-forward MODE (decision 0005 §4, step 7) — what a task being run forward is in.
 *
 * `AppService` drives it; this is the bookkeeping, kept out of the service so the three rules that
 * matter are readable in one place:
 *
 *  1. **It is not a transition.** Nothing in the journal is a fast-forward. A forward move starts
 *     the machine and the machine walks its own spine; the mode is what decides who answers the
 *     questions on the way, what the strip says, and what Skip is aimed at. So it lives in the
 *     memory of the process driving the run, and it is gone when that process is.
 *  2. **It ends on arrival, and on anything going wrong.** {@link arrivedAt} is the whole test, and
 *     `end` is written exactly once — a mode that ended twice would answer a question after the
 *     person was supposed to have it back.
 *  3. **A question is offered to the conversation once.** {@link FastForwardRun.seen} is what keeps
 *     a re-parked gate (a follow-up round, a resumed run) from being answered again by a model that
 *     has already had its say about it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { EngineEvent } from "@declarative-ai/hw";
import type { FastForwardEnd, FastForwardView } from "@jaira/shared";

export interface FastForwardRun {
  /** The task being walked forward. */
  taskId: string;
  /** The conversation answering on the way, by its task — the task's own root, or the one it was given. */
  controlTaskId: string;
  /** The target state id. */
  target: string;
  /** What the strip calls it. */
  targetLabel: string;
  /** The child key the target is entered under — what Skip is a directed move TO. */
  to: string;
  /** Child keys beneath `to`, for a nested target. */
  path: string[];
  /** The composite whose child `to` is. Absent ⇒ the run's root instance. */
  instanceId?: string;
  /** The states stepped through on the way, as child-key paths from the root. */
  through: string[];
  /** What the asker hands the target when it is finally entered. */
  inputs?: Record<string, JsonValue>;
  /** How many of `through` have been entered. */
  step: number;
  /** Where the run stands, as child keys joined by " -> ". */
  at?: string;
  answered: number;
  left: number;
  startedAt: number;
  /** Request ids already offered to the conversation — see rule 3. */
  seen: Set<string>;
  /** Why it stopped being a fast-forward. Set once; a set `end` means the mode is over. */
  end?: FastForwardEnd;
}

/** The strip's whole content — see {@link FastForwardView}. */
export function fastForwardView(run: FastForwardRun): FastForwardView {
  return {
    taskId: run.taskId,
    controlTaskId: run.controlTaskId,
    target: run.target,
    targetLabel: run.targetLabel,
    to: run.to,
    path: [...run.path],
    through: [...run.through],
    step: run.step,
    ...(run.at !== undefined ? { at: run.at } : {}),
    answered: run.answered,
    left: run.left,
    startedAt: run.startedAt,
  };
}

/** What the strip calls a target: its child key, or the tail of its state id. */
export function labelOfTarget(target: string, to: string): string {
  return to.length > 0 ? to : (target.split("/").pop() ?? target);
}

/**
 * Has the run ARRIVED — is this event the target being entered?
 *
 * The target is named by child key under a known composite, which is the same pair a directed
 * transition names, so this is the entry a Skip would have produced. A nested target arrives when
 * the LAST key of the way down is entered; the keys above it are composites the run enters on the
 * way, and entering one of those is not arriving.
 */
export function arrivedAt(run: FastForwardRun, event: EngineEvent): boolean {
  if (event.type !== "instance.entered") return false;
  const wanted = run.path.length > 0 ? run.path[run.path.length - 1]! : run.to;
  if (event.childKey !== wanted) return false;
  // Only the top level can be checked by parent id: the composites below it are entered by the run
  // and their instance ids are not known until they are.
  if (run.path.length === 0 && run.instanceId !== undefined) return event.parentInstanceId === run.instanceId;
  return true;
}

/**
 * What a SKIP leaves behind in the inbox (task-lifecycle's known gap, closed by step 7).
 *
 * A skip interrupts the running child. A parked GATE withdraws itself, because the gate hub is
 * handed the calling state's abort signal and honours a `SkipAbort`. An agent's parked tool
 * APPROVAL and its `AskUserQuestion` are not: `Approver` and `AskUser` are called with no signal,
 * placed once per run on the executor's services, and cannot tell which instance asked. So the agent
 * is interrupted and its question stays on screen, answerable, about a turn that no longer exists.
 * Fast-forwarding makes that common — Skip is always showing.
 *
 * This watches the journal a run writes and answers ONE question: when a child ends `skipped`, is
 * every prompt operation still running in this task inside what was skipped? Then every approval and
 * question the task has parked belongs to an agent that was just interrupted, and the host withdraws
 * them — a question dismissed ("decide yourself", which is what the adapter tells a dead agent
 * anyway), an approval denied once. When a prompt operation is still running OUTSIDE the skipped
 * subtree (an `async` sibling), the asks cannot be told apart and none is withdrawn: leaving a stale
 * one is recoverable, denying a live agent's tool is not. `blockedBy` says which kept them.
 */
export class SkipWithdrawals {
  private readonly parentOf = new Map<string, string>();
  private readonly prompts = new Set<string>();

  /**
   * `history` is the journal as it stood when the run started. A RESUMED run does not enter its
   * loaded instances again, so without it an agent re-dispatched inside a loaded composite would have
   * no known parent, read as running OUTSIDE anything skipped, and hold its asks in place.
   */
  constructor(history: readonly EngineEvent[] = []) {
    for (const event of history) if (event.type === "instance.entered" && event.parentInstanceId !== undefined) this.parentOf.set(event.instanceId, event.parentInstanceId);
  }

  /** Feed every journaled event, in order. Returns what to do when a skip lands, else nothing. */
  note(event: EngineEvent): { withdraw: boolean; blockedBy: string[] } | undefined {
    if (event.type === "instance.entered" && event.parentInstanceId !== undefined) this.parentOf.set(event.instanceId, event.parentInstanceId);
    if (event.type === "operation.started" && event.op === "prompt") this.prompts.add(event.instanceId);
    if (event.type === "operation.completed" || event.type === "operation.failed") this.prompts.delete(event.instanceId);
    if (event.type !== "instance.terminated") return undefined;
    if (event.outcome !== "skipped") {
      this.prompts.delete(event.instanceId);
      return undefined;
    }
    const inside = (id: string): boolean => {
      for (let at: string | undefined = id; at !== undefined; at = this.parentOf.get(at)) if (at === event.instanceId) return true;
      return false;
    };
    const within = [...this.prompts].filter(inside);
    const outside = [...this.prompts].filter((id) => !inside(id));
    for (const id of within) this.prompts.delete(id);
    // Nothing was running inside it: a never-entered member ends `skipped` too, and it asked nothing.
    if (within.length === 0) return undefined;
    return { withdraw: outside.length === 0, blockedBy: outside };
  }
}

/**
 * Note where the run has got to — the "at `ux → item` · 1 of 3" half of the strip.
 *
 * `step` counts the members of `through` that have been entered rather than the entries that have
 * happened: a loop inside one of them enters its own children several times, and "4 of 3" is worse
 * than saying nothing.
 */
export function noteEntry(run: FastForwardRun, event: EngineEvent, path: string | undefined): void {
  if (event.type !== "instance.entered" || event.childKey === undefined) return;
  if (path !== undefined && path.length > 0) run.at = path.split("/").join(" → ");
  const at = run.through.indexOf(path ?? event.childKey);
  if (at >= 0 && at + 1 > run.step) run.step = at + 1;
}
