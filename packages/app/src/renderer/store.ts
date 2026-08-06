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
  ApprovalScope,
  BoardView,
  ConfigLayer,
  ConfigView,
  ConversationView,
  ExecutorInfo,
  FileMutationResult,
  FileNode,
  FileSource,
  FileTree,
  HistorySize,
  IpcChannel,
  IpcRequest,
  IpcResponse,
  IpcResponse as Response,
  JairaBridge,
  JairaSettings,
  JairaTheme,
  PendingApproval,
  PendingInteraction,
  ProbeResult,
  PushMessage,
  SecretCapabilities,
  SecretTarget,
  StateView,
  SyncDirection,
  TaskDetail,
  WorkflowMutationResult,
  WorkflowSyncEdit,
  WorkflowSyncResult,
  WorkflowSyncStatus,
  TaskSummary,
  WorkflowLayer,
} from "@jaira/shared/browser";
import { CONFIG_JSON, isTextMime, WORKFLOW_JSON } from "@jaira/shared/browser";
import {
  docKey,
  movedDraft,
  movedDraftsUnder,
  settled,
  withDraft,
  withoutDraftsUnder,
  type Drafts,
} from "./drafts";
import {
  addGenericExecutor,
  applyExecutorPatch,
  removeGenericExecutor,
  type ExecutorPatch,
  type ExecutorTarget,
} from "./executorConfig";
import { applyModelPatch, type ModelPatch } from "./modelsConfig";

/** A prune plan or result, as `history:prune` returns it. */
export type PruneReport = Response<"history:prune">;

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
  /**
   * The board level the Tasks view is showing. `null` is the ROOT LISTING — one column per workflow
   * root — which is a different projection, not a missing level, so it gets its own value rather
   * than being spelled `undefined` and confused with "not loaded yet".
   */
  level: string | null;
  selected: string | null;
  detail: TaskDetail | null;
  pending: PendingInteraction[];
  /** Per-command approvals awaiting a decision (DESIGN §10.2). */
  approvals: PendingApproval[];
  /** Live event lines for the selected task, newest last. */
  stream: string[];
  /** How much history is stored, for the pruning panel. */
  history: HistorySize | null;
  /** The last prune plan (dry run) or applied result — never auto-applied. */
  prune: PruneReport | null;
  error: string | null;
  busy: boolean;

  // --- settings, executors and workflow authoring ---------------------------

  /** User preferences. Loaded before the first paint settles, so the theme applies immediately. */
  settings: JairaSettings;
  /** Both configuration layers plus the merged result; null until first read. */
  config: ConfigView | null;
  /** Every executor this project could use, enabled or not. */
  executors: ExecutorInfo[];
  /** The most recent health check, keyed by executor name. */
  probes: Record<string, ProbeResult>;
  /**
   * What the PROVIDER routes reported, keyed by route prefix.
   *
   * A separate map from `probes` rather than one keyed namespace: an executor and a route are
   * different things that happen to be checkable, and a shared map would collide the moment someone
   * configures a generic CLI called `local`.
   */
  modelProbes: Record<string, ProbeResult>;
  /** Executors currently being checked, so each row can show its own spinner. */
  probing: string[];
  /** What the secret store can do here — decides which "save key to…" options are offered. */
  secrets: SecretCapabilities;
  /**
   * The schema each document has been held to, keyed by `layer:path`.
   *
   * Per file rather than global: a picker that reset on every selection would be re-chosen constantly,
   * and one that remembered a single choice would apply a state schema to the next `.json` you opened.
   * Session-scoped — this is a view preference about a file, not a fact about it, and writing it to
   * disk would mean deciding which layer it belonged to.
   */
  schemaChoice: Record<string, string>;

  /**
   * Unsaved edits, keyed by `layer:path` — see `drafts.ts`.
   *
   * Here rather than inside the editors because a draft has to outlive the component showing it:
   * clicking another file unmounts that editor and switching to Tasks unmounts the entire view, and
   * neither is a decision to discard what someone typed. An entry exists only while it DIFFERS from
   * the file, which is also what lets the tree mark the rows with something pending.
   */
  drafts: Drafts;

  /**
   * Which tab a state file's editor was left on, keyed the same way.
   *
   * Per file for the same reason the schema choice is: one remembered globally would put you on the
   * JSON tab of the next state you opened because of a raw edit made to a different one.
   */
  editorTab: Record<string, "form" | "json">;

  /**
   * Where the open description and the state files stand, and the last proposal.
   *
   * Beside the drafts rather than inside the panel showing it, for the reason every other piece of
   * this view state is: a sync is a model call that takes a while, and a result held by a component
   * would be discarded by clicking anything during the wait. `result` is cleared when another file
   * is opened — a proposal is about one document, and showing it over another would be a lie about
   * which one it read.
   */
  sync: SyncState;

  /**
   * The file open in the middle panel — any file, not just a state.
   *
   * One document rather than one per type, because the panel's two halves must be looking at the
   * same revision of the same thing: a viewer reading one source and an editor writing another is
   * how a preview ends up describing a file that no longer exists.
   */
  doc: FileSource | null;

  // --- the shell ------------------------------------------------------------

  /** Which of the three views the rail has selected. */
  view: View;
  /** Both layer roots as trees — the Files view's left panel. */
  tree: FileTree | null;
  /**
   * The state the open file defines, when it defines one.
   *
   * Kept beside {@link doc} rather than derived from it because plenty of the app still addresses
   * states by id — the board drills into one, the inspector reports drift against one — and null
   * here is the honest answer for a prompt.
   */
  stateId: string | null;
  /** Everything about that state: its board or its tasks, plus the inspector's subject. */
  state: StateView | null;
  /**
   * What the inspector is describing. Clicking a card or a task row makes it the task; clicking the
   * panel header puts it back on the state.
   */
  inspect: "state" | "task";
  /** The selected task's run, read out of the journal — what a leaf state shows. */
  conversation: ConversationView | null;
  /** Which section the Settings view is showing. */
  section: SettingsSection;
  /**
   * Which configuration layer the Settings view is editing.
   *
   * An axis rather than a section, because it crosses two of them: Config and Executors are both
   * per-layer, and listing "This project" and "Shared" as siblings of "Executors" made the layer a
   * place you navigated to for one and a picker you operated for the other — two mechanisms for one
   * question, which is how the two ended up able to disagree.
   */
  configLayer: ConfigLayer;
}

