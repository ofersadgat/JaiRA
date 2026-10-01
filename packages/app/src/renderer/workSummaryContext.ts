/**
 * What the work summary reads besides its entries: the three settings, the read-only judge, the
 * approval its host can answer, and a clock — the providers `WorkSummary`
 * (`packages/universal/src/components/panel/WorkSummary.tsx`) stands under.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { PendingApproval, WorkNotes, WorkRows } from "@jaira/shared/browser";
import type { ApprovalSurfaceProps } from "./approvalSurfaceTypes";
import type { ToolEntry, WorkEntry } from "./transcript";
import { isApprovalCall, verdictKeyOf, type ReadOnlyVerdicts } from "./workSummary";

/** The three settings, as the transcript reads them. */
export interface WorkLook {
  phases: boolean;
  rows: WorkRows;
  thinking: boolean;
  /** Rate limits and system notes — see `WorkNotes`. */
  notes: WorkNotes;
}
export const DEFAULT_WORK_LOOK: WorkLook = { phases: true, rows: 3, thinking: true, notes: "hide-groups" };
/** Provided by the shell from `appearance.conversation`; the default wherever nothing provides it. */
export const WorkLookContext = createContext<WorkLook>(DEFAULT_WORK_LOOK);

/**
 * Where a phase's name learns which calls CHANGED something: the project's read-only permission set,
 * asked once per distinct call and remembered (`permissionSets:judgeReadOnly`, {@link isChange}).
 * Provided by the shell for the project it stands on, the Appearance preview's sample calls included;
 * where nothing provides it (a test's markup), a call that edits is a change and nothing else is.
 */
export interface ReadOnlyJudge {
  /** Answers, by {@link verdictKeyOf} — for the permission set as it was when they were asked. */
  known: Map<string, boolean | null>;
  asking: Set<string>;
  /** Asked, and the asking failed: not asked again until the set changes. */
  failed: Set<string>;
  /** Moves each time the set changes, so an answer asked of the old one is not kept. */
  generation: number;
  heard: Set<() => void>;
  ask: (calls: Array<{ id: string; name: string; args: unknown }>) => Promise<Record<string, boolean | null>>;
}
export function readOnlyJudgeOf(ask: ReadOnlyJudge["ask"]): ReadOnlyJudge {
  return { known: new Map(), asking: new Set(), failed: new Set(), generation: 0, heard: new Set(), ask };
}
/**
 * The permission sets changed: every answer is asked again. Remembered only so the conversation does
 * not ask main about every call on every streaming update — each answer reads the set's layered files
 * from disk — and never past a change to what it answered.
 */
export function forgetReadOnly(judge: ReadOnlyJudge): void {
  judge.generation++;
  judge.known.clear();
  judge.asking.clear();
  judge.failed.clear();
  for (const hear of judge.heard) hear();
}
export const ReadOnlyJudgeContext = createContext<ReadOnlyJudge | undefined>(undefined);

/**
 * The approval a conversation's agent is waiting on, and how to answer it — provided by the host that
 * can answer (the chat, a run's conversation). The approval is a step of the work, `approve_tool_call`
 * called by the call that needs permission, so its prompt is drawn where that step is: in the latest
 * row the summary shows, or — when the summary shows no rows, or not that one — under the summary.
 */
export interface ApprovalAsk {
  pending: PendingApproval;
  onDecide: ApprovalSurfaceProps["onDecide"];
}
export const ApprovalAskContext = createContext<ApprovalAsk | undefined>(undefined);

/** What the read-only set says of each call in `entries`, asking for the ones it has not been asked about; and a count that moves when an answer lands. */
export function useReadOnlyVerdicts(entries: readonly WorkEntry[]): { verdicts: ReadOnlyVerdicts | undefined; heard: number } {
  const judge = useContext(ReadOnlyJudgeContext);
  const [heard, setHeard] = useState(0);
  useEffect(() => {
    if (judge === undefined) return;
    const hear = (): void => setHeard((n) => n + 1);
    judge.heard.add(hear);
    return () => void judge.heard.delete(hear);
  }, [judge]);
  useEffect(() => {
    if (judge === undefined) return;
    const wanted = new Map<string, ToolEntry>();
    for (const entry of entries) {
      // The approval prompt is no call a permission set holds: it is the person being asked.
      if (entry.kind !== "tool" || isApprovalCall(entry)) continue;
      const key = verdictKeyOf(entry);
      if (!judge.known.has(key) && !judge.asking.has(key) && !judge.failed.has(key)) wanted.set(key, entry);
    }
    if (wanted.size === 0) return;
    const generation = judge.generation;
    for (const key of wanted.keys()) judge.asking.add(key);
    void judge
      .ask([...wanted].map(([id, entry]) => ({ id, name: entry.name, args: entry.args ?? null })))
      .then(
        (said) => {
          if (judge.generation !== generation) return;
          for (const [key, verdict] of Object.entries(said)) judge.known.set(key, verdict);
        },
        () => {
          if (judge.generation === generation) for (const key of wanted.keys()) judge.failed.add(key);
        },
      )
      .finally(() => {
        if (judge.generation !== generation) return;
        for (const key of wanted.keys()) judge.asking.delete(key);
        for (const hear of judge.heard) hear();
      });
    // `heard`: after the set changes, what was answered is asked again.
  }, [entries, judge, heard]);
  const verdicts = useMemo<ReadOnlyVerdicts | undefined>(() => (judge === undefined ? undefined : (entry) => judge.known.get(verdictKeyOf(entry))), [judge]);
  return { verdicts, heard };
}

/** A clock that moves once a second while something is running, and not otherwise. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

