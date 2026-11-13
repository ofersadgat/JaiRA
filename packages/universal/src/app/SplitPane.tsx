import { useEffect, useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { isConversation } from "@jaira/shared/browser";
import { kindWordOf, topOf, type PanelEntry, type PanelStack } from "@jaira/ui/panelStack";
import {
  closeSplit,
  crumbTo,
  focusOn,
  historyOf,
  leavePane,
  leftMoved,
  leftWalked,
  onPane,
  onlyPane,
  openInPane,
  paneBack,
  paneForward,
  paneShows,
  publishedOfEntry,
  rightWidthOf,
  roomEntryOf,
  showTab,
  splitFits,
  swapPanes,
  taskOfEntry,
  walkTo,
  SPLIT_PANE_MIN,
  type PaneSide,
} from "@jaira/ui/splitModel";
import { PANE, paneDefault, paneOf } from "@jaira/ui/uiState";
import { Splitter } from "../components/files/Splitter";
import { anchorRectOf } from "../components/floats/anchor";
import { ContextMenu, type MenuAt } from "../components/Menu";
import { panelOnStack } from "../components/panel/panelBridge";
import { PanelEmpty } from "../components/panel/PanelViews";
import { SpIcon, type PanelFace } from "../components/panel/SidePanel";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { useRoomWidth } from "./columnsFit";
import { PaneBody } from "./PaneBody";
import { openInPanel, placeEntry, surfaceOf } from "./places";
import { useShell } from "./shell";
import { artifactInMain, paneFaces, paneTitles, splitView } from "./viewState";
import { usePhone } from "./phone";

/**
 * A split (decision 0025, as the person corrected it 2026-11-13: "07 and 09 are the correct design for
 * split view panels"): the room's middle column as two EQUAL panes, each a main view with a path of its
 * own (`splitModel.ts`). The left stands on the room — what the Tasks, Files or Chat room shows — with
 * whatever was put on top of it; the right on its own path from its root. Each draws what its path
 * stands on as the main column would (`PaneBody`): a conversation is the thread with its composer, an
 * artifact the artifact. The left is the room's column wrapped (`LeftPane`); the right is drawn by the
 * panel column before its own splitter (`PanelColumn.tsx`). How it looks:
 *
 *   a pane's head    row, centred, gap 4, at least 40 tall, padding 0 6, a --line under (`PaneHead`):
 *                    ‹ and › (26 square; --dim, at 0.4 where there is nowhere to go), the pane's path as
 *                    crumbs, then ⋯ and ✕. While split, the room's address is the left pane's crumbs,
 *                    not the window's title bar's (`TitleBar.tsx`)
 *   the crumbs       row, centred, gap 5, padding-left 4, app 12/12.5, --dim, one line, clipped; each
 *                    but the last a link back to it (--accent underlined hovered); the last 600 --text;
 *                    an artifact's crumb led by its 16 glyph box (--panel-3, --accent). Pressing the
 *                    last, or holding ‹, lists "This pane's path" (`historyOf`), newest first, here marked
 *   the divider      the splitter between the panes (`files/Splitter.tsx`); it sizes the right pane,
 *                    kept as `PANE.splitRight`, never so wide the left goes under 360
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
function SplitTabs({ shown }: { shown: PaneSide }): JSX.Element {
  const t = useTokens();
  const split = splitView.use();
  const titles = paneTitles.use();
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
      {tab("right", titles.right)}
    </View>
  );
}

/** The room's place in words, the bottom of the left pane's path: the room, and what it stands on. */
function useRoomCrumbs(): string[] {
  const { state } = useShell();
  if (state.view === "chat") {
    const taskId = state.chat.taskId;
    const title = taskId === null ? "New conversation" : (state.allConversations.find((c) => c.taskId === taskId)?.title ?? (state.detail?.taskId === taskId ? state.detail.title : undefined));
    return ["Chat", ...(title !== undefined ? [title] : [])];
  }
  if (state.view === "files") {
    const path = state.doc?.path ?? state.dir?.path;
    return ["Files", ...(path !== undefined ? [path.split(/[\\/]/).filter(Boolean).pop() ?? path] : [])];
  }
  const title = state.detail !== null && state.detail.taskId === state.selected ? state.detail.title : undefined;
  return ["Tasks", ...(title !== undefined ? [title] : [])];
}

/** What the room under the left pane stands on, as an entry: an artifact drawn over it, else its selection. */
function useRoomEntry(): () => PanelEntry | null {
  const { state } = useShell();
  return () => {
    const main = artifactInMain.get();
    if (main !== null) {
      const project = main.artifacts.project;
      const title = main.published.title ?? main.published.entry;
      return { kind: "preview", key: `preview:${title}`, preview: { title, published: { ref: main.published, ...(project !== undefined ? { project } : {}) } } };
    }
    return roomEntryOf(state.view, {
      chatTaskId: state.chat.taskId,
      chatProject: state.chat.project ?? undefined,
      selected: state.selected,
      selectedProject: state.selectedProject ?? undefined,
      stateId: state.stateId,
      docStateId: state.doc?.stateId,
      project: state.at,
    });
  };
}

/**
 * Where something leaves a pane for the main view with no split: an artifact over it; a task by the
 * room that shows it (a conversation in Chat, anything else in Tasks); a state in Files; a value in the
 * side panel, which is where a value is read on its own.
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

/** An artifact's crumb glyph, as its title bar draws it. */
function crumbGlyphOf(entry: PanelEntry): string | undefined {
  const published = publishedOfEntry(entry);
  if (published === undefined) return undefined;
  return published.ref.kind === "canvas" ? "◫" : published.ref.kind === "markdown" ? "¶" : "▥";
}

/** One crumb of a pane's path: what it says, and where pressing it goes (absent: the last, which lists the path). */
interface Crumb {
  key: string;
  label: string;
  glyph?: string | undefined;
  to?: (() => void) | undefined;
}

/**
 * A pane's head (boards 07 and 09): ‹ › and the pane's path as crumbs, then the pane's ⋯ and ✕. The same
 * for both panes. ‹ held, or the last crumb pressed, lists the path.
 */
function PaneHead({ side, stack, crumbs, onStack, onPath, onMenu, onClose }: { side: PaneSide; stack: PanelStack; crumbs: readonly Crumb[]; onStack: (step: (stack: PanelStack) => PanelStack) => void; onPath: (e: GestureResponderEvent) => void; onMenu: (e: GestureResponderEvent) => void; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const canBack = stack.entries.length > (side === "right" ? 1 : 0);
  const next = stack.ahead[0];
  return (
    <View role="toolbar" aria-label={side === "left" ? "Left pane" : "Right pane"} flexDirection="row" alignItems="center" gap={4} minHeight={40} paddingHorizontal={6} flexShrink={0} minWidth={0} {...(edge(t, { bottom: 1 }) as object)}>
      <SpIcon icon="back" label="Back" disabled={!canBack} onPress={() => onStack((was) => paneBack(was, side))} onLongPress={onPath} />
      <SpIcon icon="back" flip label="Forward" disabled={next === undefined} onPress={() => onStack(paneForward)} />
      <View role="navigation" aria-label="This pane's path" flexDirection="row" alignItems="center" gap={5} paddingLeft={4} minWidth={0} flexShrink={1} overflow="hidden">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <View key={crumb.key} flexDirection="row" alignItems="center" gap={5} minWidth={0} flexShrink={last ? 1 : 0}>
              {i > 0 ? <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>›</Txt> : null}
              {crumb.glyph !== undefined ? (
                <View width={16} height={16} borderRadius={4} backgroundColor={t.v("panel-3") as never} alignItems="center" justifyContent="center" flexShrink={0}>
                  <Text color={t.v("accent") as never} fontSize={10}>
                    {crumb.glyph}
                  </Text>
                </View>
              ) : null}
              {last ? (
                <Press onPress={onPath} label={`${crumb.label}: this pane's path`} title="This pane's path" {...({ "aria-haspopup": "menu" } as object)} minWidth={0} flexShrink={1}>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "text" }} ellip>
                    {crumb.label}
                  </Txt>
                </Press>
              ) : crumb.to !== undefined ? (
                <Press onPress={crumb.to} label={`Back to ${crumb.label}`} title={`Back to ${crumb.label}`} maxWidth={160}>
                  {({ hovered }) => (
                    <Txt spec={{ voice: "app", scale: 12 / 12.5, color: hovered ? "accent" : "dim" }} ellip {...(hovered ? { textDecorationLine: "underline" } : {})}>
                      {crumb.label}
                    </Txt>
                  )}
                </Press>
              ) : (
                <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }} ellip maxWidth={160}>
                  {crumb.label}
                </Txt>
              )}
            </View>
          );
        })}
      </View>
      <View flex={1} minWidth={8} />
      <Press onPress={onMenu} label="This pane's menu" title="This pane's menu" {...({ "aria-haspopup": "menu" } as object)} width={26} height={26} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 1.1, color: hovered ? "text" : "dim" }} lineHeight={16}>
            ⋯
          </Txt>
        )}
      </Press>
      <SpIcon icon="cross" label="Close this pane" onPress={onClose} />
    </View>
  );
}

