/**
 * The side panel's HOST logic — which stack each room shows, what the room's rule puts at its root, and
 * how wide the column is — moved out of `App.tsx` unchanged so the universal shell (decision 0015,
 * `packages/universal/src/app/PanelColumn.tsx`) runs the same panel from the same store rather than a
 * copy of it. The DOM frame and the universal one both call these; nothing here touches the DOM.
 *
 * The stack's own rules are `panelStack.ts`; this is the part that was `App.tsx`'s: one stack per room,
 * the window's pinned stack over them, and the reconciling of a room's stack with its rule.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { InstanceNode, JairaUiState, PendingInteraction, TaskDetail, WorkflowLayer } from "@jaira/shared/browser";
import type { ComponentServices } from "./changesetReviewModel";
import { EMPTY_STACK, push, reconcile, routeChange, shownStack, widthKeyOf, type PanelEntry, type PanelStack } from "./panelStack";
import type { AppState, View } from "./store";
import { primaryAct } from "./taskAction";
import { nodeAt, type TrailStep } from "./trail";
import { FOLD, PANE, PANE_WIDE, PANEL_MIN, PANEL_RAIL, openOf, paneOf } from "./uiState";
import { projectName } from "./projects";
import { initialRunValues, runValuesOf, settledMarkOf, type RunValues } from "./runForm";
import type { RunSurface } from "./runPanel";
import type { RerunSurface } from "./panelViews";
import { pathOf } from "./panelViewsModel";
import type { JsonValue } from "@declarative-ai/json";

/** The rooms that have a side panel, and the fold each remembers — see `uiState.ts`'s `FOLD`. */
export type PanelRoom = "files" | "tasks" | "chat" | "debug";
export const PANEL_FOLD: Record<PanelRoom, string> = {
  files: FOLD.panelFiles,
  tasks: FOLD.panelTasks,
  chat: FOLD.panelChat,
  debug: FOLD.panelDebug,
};
export const EMPTY_STACKS: Record<PanelRoom, PanelStack> = { files: EMPTY_STACK, tasks: EMPTY_STACK, chat: EMPTY_STACK, debug: EMPTY_STACK };

/** The room a view is, when it has a side panel. */
export function roomOf(view: View): PanelRoom | null {
  return view === "files" || view === "tasks" || view === "chat" || view === "debug" ? view : null;
}

/**
 * The side panel's stack, one per room (the panel rulings, 2026-09-24; `panelStack.ts`).
 *
 * Shell state rather than store state, and not remembered across restarts: what the column is
 * showing is decided by what the room stands on, and what was pushed on top of that is a gesture
 * about the next few minutes. What IS remembered — widths per kind, the fold per room — is in `ui`.
 * Per room, so going to Settings and back finds each panel where it was left.
 *
 * With it, the PINNED stack — one for the whole window, not one per room (the person's ruling,
 * 2026-09-24: "a pinned context panel should be immune from any stack switches"). While it is set it is
 * the panel in every room that has one; each room keeps reconciling its own stack underneath, and a
 * room standing on something else offers it on the offer bar. Pushes, pops and tabs work on it as on
 * any stack. Unpinning — or taking the offer, or closing — hands the column back to the room.
 */
export function usePanelStacks(room: PanelRoom | null) {
  const [stacks, setStacks] = useState<Record<PanelRoom, PanelStack>>(EMPTY_STACKS);
  const roomRef = useRef(room);
  roomRef.current = room;
  const [pinnedStack, setPinnedStack] = useState<PanelStack | null>(null);
  /** The offer the person waved away, so it is not offered again until the room moves on. */
  const [dismissedOffer, setDismissedOffer] = useState<string | null>(null);
  const stacksRef = useRef(stacks);
  stacksRef.current = stacks;
  const pinnedRef = useRef<PanelStack | null>(null);
  /** The stack the frame is drawing — the pinned one with its offer, or the room's. See below. */
  const shownRef = useRef<PanelStack>(EMPTY_STACK);
  const onStack = useCallback((next: (stack: PanelStack) => PanelStack): void => {
    const at = roomRef.current;
    const shown = pinnedRef.current !== null ? shownRef.current : at === null ? EMPTY_STACK : stacksRef.current[at];
    if (pinnedRef.current === null && at === null) return;
    // See `routeChange`: whose stack a change lands on, pinned or not.
    const routed = routeChange(pinnedRef.current, shown, next(shown));
    if (routed.pinned !== pinnedRef.current) setPinnedStack(routed.pinned);
    if (routed.dismissed !== undefined) setDismissedOffer(routed.dismissed);
    if (routed.room !== undefined && at !== null) setStacks((was) => ({ ...was, [at]: routed.room! }));
  }, []);
  const roomStack = room === null ? EMPTY_STACK : stacks[room];
  const panelStack: PanelStack = room === null ? EMPTY_STACK : shownStack(pinnedStack, roomStack, dismissedOffer);
  pinnedRef.current = pinnedStack;
  shownRef.current = panelStack;
  return { stacks, setStacks, pinnedStack, onStack, roomRef, panelStack };
}

