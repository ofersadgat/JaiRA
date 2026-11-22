import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TerminalSummary } from "@jaira/shared/browser";
import { terminals, type TerminalCopy } from "@jaira/ui/terminalStore";

/**
 * One terminal as the window holds it (decision 0028), redrawn when it changes and only then — its
 * output a dozen times a second while it runs. Read whole the first time it is looked at, when the
 * engine has it; a call the engine never had, or no longer has, is `undefined`.
 */
export function useTerminal(taskId: string | undefined, callId: string | undefined, project: string | undefined): TerminalCopy | undefined {
  const snapshot = useCallback(() => (taskId === undefined || callId === undefined ? 0 : (terminals.get(taskId, callId)?.version ?? 0)), [taskId, callId]);
  useSyncExternalStore(terminals.subscribe, snapshot, snapshot);
  const copy = taskId === undefined || callId === undefined ? undefined : terminals.get(taskId, callId);
  useEffect(() => {
    if (taskId === undefined || callId === undefined) return;
    terminals.ensureList(taskId, project);
  }, [taskId, callId, project]);
  // Known (from the list or a push) but not yet held in full: read it.
  const behind = copy !== undefined && copy.length < copy.summary.length;
  useEffect(() => {
    if (behind && taskId !== undefined && callId !== undefined) terminals.ensure(taskId, callId, project);
  }, [behind, taskId, callId, project]);
  return copy;
}

/** A task's terminals, oldest first — redrawn when one starts, waits, is typed into or ends. */
export function useTerminals(taskId: string | undefined, project: string | undefined): TerminalSummary[] {
  useSyncExternalStore(terminals.subscribe, terminals.stateVersion, terminals.stateVersion);
  useEffect(() => {
    if (taskId !== undefined) terminals.ensureList(taskId, project);
  }, [taskId, project]);
  return taskId === undefined ? [] : terminals.listOf(taskId);
}

/** The Terminals tab's count: the task's running commands, and how many of them wait for the person. */
export function runningOf(list: readonly TerminalSummary[]): { count: number; waiting: number } {
  const running = list.filter((one) => one.endedAt === undefined);
  return { count: running.length, waiting: running.filter((one) => one.waiting === true).length };
}

/**
 * The processes a tool call other than `shell` started (`TerminalSummary.call`), oldest first — redrawn
 * when one of them starts or ends, not on every other terminal's change.
 */
export function useCallTerminals(taskId: string | undefined, callId: string | undefined, project: string | undefined): TerminalSummary[] {
  const snapshot = useCallback(
    () =>
      taskId === undefined || callId === undefined
        ? ""
        : terminals
            .listOf(taskId)
            .filter((one) => one.call === callId)
            .map((one) => `${one.callId}:${one.endedAt ?? ""}`)
            .join(","),
    [taskId, callId],
  );
  useSyncExternalStore(terminals.subscribe, snapshot, snapshot);
  useEffect(() => {
    if (taskId !== undefined && callId !== undefined) terminals.ensureList(taskId, project);
  }, [taskId, callId, project]);
  return taskId === undefined || callId === undefined ? [] : terminals.listOf(taskId).filter((one) => one.call === callId);
}
