import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { SHARED_SESSION, type TaskDetail } from "@jaira/shared/browser";
import { EVENTS_STATE_ID } from "@jaira/ui/automationsModel";
import { projectName } from "@jaira/ui/projects";
import { chatProjectOf } from "@jaira/ui/chatWorkflow";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { closeFoldsOf, conversationInMainOf, openNewTaskWith, panelGeometryOf, panelRuleOf, parkedGateOf, rerunSurfaceFor, roomOf, runSurfaceFor, startAgainOf, usePanelStacks, useRoomRule, type PanelRoom } from "@jaira/ui/panelHost";
import { EMPTY_STACK, topOf, type PanelEntry } from "@jaira/ui/panelStack";
import { PANE, SHUT, paneOf, shutOf } from "@jaira/ui/uiState";
import type { PinnedValue } from "@jaira/ui/valuePanel";
import { faceOf, type FaceHost } from "../components/panel/faces";
import { EventsTaskAutomations } from "../components/workflow/ConfigPanel";
import { ToolsFieldProvider, useToolsFieldRead } from "@jaira/ui/toolsFieldModel";
import { NewTaskForm } from "../components/panel/NewTaskForm";
import { panelOnStack, runFocus, runViewed } from "../components/panel/panelBridge";
import type { TranscriptSource } from "../components/panel/RunTranscript";
import { SidePanel } from "../components/panel/SidePanel";
import { edge } from "../primitives";
import { useTokens } from "../tokens";
import { useShell } from "./shell";
import { newTaskOpener, panelTopKind, runMode } from "./viewState";

/**
 * A room's side panel (`aside.ctx-panel`, `App.tsx`, `sidePanel.tsx`): the splitter and the panel stack's
 * top entry — a task's run, a conversation's context, a column's state, a value, the new-task form.
 * Nothing while the stack is empty, as `panelColumn` is null there. The Tasks, Files and Chat rooms each
 * stand one here (`roomOf`); the Chat room's rule is its conversation's, which it can hand in (`chat`).
 *
 * The stack, the room's rule and the column's width are `panelHost.ts`'s, the same code `App.tsx` runs;
 * what an entry says is `faces.tsx`'s (`panelFaces.tsx`'s `faceOf`), over `panelFaceModel.ts`.
 *
 *   .ctx-panel     --panel, a --line on the left (--rule folded), clipped; the column's width
 *   .splitter      6 wide, a 2px --line down its middle
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

  const selectedProject = state.selectedProject ?? undefined;
  const startAgain = useCallback((taskId: string) => startAgainOf(actions, detail, selectedProject, taskId), [actions, detail, selectedProject]);
  const top = topOf(panelStack);
  const geometry = panelGeometryOf(ui, room, top);
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
  // The values somebody asked to HOLD — the Held tab (`App.tsx`'s `held`).
  const [held, setHeld] = useState<PinnedValue[]>([]);
  const hold = useCallback((item: PinnedValue) => setHeld((was) => (was.some((one) => one.title === item.title) ? was : [...was, item])), []);
  const unhold = useCallback((item: PinnedValue) => setHeld((was) => was.filter((one) => one.title !== item.title)), []);

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
    // `App.tsx` hands the conversation both of a cut's verbs, so its entered rows carry their room.
    cuts: true,
    project: selectedProject,
    // The questions MOVES parked in task conversations: each drawn where its move asked it (`App.tsx`).
    moveQuestions: state.pending.filter((p) => p.moves === true),
    onMoveQuestion: (requestId: string, value: unknown) => actions.answer(requestId, value),
  };

  const host: FaceHost = {
    detail,
    // The selected task's detail; one the store is not holding is read by its own panel (`OwnRun`), not copied.
    detailOf: (taskId) => (detail?.taskId === taskId ? detail : chat?.detail?.taskId === taskId ? chat.detail : null),
    project: selectedProject,
    source,
    onStack,
    gate: inlineGate,
    onGate: (value) => inlineGate !== undefined && actions.answer(inlineGate.requestId, value),
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
    // The open file's state, or the board column's (`App.tsx`'s `stateOf`); a state held for a pinned
    // panel is not read here.
    stateOf: (stateId) => {
      if (state.doc?.stateId === stateId && state.stateId === stateId) return { view: state.state };
      if (state.taskWorkflow === stateId) {
        const run = runSurfaceFor(state, actions, detail, stateId, state.taskWorkflowProject, state.taskWorkflowRun);
        return { view: state.taskState, ...(run !== undefined ? { run } : {}) };
      }
      return undefined;
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
    turns: state.conversation?.turns ?? [],
    // The workflow editor's, in a configuration card and a state's Configuration (`App.tsx`'s `config`).
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
    // The events task's Configuration tab: Settings' Automations editor on the task's layer (`App.tsx`'s
    // `automationsOf`). Settings is opened on its page; the part it scrolls to is the desktop's alone.
    automationsOf: (project, onOpenConversation) => {
      const at = project ?? state.at ?? SHARED_SESSION;
      const shared = at === SHARED_SESSION;
      const toSettings = (section: Parameters<typeof actions.setSection>[0]): void => {
        if (!shared) actions.standOn(at);
        actions.setConfigLayer(shared ? "base" : "project");
        actions.setSection(section);
        actions.setView("settings");
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
          onOpenEvents={() => toSettings("tools")}
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
      {geometry.open ? (
        <View width={6} flexShrink={0} alignItems="center">
          <View width={2} flex={1} backgroundColor={t.v("line") as never} />
        </View>
      ) : null}
      <View
        width={geometry.width}
        flexShrink={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { left: 1 }, geometry.open ? "line" : "rule") as object)}
      >
        <ToolsFieldProvider value={toolsFieldData}>
          <SidePanel stack={panelStack} onStack={onStack} face={face} folded={!geometry.open} onFold={(folded) => geometry.foldKey !== null && actions.setFold(geometry.foldKey, !folded)} closeFolds={closeFoldsOf(panelStack)} />
        </ToolsFieldProvider>
      </View>
    </>
  );
}

export type { PanelRoom };