/**
 * The room's stack brought into line with its rule, whenever the rule changes — and a question
 * arriving takes the task's panel to its conversation: the one time the panel moves the reader by
 * itself, because the alternative is a task that stopped for no visible reason.
 */
export function useRoomRule(
  room: PanelRoom | null,
  rule: PanelEntry | null,
  askingId: string | undefined,
  setStacks: (next: (was: Record<PanelRoom, PanelStack>) => Record<PanelRoom, PanelStack>) => void,
): void {
  const ruleSig = rule === null ? "" : JSON.stringify(rule);
  useEffect(() => {
    if (room === null) return;
    setStacks((was) => {
      const next = reconcile(was[room], rule);
      return next === was[room] ? was : { ...was, [room]: next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, ruleSig]);
  useEffect(() => {
    if (askingId === undefined || room !== "tasks" || rule?.kind !== "task") return;
    setStacks((was) => ({ ...was, tasks: reconcile(was.tasks, rule, { tab: "conversation" }) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askingId]);
}

/**
 * Whether the main view is showing the selected task's CONVERSATION — the one fact that decides
 * whether the panel beside it may show that conversation too. It may not (the person's ruling,
 * 2026-09-24): the same conversation is never on screen twice, so the panel shows its CONTEXT.
 *
 * A walked-into run shows its conversation when the toggle says so, when the tail is a subagent's,
 * or when there is no board to show instead — a run that declared no children and entered none is
 * read as what it said whatever the toggle says (`RunView`).
 */
export function conversationInMainOf(state: Pick<AppState, "view" | "trail" | "trailState" | "state" | "detail">, runMode: "board" | "conversation"): boolean {
  const { view, detail } = state;
  const trailTail = state.trail.at(-1);
  const trailNode = trailTail === undefined || detail === null ? undefined : nodeAt(detail.instances, trailTail.instanceId);
  const trailHasBoard = (state.trailState?.children.length ?? state.state?.children.length ?? 0) > 0 || (trailNode?.children.length ?? 0) > 0;
  return (
    (view === "tasks" || view === "files") &&
    trailTail !== undefined &&
    detail !== null &&
    (trailTail.sidechain !== undefined || runMode === "conversation" || !trailHasBoard)
  );
}

/** A task as the panel's root, and the same task's context beside its conversation. */
export const taskEntryOf = (taskId: string, project: string | undefined): PanelEntry => ({
  kind: "task",
  key: `task:${taskId}`,
  taskId,
  ...(project !== undefined ? { project } : {}),
  tab: "conversation",
});
export const convoEntryOf = (taskId: string, project: string | undefined): PanelEntry => ({
  kind: "convo",
  key: `convo:${taskId}`,
  taskId,
  ...(project !== undefined ? { project } : {}),
  tab: "steps",
});

/**
 * What each room's panel stands on — its RULE (the panel rulings, 2026-09-24). The stack's root is
 * this; everything else in the stack was pushed by a link inside the panel.
 *
 *  - Files: a run on the trail — its context beside its conversation, or the task beside its board;
 *    a state file — the state (Run · Checks; its configuration is the editor); a plain file or a
 *    folder — nothing: the panel closes, and what there is to say is the ⓘ on the address.
 *  - Tasks: the same for a run walked into; a column — its state; a card — its task.
 *  - Chat: the conversation's context (folded until asked for).
 *  - Debug: the self-test's task.
 */
export function panelRuleOf(
  at: PanelRoom,
  state: Pick<AppState, "trail" | "detail" | "debug" | "taskFocus" | "stateId" | "doc" | "at" | "taskWorkflow" | "inspect" | "taskWorkflowProject" | "selectedProject">,
  chat: { taskId: string | null; project: string },
  conversationInMain: boolean,
): PanelEntry | null {
  const { detail } = state;
  const trailTail = state.trail.at(-1);
  const selectedProject = state.selectedProject ?? undefined;
  if (at === "chat") {
    return chat.taskId === null ? null : { kind: "chat", key: `chat:${chat.taskId}`, taskId: chat.taskId, project: chat.project, tab: "produced" };
  }
  if (at === "debug") {
    return detail !== null && detail.taskId === state.debug.taskId ? taskEntryOf(detail.taskId, selectedProject) : null;
  }
  if (trailTail !== undefined && detail !== null && (at === "files" || state.taskFocus !== null)) {
    return conversationInMain ? convoEntryOf(detail.taskId, selectedProject) : taskEntryOf(detail.taskId, selectedProject);
  }
  if (at === "files") {
    return state.stateId !== null && state.doc?.stateId !== undefined
      ? { kind: "state", key: `state:${state.at ?? ""}:${state.stateId}`, stateId: state.stateId, project: state.at, tab: "run" }
      : null;
  }
  if (state.taskWorkflow !== null && state.inspect !== "workflow") {
    return { kind: "state", key: `state:${state.taskWorkflowProject ?? ""}:${state.taskWorkflow}`, stateId: state.taskWorkflow, project: state.taskWorkflowProject, tab: "run" };
  }
  return detail !== null ? taskEntryOf(detail.taskId, selectedProject) : null;
}

/** The gate a task is parked on — a move's question is not a state asking (`moveQuestions`). */
export function parkedGateOf(pending: readonly PendingInteraction[], taskId: string): PendingInteraction | undefined {
  return pending.find((p) => (p.about === taskId || p.taskId === taskId) && p.moves !== true);
}

/**
 * The interaction the selected task is parked on, as a leaf's conversation pins it (`waiting`: what it
 * asks for), and its Answer — which selects the task, where the gate is answered (`onAnswer`).
 */
export function leafWaitOf(
  pending: readonly PendingInteraction[],
  selected: string | null,
  select: (taskId: string, project?: string) => void,
): { waiting?: { component: string }; onAnswer?: () => void } {
  const waiting = pending.find((p) => p.taskId === selected);
  if (waiting === undefined) return {};
  return { waiting: { component: waiting.config?.prompt ?? waiting.component }, onAnswer: () => select(waiting.taskId, waiting.project) };
}

/**
 * ⇤ on a subagent's conversation in the panel: that conversation into the main view — walked into at
 * once when the task's run is already the one walked, else after the task opens there (the walk waits
 * for the task to be selected, walked into and loaded).
 */
export function useAdoptSubagent(
  state: Pick<AppState, "selected" | "trail" | "at">,
  detail: TaskDetail | null,
  actions: {
    walkIntoSidechain: (node: InstanceNode, call: string, name: string) => void;
    setView: (view: View) => void;
    openTask: (taskId: string, project: string, level: string) => unknown;
  },
): (taskId: string, project: string | undefined, step: TrailStep) => void {
  const [adoptAfter, setAdoptAfter] = useState<{ taskId: string; step: TrailStep } | null>(null);
  useEffect(() => {
    if (adoptAfter === null || state.selected !== adoptAfter.taskId || state.trail.length === 0 || detail === null) return;
    const host = nodeAt(detail.instances, adoptAfter.step.instanceId);
    if (host !== undefined) actions.walkIntoSidechain(host, adoptAfter.step.sidechain ?? "", adoptAfter.step.name ?? "");
    setAdoptAfter(null);
  }, [adoptAfter, state.selected, state.trail.length, detail, actions]);
  return (taskId, project, step) => {
    const host = detail !== null && detail.taskId === taskId ? nodeAt(detail.instances, step.instanceId) : undefined;
    if (host !== undefined && state.trail.length > 0 && state.selected === taskId) {
      actions.walkIntoSidechain(host, step.sidechain ?? "", step.name ?? "");
      return;
    }
    setAdoptAfter({ taskId, step });
    actions.setView("tasks");
    void actions.openTask(taskId, project ?? state.at ?? "", detail?.workflow ?? step.stateId);
  };
}

/**
 * What the shell can lend a changeset reviewer beyond the defaults (CHANGESETS.md §8.2): the
 * unsaved-edit map, and a way into the editor. Supplied to BOTH hosts — the gate modal and the
 * conversation view — because a host's reach, not the component, is what decides these exist.
 */
export function reviewerServicesOf(
  drafts: Readonly<Record<string, string>>,
  actions: { setView: (view: View) => void; openPath: (layer: WorkflowLayer, path: string) => unknown },
): Pick<ComponentServices, "drafts" | "openFile"> {
  return {
    drafts: new Map(Object.entries(drafts)),
    openFile: (layer: string, path: string) => {
      actions.setView("files");
      void actions.openPath(layer as WorkflowLayer, path);
    },
  };
}

/**
 * The column's geometry: its fold key, whether it is open, the key its width is remembered under, and
 * the width. Remembered per KIND of thing on top (`widthKeyOf`) — a form wants more room than a task's
 * tabs, and the column says so by moving.
 */
export function panelGeometryOf(ui: JairaUiState, room: PanelRoom | null, top: PanelEntry | undefined): { foldKey: string | null; open: boolean; widthKey: string; width: number } {
  const foldKey = room === null ? null : PANEL_FOLD[room];
  const open = foldKey === null ? true : openOf(ui, foldKey);
  const widthKey = top === undefined ? PANE.panelTask : widthKeyOf(top.kind);
  const width = top === undefined ? 0 : open ? Math.max(PANEL_MIN, Math.min(paneOf(ui, widthKey), PANE_WIDE)) : PANEL_RAIL;
  return { foldKey, open, widthKey, width };
}

/** Whether the panel's root stands beside a conversation, where ✕ folds rather than closes. */
export function closeFoldsOf(stack: PanelStack): boolean {
  return stack.entries[0]?.kind === "chat" || stack.entries[0]?.kind === "convo";
}

/**
 * Start a task again the way its state asks — resume it, start one that never ran, or re-run it
 * (`primaryAct`); a task that is not the selected one is re-run.
 */
export function startAgainOf(
  actions: { resumeTask: (taskId: string, project?: string) => unknown; startTask: (taskId: string, fake?: unknown, project?: string) => unknown; rerunTask: (taskId: string, project?: string) => unknown },
  detail: TaskDetail | null,
  project: string | undefined,
  taskId: string,
): void {
  const act = detail !== null && detail.taskId === taskId ? primaryAct(detail) : "rerun";
  if (act === "resume") void actions.resumeTask(taskId, project);
  else if (act === "start") void actions.startTask(taskId, undefined, project);
  else void actions.rerunTask(taskId, project);
}

/** The New-task form is a panel root in the Tasks room; the button opens it there, unfolded. */
export function openNewTaskWith(onStack: (next: (stack: PanelStack) => PanelStack) => void, setFold: (id: string, open: boolean) => void): void {
  onStack((was) => push(was, { kind: "newTask", key: "newTask" }));
  setFold(PANEL_FOLD.tasks, true);
}

/**
 * A state's run form and history, as a board column (or a conversation's gutter) opens it in the panel —
 * `App.tsx`'s `runSurfaceOf`, moved here unchanged so the universal panel builds the same surface.
 *
 * What the boxes hold: reached from a board column, the state's own defaults with whatever has been
 * typed over them — a form for the NEXT run. Reached from a conversation's gutter, the panel is
 * describing a run that already happened, so they hold what that run was called with; typing still
 * wins, because the reason to look at those values beside the Run button is usually to change one of
 * them and go again. How each value was settled (decision 0005 §4) is said only while the boxes still
 * hold what the run was called with.
 */
export function runSurfaceFor(
  state: Pick<AppState, "workflowForms" | "projects" | "runValues" | "tasks" | "sharedTasks" | "at" | "busy" | "selected">,
  actions: {
    setRunValues: (stateId: string, values: RunValues) => void;
    runState: (stateId: string, title: string, inputs: Record<string, JsonValue>, project?: string) => unknown;
    select: (taskId: string, project?: string) => void;
  },
  detail: TaskDetail | null,
  stateId: string,
  project: string | null,
  runInstance: string | null,
): RunSurface | undefined {
  const fields = state.workflowForms[stateId];
  if (fields === undefined) return undefined;
  const summary = state.projects.find((p) => p.project === project);
  const run = runInstance === null ? null : nodeAt(detail?.instances ?? [], runInstance);
  const called = run?.inputs;
  const recorded = state.runValues[stateId] === undefined ? run?.inputProvenance : undefined;
  const titleOf = (taskId: string): string | undefined => [...state.tasks, ...state.sharedTasks].find((task) => task.taskId === taskId)?.title;
  return {
    fields,
    values: state.runValues[stateId] ?? (called !== undefined ? runValuesOf(fields ?? [], called) : initialRunValues(fields ?? [])),
    ...(recorded !== undefined ? { provenance: (path: string) => settledMarkOf(recorded[path], titleOf) } : {}),
    target: {
      ...(project !== null && project !== state.at ? { project } : {}),
      label: summary?.label ?? projectName(project),
      open: project !== null,
    },
    ...(project !== null ? { targetDir: project } : {}),
    exists: true,
    // A board column is a file on disk by construction. There is no editor here to have unsaved
    // edits in — the one that could is in the other view, describing whatever IT has open.
    dirty: false,
    busy: state.busy,
    tasks: summary?.kind === "shared" ? state.sharedTasks : state.tasks,
    selected: state.selected,
    onChange: (values) => actions.setRunValues(stateId, values),
    onRun: (title, inputs) => void actions.runState(stateId, title, inputs, project ?? undefined),
    onSelectTask: actions.select,
  };
}

/**
 * Where a re-run with changes starts: the task's workflow as a run form, opening on what the task was
 * called with — `App.tsx`'s `rerunSurface`, moved here unchanged so the universal panel builds the same.
 * Starting it makes a NEW task and closes the card (the stack back to its root).
 */
export function rerunSurfaceFor(
  state: Pick<AppState, "workflowForms" | "runValues" | "busy">,
  actions: { setRunValues: (stateId: string, values: RunValues) => void; runState: (stateId: string, title: string, inputs: Record<string, JsonValue>, project?: string) => unknown },
  task: TaskDetail,
  project: string | undefined,
  onStack: (next: (stack: PanelStack) => PanelStack) => void,
): RerunSurface {
  const fields = state.workflowForms[task.workflow];
  const key = `rerun:${task.taskId}`;
  const called = task.instances[0]?.inputs ?? {};
  return {
    workflow: task.workflow,
    fields,
    values: state.runValues[key] ?? runValuesOf(fields ?? [], called),
    busy: state.busy,
    onChange: (values) => actions.setRunValues(key, values),
    onRun: (inputs) => {
      void actions.runState(task.workflow, `${task.title} · again`, inputs, project);
      onStack((was) => ({ ...was, entries: was.entries.slice(0, 1), motion: "pop" }));
    },
  };
}

/**
 * Every state the task entered, as a place a copy can start — its entry's journal position (the
 * re-run card's "Start from", `panelFaces.tsx`). The root has nothing before it: starting there is
 * starting from the beginning.
 */
export function rerunStartsOf(detail: TaskDetail, turns: readonly { kind: string; instanceId?: string | undefined; seq: number }[]): { seq: number; label: string }[] {
  return turns.flatMap((turn) => {
    if (turn.kind !== "entered" || turn.instanceId === undefined) return [];
    const node = nodeAt(detail.instances, turn.instanceId);
    if (node === undefined || node.parentInstanceId === undefined) return [];
    return [{ seq: turn.seq, label: pathOf(detail.instances, node).slice(1).join(" › ") }];
  });
}