/**
 * A pane's head and menus: its crumbs, its path menu, its ⋯ menu — the same for both panes, about the
 * pane on `side`.
 */
function usePaneHead(side: PaneSide, face: ((entry: PanelEntry) => PanelFace) | null): { head: ReactNode; menu: ReactNode } | null {
  const split = splitView.use();
  const phone = usePhone();
  const roomCrumbs = useRoomCrumbs();
  const roomEntry = useRoomEntry();
  const toMain = useToMain();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const stack = side === "left" ? split.left : split.right;
  const titleOf = (entry: PanelEntry): string => (face !== null ? face(entry).titleText : entry.kind === "preview" ? entry.preview.title : entry.key);
  const crumbs: Crumb[] =
    stack === null
      ? []
      : [
          ...(side === "left"
            ? roomCrumbs.map((label, i) => ({ key: `room:${String(i)}`, label, ...(stack.entries.length > 0 && i === roomCrumbs.length - 1 ? { to: () => onStack((was) => crumbTo(was, -1)) } : {}) }))
            : []),
          ...stack.entries.map((entry, i) => ({ key: entry.key, label: titleOf(entry), glyph: crumbGlyphOf(entry), to: () => onStack((was) => crumbTo(was, i)) })),
        ];
  const shown = crumbs.at(-1)?.label ?? "";
  useEffect(() => {
    const was = paneTitles.get();
    if (was[side] !== shown) paneTitles.set({ ...was, [side]: shown });
  }, [side, shown]);
  if (stack === null) return null;
  function onStack(step: (stack: PanelStack) => PanelStack): void {
    splitView.set(onPane(splitView.get(), side, step));
  }
  const onPath = (e: GestureResponderEvent): void =>
    setMenu({
      ...menuPointOf(e),
      title: "This pane's path",
      items: historyOf(stack, side).map((line) => ({
        label: line.entry === null ? roomCrumbs.join(" › ") : titleOf(line.entry),
        note: `${line.entry === null ? roomCrumbs[0]!.toLowerCase() : kindWordOf(line.entry)}${line.offset === 0 ? " · here" : ""}`,
        checked: line.offset === 0,
        onSelect: () => onStack((was) => walkTo(was, line.offset)),
      })),
    });
  const closeThis = (): void => splitView.set(side === "right" ? closeSplit(splitView.get()) : onlyPane(splitView.get(), "right"));
  const onMenu = (e: GestureResponderEvent): void => {
    const now = splitView.get();
    const showing = paneShows(now, side, roomEntry());
    setMenu({
      ...menuPointOf(e),
      items: [
        {
          label: "Swap the panes",
          disabled: now.right === null,
          onSelect: () => {
            const room = roomEntry();
            if (artifactInMain.get() !== null) artifactInMain.set(null);
            splitView.set(swapPanes(splitView.get(), room));
          },
        },
        // The other pane closes; the right's content, kept alone, becomes the main view.
        { label: "Only this pane", disabled: now.right === null, onSelect: () => splitView.set(onlyPane(splitView.get(), side)) },
        {
          label: "Move to the side panel",
          disabled: panelOnStack.get() === null || showing === null,
          onSelect: () => {
            if (showing === null) return;
            // An artifact leaves its pane by its own move; anything else on the pane's path is taken off
            // it (the room under the left stays where it is).
            if (publishedOfEntry(showing) === undefined) splitView.set(leavePane(splitView.get(), side));
            placeEntry("panel", showing, toMain, phone);
          },
        },
        { label: "Close this pane", separator: true, disabled: now.right === null, onSelect: closeThis },
      ],
    });
  };
  return {
    head: <PaneHead side={side} stack={stack} crumbs={crumbs} onStack={onStack} onPath={onPath} onMenu={onMenu} onClose={closeThis} />,
    menu: menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null,
  };
}

