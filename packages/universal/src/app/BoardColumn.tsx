import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { boardCardOrderOf, pickCard, type BoardPick } from "@jaira/ui/boardModel";
import { undoableOn } from "@jaira/ui/taskDrag";
import { groupOf, groupProjects, markQueued, mergeBoards } from "@jaira/ui/workspaceGroups";
import { Board, type Mods } from "../components/Board";
import { TaskAddressBar } from "../components/TaskAddressBar";
import { Txt, edge, scrollbarProps } from "../primitives";
import { useTokens } from "../tokens";
import { useShell } from "./shell";
import { RunView } from "../components/run/RunView";
import { useRunContext } from "../components/run/runContext";
import { useFileSurfaces } from "./FilesView";
import { boardAt } from "./viewState";

/**
 * The Tasks room's middle column (`.tasks-view > .col.mid`, `App.tsx`): one board per project group,
 * each after its own address bar but the first, or the run the address has drilled into (`RunView`,
 * `components/run/`).
 * The props each board gets are the ones `App.tsx` hands its own, from the same store.
 *
 *   .tasks-view .col.mid            a column on --bg that scrolls (both ways) while every project is listed
 *   .board-group                    column, a --line under it; its own height while listing (`flex: none`),
 *                                   the column's when narrowed to one project
 *   .board-group > .doc-bar         the group's address bar: `TaskAddressBar` standing on that group
 *                                   (`place="section"`), every group's but the first, and none when narrowed
 *   .board-tail                     a column's height of room past the last group, while there are several
 *   p.empty                         "Open a project to see its board." / "No board here yet.": the body's
 *                                   13/12.5 on --dim, padding 8 0, the paragraph's 1em margins
 *
 * Which group the column is scrolled to is `App.tsx`'s `trackBoards`: the last group whose top has
 * reached the column's, told to the title bar through `viewState.boardAt`. Not copied: the right-click
 * menus.
 */
