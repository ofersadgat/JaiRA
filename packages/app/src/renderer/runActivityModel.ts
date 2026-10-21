/**
 * What the activity strip under a conversation SAYS (`RunActivity`,
 * `packages/universal/src/components/panel/RunActivity.tsx`) and the clock it counts with. Pure but for
 * {@link useElapsed}, a React hook with no DOM in it.
 */
import { useEffect, useState } from "react";
import type { TaskDetail } from "@jaira/shared/browser";
import { STOPPED, stoppedAction } from "./taskAction";
import { nodeAt } from "./trail";

/** `09:14:02`. Seconds included: the gap between two calls is the thing being read. */
export function clockOf(at: number | undefined): string {
  return at === undefined || at === 0 ? "" : new Date(at).toLocaleTimeString();
}

/** `2.4 s`, `1 m 12 s`, `14 h 32 m` — past an hour the seconds are noise, and 872 minutes is a sum to do. */
export function durationOf(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds / 60) % 60} m`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

/**
 * How often a live counter ticks, by default. A thinking block is a pause you are WAITING OUT, counted
 * in tenths so the digits prove something is alive.
 */
const TICK_MS = 100;

/**
 * `tick` is a parameter because the two things that count here are counting different quantities.
 * A thinking block is a pause you are WAITING OUT, measured in tenths so the digits prove something
 * is alive. A run has been going for four minutes and nobody is watching the seconds — a tenth there
 * is forty re-renders a second spent on a number whose last digit nobody reads.
 */
export function useElapsed(startedAt: number | undefined, live: boolean, tick = TICK_MS): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tick);
    return () => clearInterval(timer);
  }, [live, startedAt, tick]);
  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

/** Which strip `RunActivity` draws, and what it names. */
export type Activity =
  | { kind: "forward" }
  | { kind: "stopping"; where: string }
  | { kind: "listening"; listening: readonly string[] }
  | { kind: "going"; waiting: boolean; where: string }
  | { kind: "stopped"; where: string; tone: string; said: string; resuming: boolean; verb: string; hint: string }
  | { kind: "none" };

/**
 * The strip's reading of a task — `RunActivity` draws each case. `where` is the whole active path
 * (`plan → critique → human_review`), empty when there is none; `going` tells the caller to count, from
 * {@link startedAtOf}.
 */
export function activityOf(
  detail: TaskDetail,
  asking: boolean,
  can: { rerun: boolean; resume: boolean },
  /**
   * The instance whose agent is asking, when the app closed under its run: the run has no active path
   * any more, and this is where it is waiting — what the strip names, as it did before the close.
   */
  askedIn?: string,
): Activity {
  if (detail.fastForward !== undefined) return { kind: "forward" };
  const deepest = detail.activePath[detail.activePath.length - 1];
  const node = deepest === undefined ? undefined : nodeAt(detail.instances, deepest.instanceId);
  const waiting = node?.status === "waiting_for_user" || asking;
  const going = detail.status === "running" || waiting;
  const asked = detail.activePath.length === 0 && asking && askedIn !== undefined ? nodeAt(detail.instances, askedIn) : undefined;
  const where =
    asked !== undefined
      ? (asked.stateId.split("/").pop() ?? asked.stateId)
      : detail.activePath.map((step) => step.childKey ?? step.stateId.split("/").pop() ?? step.stateId).join(" → ");
  if (detail.status === "stopping") return { kind: "stopping", where };
  const listening = !waiting && detail.status === "running" && (detail.listening?.length ?? 0) > 0 && node?.operation?.status !== "running" && node?.status !== "waiting_for_user";
  if (listening) return { kind: "listening", listening: detail.listening! };
  if (going) return { kind: "going", waiting, where };
  const stopped = stoppedAction(detail);
  if (stopped === undefined || !can.rerun) return { kind: "none" };
  const resuming = stopped.act === "resume" && can.resume;
  const fallback = STOPPED[detail.status]!;
  return { kind: "stopped", where, tone: stopped.tone, said: stopped.said, resuming, verb: resuming ? stopped.verb : fallback.verb, hint: resuming ? stopped.hint : fallback.hint };
}

/**
 * When the running run started — what the strip's counter counts from. A run the app closed under while
 * it waited on the person (`asking`) still counts from its own start, as it did before the close.
 */
export function startedAtOf(detail: TaskDetail, asking = false): number | undefined {
  const running = detail.runs.find((run) => run.outcome === "running")?.startedAt;
  if (running !== undefined || !asking || detail.runs.length === 0) return running;
  return Math.max(...detail.runs.map((run) => run.startedAt));
}