/** The sync surface's state: the last answer, the last proposal, and whether one is in flight. */
export interface SyncState {
  status: WorkflowSyncStatus | null;
  result: WorkflowSyncResult | null;
  running: boolean;
  error: string | null;
}

/**
 * What is left of a sync when another file is opened.
 *
 * The proposal and the status are about ONE document, so both go. `running` does not: a sync in
 * flight is still in flight, and clearing the flag would offer a second Run while the first is
 * still going — which main refuses, so the only thing it would produce is an error.
 */
function clearedSync(sync: SyncState): SyncState {
  return sync.result === null && sync.status === null && sync.error === null
    ? sync
    : { status: null, result: null, running: sync.running, error: null };
}

/** The three destinations on the activity rail. */
export type View = "files" | "tasks" | "settings";

/**
 * Sections of the Settings view — everything that was never one of the two activities.
 *
 * `config` and `executors` are read at the layer {@link AppState.configLayer} names; `history` is a
 * project's run journal and has no layer to pick.
 */
export type SettingsSection = "config" | "executors" | "models" | "history";

const EMPTY: AppState = {
  projectDir: null,
  tasks: [],
  board: null,
  level: null,
  selected: null,
  detail: null,
  pending: [],
  approvals: [],
  stream: [],
  history: null,
  prune: null,
  error: null,
  busy: false,
  // Light until the saved preference says otherwise, matching the stylesheet's own default so the
  // first paint and the loaded setting agree in the common case.
  settings: { theme: "light", wrapJson: false },
  config: null,
  executors: [],
  probes: {},
  modelProbes: {},
  probing: [],
  secrets: { keychain: false },
  schemaChoice: {},
  sync: { status: null, result: null, running: false, error: null },
  drafts: {},
  editorTab: {},
  doc: null,
  view: "tasks",
  tree: null,
  stateId: null,
  state: null,
  inspect: "state",
  conversation: null,
  section: "config",
  configLayer: "project",
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

  /**
   * Fetch one board level. `null` is the root listing, which is a different channel — the roots have
   * no parent state to be the children of, so there is nothing for `board:view` to project.
   *
   * Called with no argument it re-fetches whatever level is current, which is what a push
   * invalidation wants.
   */
  const refreshBoard = useCallback(
    async (level?: string | null) => {
      try {
        const next = level === undefined ? ref.current.level : level;
        const board = next === null ? await invoke("board:roots", undefined) : await invoke("board:view", { level: next });
        patch({ board, level: next });
      } catch (e) {
        fail(e);
      }
    },
    [patch, fail],
  );

  /**
   * The Files tree. Refetched on the same `workflows` invalidation the lint surface uses.
   *
   * Quiet on failure, like the config read: the overwhelmingly common cause is no project being
   * open, and the panel already renders its own empty state for that. An error toast on switching
   * views would be noise reporting a condition the user can see.
   */
  const refreshTree = useCallback(async () => {
    try {
      patch({ tree: await invoke("files:tree", undefined) });
    } catch {
      patch({ tree: null });
    }
  }, [patch]);

  /**
   * The selected state's view.
   *
   * Silent on failure rather than raising a toast: the tree can point at a state whose file the user
   * is mid-edit, and a parse error there is already reported against the file itself.
   */
  const refreshState = useCallback(
    async (stateId: string | null) => {
      if (stateId === null) return patch({ state: null });
      try {
        patch({ state: await invoke("state:view", { stateId }) });
      } catch {
        patch({ state: null });
      }
    },
    [patch],
  );

  /**
   * Read the open file, by path.
   *
   * Loaded alongside its state view rather than behind an "Edit" button: both halves of the panel
   * are on screen at once, so the source has to arrive with the selection.
   *
   * One channel for every file type, including states. `workflow:read` still exists and is still
   * what `openWorkflow` uses when all it has is an id, but the panel holds one document and it comes
   * from here — two ways of loading the same file is how the viewer and the editor end up a revision
   * apart.
   */
  const refreshDoc = useCallback(
    async (layer: WorkflowLayer | null, path: string | null) => {
      if (layer === null || path === null) return patch({ doc: null });
      try {
        const doc = await invoke("file:read", { layer, path });
        // A draft the file has caught up with is no longer an edit — see `settled`. Dropped here,
        // where the document is re-read, rather than at the save site: the same thing is true of a
        // file changed under us, and there is one place that learns about both.
        patch({ doc, drafts: settled(ref.current.drafts, docKey(layer, path), doc.text) });
      } catch {
        patch({ doc: null });
      }
    },
    [patch],
  );

  /**
   * Where a state id lives, as a `(layer, path)` pair.
   *
   * Answered from the tree rather than by deriving `workflows/${id}.json`, because a state may be
   * authored as YAML. Falls back to that derivation, which is the path `workflow:write` would create.
   *
   * `layer` is passed in when the caller already knows which of the two copies it means — a
   * right-clicked tree row does. Without it, the layer is whichever one the search path resolves to,
   * which is what a board column drilling into a child id is asking for.
   */
  const locateState = useCallback(
    async (stateId: string, layer?: WorkflowLayer): Promise<{ layer: WorkflowLayer; path: string } | null> => {
      let at: WorkflowLayer;
      if (layer !== undefined) {
        at = layer;
      } else {
        try {
          at = (await invoke("state:view", { stateId })).layer;
        } catch {
          return null;
        }
      }
      const find = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (node.stateId === stateId && node.layer === at) return node;
          const hit = node.children ? find(node.children) : null;
          if (hit) return hit;
        }
        return null;
      };
      const root = ref.current.tree?.roots.find((r) => r.layer === at);
      const node = root ? find(root.nodes) : null;
      return { layer: at, path: node?.path ?? `workflows/${stateId}.json` };
    },
    [],
  );

  /**
   * Put the selection somewhere that still exists after a path-addressed rename or delete.
   *
   * A directory operation can take the state the middle panel is showing with it — renaming
   * `workflows/feature/` changes the id of everything under it — and a selection left pointing at an
   * id that no longer names anything shows an empty panel with no explanation of what happened.
   */
  const afterFileChange = useCallback(
    async (result: FileMutationResult, moved?: { layer: WorkflowLayer; path: string; to?: string }) => {
      // The drafts for whatever the operation touched, which for a directory is everything inside
      // it. A rename carries them to the new path; a delete is the end of them.
      if (moved !== undefined) {
        patch({
          drafts:
            moved.to === undefined
              ? withoutDraftsUnder(ref.current.drafts, moved.layer, moved.path)
              : movedDraftsUnder(ref.current.drafts, moved.layer, moved.path, moved.to),
        });
      }
      await refreshTree();
      const open = ref.current.stateId;
      if (open !== null && result.states.includes(open)) {
        return patch({ stateId: null, state: null, doc: null, inspect: "state" });
      }
      await refreshState(open);
    },
    [patch, refreshTree, refreshState],
  );

  const refreshConversation = useCallback(
    async (taskId: string | null) => {
      if (taskId === null) return patch({ conversation: null });
      try {
        patch({ conversation: await invoke("task:conversation", { taskId }) });
      } catch {
        patch({ conversation: null });
      }
    },
    [patch],
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

  const refreshApprovals = useCallback(async () => {
    try {
      patch({ approvals: await invoke("approval:pending", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshHistory = useCallback(async () => {
    try {
      patch({ history: await invoke("history:size", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  /**
   * Settings, config, executors and secret capabilities.
   *
   * None of the four needs a project. Settings belong to the person, so the theme applies on an
   * empty window; the other three are answered from the SHARED root when nothing is open —
   * `readConfig` never touches a project, `effectiveConfig` falls back to the base document, and
   * secret capabilities are the machine's keychain. They used to sit behind the no-project return in
   * {@link refreshAll}, which left `config` null and made both settings layers — including Shared,
   * which is always editable — render "open a project to edit its configuration".
   */
  const refreshSettings = useCallback(async () => {
    try {
      patch({ settings: await invoke("settings:read", undefined) });
    } catch (e) {
      fail(e);
    }
  }, [patch, fail]);

  const refreshConfig = useCallback(async () => {
    try {
      const [config, executors, secrets] = await Promise.all([
        invoke("config:read", undefined),
        invoke("executor:list", undefined),
        invoke("secret:capabilities", undefined),
      ]);
      patch({ config, executors, secrets });
    } catch {
      // Nothing here needs a project, so a failure is a real one — but the panes render their own
      // emptiness and an error banner over a settings screen helps nobody.
    }
  }, [patch]);

  const refreshAll = useCallback(async () => {
    const current = await invoke("project:current", undefined).catch(() => null);
    patch({ projectDir: current?.dir ?? null });
    // Before the early return: preferences are the person's, and the shared root is the machine's.
    // Both mean something with no project open, and the Files view and Settings are reachable on an
    // empty window — which is where someone goes to set the shared layer up in the first place.
    await Promise.all([refreshSettings(), refreshTree(), refreshConfig()]);
    if (!current) return;
    await Promise.all([
      refreshTasks(),
      refreshBoard(),
      refreshPending(),
      refreshApprovals(),
      refreshHistory(),
      // Again, now that a project layer exists to lay over the base one.
      refreshConfig(),
      // Again, now that a project supplies a second root to walk.
      refreshTree(),
      refreshDetail(ref.current.selected),
      refreshState(ref.current.stateId),
    ]);
  }, [
    patch,
    refreshTasks,
    refreshBoard,
    refreshPending,
    refreshApprovals,
    refreshHistory,
    refreshSettings,
    refreshConfig,
    refreshTree,
    refreshDetail,
    refreshState,
  ]);

  /**
   * Apply the theme to the document element.
   *
   * Written as a data attribute rather than a class because that is what the stylesheet's
   * `:root[data-theme="dark"]` block selects on, and because it is trivially inspectable in
   * devtools when a colour looks wrong.
   */
  useEffect(() => {
    document.documentElement.dataset["theme"] = state.settings.theme;
  }, [state.settings.theme]);

  // Initial load + push subscription.
  useEffect(() => {
    void refreshAll();
    return bridge().subscribe((message: PushMessage) => {
      switch (message.type) {
        case "store:invalidate":
          if (message.scope === "tasks") {
            void refreshTasks();
            void refreshHistory();
          }
          if (message.scope === "board") {
            void refreshBoard();
            // The Files board is the same projection reached another way, so a card that moved has
            // to move there too.
            void refreshState(ref.current.stateId);
          }
          if (message.scope === "task") {
            void refreshDetail(ref.current.selected);
            if (ref.current.inspect === "task") void refreshConversation(ref.current.selected);
          }
          if (message.scope === "workflows") {
            void refreshTree();
            void refreshState(ref.current.stateId);
          }
          if (message.scope === "config") void refreshConfig();
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
        case "approval:requested":
        case "approval:resolved":
          void refreshApprovals();
          break;
        case "run:finished":
          void refreshTasks();
          void refreshBoard();
          void refreshDetail(ref.current.selected);
          void refreshState(ref.current.stateId);
          if (ref.current.inspect === "task") void refreshConversation(ref.current.selected);
          break;
      }
    });
  }, [
    refreshAll,
    refreshTasks,
    refreshBoard,
    refreshDetail,
    refreshPending,
    refreshApprovals,
    refreshHistory,
    refreshConfig,
    refreshTree,
    refreshState,
    refreshConversation,
  ]);

  const actions = useMemo(
    () => ({
      /**
       * Select a task.
       *
       * Also swaps the inspector onto it, which is the whole contextual-inspector rule: what you
       * clicked is what the right-hand panel describes. The conversation is fetched alongside the
       * detail because a leaf state shows it immediately, and a second round trip would leave a
       * visible gap where the transcript should be.
       */
      select: (taskId: string | null) => {
        patch({ selected: taskId, stream: [], inspect: taskId === null ? "state" : "task" });
        void refreshDetail(taskId);
        void refreshConversation(taskId);
      },
      /** Put the inspector back on the state — what clicking the panel header does. */
      inspectState: () => patch({ inspect: "state" }),
      /**
       * Walk into a level in the Tasks view. `null` returns to the root listing.
       *
       * The breadcrumb is clickable before a project is open, so this needs the same guard
       * {@link setView} does.
       */
      drillTo: (level: string | null) => {
        if (ref.current.projectDir === null) return;
        void refreshBoard(level);
      },
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
      /**
       * Answer a per-command approval. `scope` is why a user is not asked the same
       * question on every tool call (DESIGN §10.2).
       */
      decideApproval: async (requestId: string, decision: "allow" | "deny", scope: ApprovalScope = "once") => {
        try {
          await invoke("approval:submit", { requestId, decision, scope });
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
      /**
       * Preview a prune (SPEC §13). Always a dry run: the panel shows what would
       * go before the user confirms, because deleted history does not come back.
       */
      planPrune: async (olderThanDays: number, keepRunsPerTask: number) => {
        try {
          patch({ prune: await invoke("history:prune", { olderThanDays, keepRunsPerTask }) });
        } catch (e) {
          fail(e);
        }
      },
      applyPrune: async (olderThanDays: number, keepRunsPerTask: number) => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("history:prune", { olderThanDays, keepRunsPerTask, apply: true });
          patch({ prune: result, history: result.remaining, busy: false });
        } catch (e) {
          fail(e);
        }
      },
      dismissPrune: () => patch({ prune: null }),
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
      /**
       * Pick a directory, then open or set up whatever was picked.
       *
       * Two round trips rather than one channel that does both, so the failure has a path in it: a
       * folder chosen for "open" that turns out not to be a project fails with its own name in the
       * message, and the offer to set it up instead is a second click rather than a silent write
       * into a directory somebody only meant to look at.
       */
      chooseProject: async (mode: "open" | "init") => {
        patch({ busy: true, error: null });
        try {
          const picked = await invoke("project:choose", { mode });
          if (picked === null) {
            patch({ busy: false });
            return;
          }
          await invoke(mode === "init" ? "project:init" : "project:open", { dir: picked.dir });
          patch({ busy: false, selected: null, detail: null });
          await refreshAll();
        } catch (e) {
          fail(e);
        }
      },

      // --- appearance -------------------------------------------------------

      /**
       * Switch theme.
       *
       * The new value is applied to local state FIRST and persisted after: the toggle has to feel
       * instant, and a settings file that cannot be written is not a reason to refuse the change
       * for this session.
       */
      setTheme: async (theme: JairaTheme) => {
        patch({ settings: { ...ref.current.settings, theme } });
        try {
          patch({ settings: await invoke("settings:write", { theme }) });
        } catch (e) {
          fail(e);
        }
      },

      // --- the shell --------------------------------------------------------

      /**
       * Switch view, refetching what that view reads.
       *
       * The Files tree is fetched whether or not a project is open — the shared root is
       * machine-global, so there is always something to show. Both refreshers swallow their own
       * failures, which is what stopped switching views from raising "no project is open" as a
       * toast; guarding the call instead would have hidden the shared root as well.
       */
      setView: (view: View) => {
        patch({ view, error: null });
        if (view === "settings") void refreshConfig();
        if (view === "files") void refreshTree();
      },
      setSection: (section: SettingsSection) => {
        patch({ section });
        // Checking a route costs nothing — no request, no process — so the answer is there when the
        // section opens rather than behind a button nobody knows to press. That matters most for the
        // one case this screen exists for: arriving after a run refused for want of a model.
        if (section === "models") void actions.probeModelRoutes();
      },
      setConfigLayer: (configLayer: ConfigLayer) => patch({ configLayer }),

      /**
       * Open a file in the Files tree.
       *
       * The node carries everything the panel needs to decide what to render — its layer, its path,
       * its MIME type, and its state id when it has one — so selection is one call whatever was
       * clicked. Opening a different file drops whatever task the inspector was describing, because
       * that task has nothing to do with the new file.
       */
      selectFile: (node: FileNode) => {
        patch({ stateId: node.stateId ?? null, inspect: "state", doc: null, sync: clearedSync(ref.current.sync) });
        void refreshState(node.stateId ?? null);
        if (isTextMime(node.mime)) return void refreshDoc(node.layer, node.path);
        // A PNG or the database: `file:read` would refuse it, and a refusal here would leave the
        // panel empty with nothing to explain it. Open it as a document with no contents instead —
        // the panel then says which type it cannot edit, which is the answer to why it is blank.
        patch({
          doc: { layer: node.layer, path: node.path, file: node.path, mime: node.mime, text: "", exists: true },
        });
      },

      /**
       * Select a state by id — what walking into a board column does.
       *
       * A column knows a child's id but not which file supplied it, so the pair has to be looked up
       * before the document can be read. Drilling and selecting stay one action: the tree highlights
       * the file this resolves to, so it always says where you are.
       */
      selectState: (stateId: string | null) => {
        patch({ stateId, inspect: "state", doc: null, sync: clearedSync(ref.current.sync) });
        void refreshState(stateId);
        if (stateId === null) return void refreshDoc(null, null);
        void locateState(stateId).then((at) => refreshDoc(at?.layer ?? null, at?.path ?? null));
      },

      /**
       * Open a file by its path, for callers that have one and no tree node.
       *
       * `selectState` cannot serve this: it resolves an id through `state:view`, which fails for a
       * state that does not exist yet — and a state file a sync has just PROPOSED is exactly that.
       * Opening by path shows the file as "not created yet" with the proposal in its editor, which
       * is the correct picture of what saving would do.
       */
      openPath: (layer: WorkflowLayer, path: string) => {
        patch({ inspect: "state", doc: null, sync: clearedSync(ref.current.sync) });
        // One read, not two: the document that arrives is what says whether this path defines a
        // state, and asking twice is how the panel and the inspector end up a revision apart.
        void refreshDoc(layer, path).then(() => {
          const stateId = ref.current.doc?.stateId ?? null;
          patch({ stateId });
          return refreshState(stateId);
        });
      },

      // --- the description and the workflows --------------------------------

      /**
       * Which of the description and the state files has moved since they were last in step.
       *
       * Quiet on failure like the other panel-side reads: this fires when a file is opened, and a
       * project that is not open yet is not something to raise a toast about. A null status is a
       * "checking…" line rather than an error.
       */
      syncStatus: async (layer: WorkflowLayer, path: string) => {
        try {
          patch({ sync: { ...ref.current.sync, status: await invoke("workflow:syncStatus", { layer, path }) } });
        } catch {
          patch({ sync: { ...ref.current.sync, status: null } });
        }
      },

      /**
       * Run a sync, and turn what it proposes into unsaved drafts.
       *
       * The two halves of the promise this feature makes are both here. The document sent is the
       * DRAFT — what the editor is showing, not what the file says — so a sync answers about the
       * description in front of you. And what comes back is written to `drafts`, never to disk: the
       * rewritten description lands in the editor below the panel, proposed state files land against
       * their own rows in the tree, and every one of them is saved, or not, by the person reading it.
       *
       * A proposal identical to the file on disk is recorded as no draft at all — `drafts` holds
       * differences (see `drafts.ts`), and an entry equal to the file would mark a row as edited
       * when nothing about it would change.
       */
      runSync: async (direction: SyncDirection) => {
        const doc = ref.current.doc;
        if (doc === null) return;
        const key = docKey(doc.layer, doc.path);
        const text = ref.current.drafts[key] ?? doc.text;
        patch({ sync: { ...ref.current.sync, running: true, error: null } });
        try {
          const result = await invoke("workflow:sync", {
            layer: doc.layer,
            path: doc.path,
            direction,
            text,
          });
          let drafts = ref.current.drafts;
          if (result.document !== undefined) {
            drafts = withDraft(drafts, key, result.document.text === doc.text ? null : result.document.text);
          }
          for (const edit of result.edits ?? []) {
            if (edit.applicable) drafts = withDraft(drafts, docKey(edit.layer, edit.path), edit.text);
          }
          patch({ drafts, sync: { status: ref.current.sync.status, result, running: false, error: null } });
          // The status moves with the proposal: a sync that found nothing to do has just recorded
          // that the two agree, and the panel should say so without being reopened.
          await actionsRef.current.syncStatus(doc.layer, doc.path);
        } catch (e) {
          patch({ sync: { ...ref.current.sync, running: false, error: (e as Error).message } });
        }
      },

      /** Abort a sync in flight. The proposal it would have produced is simply never delivered. */
      cancelSync: async () => {
        try {
          await invoke("workflow:syncCancel", undefined);
        } catch (e) {
          fail(e);
        }
      },

      /** Open the file one proposed edit would change, so a listed edit is one click from readable. */
      openSyncEdit: (edit: WorkflowSyncEdit) => actionsRef.current.openPath(edit.layer, edit.path),

      // --- configuration ----------------------------------------------------

      /**
       * Replace one configuration layer. Main validates before writing, so a rejected save leaves
       * the file untouched and the message names the offending field.
       */
      saveConfig: async (layer: "base" | "project", config: unknown) => {
        patch({ busy: true, error: null });
        try {
          const next = await invoke("config:write", { layer, config: config as never });
          patch({ config: next, busy: false });
          await refreshConfig();
          // `config.json` is the one editor that does not save through `saveDoc` — it writes a
          // parsed document so main can validate it — so its draft has to be released here. Only
          // when the open file IS that layer's config: the Settings pane calls this too, and it has
          // no business clearing an edit to whatever the Files view happens to have open.
          const open = ref.current.doc;
          if (open !== null && open.mime === CONFIG_JSON && open.layer === layer) {
            patch({ drafts: withDraft(ref.current.drafts, docKey(open.layer, open.path), null) });
          }
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Write `config.models` into a named layer — the default id, the routes, the presets.
       *
       * The same layering rule the executor form follows, for the same reason: patched into that
       * layer's own document, never the merged one, so saving in a project cannot silently copy the
       * shared root's settings out of it.
       */
      saveModels: async (fields: ModelPatch, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = applyModelPatch(layer === "base" ? current.base : current.project, fields);
        await actions.saveConfig(layer, doc);
        await actions.probeModelRoutes();
      },

      /** Health-check the provider routes. Never makes a request — see `model:probe`. */
      probeModelRoutes: async () => {
        try {
          const results = await invoke("model:probe", undefined);
          const modelProbes: Record<string, ProbeResult> = {};
          for (const result of results) modelProbes[result.name] = result;
          patch({ modelProbes });
        } catch (e) {
          fail(e);
        }
      },

      // --- executors --------------------------------------------------------

      /** Health-check one executor, or all of them when `name` is omitted. */
      probeExecutors: async (name?: string) => {
        const targets = name !== undefined ? [name] : ref.current.executors.map((e) => e.name);
        patch({ probing: [...new Set([...ref.current.probing, ...targets])], error: null });
        try {
          const results = await invoke("executor:probe", name !== undefined ? { name } : {});
          const probes = { ...ref.current.probes };
          for (const result of results) probes[result.name] = result;
          patch({ probes, probing: ref.current.probing.filter((n) => !targets.includes(n)) });
        } catch (e) {
          patch({ probing: ref.current.probing.filter((n) => !targets.includes(n)) });
          fail(e);
        }
      },

      /**
       * Write one executor's settings into a named layer.
       *
       * Patched into that layer's raw document rather than the merged one, or saving would copy
       * every inherited base value into the project and freeze it there. A field patched to
       * `undefined` is removed, which is how a project stops overriding the shared root.
       */
      setExecutorConfig: async (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = applyExecutorPatch(layer === "base" ? current.base : current.project, executor, fields);
        await actionsRef.current.saveConfig(layer, doc);
        // The write may have changed the binary or the credential, so what was known about this
        // executor's health no longer describes the executor that is now configured.
        await actionsRef.current.probeExecutors(executor.name);
      },

      /** Turn an executor on or off — the one field every executor shares. */
      setExecutorEnabled: async (name: string, enabled: boolean, layer: ConfigLayer) => {
        const executor = ref.current.executors.find((e) => e.name === name);
        if (executor === undefined) return;
        await actionsRef.current.setExecutorConfig(executor, { enabled }, layer);
      },

      /** Declare a new non-Claude CLI executor in a layer (DESIGN §8.1's `generic-cli`). */
      addExecutor: async (spec: { name: string; command: string }, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        try {
          const doc = addGenericExecutor(layer === "base" ? current.base : current.project, spec);
          await actionsRef.current.saveConfig(layer, doc);
          await actionsRef.current.probeExecutors();
        } catch (e) {
          fail(e);
        }
      },

      /** Delete a configured CLI executor from a layer. Built-ins are turned off, never removed. */
      removeExecutor: async (name: string, layer: ConfigLayer) => {
        const current = ref.current.config;
        if (!current) return;
        const doc = removeGenericExecutor(layer === "base" ? current.base : current.project, name);
        await actionsRef.current.saveConfig(layer, doc);
        await actionsRef.current.probeExecutors();
      },

      /**
       * Store an executor's credential: the NAME into config, the VALUE into the secret store.
       *
       * One action rather than two calls from the pane, because the two halves are one intention and
       * doing them separately gets the order wrong in a way that shows: naming a secret the config
       * did not mention re-probes, and a probe between the two steps reports the key as missing when
       * it is merely a moment from being written.
       *
       * The value goes straight to main and is never held in renderer state; an empty one CLEARS the
       * secret, which is how a key is revoked.
       */
      saveCredential: async (request: {
        executor: ExecutorTarget & { credential?: string | undefined };
        name: string;
        value: string;
        target: SecretTarget;
        layer: ConfigLayer;
      }) => {
        const { executor, name, value, target, layer } = request;
        patch({ busy: true, error: null });
        try {
          await invoke("secret:set", { name, value, target });
          patch({ busy: false });
          if (name !== executor.credential) {
            // A stored key nothing points at would never be looked up, so naming it in the layer
            // being edited is part of saving it — not a second thing to remember.
            await actionsRef.current.setExecutorConfig(executor, { credential: name }, layer);
          } else {
            await actionsRef.current.probeExecutors(executor.name);
          }
        } catch (e) {
          fail(e);
        }
      },

      // --- workflow authoring -----------------------------------------------

      /**
       * Select a state and load its file — what opening one from a menu does.
       *
       * Takes the layer explicitly, unlike {@link selectState}: the caller right-clicked one of the
       * two copies, and resolving the id again would be free to pick the other one.
       */
      openWorkflow: async (stateId: string, layer: WorkflowLayer) => {
        patch({ busy: true, error: null, view: "files", stateId, inspect: "state" });
        try {
          const at = await locateState(stateId, layer);
          await refreshDoc(layer, at?.path ?? `workflows/${stateId}.json`);
          patch({ busy: false });
          await refreshState(stateId);
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Create a state, writing the file immediately.
       *
       * Not "open an editor over a file that does not exist yet": a state you have named and then
       * cannot see in the tree is a state you will name again. The document starts empty and the
       * lint surface says what it still needs, which is the same thing it would say after a Save.
       */
      createWorkflow: async (stateId: string, layer: WorkflowLayer) => {
        patch({ busy: true, error: null, view: "files" });
        try {
          await invoke("workflow:write", { stateId, layer, text: "{}" });
          patch({ busy: false, stateId, inspect: "state" });
          await Promise.all([
            refreshTree(),
            refreshState(stateId),
            refreshDoc(layer, `workflows/${stateId}.json`),
          ]);
        } catch (e) {
          fail(e);
        }
      },

      /** Create a plain file or a directory under a layer root. */
      createFile: async (layer: WorkflowLayer, path: string, kind: "file" | "directory", text?: string) => {
        patch({ busy: true, error: null });
        try {
          await invoke("file:create", { layer, path, kind, ...(text !== undefined ? { text } : {}) });
          patch({ busy: false });
          await refreshTree();
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Rename, duplicate, or copy a state into the other layer.
       *
       * Returns the result rather than swallowing it: a refusal carries the states that reference
       * this one, and the caller is the only thing that can decide whether to ask and retry.
       */
      moveWorkflow: async (request: {
        stateId: string;
        layer: WorkflowLayer;
        to: string;
        toLayer: WorkflowLayer;
        copy?: boolean;
        force?: boolean;
      }): Promise<WorkflowMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          // Where the file is NOW, asked before the move so there is still something to find. A
          // rename leaves nothing at the old path, and a draft stranded there would reappear under
          // whatever is created with that name next.
          const from = request.copy === true ? null : await locateState(request.stateId, request.layer);
          const result = await invoke("workflow:move", request);
          patch({ busy: false });
          if (result.applied) {
            // Follow the file: after a rename the old id names nothing, and leaving the tree
            // pointed at it would show "select a state" for something that just moved.
            await refreshTree();
            const at = await locateState(result.stateId, result.layer);
            // The draft follows it too. Renaming a state is usually part of the same piece of work
            // as editing it, so this is one action, not a reason to lose the other half of it.
            if (from !== null) {
              const to = at === null ? null : docKey(at.layer, at.path);
              patch({ drafts: movedDraft(ref.current.drafts, docKey(from.layer, from.path), to) });
            }
            if (ref.current.stateId === request.stateId || request.copy === true) {
              patch({ stateId: result.stateId, inspect: "state" });
              await Promise.all([refreshState(result.stateId), refreshDoc(at?.layer ?? null, at?.path ?? null)]);
            } else {
              await refreshState(ref.current.stateId);
            }
          }
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /** Delete a state file. Refused while anything references it, unless `force`. */
      deleteWorkflow: async (
        stateId: string,
        layer: WorkflowLayer,
        force?: boolean,
      ): Promise<WorkflowMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const at = await locateState(stateId, layer);
          const result = await invoke("workflow:delete", { stateId, layer, ...(force === true ? { force } : {}) });
          patch({ busy: false });
          if (result.applied) {
            const wasOpen = ref.current.stateId === stateId;
            if (at !== null) patch({ drafts: withoutDraftsUnder(ref.current.drafts, at.layer, at.path) });
            await refreshTree();
            if (wasOpen) {
              patch({ stateId: null, state: null, inspect: "state", doc: null });
            } else {
              await refreshState(ref.current.stateId);
            }
          }
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /**
       * Rename or move a file or directory, addressed by path.
       *
       * Returns the result for the same reason {@link moveWorkflow} does: a refusal names the
       * states that would break, and only the caller can decide whether to ask and retry.
       */
      renameFile: async (
        layer: WorkflowLayer,
        path: string,
        to: string,
        force?: boolean,
      ): Promise<FileMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("file:rename", { layer, path, to, ...(force === true ? { force } : {}) });
          patch({ busy: false });
          if (result.applied) await afterFileChange(result, { layer, path, to });
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /** Delete a file or directory. A directory takes every state inside it. */
      deleteFile: async (layer: WorkflowLayer, path: string, force?: boolean): Promise<FileMutationResult | null> => {
        patch({ busy: true, error: null });
        try {
          const result = await invoke("file:delete", { layer, path, ...(force === true ? { force } : {}) });
          patch({ busy: false });
          if (result.applied) await afterFileChange(result, { layer, path });
          return result;
        } catch (e) {
          fail(e);
          return null;
        }
      },

      /**
       * Check a draft against a schema.
       *
       * Returns null on failure rather than raising a toast: the editor is being typed into, and an
       * error banner over every transiently-bad state would be its own kind of noise. The status
       * chip going quiet is the report.
       */
      validateSchema: async (schemaId: string, text: string) => {
        try {
          return await invoke("schema:validate", { schemaId, text });
        } catch {
          return null;
        }
      },

      /**
       * What a set of states declare as inputs, for the children table's wiring rows.
       *
       * Null on failure, and quietly, for the same reason `validateSchema` is: this is asked while a
       * child's `state` field is being TYPED, so most calls name something that does not exist yet.
       * A toast per keystroke would report the author's own typing back at them.
       */
      stateSlots: async (stateIds: string[]) => {
        if (stateIds.length === 0) return {};
        try {
          return await invoke("state:slots", { stateIds });
        } catch {
          return null;
        }
      },

      /**
       * Turn word wrap on or off in the JSON editor.
       *
       * Written through to `settings.json` like the theme is, so the choice outlives the window. The
       * local patch lands first: waiting for the round-trip would make the toggle feel like it had
       * not registered, and a failed write leaves the setting where the file says it is on next read.
       */
      setWrapJson: async (wrapJson: boolean) => {
        patch({ settings: { ...ref.current.settings, wrapJson } });
        try {
          patch({ settings: await invoke("settings:write", { wrapJson }) });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Remember which schema a document is being held to.
       *
       * `null` is recorded as `""` rather than by deleting the entry, because ABSENT and NONE are
       * now different answers: absent means nobody has decided yet, and that is what lets a file be
       * detected when it opens. Deleting the key would make "plain JSON, I chose that" indis-
       * tinguishable from "not looked at", and the detector would overrule the choice on every
       * re-render.
       */
      setSchemaChoice: (key: string, schemaId: string | null) =>
        patch({ schemaChoice: { ...ref.current.schemaChoice, [key]: schemaId ?? "" } }),

      /**
       * Hold — or forget — one file's unsaved text.
       *
       * `null` is "there is no draft", which is what both Revert and typing the file back to what it
       * says mean. The map holds differences only, so this is also what un-marks the row in the tree.
       */
      setDraft: (key: string, text: string | null) => patch({ drafts: withDraft(ref.current.drafts, key, text) }),

      /** Remember which tab a state file's editor is on, so returning to the file returns to it. */
      setEditorTab: (key: string, tab: "form" | "json") =>
        patch({ editorTab: { ...ref.current.editorTab, [key]: tab } }),

      /**
       * Which schema a document already satisfies, for the picker's initial value.
       *
       * Quiet on failure like the other editor-side calls: this runs as a file opens, and the answer
       * is a suggestion. Failing to guess is not something to interrupt anyone about.
       */
      detectSchema: async (text: string) => {
        try {
          return await invoke("schema:detect", { text });
        } catch {
          return null;
        }
      },

      /** Show a file in the OS file manager. */
      revealFile: async (file: string) => {
        try {
          await invoke("shell:reveal", { file });
        } catch (e) {
          fail(e);
        }
      },

      /**
       * Save the open file, by whichever channel its type requires.
       *
       * The surface that called this does not choose — see `FileSurfaceProps.onSave`. A state file
       * goes through `workflow:write`, which parses it and re-lints the browser; everything else
       * goes through `file:write`, which does not, because a half-written markdown prompt must be
       * saveable and a half-written state file must not break every workflow in the layer.
       */
      saveDoc: async (text: string) => {
        const doc = ref.current.doc;
        if (doc === null) return;
        patch({ busy: true, error: null });
        try {
          if (doc.stateId !== undefined && doc.mime === WORKFLOW_JSON) {
            await invoke("workflow:write", { stateId: doc.stateId, layer: doc.layer, text });
          } else {
            await invoke("file:write", { layer: doc.layer, path: doc.path, text });
          }
          patch({ busy: false });
          await Promise.all([
            refreshTree(),
            refreshState(doc.stateId ?? null),
            refreshDoc(doc.layer, doc.path),
          ]);
          // After the re-read, not before it: the draft is what the editor is showing, and clearing
          // it while the old contents were still in `doc` would flash the pre-save text on screen.
          // `refreshDoc` usually drops it already — this covers a write that came back normalised,
          // where the file no longer matches the draft byte for byte but the save did happen.
          patch({ drafts: withDraft(ref.current.drafts, docKey(doc.layer, doc.path), null) });
        } catch (e) {
          fail(e);
        }
      },
    }),
    [
      patch,
      fail,
      refreshAll,
      refreshTasks,
      refreshBoard,
      refreshDetail,
      refreshConfig,
      refreshTree,
      refreshState,
      refreshDoc,
      locateState,
      refreshConversation,
      afterFileChange,
    ],
  );

  // Actions that call sibling actions read them through here, so the memo above does not have to
  // depend on itself.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  return { state, actions };
}
