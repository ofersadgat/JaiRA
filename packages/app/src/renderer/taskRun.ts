/**
 * One task's RUN, loaded on its own — for a surface drawing a task that is not the selected one.
 *
 * The store loads exactly one run: the selected task's tree, turns, sessions, records and live tail.
 * Two surfaces need another one beside it and must not borrow the store's — that would file one
 * task's words under another's instance ids:
 *
 *  - an ADOPTED task's history, drawn inside the conversation of the task that adopted it
 *    (`AdoptedHistory`, decision 0005);
 *  - a PINNED side panel whose task is no longer the selection (the person's ruling, 2026-09-24: a
 *    pinned panel is immune to every change of selection and otherwise works normally — its
 *    conversation included).
 *
 * Everything is fetched by the task's OWN id, refreshed on that task's pushes, and the live tail is
 * folded the same way the store folds its own (`liveTurnFold.ts`). What comes back is a surface
 * context: the host's, with every run-shaped field replaced by this run's.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionRef, TaskDetail } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "./fileTypes";
import { alreadyFolded, foldLiveTurn, liveTurnOfSnapshot, tailIsAhead } from "./liveTurnFold";
import { sessionKey } from "./sessionCache";
import { invoke, subscribe } from "./store";
import { useView, useViews } from "./useView";

const NO_HISTORY: SessionRef[] = [];

export interface TaskRun {
  detail: TaskDetail | null;
  /** Why the run could not be read, when it could not. */
  failed: string | null;
  /** The host's context with this run in it. */
  context: FileSurfaceContext;
}

export function useTaskRun(taskId: string, project: string | undefined, host: FileSurfaceContext): TaskRun {
  // The run's views, from the window's store (decision 0018): held while it is shown, read again
  // whenever its records move. Its transcripts are held still while a turn streams — the live tail
  // is drawing that turn — and read as it ends.
  const [liveTurn, setLiveTurn] = useState<FileSurfaceContext["liveTurn"]>(null);
  const streaming = liveTurn !== null;
  const detailHeld = useView("task:detail", { taskId });
  const conversationHeld = useView("task:conversation", { taskId });
  const historyHeld = useView("session:history", { taskId });
  const rowsHeld = useView("run:records", { taskId });
  const [open, setOpen] = useState<string[]>([]);
  const openViews = useViews(
    "session:view",
    useMemo(() => open.map((instanceId) => ({ taskId, instanceId })), [open, taskId]),
    streaming,
  );
  const detail = detailHeld.value ?? null;
  const conversation = conversationHeld.value ?? null;
  const history = historyHeld.value ?? NO_HISTORY;
  const rows = rowsHeld.value;
  const records = useMemo(() => Object.fromEntries((rows ?? []).map((row) => [row.recordId, row])), [rows]);
  const sessions = useMemo(() => {
    const out: FileSurfaceContext["sessions"] = {};
    open.forEach((instanceId, i) => {
      const view = openViews[i]?.value;
      if (view !== undefined) out[instanceId] = view;
    });
    return out;
  }, [open, openViews]);
  const failed = detailHeld.error ?? null;

  // Another task: another run, nothing open in it yet, no tail.
  useEffect(() => {
    setOpen([]);
    setLiveTurn(null);
  }, [taskId]);

  // The live tail: seeded from main, then folded from the pushes about this task (decision 0018 §10's
  // deltas). A settled call ends it, and the transcripts held still while it streamed are read.
  useEffect(() => {
    let mounted = true;
    void invoke("session:live", { taskId, ...(project !== undefined ? { project } : {}) })
      .catch(() => null)
      .then((snap) => mounted && setLiveTurn((current) => (tailIsAhead(current, snap) ? current : liveTurnOfSnapshot(snap))));
    const off = subscribe((message) => {
      if (!("taskId" in message) || message.taskId !== taskId) return;
      if (message.type === "session:turn") {
        setLiveTurn((current) => (alreadyFolded(current, message) ? current : foldLiveTurn(current, message)));
        return;
      }
      const event = message.type === "engine:event" ? (message.event as { type?: string } | undefined) : undefined;
      if (message.type === "run:finished" || event?.type === "operation.completed" || event?.type === "operation.failed") setLiveTurn(null);
    });
    return () => {
      mounted = false;
      off();
    };
  }, [taskId, project]);

  const loadSessions = useCallback((wanted: ReadonlyArray<{ instanceId: string }>) => {
    setOpen((was) => {
      const add = wanted.map((one) => sessionKey(one)).filter((id) => !was.includes(id));
      return add.length === 0 ? was : [...was, ...new Set(add)];
    });
  }, []);

  const context = useMemo<FileSurfaceContext>(
    () => ({
      ...host,
      ...(project !== undefined ? { project } : {}),
      selected: taskId,
      detail,
      conversation,
      sessions,
      onLoadSessions: loadSessions,
      onLoadSession: (instanceId: string) => loadSessions([{ instanceId }]),
      sessionHistory: history,
      records,
      session: null,
      sessionInstance: null,
      liveTurn,
      // The host's walk is about ITS task; this run has none.
      trail: [],
      trailState: null,
    }),
    [host, project, taskId, detail, conversation, sessions, loadSessions, history, records, liveTurn],
  );

  return { detail, failed, context };
}
