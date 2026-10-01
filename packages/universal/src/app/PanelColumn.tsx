import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { SHARED_SESSION, type TaskDetail } from "@jaira/shared/browser";
import { EVENTS_STATE_ID } from "@jaira/ui/automationsModel";
import { projectName } from "@jaira/ui/projects";
import { chatProjectOf } from "@jaira/ui/chatWorkflow";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { closeFoldsOf, conversationInMainOf, openNewTaskWith, panelGeometryOf, panelRuleOf, parkedGateOf, rerunSurfaceFor, roomOf, runSurfaceFor, startAgainOf, useAdoptSubagent, useHeldStates, usePanelStacks, usePanelTween, useRoomRule, type PanelRoom } from "@jaira/ui/panelHost";
import { EMPTY_STACK, topOf, type PanelEntry } from "@jaira/ui/panelStack";
import { PANE, PANEL_MIN, PANE_WIDE, SHUT, paneDefault, paneOf, shutOf } from "@jaira/ui/uiState";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { invoke } from "@jaira/ui/store";
import { faceOf, type FaceHost } from "../components/panel/faces";
import { EventsTaskAutomations } from "../components/workflow/ConfigPanel";
import { wantPart } from "../components/settings/parts";
import { ToolsFieldProvider, useToolsFieldRead } from "@jaira/ui/toolsFieldModel";
import { NewTaskForm } from "../components/panel/NewTaskForm";
import { panelOnStack, runFocus, runViewed } from "../components/panel/panelBridge";
import type { TranscriptSource } from "../components/panel/RunTranscript";
import { useRunContext } from "../components/run/runContext";
import { SidePanel } from "../components/panel/SidePanel";
import { paneTween } from "../components/panel/panelMotion";
import { Splitter } from "../components/files/Splitter";
import { edge, landmark } from "../primitives";
import { useTokens } from "../tokens";
import { useShell } from "./shell";
import { newTaskOpener, panelTopKind, runMode } from "./viewState";

/**
 * A room's side panel: the splitter and the panel stack's top entry (`SidePanel.tsx`) — a task's run, a
 * conversation's context, a column's state, a value, the new-task form. Nothing while the stack is
 * empty. The Tasks, Files, Chat and Debug rooms each stand one here (`roomOf`); the Chat room's rule is
 * its conversation's, which it can hand in (`chat`).
 *
 * The stack, the room's rule and the column's width are `panelHost.ts`'s; what an entry says is
 * `faces.tsx`'s `faceOf`, over `panelFaceModel.ts`. How it looks:
 *
 *   the column     --panel, a --line on the left (--rule folded), clipped; the column's width, eased to
 *                  a new kind's or a fold's (`panelMotion.web.ts`)
 *   the splitter   6 wide, a 2px --line down its middle; dragged (`files/Splitter.tsx`)
 */
