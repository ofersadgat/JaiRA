/**
 * The fast-forward MODE (decision 0005 §4, step 7) — what a task being run forward is in.
 *
 * `AppService` drives it; this is the bookkeeping, kept out of the service so the three rules that
 * matter are readable in one place:
 *
 *  1. **It is not a transition.** A forward move starts the machine and the machine walks its own
 *     spine; the mode is what decides who answers the questions on the way, what the strip says,
 *     and what Skip is aimed at. The process driving the run holds it, and the journal holds its
 *     start and its end (`jaira.fastForward` / `jaira.fastForwardEnded`, `hostRows.ts`): a process
 *     that goes away writes no end, and the resume that follows takes the mode up again
 *     ({@link restoredFastForward}). Approvals stay out of it however it was begun.
 *  2. **It ends on arrival, and on anything going wrong.** {@link arrivedAt} is the whole test, and
 *     `end` is written exactly once — a mode that ended twice would answer a question after the
 *     person was supposed to have it back.
 *  3. **A question is offered to the conversation once.** {@link FastForwardRun.seen} is what keeps
 *     a re-parked gate (a follow-up round, a resumed run) from being answered again by a model that
 *     has already had its say about it.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { EngineEvent } from "@declarative-ai/hw";
import { ANSWERED_EVENT, type FastForwardEnd, type FastForwardEvent, type FastForwardView } from "@jaira/shared";

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
 * APPROVAL and its `AskUserQuestion` are not: `Approver` and `AskUser` are called with no signal.
 * So the agent is interrupted and its question stays on screen, answerable, about a turn that no
 * longer exists. Fast-forwarding makes that common — Skip is always showing.
 *
 * What makes them withdrawable is that each names the instance that asked: the engine stamps
 * `instanceId` on every approval and question request it hands an operation. This watches the
 * journal a run writes and, when a child ends `skipped`, answers which instances are INSIDE what was
 * skipped — the skipped instance and everything entered under it. The host withdraws exactly the
 * asks those instances made — a question dismissed ("decide yourself", which is what the adapter
 * tells a dead agent anyway), an approval denied once — and leaves an `async` sibling's, which is
 * still running and still waiting for its answer. An ask that names no instance (a chat turn's) is
 * never inside anything skipped.
 */
export class SkipWithdrawals {
  private readonly parentOf = new Map<string, string>();

  /**
   * `history` is the journal as it stood when the run started. A RESUMED run does not enter its
   * loaded instances again, so without it an agent re-dispatched inside a loaded composite would have
   * no known parent, read as running OUTSIDE anything skipped, and hold its asks in place.
   */
  constructor(history: readonly EngineEvent[] = []) {
    for (const event of history) if (event.type === "instance.entered" && event.parentInstanceId !== undefined) this.parentOf.set(event.instanceId, event.parentInstanceId);
  }

  /**
   * Feed every journaled event, in order. When a child ends `skipped`, returns the test for whether
   * an asking instance is inside what was skipped; else nothing.
   */
  note(event: EngineEvent): ((instanceId: string | undefined) => boolean) | undefined {
    if (event.type === "instance.entered" && event.parentInstanceId !== undefined) this.parentOf.set(event.instanceId, event.parentInstanceId);
    if (event.type !== "instance.terminated" || event.outcome !== "skipped") return undefined;
    const skipped = event.instanceId;
    return (instanceId) => {
      for (let at: string | undefined = instanceId; at !== undefined; at = this.parentOf.get(at)) if (at === skipped) return true;
      return false;
    };
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

/**
 * The mode a journal says is still OPEN, rebuilt for a resumed run — see `hostRows.ts`.
 *
 * Everything the strip showed is re-read from the rows after the start: how many questions the
 * conversation answered (its `jaira.answered` rows), how far the run had got (the entries of
 * `through`), and — should the target's entry already be there, the process having died between it
 * and the end row — that it has in fact ARRIVED, in which case there is nothing to take up. `left`
 * starts again from nothing: a question left to the person is not a row, and the resumed run asks it
 * again under a request id this process has never offered.
 */
export function restoredFastForward(
  taskId: string,
  start: FastForwardEvent,
  history: readonly EngineEvent[],
  since: readonly EngineEvent[],
): { run: FastForwardRun; arrived: boolean } {
  const run: FastForwardRun = {
    taskId,
    controlTaskId: start.controlTaskId,
    target: start.target,
    targetLabel: start.targetLabel,
    to: start.to,
    path: [...start.path],
    ...(start.under !== undefined ? { instanceId: start.under } : {}),
    through: [...start.through],
    ...(start.inputs !== undefined ? { inputs: start.inputs } : {}),
    step: 0,
    answered: 0,
    left: 0,
    startedAt: start.startedAt,
    seen: new Set(),
  };
  const entry = new Map<string, { parent?: string; key?: string }>();
  for (const event of history) {
    if (event.type === "instance.entered") entry.set(event.instanceId, { ...(event.parentInstanceId !== undefined ? { parent: event.parentInstanceId } : {}), ...(event.childKey !== undefined ? { key: event.childKey } : {}) });
  }
  const pathOf = (id: string): string => {
    const keys: string[] = [];
    const visited = new Set<string>();
    for (let at: string | undefined = id; at !== undefined && !visited.has(at); at = entry.get(at)?.parent) {
      visited.add(at);
      const key = entry.get(at)?.key;
      if (key !== undefined) keys.unshift(key);
    }
    return keys.join("/");
  };
  let arrived = false;
  for (const event of since) {
    const row = event as unknown as { type: string; byTaskId?: string };
    if (row.type === ANSWERED_EVENT && row.byTaskId === start.controlTaskId) run.answered += 1;
    if (arrivedAt(run, event)) arrived = true;
    if (event.type === "instance.entered") noteEntry(run, event, pathOf(event.instanceId));
  }
  return { run, arrived };
}
