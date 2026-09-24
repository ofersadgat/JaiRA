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
import type { ConversationView, OperationRecordView, SessionRef, TaskDetail } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "./fileTypes";
import { alreadyFolded, foldLiveTurn, liveTurnOfSnapshot, tailIsAhead } from "./liveTurnFold";
import { sessionKey } from "./sessionCache";
import { invoke, subscribe } from "./store";

export interface TaskRun {
  detail: TaskDetail | null;
  /** Why the run could not be read, when it could not. */
  failed: string | null;
  /** The host's context with this run in it. */
  context: FileSurfaceContext;
}

export function useTaskRun(taskId: string, project: string | undefined, host: FileSurfaceContext): TaskRun {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [conversation, setConversation] = useState<ConversationView | null>(null);
  const [history, setHistory] = useState<SessionRef[]>([]);
  const [records, setRecords] = useState<Record<string, OperationRecordView>>({});
  const [sessions, setSessions] = useState<FileSurfaceContext["sessions"]>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [liveTurn, setLiveTurn] = useState<FileSurfaceContext["liveTurn"]>(null);

  useEffect(() => {
    let mounted = true;
    const at = project !== undefined ? { project } : {};
    setDetail(null);
    setSessions({});
    const load = async (): Promise<void> => {
      try {
        const [d, c, h, snap] = await Promise.all([
          invoke("task:detail", { taskId, ...at }),
          invoke("task:conversation", { taskId, ...at }),
          invoke("session:history", { taskId, ...at }),
          invoke("session:live", { taskId, ...at }).catch(() => null),
        ]);
        const rows = await invoke("run:records", { taskId, ...at }).catch(() => [] as OperationRecordView[]);
        if (!mounted) return;
        setDetail(d);
        setConversation(c);
        setHistory(h);
        setRecords(Object.fromEntries(rows.map((row) => [row.recordId, row])));
        setLiveTurn((current) => (tailIsAhead(current, snap) ? current : liveTurnOfSnapshot(snap)));
        setFailed(null);
      } catch (e) {
        if (mounted) setFailed((e as Error).message);
      }
    };
    void load();
    const off = subscribe((message) => {
      if (!("taskId" in message) || message.taskId !== taskId) return;
      if (message.type === "session:turn") {
        setLiveTurn((current) => (alreadyFolded(current, message) ? current : foldLiveTurn(current, message)));
        return;
      }
      if (message.type === "engine:event") {
        const event = message.event as { type?: string; instanceId?: string } | undefined;
        if (event?.type === "operation.completed" || event?.type === "operation.failed") {
          // The record landed: the cached transcript of that instance was read while it was open.
          setLiveTurn(null);
          if (typeof event.instanceId === "string") {
            const key = sessionKey({ instanceId: event.instanceId });
            setSessions((prev) => {
              if (prev[key] === undefined) return prev;
              const { [key]: _stale, ...rest } = prev;
              return rest;
            });
          }
        }
        void load();
        return;
      }
      if (message.type === "run:finished") {
        setSessions({});
        void load();
      }
    });
    return () => {
      mounted = false;
      off();
    };
  }, [taskId, project]);

  const loadSessions = useCallback(
    (wanted: ReadonlyArray<{ instanceId: string }>) => {
      void (async () => {
        const missing = wanted.filter((one) => sessions[sessionKey(one)] === undefined);
        if (missing.length === 0) return;
        const loaded = await Promise.all(
          missing.map(async (one) => {
            try {
              return [sessionKey(one), await invoke("session:view", { taskId, instanceId: one.instanceId, ...(project !== undefined ? { project } : {}) })] as const;
            } catch {
              return null;
            }
          }),
        );
        setSessions((prev) => {
          const next = { ...prev };
          for (const entry of loaded) if (entry !== null) next[entry[0]] = entry[1];
          return next;
        });
      })();
    },
    [taskId, project, sessions],
  );

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