/**
 * The left pane: the room's middle column, as it always was — and, once something is put on top of it
 * (a drop, Swap, Only this pane), that, drawn as the main view draws it, ‹ going back to the room, which
 * stays mounted under it. It has its head while the column is split or while it has a path to walk; it
 * is focused by a press in it, and hidden behind its tab while the room is too narrow for both. `at` is
 * what the room stands on: when it moves, what was on top of it goes.
 */
export function LeftPane({ at, children, ...box }: { at?: string | null | undefined; children: ReactNode } & Record<string, unknown>): JSX.Element {
  const split = splitView.use();
  const narrow = useNarrow();
  const phone = usePhone();
  const faces = paneFaces.use();
  const splitOn = split.right !== null && !phone;
  useEffect(() => {
    splitView.set(leftMoved(splitView.get()));
  }, [at]);
  const pane = usePaneHead("left", faces?.left ?? null);
  const top = topOf(split.left);
  const headed = !phone && (splitOn || leftWalked(split));
  const hidden = splitOn && narrow && split.tab === "right";
  return (
    <View flex={1} minWidth={0} minHeight={0} position="relative" flexDirection="column" {...(splitOn ? focusProps("left") : {})} {...((hidden ? { display: "none" } : {}) as object)} {...((isWeb ? { "data-place": "main" } : {}) as object)}>
      {splitOn && narrow ? <SplitTabs shown="left" /> : null}
      {headed ? pane?.head : null}
      <View flex={1} minWidth={0} minHeight={0} position="relative" {...box}>
        {/* The room stays mounted under what is on top of it: back finds it where it was. */}
        <View flex={1} minWidth={0} minHeight={0} position="relative" flexDirection={box["flexDirection"] === "row" ? "row" : "column"} {...((top !== undefined ? { display: "none" } : {}) as object)}>
          {children}
        </View>
        {top !== undefined ? faces === null ? <PanelEmpty>Opening…</PanelEmpty> : <PaneBody key={top.key} entry={top} face={faces.left} onOpen={(entry) => splitView.set(openInPane(splitView.get(), "left", entry))} /> : null}
      </View>
      {splitOn && !narrow && split.focus === "left" ? <FocusLine /> : null}
      {pane?.menu}
    </View>
  );
}