export function PanelColumn({ chat }: { chat?: { taskId: string | null; project: string; detail: TaskDetail | null } | undefined } = {}): JSX.Element | null {
  const t = useTokens();
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const look = useMemo(() => lookOf(state.config), [state.config]);
  // The Tools field's permission sets and tools, for the workflow editor in a state's Configuration.
  const toolsFieldData = useToolsFieldRead(state.at, state.tree);
  const room = roomOf(state.view);
  const { setStacks, onStack, panelStack, roomRef } = usePanelStacks(room);
  // Which reading of a drilled run the column shows — the title bar's toggle (`viewState.ts`).
  const mode = runMode.use();
  const conversationInMain = conversationInMainOf(state, mode);
  const chatAt = chat !== undefined ? { taskId: chat.taskId, project: chat.project } : { taskId: state.chat.taskId, project: chatProjectOf(state.chat.project, state.at) };
  const rule = room === null ? null : panelRuleOf(room, state, chatAt, conversationInMain);
  const detail = state.detail;
  const inlineGate = state.view === "tasks" && detail !== null ? parkedGateOf(state.pending, detail.taskId) : undefined;
  useRoomRule(room, rule, inlineGate?.requestId, setStacks);
  const hostGate = detail !== null ? parkedGateOf(state.pending, detail.taskId) : undefined;

  const selectedProject = state.selectedProject ?? undefined;
  const startAgain = useCallback((taskId: string) => startAgainOf(actions, detail, selectedProject, taskId), [actions, detail, selectedProject]);
  const top = topOf(panelStack);
  const geometry = panelGeometryOf(ui, room, top);
  // The width animates when the kind on top changes or the panel folds, not while it is dragged.
  const tween = usePanelTween(geometry.widthKey, geometry.open, top === undefined);
  // The New-task button's side of the stack (`viewState.ts`): what is on top, and how to open the form.
  const topKind = top?.kind ?? null;
  useEffect(() => panelTopKind.set(topKind), [topKind]);
  useEffect(() => {
    newTaskOpener.set(() => openNewTaskWith(onStack, actions.setFold));
    return () => newTaskOpener.set(null);
  }, [onStack, actions]);
  // A re-run with changes needs its workflow's form, which is read on demand like the New-task form's.
  const rerunOf = top?.kind === "rerun" ? (detail?.taskId === top.taskId ? detail.workflow : null) : null;
  useEffect(() => {
    if (rerunOf !== null && state.workflowForms[rerunOf] === undefined) actions.pickWorkflow(rerunOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunOf]);
  // The stack, for the middle column's links into the panel (`panelBridge.ts`).
  useEffect(() => {
    panelOnStack.set(onStack);
    return () => panelOnStack.set(null);
  }, [onStack]);
  // The step the middle column's conversation is showing, for the Steps index beside it.
  const viewed = runViewed.use();
  // The values somebody asked to HOLD — the Held tab.
  const [held, setHeld] = useState<PinnedValue[]>([]);
  const hold = useCallback((item: PinnedValue) => setHeld((was) => (was.some((one) => one.title === item.title) ? was : [...was, item])), []);
  const unhold = useCallback((item: PinnedValue) => setHeld((was) => was.filter((one) => one.title !== item.title)), []);

  /**
   * The detail of a task the panel shows that is not the selection — a subtask pushed on the stack, an
   * entry left under a pushed card. Fetched once per task and dropped when nothing shows it.
   */
  const [heldDetails, setHeldDetails] = useState<Record<string, TaskDetail>>({});
  const shownTasks = [...new Set(panelStack.entries.flatMap((entry) => ("taskId" in entry && entry.taskId !== undefined ? [`${entry.taskId}\u0000${entry.project ?? ""}`] : [])))]
    .filter((key) => key.split("\u0000")[0] !== detail?.taskId)
    .sort();
  const shownSig = shownTasks.join("|");
  useEffect(() => {
    let live = true;
    const wanted = new Set(shownTasks.map((key) => key.split("\u0000")[0]!));
    setHeldDetails((was) => {
      const kept = Object.fromEntries(Object.entries(was).filter(([taskId]) => wanted.has(taskId)));
      return Object.keys(kept).length === Object.keys(was).length ? was : kept;
    });
    for (const key of shownTasks) {
      const [taskId, project] = key.split("\u0000") as [string, string];
      if (heldDetails[taskId] !== undefined) continue;
      void invoke("task:detail", { taskId, ...(project !== "" ? { project } : {}) })
        .then((found) => live && setHeldDetails((was) => ({ ...was, [taskId]: found })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSig]);

  // A state the panel shows that the store is not holding — a pinned one, one a value opened here
  // (`panelHost.ts`' `useHeldStates`).
  const heldStates = useHeldStates(panelStack.entries, state, actions.pickWorkflow);

  // The run's verbs and links as the middle column has them: both read the one context.
  const run = useRunContext();
  // ⇤ on a subagent's conversation: into the main view, once its task's run is walked.
  const adoptSubagent = useAdoptSubagent(state, detail, actions);
  const source: TranscriptSource = {
    conversation: state.conversation,
    sessions: state.sessions,
    sessionHistory: state.sessionHistory,
    records: state.records,
    liveTurn: state.liveTurn,
    onLoadSessions: actions.loadSessions,
    shutStates: shutOf(ui, SHUT.runStates),
    onToggleShutState: (key: string) => actions.toggleShut(SHUT.runStates, key),
    onSetShutStates: (keys: readonly string[], shut: boolean) => actions.setShut(SHUT.runStates, keys, shut),
    batches: lookOf(state.config).conversation.sequentialBatches,
    userEvents: state.userEvents,
    onDeliverUserEvent: actions.deliverUserEvent,
    // The conversation gets both of a cut's verbs, the workflow's link and the task links.
    onRewind: run.onRewind,
    onFork: run.onFork,
    onOpenWorkflow: run.onOpenWorkflow,
    onSelectTask: actions.select,
    // What the shell lends a gate that mounts the changeset reviewer (`panelHost.ts`' `reviewerServicesOf`).
    gateServices: run.runGateServices,
    project: selectedProject,
    // The questions MOVES parked in task conversations: each drawn where its move asked it.
    moveQuestions: state.pending.filter((p) => p.moves === true),
    onMoveQuestion: (requestId: string, value: unknown) => actions.answer(requestId, value),
  };

  const host: FaceHost = {
    detail,
    // The selected task's detail, else one fetched for the panel (`heldDetails`); its run is read by its
    // own entry's body (`OwnRun`).
    detailOf: (taskId) => (detail?.taskId === taskId ? detail : chat?.detail?.taskId === taskId ? chat.detail : (heldDetails[taskId] ?? null)),
    project: selectedProject,
    source,
    onStack,
    // The selected task's gate in whichever room its panel stands: the Files room's panel is parked at
    // it too, not "Running".
    gate: hostGate,
    onGate: (value) => hostGate !== undefined && actions.answer(hostGate.requestId, value),
    // The gate a task is parked on, wherever its panel is — not only the selected one's.
    gateOf: (taskId) => {
      const asking = parkedGateOf(state.pending, taskId);
      return asking === undefined ? undefined : { gate: asking, onGate: (value: unknown) => actions.answer(asking.requestId, value) };
    },
    startAgain,
    resume: (taskId) => void actions.resumeTask(taskId, selectedProject),
    cancel: (taskId) => actions.cancelTask(taskId, selectedProject),
    reviewChanges: (taskId) => actions.reviewChanges(taskId, selectedProject),
    // ⇤: the conversation into the main view, which hands the panel to its context.
    adoptTask: (taskId, at, workflow) => {
      runMode.set("conversation");
      if (state.trail.length > 0 && state.selected === taskId) return;
      actions.setView("tasks");
      actions.openTask(taskId, at ?? state.at ?? "", workflow);
    },
    adoptSubagent,
    ...(conversationInMain && detail !== null
      ? {
          // ⇥: back out of the main view — the board with the task selected, its conversation here.
          giveBack: () => {
            const taskId = detail.taskId;
            actions.setView("tasks");
            actions.walkBackTo(-1);
            actions.select(taskId, selectedProject);
          },
          goTo: (instanceId: string) => runFocus.set({ instance: instanceId, at: Date.now() }),
          viewed,
        }
      : {}),
    // The open file's state, the board column's, or one read for the panel.
    stateOf: (stateId, project) => {
      if (state.doc?.stateId === stateId && state.stateId === stateId) return { view: state.state };
      if (state.taskWorkflow === stateId) {
        const run = runSurfaceFor(state, actions, detail, stateId, state.taskWorkflowProject, state.taskWorkflowRun);
        return { view: state.taskState, ...(run !== undefined ? { run } : {}) };
      }
      const held = heldStates[`${stateId}\u0000${project ?? ""}`];
      if (held === undefined) return undefined;
      const run = runSurfaceFor(state, actions, detail, stateId, project ?? null, null);
      return { view: held, ...(run !== undefined ? { run } : {}) };
    },
    inEditor: (stateId) => state.view === "files" && state.doc?.stateId === stateId,
    openInFiles: (stateId) => {
      actions.setView("files");
      actions.selectState(stateId, { run: false });
    },
    held,
    hold,
    unhold,
    stepsHeight: paneOf(ui, PANE.panelSteps),
    setStepsHeight: (height) => actions.setPane(PANE.panelSteps, height),
    newTask: (
      <NewTaskForm
        workflows={state.workflows}
        forms={state.workflowForms}
        values={state.runValues}
        sources={state.inputSources}
        busy={state.busy}
        onPick={actions.pickWorkflow}
        onChange={actions.setRunValues}
        onCreate={(workflow, inputs, sources) => void actions.createTask(workflow, inputs, sources)}
        onDone={() => onStack((was) => (topOf(was)?.kind === "newTask" ? (was.entries.length > 1 ? { ...was, entries: was.entries.slice(0, -1), motion: "pop" } : { ...EMPTY_STACK, motion: "replace" }) : was))}
      />
    ),
    rerunSurface: (task) => rerunSurfaceFor(state, actions, task, selectedProject, onStack),
    onFork: (taskId, seq) => void actions.forkTask(taskId, seq, selectedProject),
    onRewind: run.onRewind,
    turns: state.conversation?.turns ?? [],
    // The workflow editor's, in a configuration card and a state's Configuration.
    config: {
      tree: state.tree,
      executors: state.executors,
      busy: state.busy,
      wrapJson: look.editors.json.wrap,
      onWrapJson: actions.setWrapJson,
      services: {
        readFile: actions.readFile,
        readState: actions.readState,
        loadStateSlots: actions.stateSlots,
        validateSchema: actions.validateSchema,
        wrapJson: look.editors.json.wrap,
        onWrapJson: actions.setWrapJson,
      },
      readState: actions.readState,
      saveState: actions.saveState,
      ui: {
        pane: (id, fallback) => ui.panes[id] ?? fallback,
        setPane: actions.setPane,
        open: (id, fallback) => ui.open[id] ?? fallback,
        setOpen: actions.setFold,
      },
    },
    // The events task's Configuration tab: Settings' Automations editor on the task's layer. Its links
    // open Settings on the page, standing on the task's project, and at the part within it where one is
    // named (`parts.ts`' `wantPart`: gone to once the page has drawn it).
    automationsOf: (project, onOpenConversation) => {
      const at = project ?? state.at ?? SHARED_SESSION;
      const shared = at === SHARED_SESSION;
      const toSettings = (section: Parameters<typeof actions.setSection>[0], part?: string): void => {
        if (!shared) actions.standOn(at);
        actions.setConfigLayer(shared ? "base" : "project");
        actions.setSection(section);
        actions.setView("settings");
        if (part !== undefined) wantPart(part);
      };
      return (
        <EventsTaskAutomations
          project={at}
          projectName={shared ? "Shared" : (state.projects.find((p) => p.project === at)?.label ?? projectName(at))}
          busy={state.busy}
          workflows={state.workflows.map((entry) => ({ id: entry.rootId, label: entry.label }))}
          forms={state.workflowForms}
          onWorkflow={actions.pickWorkflow}
          onOpenConversation={onOpenConversation}
          onEditFile={(layer) => void actions.openWorkflow(EVENTS_STATE_ID, layer)}
          onOpenEvents={() => toSettings("tools", "events")}
          onOpenConnections={() => toSettings("connections")}
        />
      );
    },
  };
  const face = (entry: PanelEntry): ReturnType<typeof faceOf> => faceOf(host, entry);
  void roomRef;

  if (top === undefined) return null;
  return (
    <>
      {/* The side panel's splitter: a drag writes the width of the kind on top (`widthKey`) — it sizes
          the pane after it, so a drag left widens it. */}
      {geometry.open ? (
        <Splitter
          label="Resize the side panel"
          value={paneOf(ui, geometry.widthKey)}
          reset={paneDefault(geometry.widthKey)}
          invert
          min={PANEL_MIN}
          max={PANE_WIDE}
          onChange={(size) => actions.setPane(geometry.widthKey, size)}
        />
      ) : null}
      <View
        {...(landmark("complementary") as object)}
        width={geometry.width}
        flexShrink={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { left: 1 }, geometry.open ? "line" : "rule") as object)}
        {...(paneTween(tween) as object)}
      >
        <ToolsFieldProvider value={toolsFieldData}>
          <SidePanel stack={panelStack} onStack={onStack} face={face} folded={!geometry.open} onFold={(folded) => geometry.foldKey !== null && actions.setFold(geometry.foldKey, !folded)} closeFolds={closeFoldsOf(panelStack)} />
        </ToolsFieldProvider>
      </View>
    </>
  );
}

export type { PanelRoom };
