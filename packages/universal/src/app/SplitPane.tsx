import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { isConversation } from "@jaira/shared/browser";
import { kindWordOf, topOf, type PanelEntry, type PanelStack } from "@jaira/ui/panelStack";
import { closeSplit, focusOn, historyOf, leaveRight, leftEntryOf, leftMoved, onRight, publishedOfEntry, rightWidthOf, showTab, splitFits, swapRight, taskOfEntry, walkTo, SPLIT_PANE_MIN, type PaneSide } from "@jaira/ui/splitModel";
import { PANE, paneDefault, paneOf } from "@jaira/ui/uiState";
import { Splitter } from "../components/files/Splitter";
import { anchorRectOf } from "../components/floats/anchor";
import { ContextMenu, type MenuAt } from "../components/Menu";
import { panelOnStack } from "../components/panel/panelBridge";
import { SidePanel, SpIcon, type PanelFace } from "../components/panel/SidePanel";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { useRoomWidth } from "./columnsFit";
import { openInPanel, placeEntry, surfaceOf } from "./places";
import { useShell } from "./shell";
import { artifactInMain, splitTitle, splitView } from "./viewState";
import { usePhone } from "./phone";

/**
 * A split (decision 0025): the room's middle column as two panes. The left is the room's own column
 * (`LeftPane`, round what each room draws there); the right is a path of its own — a panel stack, drawn
 * by the same faces as the side panel in the panel's frame (`SidePanel`'s `pane`) — drawn by the panel
 * column before its own splitter (`PanelColumn.tsx`), so its faces get the panel's host over its stack.
 * How it looks:
 *
 *   the divider      the splitter between the panes (`files/Splitter.tsx`); it sizes the right pane,
 *                    kept as `PANE.splitRight`, never so wide the left goes under 360
 *   the right pane   --bg-panel's --panel, a column; the panel's head (‹ › always, the trail, the name),
 *                    then ⋯ and ✕ where the panel's pin, fold and close are
 *   focus            the pane last pressed in: a 2px --accent line along its top, an inset shadow over
 *                    what it shows (`FocusLine`) — never a coloured left edge
 *   narrow           too narrow for two panes of 360 and the divider (`splitFits`): one pane, the two
 *                    as tabs over it (`SplitTabs`), a dot on the hidden one when what it shows changed
 *   ⋯                Swap the panes, Only this pane, Move to the side panel, Close this pane (a
 *                    `ContextMenu`, through the menu layer)
 */

/** Which pane a press landed in: it is focused. A capture, so whatever the press is on still gets it. */
function focusProps(side: PaneSide): Record<string, unknown> {
  const focus = (): void => splitView.set(focusOn(splitView.get(), side));
  return isWeb
    ? { onPointerDownCapture: focus }
    : {
        onStartShouldSetResponderCapture: () => {
          focus();
          return false;
        },
      };
}

/** The focused pane's line: 2px of --accent along its top, an inset shadow over what the pane shows. */
function FocusLine(): JSX.Element {
  const t = useTokens();
  return <View position="absolute" top={0} left={0} right={0} height={2} zIndex={11} pointerEvents="none" {...({ boxShadow: `inset 0 2px 0 ${String(t.v("accent"))}` } as object)} />;
}

/** Whether the room is too narrow for two panes, while it is split. */
function useNarrow(): boolean {
  const room = useRoomWidth();
  return !splitFits(room);
}

/**
 * The two panes as tabs, while the room cannot hold both (decision 0025, chosen: board 14). How it looks:
 * a row, a --line under, padding 0 8; a tab padding 7 10 6, 2px under it (--accent on the one shown),
 * --dim (--text shown); the hidden one's dot 6 round, --accent, after its name.
 */