export function BoardColumn(): JSX.Element {
  const t = useTokens();
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const groups = useMemo(() => groupProjects(state.projects, ui.groupWorkspaces !== false), [state.projects, ui.groupWorkspaces]);
  // The board's selection, one task or a set (`pickCard`), as `App.tsx` keeps it.
  const [picked, setPicked] = useState<BoardPick>(null);
  const pickedSet = useMemo(() => (picked === null ? null : new Set(picked.ids)), [picked]);
  // A selection made somewhere other than the board replaces the set.
  useEffect(() => {
    setPicked((was) => (was !== null && state.selected !== null && !was.ids.includes(state.selected) ? null : was));
  }, [state.selected]);
  // `.board-tail` is 100% of the column: the scroller's own height, measured.
  const [height, setHeight] = useState(0);
  const scroller = useRef<ScrollView>(null);
  /** The projects as the address bar names them: a workspace by its group's name. */
  const namedProjects = useMemo(() => state.projects.map((p) => ({ ...p, label: groupOf(groups, p.project)?.label ?? p.label })), [state.projects, groups]);
  // `trackBoards`: each group's top in the column's content, and how far the column is scrolled.
  const tops = useRef(new Map<string, number>());
  const scrolled = useRef(0);
  const track = useCallback(() => {
    // The LAST group whose top has passed the column's: the one under the bar.
    let at: string | null = null;
    let best = -Infinity;
    for (const [key, top] of tops.current) {
      if (top - scrolled.current <= 1 && top > best) {
        at = key;
        best = top;
      }
    }
    boardAt.set(at);
  }, []);
  // Groups arriving, or being narrowed away, move the boundaries without a scroll (as `App.tsx` re-measures).
  useEffect(track, [track, state.projects, state.boards, state.taskFocus]);
  // What a drilled run reads from (`App.tsx`'s `surfaces`), for `RunView`.
  const runContext = { ...useFileSurfaces(), ...useRunContext() };

  // A RUN is on the path, so the column shows that run — its executions as cards, or what it said.
  if (state.trail.length > 0 && state.taskFocus !== null) {
    return (
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column" backgroundColor={t.v("bg") as never}>
        <RunView context={runContext} />
      </View>
    );
  }

  const pickTask = (project: string, taskId: string, e?: Mods): void => {
    const next = pickCard(picked, project, taskId, e, () => boardCardOrderOf(state.boards[project]).map((c) => c.taskId));
    setPicked(next.picked);
    if (next.select !== undefined) actions.select(next.select, project);
  };
  const narrowed = state.taskFocus !== null;
  const shown = groups.filter((g) => state.taskFocus === null || g.members.some((m) => m.project === state.taskFocus));
  // Groups narrowed away, or gone, are no longer places the column can stand on.
  for (const key of [...tops.current.keys()]) if (!shown.some((g) => g.key === key)) tops.current.delete(key);
  const empty = (words: string): JSX.Element => (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {words}
    </Txt>
  );
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      // On web it scrolls both ways, as `.col.mid` does.
      style={{ flex: 1, backgroundColor: t.v("bg") as string, ...(isWeb ? { overflowX: "auto" } : {}) } as never}
      contentContainerStyle={{ flexGrow: 1, flexDirection: "column" }}
      scrollEventThrottle={16}
      onScroll={(e) => {
        scrolled.current = e.nativeEvent.contentOffset.y;
        track();
      }}
      ref={scroller}
      testID="board-column"
      // On web the layout event rounds to whole pixels (`offsetHeight`); the desktop's tail is the exact
      // height, and half a pixel moves every rule under it on a fractional-scale screen.
      onLayout={(e) => {
        const node = isWeb ? (scroller.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.() : null;
        setHeight(node?.getBoundingClientRect().height ?? e.nativeEvent.layout.height);
      }}
    >
      {state.projects.length === 0 ? empty("Open a project to see its board.") : null}
      {shown.map((g, i) => {
        // One board for the project's workspaces, merged by column (decision 0013 §4).
        const board = markQueued(mergeBoards(g, state.boards), state.queue);
        const own = (card: { project?: string }): string => card.project ?? g.key;
        const owner = (taskId: string): string =>
          [...(board?.columns.flatMap((c) => c.cards) ?? []), ...(board?.atLevel ?? []), ...(board?.finished ?? [])].find((c) => c.taskId === taskId)?.project ?? g.key;
        const holds = (project: string | null | undefined): boolean => g.members.some((m) => m.project === project);
        return (
          <View
            key={g.key}
            flexDirection="column"
            {...(narrowed ? { flexGrow: 1, flexShrink: 1, minHeight: 0 } : { flexShrink: 0 })}
            {...(edge(t, { bottom: 1 }) as object)}
            onLayout={(e) => {
              tops.current.set(g.key, e.nativeEvent.layout.y);
              track();
            }}
          >
            {/* A header per section but the first, and none when narrowed: the title bar's address is it. */}
            {i > 0 && state.taskFocus === null ? (
              <TaskAddressBar
                place="section"
                projects={namedProjects}
                focus={null}
                at={g.key}
                boards={state.boards}
                trail={[]}
                seen={ui.seen}
                onSeen={actions.markProjectSeen}
                onFocus={actions.focusProject}
                onDrill={actions.drillProject}
                onWalkBack={actions.walkBackTo}
                onOpenProject={() => void actions.chooseProject("open")}
              />
            ) : null}
            {board !== null ? (
              <Board
                board={board}
                selected={holds(state.selectedProject) ? state.selected : null}
                selectedSet={picked !== null && holds(picked.project) ? pickedSet! : undefined}
                numbered={board.level !== ""}
                onSelectTask={(taskId, e) => pickTask(owner(taskId), taskId, e)}
                onOpenAt={(taskId, stateId) => {
                  setPicked({ project: owner(taskId), ids: [taskId], anchor: taskId });
                  actions.select(taskId, owner(taskId), stateId ?? null);
                }}
                onSelectColumn={(stateId) => actions.selectWorkflow(stateId, g.key)}
                selectedColumn={state.taskWorkflowProject === g.key ? state.taskWorkflow : null}
                onDrill={(level) => {
                  for (const m of g.members) actions.drillProject(m.project, level);
                }}
                onOpenTask={(card) => actions.openTask(card.taskId, own(card), board.level === "" ? card.workflow : board.level)}
                connect={{
                  onMove: (card, move, confirmed) => void actions.connectTask(own(card), card.taskId, move.target, { path: move.path, ...(confirmed === true ? { confirmed: true } : {}) }),
                  undoable: undoableOn(board),
                  onUndo: (taskId) => void actions.undoConnect(taskId, owner(taskId)),
                }}
              />
            ) : (
              empty("No board here yet.")
            )}
          </View>
        );
      })}
      {/* Room to scroll past the end, so the last group can reach the top of the column. */}
      {state.taskFocus === null && groups.length > 1 ? <View flexShrink={0} height={height} /> : null}
    </ScrollView>
  );
}