/**
 * The right pane, with the divider before it — drawn while the column is split, by the panel column
 * (`PanelColumn.tsx`), whose host makes the faces it draws a state or a value with.
 */
export function SplitPane(): JSX.Element | null {
  const t = useTokens();
  const { state, actions } = useShell();
  const split = splitView.use();
  const faces = paneFaces.use();
  const room = useRoomWidth();
  const narrow = !splitFits(room);
  const phone = usePhone();
  const pane = usePaneHead("right", faces?.right ?? null);
  const right = split.right;
  const top = right === null ? undefined : topOf(right);
  if (right === null || top === undefined || phone || pane === null) return null;
  const width = rightWidthOf(paneOf(state.settings.ui, PANE.splitRight), room);
  const hidden = narrow && split.tab === "left";
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
        backgroundColor={t.v("bg") as never}
        {...focusProps("right")}
        {...((hidden ? { display: "none" } : {}) as object)}
        {...((isWeb ? { "data-place": "split" } : {}) as object)}
      >
        {narrow ? <SplitTabs shown="right" /> : null}
        {pane.head}
        {faces === null ? <PanelEmpty>Opening…</PanelEmpty> : <PaneBody key={top.key} entry={top} face={faces.right} onOpen={(entry) => splitView.set(openInPane(splitView.get(), "right", entry))} />}
        {!narrow && split.focus === "right" ? <FocusLine /> : null}
      </View>
      {pane.menu}
    </>
  );
}
