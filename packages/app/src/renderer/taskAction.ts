/**
 * What the button on a task DOES, and what it is called — the one answer, for every surface.
 *
 * Its own module because three of them ask: the strip under a run, the header beside the title, and
 * the click handler that has to perform whatever the words promised. They used to decide separately,
 * and the two that decided from the STATUS alone could not tell a crash that journaled nothing from
 * one that journaled a whole run — so the button offered a copy where a plain start was both legal
 * and what the person meant. The distinction is the main process's to make and arrives on
 * {@link ResumePlan}; this reads it, and nothing else in the renderer re-derives it.
 */
import type { ResumePlan, TaskDetail } from "@jaira/shared/browser";

/**
 * What each way of stopping is called, and what starting it again actually does.
 *
 * The verbs are different because the ACTS are different, and the engine is what decides which:
 * `isStartableStatus` lets an interrupted, failed or STOPPED task begin again in place, against the
 * snapshot its first run pinned; a task that finished, or one that has been spoken to, is copied into
 * a fresh one instead (see `service.rerunTask`). One button either way, but it must not claim to
 * resume when what it will do is start over, and it must not claim to be the same task when what
 * comes back is a new one.
 *
 * "Run again" is therefore reserved for the case it is TRUE of: a task with no usable record, which
 * genuinely starts from the top. A stop leaves a record, so it gets Resume or Retry below.
 *
 * These are the FALLBACK verbs — what a stop is called when resuming is not on offer. A task whose
 * record can still be replayed gets {@link RESUMABLE} instead, which is the whole reason this table
 * no longer has the last word.
 */
export const STOPPED: Partial<Record<TaskDetail["status"], { said: string; verb: string; hint: string; tone: string }>> = {
  failed: {
    said: "Failed",
    verb: "Try again",
    hint: "Runs the workflow again from the top, against the snapshot this task pinned",
    tone: "bad",
  },
  interrupted: {
    said: "Interrupted",
    verb: "Start again",
    hint: "Runs the workflow again from the top, against the snapshot this task pinned",
    tone: "warn",
  },
  canceled: {
    said: "Stopped",
    verb: "Start again",
    hint: "Runs the workflow again from the top, against the snapshot this task pinned",
    tone: "warn",
  },
  queued: { said: "Not started", verb: "Start", hint: "Runs the workflow", tone: "idle" },
};

/**
 * The two verbs a task with a readable record gets instead — and why there are two.
 *
 * Both do the SAME thing to the engine: start at the root of the pinned snapshot with the task's
 * replay index, so every operation an earlier run completed is taken from the record rather than
 * dispatched, and the first real call is wherever the answers stop. What differs is the fact each
 * one is reporting, and that difference is not a preference — it is how the run ended.
 *
 *  - **Resume** — there is a frontier: somewhere the run was in the middle of, which is what it will
 *    pick up. Two ways to get one, and they are the same fact about the task — a crash that left
 *    instances live, and a STOP, which unwinds and terminates them but is still an interruption
 *    rather than a verdict (`replay.ts`'s `stoppedInside`).
 *  - **Retry** — a state FAILED and the run ended with it, so there is no frontier at all. What the
 *    same walk does here is replay everything that worked and re-run the state that broke, which is
 *    a retry of that state with its history intact. Its conversation position was claimed by the
 *    failed attempt, so re-entering forks automatically (SESSIONS.md §4) rather than stacking a
 *    second answer on top of the first.
 *
 * The fork belongs to Retry alone, and that is why the split has to be right rather than nearly
 * right. A stop used to land here — every stopped run reported an empty frontier, because the abort
 * had tidied the tree away — so a task paused on a human gate offered "Retry" and the story that
 * goes with it, about a state that had done nothing but ask a question. A gate places no call, so
 * it claims no position and there is nothing there to fork.
 *
 * Calling both "Resume" would say "picks up where it left off" about a run that left off nowhere;
 * calling both "Retry" would say "runs it again" about a run that is being continued. Neither is a
 * word this strip can afford to get wrong, which is the same standard the table above is held to.
 */
const RESUMABLE: Record<"continue" | "retry", { verb: string; hint: (kept: number, where: string) => string }> = {
  continue: {
    verb: "Resume",
    hint: (kept, where) =>
      `Picks up in ${where} — keeps the ${kept} operation${kept === 1 ? "" : "s"} this task already finished and runs nothing again`,
  },
  retry: {
    verb: "Retry",
    hint: (kept) =>
      `Re-runs the state that failed — keeps the ${kept} operation${kept === 1 ? "" : "s"} before it and runs none of them again`,
  },
};

/**
 * WHICH ACT the primary button performs for a task — resume it, start it, or copy it.
 *
 * One answer, read by every surface that offers the button: the strip below a run, and the header
 * beside the title. They used to decide separately, and the header decided from the STATUS alone —
 * which is not enough to tell the two kinds of not-queued apart. A task that crashed before the
 * engine journaled anything is `interrupted` with nothing recorded: the lifecycle deliberately lets
 * that one start in place, and a header reading only the status offered a copy instead, leaving the
 * empty original behind forever.
 *
 * The distinction is not the renderer's to make. `ResumePlan.kind` is the main process's answer,
 * taken from the same journal probe `beginTaskRun` refuses on, so a button can no longer promise
 * something the lifecycle then refuses. Absent a plan — a surface that did not ask, a task that
 * cannot start — the answer is the conservative one: copy, which is legal for any task at all.
 */
export function primaryAct(detail: Pick<TaskDetail, "resume">): "resume" | "start" | "rerun" {
  switch (detail.resume?.kind) {
    case "continue":
    case "retry":
      return "resume";
    case "fresh":
      return "start";
    default:
      return "rerun";
  }
}

/** What the strip offers for a stopped task: the resume verb where there is one, else the fallback. */
export function stoppedAction(
  detail: Pick<TaskDetail, "status" | "resume">,
): { said: string; verb: string; hint: string; tone: string; act: "resume" | "start" | "rerun" } | undefined {
  const stopped = STOPPED[detail.status];
  if (stopped === undefined) return undefined;
  const plan = detail.resume;
  const act = primaryAct(detail);
  if (act !== "resume") {
    // A record with a hole in it says so on the button that is still offered, rather than leaving a
    // person to wonder why the one they expected is missing.
    const blocked = plan?.blocked;
    return {
      ...stopped,
      ...(blocked !== undefined ? { hint: `${stopped.hint} — resuming is unavailable: ${blocked}` } : {}),
      act,
    };
  }
  const shape = RESUMABLE[plan!.kind as "continue" | "retry"];
  const where = plan!.frontier.map((entry) => entry.stateId.split("/").pop() ?? entry.stateId).join(", ");
  return {
    said: stopped.said,
    verb: shape.verb,
    hint: shape.hint(plan!.replayed, where.length > 0 ? where : "this run"),
    tone: stopped.tone,
    act,
  };
}
