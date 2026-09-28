import { useCallback, useEffect, type JSX } from "react";
import { View } from "@tamagui/core";
import type { TaskDetail } from "@jaira/shared/browser";
import { chatProjectOf } from "@jaira/ui/chatWorkflow";
import { BADGE, taskTabs, taskVerbsOf } from "@jaira/ui/panelFaceModel";
import { closeFoldsOf, conversationInMainOf, openNewTaskWith, panelGeometryOf, panelRuleOf, parkedGateOf, roomOf, startAgainOf, usePanelStacks, useRoomRule } from "@jaira/ui/panelHost";
import { topOf, type PanelEntry } from "@jaira/ui/panelStack";
import { taskNameOf } from "@jaira/ui/taskName";
import { SHUT, shutOf } from "@jaira/ui/uiState";
import { SidePanel, type PanelFace } from "../components/panel/SidePanel";
import { TaskConversation } from "../components/panel/TaskConversation";
import type { TranscriptSource } from "../components/panel/RunTranscript";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { useShell } from "./shell";
import { newTaskOpener, panelTopKind, runMode } from "./viewState";
import { Uncopied } from "./Uncopied";

/**
 * The Tasks room's side panel (`aside.ctx-panel`, `App.tsx`, `sidePanel.tsx`): the splitter and the
 * panel stack's top entry — a task's run, a column's state, the new-task form. Nothing while the stack
 * is empty, as `panelColumn` is null there.
 *
 * The stack, the room's rule and the column's width are `panelHost.ts`'s, the same code `App.tsx` runs;
 * what a task entry says is `panelFaceModel.ts`'s. Of the entries, a TASK is copied (its head, tabs and
 * Conversation); the rest, and a task's other tabs, are drawn {@link Uncopied}.
 *
 *   .ctx-panel     --panel, a --line on the left (--rule folded), clipped; the column's width
 *   .splitter      6 wide, a 2px --line down its middle
 */
export function PanelColumn(): JSX.Element | null {
  const t = useTokens();
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const room = roomOf(state.view);
  const { setStacks, onStack, panelStack } = usePanelStacks(room);
  // Which reading of a drilled run the column shows — the title bar's toggle (`viewState.ts`).
  const conversationInMain = conversationInMainOf(state, runMode.use());
  const rule = room === null ? null : panelRuleOf(room, state, { taskId: state.chat.taskId, project: chatProjectOf(state.chat.project, state.at) }, conversationInMain);
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
    // `App.tsx` hands the conversation both of a cut's verbs, so its entered rows carry their room.
    cuts: true,
  };

  const face = (entry: PanelEntry): PanelFace => {
    if (entry.kind !== "task") return { title: entry.kind, titleText: entry.kind, body: <Uncopied name={`the ${entry.kind} panel`} flex={1} />, scroll: false };
    const own = detail !== null && detail.taskId === entry.taskId ? detail : null;
    const project = entry.project ?? selectedProject;
    const gate = own !== null ? parkedGateOf(state.pending, own.taskId) : undefined;
    const head = taskHeadOf(own, entry.taskId);
    const body = ((): JSX.Element => {
      if (own === null) return <Uncopied name="a task the store is not holding" flex={1} />;
      if (entry.tab !== "conversation") return <Uncopied name={`the ${entry.tab} tab`} flex={1} />;
      return (
        <TaskConversation
          detail={own}
          project={project}
          source={source}
          gate={gate}
          onGate={(value) => gate !== undefined && actions.answer(gate.requestId, value)}
          onRerun={startAgain}
          onResume={(taskId) => void actions.resumeTask(taskId, selectedProject)}
        />
      );
    })();
    return {
      ...head,
      verbs:
        own === null
          ? []
          : taskVerbsOf(
              {
                startAgain,
                cancel: (taskId) => actions.cancelTask(taskId, selectedProject),
                onStack,
                // ⇤: the conversation into the main view — which the universal shell does not draw yet,
                // so this opens the task there as `App.tsx`'s `adoptTask` does, without the run mode.
                adoptTask: (taskId, at, workflow) => {
                  if (state.trail.length > 0 && state.selected === taskId) return;
                  actions.setView("tasks");
                  actions.openTask(taskId, at ?? state.at ?? "", workflow);
                },
              },
              own,
              project,
              true,
            ),
      tabs: taskTabs(gate !== undefined ? { pending: gate } : undefined, own, true),
      tab: entry.tab,
      body,
      scroll: false,
    };
  };

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
        <SidePanel stack={panelStack} onStack={onStack} face={face} folded={!geometry.open} onFold={(folded) => geometry.foldKey !== null && actions.setFold(geometry.foldKey, !folded)} closeFolds={closeFoldsOf(panelStack)} />
      </View>
    </>
  );
}

/** A task's status glyph (`board.tsx`'s `Badge`): 16 wide, 15px, coloured by status. */
function Badge({ status }: { status: string }): JSX.Element {
  const hue = status === "running" || status === "interrupted" ? "accent" : status === "waiting_for_user" ? "warn" : status === "completed" ? "ok" : status === "failed" || status === "blocked" || status === "timeout" ? "bad" : "dim";
  return (
    <Txt spec={{ voice: "app", scale: 1, color: hue, lineHeight: { px: 22.5 } }} fontSize={15} width={16} textAlign="center" flexShrink={0}>
      {BADGE[status] ?? "·"}
    </Txt>
  );
}


/** The head's line for a task: its status, its name, and what identifies it (`taskHeadOf`). */
function taskHeadOf(detail: TaskDetail | null, taskId: string): Pick<PanelFace, "glyph" | "title" | "titleText" | "sub"> {
  if (detail === null) return { title: taskId, titleText: taskId, glyph: <Badge status="queued" /> };
  return {
    glyph: <Badge status={detail.status} />,
    title: taskNameOf(detail),
    titleText: detail.title,
    // The id in its own run, as the DOM's `span.mono` is: one run shapes differently at the seam.
    sub: (
      <>
        <Txt spec={{ voice: "app", scale: 0.92, color: "dim" }}>{detail.taskId}</Txt>
        {` · ${detail.workflow}`}
        {detail.branch !== undefined ? ` · ⎇ ${detail.branch}` : null}
      </>
    ),
  };
}