function SplitTabs({ shown, right }: { shown: PaneSide; right: string }): JSX.Element {
  const t = useTokens();
  const split = splitView.use();
  const tab = (side: PaneSide, label: string): JSX.Element => {
    const on = shown === side;
    return (
      <Press
        key={side}
        role="tab"
        aria-selected={on}
        label={label}
        onPress={() => splitView.set(showTab(splitView.get(), side))}
        flexDirection="row"
        alignItems="center"
        gap={6}
        paddingTop={7}
        paddingHorizontal={10}
        paddingBottom={6}
        maxWidth="50%"
        marginBottom={-1}
        {...(edge(t, { bottom: 2 }, on ? String(t.v("accent")) : "rgba(0, 0, 0, 0)") as object)}
      >
        {({ hovered }) => (
          <>
            <Txt spec={{ voice: "app", scale: 0.98, weight: 500, color: on || hovered ? "text" : "dim" }} ellip minWidth={0}>
              {label}
            </Txt>
            {!on && split.changed === side ? <View width={6} height={6} borderRadius={3} backgroundColor={t.v("accent") as never} flexShrink={0} aria-label="changed" /> : null}
          </>
        )}
      </Press>
    );
  };
  return (
    <View role="tablist" flexDirection="row" paddingHorizontal={8} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
      {tab("left", "Main view")}
      {tab("right", right)}
    </View>
  );
}

/**
 * The left pane: the room's middle column, as it always was — focused by a press in it, marked while the
 * column is split, and hidden behind its tab while the room is too narrow for both. `at` is what the
 * column stands on: when it moves while hidden, its tab is marked.
 */
export function LeftPane({ at, children, ...box }: { at?: string | null | undefined; children: ReactNode } & Record<string, unknown>): JSX.Element {
  const split = splitView.use();
  const narrow = useNarrow();
  const phone = usePhone();
  const splitOn = split.right !== null && !phone;
  useEffect(() => {
    splitView.set(leftMoved(splitView.get()));
  }, [at]);
  const rightTitle = splitTitle.use();
  const hidden = splitOn && narrow && split.tab === "right";
  return (
    <View flex={1} minWidth={0} minHeight={0} position="relative" {...(splitOn ? focusProps("left") : {})} {...((hidden ? { display: "none" } : {}) as object)} {...((isWeb ? { dataSet: { place: "main" } } : {}) as object)}>
      {splitOn && narrow ? <SplitTabs shown="left" right={rightTitle} /> : null}
      <View flex={1} minWidth={0} minHeight={0} position="relative" {...box}>
        {children}
      </View>
      {splitOn && !narrow && split.focus === "left" ? <FocusLine /> : null}
    </View>
  );
}

/**
 * Where something leaves the right pane for the main view: an artifact over it; a task by the room that
 * shows it (a conversation in Chat, anything else in Tasks); a state in Files; a value in the side panel,
 * which is where a value is read on its own.
 */
export function useToMain(): (entry: PanelEntry) => void {
  const { state, actions } = useShell();
  return (entry) => {
    const task = taskOfEntry(entry);
    if (task !== undefined) {
      const conversation = state.allConversations.some((c) => c.taskId === task.taskId) || (state.detail?.taskId === task.taskId && isConversation(state.detail));
      if (conversation) {
        actions.setView("chat");
        actions.openConversation(task.taskId, task.project);
      } else {
        actions.setView("tasks");
        actions.select(task.taskId, task.project);
      }
      return;
    }
    if (entry.kind === "state" || entry.kind === "config") {
      actions.setView("files");
      actions.selectState(entry.stateId, { run: false });
      return;
    }
    const published = publishedOfEntry(entry);
    if (published !== undefined) {
      artifactInMain.set({ published: published.ref, artifacts: surfaceOf(published.ref.taskId, published.project) });
      return;
    }
    openInPanel(entry);
  };
}

/** A float's place from a press: under the control pressed, else at the press. */
function menuPointOf(e: GestureResponderEvent): { x: number; y: number } {
  const rect = anchorRectOf((e as unknown as { currentTarget?: unknown }).currentTarget);
  return rect !== null ? { x: rect.left, y: rect.bottom + 3 } : { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 12 };
}

/**
 * The right pane, with the divider before it — drawn while the column is split, by the panel column
 * (`PanelColumn.tsx`), which hands it the faces.
 */
