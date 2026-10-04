import { useMemo, type JSX } from "react";
import { View } from "@tamagui/core";
import { taskNameOf, taskNamePending } from "@jaira/ui/taskNameModel";
import { FOLD } from "@jaira/ui/uiState";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { NewTask } from "../components/NewTask";
import { RunModeToggle } from "../components/RunModeToggle";
import { TaskAddressBar } from "../components/TaskAddressBar";
import { FilesAddress } from "./FilesView";
import { DRAG_REGION, WINDOW_GUTTER } from "../primitives";
import { useShell } from "./shell";
import { usePhone } from "./phone";
import { ChatTitle } from "../components/chat/ChatTitle";
import { useChatSurface } from "../components/chat/surface";
import { boardAt, newTaskOpener, panelTopKind, runMode } from "./viewState";

/**
 * What stands in the title bar: the ADDRESS of what is open. In Tasks, the task address bar
 * (`TaskAddressBar.tsx`, with `Crumbs.tsx`); in Files, the file address bar; in Chat, the conversation's
 * name. Then the drag filler ({@link TitleDrag}). The bar itself — 34 tall at least, `--panel`, a
 * `--line` under it — is `UniversalApp`'s.
 */
export function ShellTitleBar(): JSX.Element {
  const { state } = useShell();
  // A phone has no window to drag: the bar is its address alone, which may take the whole width.
  if (usePhone() && state.view === "tasks") return <TasksAddress />;
  if (state.view === "chat") return <ChatAddress />;
  if (state.view === "files") {
    return (
      <>
        <FilesAddress />
        <TitleDrag />
      </>
    );
  }
  // Settings, Logs, Debug and Components have no address: the bar is its filler alone.
  if (state.view !== "tasks") return <TitleDrag />;
  return (
    <>
      <TasksAddress />
      <TitleDrag />
    </>
  );
}

/**
 * The filler the desktop's window is moved by — flex 1, at least 8 and the gutter the OS draws its
 * window buttons into (`WINDOW_GUTTER.right`), a drag region whose words cannot be selected. A separate
 * box and not the row: a drag region swallows presses, and the crumbs beside it are places to go. On a
 * phone it is the filler alone.
 */
function TitleDrag(): JSX.Element {
  return <View flex={1} minWidth={WINDOW_GUTTER.right(8) as never} style={DRAG_REGION as never} />;
}

/** In Tasks, `TaskAddressBar` on the store, with the run's reading toggle and New task as its tools. */
function TasksAddress(): JSX.Element {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const groups = useMemo(() => groupProjects(state.projects, ui.groupWorkspaces !== false), [state.projects, ui.groupWorkspaces]);
  /** The projects as the address bar names them: a workspace by its group's name. */
  const namedProjects = useMemo(() => state.projects.map((p) => ({ ...p, label: groupOf(groups, p.project)?.label ?? p.label })), [state.projects, groups]);
  /**
   * `atProject`: the group the column is scrolled to. The column reports it (`viewState.boardAt`); until
   * it has, the first group it draws, which is the one at the top of an unscrolled column.
   */
  const scrolled = boardAt.use();
  const atProject = scrolled ?? groups.find((g) => state.taskFocus === null || g.members.some((m) => m.project === state.taskFocus))?.key ?? null;
  /** The tasks standing at the level the walk began from — the base run crumb's alternatives. */
  const taskLevelCards = useMemo(() => {
    const board = state.taskFocus === null ? null : state.boards[state.taskFocus];
    return board === null || board === undefined ? [] : [...board.atLevel, ...board.columns.flatMap((c) => c.cards)];
  }, [state.boards, state.taskFocus]);
  const detail = state.detail;
  const mode = runMode.use();
  const top = panelTopKind.use();
  const opener = newTaskOpener.use();
  const phone = usePhone();
  const openNewTask = (): void => {
    if (opener !== null) return opener();
    // No panel column to push the form onto yet: unfold it, as `openNewTaskWith` does after pushing.
    actions.setFold(FOLD.panelTasks, true);
  };
  const tools = (
    <>
      {state.trail.length > 0 && state.taskFocus !== null ? <RunModeToggle mode={mode} onMode={runMode.set} /> : null}
      {(state.taskFocus ?? atProject) === state.at && state.at !== null ? <NewTask onOpen={openNewTask} open={top === "newTask"} /> : null}
    </>
  );
  // A phone's bar has no room for the crumbs and the tools side by side: the tools take a row under them.
  const hasTools = (state.trail.length > 0 && state.taskFocus !== null) || ((state.taskFocus ?? atProject) === state.at && state.at !== null);
  const bar = (withTools: boolean): JSX.Element => (
    <TaskAddressBar
      projects={namedProjects}
      focus={state.taskFocus}
      at={atProject}
      boards={state.boards}
      trail={state.trail}
      run={{
        instances: detail?.instances ?? [],
        runs: taskLevelCards,
        selectedTask: state.selected,
        ...(detail != null ? { taskTitle: taskNameOf(detail), taskTitlePending: taskNamePending(detail) } : {}),
        onWalkTo: actions.walkTo,
        onSelectTask: (taskId) => actions.select(taskId, state.selectedProject ?? undefined),
      }}
      seen={ui.seen}
      onSeen={actions.markProjectSeen}
      onFocus={actions.focusProject}
      onDrill={actions.drillProject}
      onWalkBack={actions.walkBackTo}
      onOpenProject={() => void actions.chooseProject("open")}
      tools={withTools ? tools : null}
    />
  );
  if (!phone || !hasTools || state.trail.length === 0) return bar(true);
  return (
    <View flex={1} minWidth={0} flexDirection="column">
      <View flexDirection="row" minWidth={0}>
        {bar(false)}
      </View>
      <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8} paddingHorizontal={8} paddingBottom={6}>
        {tools}
      </View>
    </View>
  );
}

/** In Chat, the conversation's name, then the drag filler. */
function ChatAddress(): JSX.Element {
  return (
    <>
      <ChatTitle surface={useChatSurface()} />
      <TitleDrag />
    </>
  );
}
