/**
 * Renderer store (DESIGN §11.2): the board is a *subscription*, not a poll.
 *
 * Pushes from main say what changed (`store:invalidate`, `engine:event`); this
 * store refetches the affected view. It deliberately derives nothing about engine
 * semantics — statuses, columns and active paths all arrive pre-projected, which
 * is what keeps the UI from disagreeing with the engine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BoardView,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  JairaBridge,
  PendingInteraction,
  PushMessage,
  TaskDetail,
  TaskSummary,
} from "@jaira/shared/browser";

declare global {
  interface Window {
    jaira?: JairaBridge;
  }
}

function bridge(): JairaBridge {
  const api = window.jaira;
  if (!api) throw new Error("the JaiRA bridge is unavailable (preload did not run)");
  return api;
}

export async function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  return bridge().invoke(channel, request);
}

export interface AppState {
  projectDir: string | null;
  tasks: TaskSummary[];
  board: BoardView | null;
  level: string | undefined;
  selected: string | null;
  detail: TaskDetail | null;
  pending: PendingInteraction[];
  /** Live event lines for the selected task, newest last. */
  stream: string[];
  error: string | null;
  busy: boolean;
}

const EMPTY: AppState = {
  projectDir: null,
  tasks: [],
  board: null,
  level: undefined,
  selected: null,
  detail: null,
  pending: [],
  stream: [],
  error: null,
  busy: false,
};

/** Keep the live log bounded — a long run would otherwise grow without limit. */
const STREAM_LIMIT = 300;

export function useApp() {
  const [state, setState] = useState<AppState>(EMPTY);
  const patch = useCallback((next: Partial<AppState>) => setState((s) => ({ ...s, ...next })), []);
  // Read in callbacks without making them depend on every render.
  const ref = useRef(state);
  ref.current = state;

  const fail = useCallback((e: unknown) => patch({ error: (e as Error).message, busy: false }), [patch]);

  const refreshTasks = useCallback(async () => {
    try {
      patch({ tasks: await invoke("task:list", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshBoard = useCallback(
    async (level?: string) => {
      try {
        const next = level ?? ref.current.level;
        patch({ board: await invoke("board:view", next !== undefined ? { level: next } : {}), level: next });
      } catch (e) {
        fail(e);
      }
    },
    [patch, fail],
  );

  const refreshDetail = useCallback(
    async (taskId: string | null) => {
      if (!taskId) return patch({ detail: null });
      try {
        patch({ detail: await invoke("task:detail", { taskId }) });
      } catch (e) {
        fail(e);
      }
    },
    [patch, fail],
  );

  const refreshPending = useCallback(async () => {
    try {
      patch({ pending: await invoke("interaction:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshAll = useCallback(async () => {
    const current = await invoke("project:current", undefined).catch(() => null);
    patch({ projectDir: current?.dir ?? null });
    if (!current) return;
    await Promise.all([refreshTasks(), refreshBoard(), refreshPending(), refreshDetail(ref.current.selected)]);
  }, [patch, refreshTasks, refreshBoard, refreshPending, refreshDetail]);

  // Initial load + push subscription.
  useEffect(() => {
    void refreshAll();
    return bridge().subscribe((message: PushMessage) => {
      switch (message.type) {
        case "store:invalidate":
          if (message.scope === "tasks") void refreshTasks();
          if (message.scope === "board") void refreshBoard();
          if (message.scope === "task") void refreshDetail(ref.current.selected);
          break;
        case "engine:event": {
          if (message.taskId !== ref.current.selected) return;
          const event = message.event as { type?: string; stateId?: string; to?: string; outcome?: string };
          const detail = [event.stateId, event.to ?? event.outcome].filter(Boolean).join(" → ");
          setState((s) => ({
            ...s,
            stream: [...s.stream, `${event.type ?? "event"}  ${detail}`].slice(-STREAM_LIMIT),
          }));
          break;
        }
        case "interaction:requested":
        case "interaction:resolved":
          void refreshPending();
          break;
        case "run:finished":
          void refreshTasks();
          void refreshBoard();
          void refreshDetail(ref.current.selected);
          break;
      }
    });
  }, [refreshAll, refreshTasks, refreshBoard, refreshDetail, refreshPending]);

  const actions = useMemo(
    () => ({
      select: (taskId: string | null) => {
        patch({ selected: taskId, stream: [] });
        void refreshDetail(taskId);
      },
      drillTo: (level?: string) => void refreshBoard(level),
      dismissError: () => patch({ error: null }),
      createTask: async (title: string, workflow: string, issue: string) => {
        patch({ busy: true, error: null });
        try {
          const summary = await invoke("task:create", {
            title,
            workflow,
            ...(issue ? { inputs: { issue } } : {}),
          });
          patch({ busy: false, selected: summary.taskId });
          await Promise.all([refreshTasks(), refreshBoard(), refreshDetail(summary.taskId)]);
        } catch (e) {
          fail(e);
        }
      },
      startTask: async (taskId: string, fake?: unknown) => {
        patch({ busy: true, error: null, stream: [] });
        try {
          await invoke("task:start", { taskId, ...(fake !== undefined ? { fake: fake as never } : {}) });
          patch({ busy: false });
        } catch (e) {
          fail(e);
        }
      },
      cancelTask: async (taskId: string) => {
        try {
          await invoke("task:cancel", { taskId });
        } catch (e) {
          fail(e);
        }
      },
      answer: async (requestId: string, value: unknown) => {
        try {
          await invoke("interaction:submit", { requestId, value: value as never });
        } catch (e) {
          fail(e);
        }
      },
      openProject: async (dir: string) => {
        patch({ busy: true, error: null });
        try {
          await invoke("project:open", { dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },
    }),
    [patch, fail, refreshAll, refreshTasks, refreshBoard, refreshDetail],
  );

  return { state, actions };
}