export function SplitPane({ face }: { face: (entry: PanelEntry) => PanelFace }): JSX.Element | null {
  const t = useTokens();
  const { state, actions } = useShell();
  const split = splitView.use();
  const room = useRoomWidth();
  const narrow = !splitFits(room);
  const toMain = useToMain();
  const phone = usePhone();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const right = split.right;
  const top = right === null ? undefined : topOf(right);
  const topFace = top === undefined ? undefined : face(top);
  const rightTitle = topFace?.titleText ?? "Split";
  // What the left pane's tab strip calls this one while narrow.
  useEffect(() => splitTitle.set(rightTitle), [rightTitle]);
  if (right === null || top === undefined || phone) return null;
  const onStack = (step: (stack: PanelStack) => PanelStack): void => splitView.set(onRight(splitView.get(), step));
  const ui = state.settings.ui;
  const width = rightWidthOf(paneOf(ui, PANE.splitRight), room);
  const hidden = narrow && split.tab === "left";

  const leftEntry = (): PanelEntry | null => {
    const main = artifactInMain.get();
    if (main !== null) {
      const project = main.artifacts.project;
      const title = main.published.title ?? main.published.entry;
      return { kind: "preview", key: `preview:${title}`, preview: { title, published: { ref: main.published, ...(project !== undefined ? { project } : {}) } } };
    }
    return leftEntryOf(state.view, {
      chatTaskId: state.chat.taskId,
      chatProject: state.chat.project ?? undefined,
      selected: state.selected,
      selectedProject: state.selectedProject ?? undefined,
      stateId: state.stateId,
      docStateId: state.doc?.stateId,
      project: state.at,
    });
  };
  const paneMenu = (e: GestureResponderEvent): void =>
    setMenu({
      ...menuPointOf(e),
      items: [
        {
          label: "Swap the panes",
          onSelect: () => {
            const was = leftEntry();
            if (artifactInMain.get() !== null) artifactInMain.set(null);
            splitView.set(swapRight(splitView.get(), was));
            placeEntry("main", top, toMain, phone);
          },
        },
        {
          // The right pane's content becomes the main view, and the column is one again.
          label: "Only this pane",
          onSelect: () => {
            splitView.set(closeSplit());
            placeEntry("main", top, toMain, phone);
          },
        },
        {
          label: "Move to the side panel",
          disabled: panelOnStack.get() === null,
          onSelect: () => {
            if (publishedOfEntry(top) === undefined) splitView.set(leaveRight(splitView.get()));
            placeEntry("panel", top, toMain, phone);
          },
        },
        { label: "Close this pane", separator: true, onSelect: () => splitView.set(closeSplit()) },
      ],
    });
  const pathMenu = (e: GestureResponderEvent): void =>
    setMenu({
      ...menuPointOf(e),
      title: "This pane's path",
      items: historyOf(right).map((line) => ({
        label: face(line.entry).titleText,
        note: line.offset === 0 ? `${kindWordOf(line.entry)} · here` : kindWordOf(line.entry),
        checked: line.offset === 0,
        onSelect: () => onStack((was) => walkTo(was, line.offset)),
      })),
    });
  const controls = (
    <View flexDirection="row" alignItems="center" gap={1} flexShrink={0} paddingLeft={6} marginLeft={2} {...(edge(t, { left: 1 }) as object)}>
      <Press onPress={paneMenu} label="This pane's menu" title="This pane's menu" {...({ "aria-haspopup": "menu" } as object)} width={26} height={26} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 1.1, color: hovered ? "text" : "dim" }} lineHeight={16}>
            ⋯
          </Txt>
        )}
      </Press>
      <SpIcon icon="cross" label="Close this pane" onPress={() => splitView.set(closeSplit())} />
    </View>
  );
  return (
    <>
      {!narrow ? (
        <Splitter label="Resize the split" value={width} reset={paneDefault(PANE.splitRight)} invert min={SPLIT_PANE_MIN} max={Math.max(SPLIT_PANE_MIN, room - SPLIT_PANE_MIN - 6)} onChange={(size) => actions.setPane(PANE.splitRight, size)} />
      ) : null}
      <View
        {...((isWeb ? { "aria-label": "Split pane" } : {}) as object)}
        {...(narrow ? { flex: 1 } : { width })}
        flexShrink={0}
        minWidth={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        position="relative"
        backgroundColor={t.v("panel") as never}
        {...focusProps("right")}
        {...((hidden ? { display: "none" } : {}) as object)}
        {...((isWeb ? { dataSet: { place: "split" } } : {}) as object)}
      >
        {narrow ? <SplitTabs shown="right" right={rightTitle} /> : null}
        <SidePanel stack={right} onStack={onStack} face={face} folded={false} onFold={() => undefined} pane={{ controls, onPath: pathMenu }} />
        {!narrow && split.focus === "right" ? <FocusLine /> : null}
      </View>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}
