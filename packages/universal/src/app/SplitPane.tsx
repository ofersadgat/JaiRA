import { Fragment, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { PanelEntry } from "@jaira/ui/panelStack";
import {
  SPLIT_PANE_MIN,
  closePane,
  focusOn,
  followOf,
  historyOf,
  isRoom,
  isSplit,
  leavePane,
  onPane,
  onlyPane,
  openInPane,
  paneBack,
  paneForward,
  pushPath,
  publishedOfEntry,
  rightWidthOf,
  ROOM,
  roomEntryOf,
  roomMoved,
  roomPaneOf,
  showTab,
  splitFits,
  swapPanes,
  topOfPath,
  trailOf,
  walkTo,
  type PaneEntry,
  type PanePath,
} from "@jaira/ui/splitModel";
import { PANE, PANEL_RAIL, paneDefault, paneOf } from "@jaira/ui/uiState";
import { Splitter } from "../components/files/Splitter";
import { anchorRectOf } from "../components/floats/anchor";
import { ContextMenu, type MenuAt } from "../components/Menu";
import { panelOnStack } from "../components/panel/panelBridge";
import { PanelEmpty } from "../components/panel/PanelViews";
import { SpIcon } from "../components/panel/SidePanel";
import { DRAG_REGION, DragStrip, NO_SELECT, Press, Txt, WINDOW_GUTTER, edge } from "../primitives";
import { useTokens } from "../tokens";
import { useColumnsFit, useRoomWidth } from "./columnsFit";
import { PaneBody } from "./PaneBody";
import { openInPanel, placeEntry } from "./places";
import { useShell } from "./shell";
import { RoomAddress, ShellSidebarToggle } from "./TitleBar";
import { paneFaces, paneTitles, panelOpenWidth, splitView } from "./viewState";
import { usePhone } from "./phone";

/**
 * The middle column as PANES (decision 0025, as the person ruled 2026-11-13: "both panels should be fully
 * self contained. I.e. their ui should be identical. You should be able to close either of them."): one,
 * or two side by side, each a main view with a path of its own (`splitModel.ts`). They are one component,
 * `Pane`, drawn once or twice; nothing in it is about which side it stands on but its place in the row
 * and the divider before the second. The room's own view (what the Tasks, Files or Chat room draws) is
 * an entry on the path of whichever pane holds it — at most one — and stays mounted under what is put on
 * top of it. How it looks:
 *
 *   a pane's head    row, centred, gap 4, at least 40 tall, padding 0 6, a --line under (`PaneHead`):
 *                    on the pane at the window's left the sidebar's toggle (`|◂` / `▸|`, 26 square),
 *                    ‹ and › (26 square; --dim, at 0.4 where there is nowhere to go) walking its history, where it stands as crumbs,
 *                    what stands on top's own controls, ⋯, and ✕ while split. Drawn while split, or while
 *                    the pane's path is more than the room; else the window's title bar says the room's
 *                    place, as it always did
 *   the crumbs       row, centred, gap 5, padding-left 4, app 12/12.5, --dim, one line, clipped; each
 *                    but the last a link to it (its conversation, its task) (--accent underlined hovered); the last 600 --text;
 *                    an artifact's crumb led by its 16 glyph box (--panel-3, --accent). Pressing the
 *                    last, or holding ‹, lists "This pane's history" (newest first, here marked). The room on
 *                    top is its own address (`RoomAddress`: the Tasks room's crumbs, its run reading
 *                    toggle and New task; the conversation's name; the file's)
 *   on top's own     an artifact: its three place buttons (`PlaceButtons`), lit where it is — its body
 *                    has no title bar of its own, so it has one head on either side
 *   the divider      the splitter before the second pane (`files/Splitter.tsx`); it sizes that pane,
 *                    kept as `PANE.splitRight`, never so wide the first goes under 360
 *   focus            the pane last pressed in: a 2px --accent row along its top, above its head
 *                    (every pane has the row; the others' is clear) — never a coloured left edge
 *   narrow           too narrow for two panes of 360 and the divider (`splitFits`): one pane, the two
 *                    as tabs over it (`SplitTabs`), a dot on the hidden one when what it shows changed
 *   ⋯                Swap the panes, Only this pane, Move to the side panel, Close this pane (a
 *                    `ContextMenu`, through the menu layer) — the same on either pane
 */

/** Which pane a press landed in: it is focused. A capture, so whatever the press is on still gets it. */
function focusProps(pane: number): Record<string, unknown> {
  const focus = (): void => splitView.set(focusOn(splitView.get(), pane));
  return isWeb
    ? { onPointerDownCapture: focus }
    : {
        onStartShouldSetResponderCapture: () => {
          focus();
          return false;
        },
      };
}

/**
 * The two panes as tabs, while the room cannot hold both (decision 0025, chosen: board 14). How it looks:
 * a row, a --line under, padding 0 8; a tab padding 7 10 6, 2px under it (--accent on the one shown),
 * --dim (--text shown); the hidden one's dot 6 round, --accent, after its name. The row is the window's
 * top row then (the pane's head stands under it), so it is what the window is moved by: the whole of it
 * but the tabs (`DragStrip`), at least the 34 the top row stands at, the window's buttons kept clear
 * (`gutter`).
 */
function SplitTabs({ shown, gutter }: { shown: number; gutter: number | string }): JSX.Element {
  const t = useTokens();
  const split = splitView.use();
  const titles = paneTitles.use();
  return (
    <View role="tablist" flexDirection="row" paddingHorizontal={8} minHeight={34} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)} style={DRAG_REGION as never}>
      <DragStrip>
      {split.panes.map((_, pane) => {
        const on = shown === pane;
        const label = titles[pane] ?? "";
        return (
          <Press
            key={pane}
            role="tab"
            aria-selected={on}
            label={label}
            onPress={() => splitView.set(showTab(splitView.get(), pane))}
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
                {!on && split.changed === pane ? <View width={6} height={6} borderRadius={3} backgroundColor={t.v("accent") as never} flexShrink={0} aria-label="changed" /> : null}
              </>
            )}
          </Press>
        );
      })}
      <View flex={1} minWidth={8} alignSelf="stretch" style={DRAG_REGION as never} />
      {gutter !== 0 ? <View width={gutter as never} alignSelf="stretch" flexShrink={0} style={DRAG_REGION as never} /> : null}
      </DragStrip>
    </View>
  );
}

/** The room's place in words, as a crumb under what is put on top of it: the room, and what it stands on. */
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

/** A float's place from a press: under the control pressed, else at the press. */
function menuPointOf(e: GestureResponderEvent): { x: number; y: number } {
  const rect = anchorRectOf((e as unknown as { currentTarget?: unknown }).currentTarget);
  return rect !== null ? { x: rect.left, y: rect.bottom + 3 } : { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 12 };
}

/** An artifact's crumb glyph, as its title bar would draw it. */
function crumbGlyphOf(entry: PaneEntry): string | undefined {
  const published = publishedOfEntry(entry);
  if (published === undefined) return undefined;
  return published.ref.kind === "canvas" ? "◫" : published.ref.kind === "markdown" ? "¶" : "▥";
}

/** One crumb of a pane's path: what it says, where pressing it goes, or (the room on top) the room's own address. */
interface Crumb {
  key: string;
  label: string;
  glyph?: string | undefined;
  to?: (() => void) | undefined;
  address?: boolean;
}

/**
 * A pane's head (boards 07 and 09): ‹ › walking the pane's history, where it stands as crumbs (`trailOf`), what is on top's own controls,
 * then ⋯ and (split) ✕. The same for every pane.
 */
function PaneHead({ pane, path, crumbs, closable, lead, gutter, strip, onStep, onPath, onMenu, onClose }: {
  pane: number;
  path: PanePath;
  crumbs: readonly Crumb[];
  closable: boolean;
  /** The pane at the window's left: its head leads with the sidebar's toggle (`ShellSidebarToggle`). */
  lead: boolean;
  /** Where the OS draws the window's buttons over this head (`WINDOW_GUTTER`), kept clear. */
  gutter: number | string;
  /**
   * The head is the window's top row (not under the narrow room's tabs): the whole of it moves the
   * window but for its controls (`DragStrip`) — the address in it took all its width, and the filler
   * after it was left 8 wide.
   */
  strip: boolean;
  onStep: (step: (path: PanePath) => PanePath) => void;
  onPath: (e: GestureResponderEvent) => void;
  onMenu: (e: GestureResponderEvent) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  return (
    <View role="toolbar" aria-label="Pane" {...((isWeb ? { "data-pane-head": String(pane) } : {}) as object)} flexDirection="row" alignItems="center" gap={4} minHeight={40} paddingHorizontal={6} flexShrink={0} minWidth={0} {...(edge(t, { bottom: 1 }) as object)} style={(strip ? DRAG_REGION : NO_SELECT) as never}>
      <DragStrip on={strip}>
      {lead ? <ShellSidebarToggle /> : null}
      <SpIcon icon="back" label="Back" disabled={path.entries.length <= 1} onPress={() => onStep(paneBack)} onLongPress={onPath} />
      <SpIcon icon="back" flip label="Forward" disabled={path.ahead.length === 0} onPress={() => onStep(paneForward)} />
      <View role="navigation" aria-label="Where this pane is" flexDirection="row" alignItems="center" gap={5} paddingLeft={4} minWidth={0} flexShrink={1} flexGrow={crumbs.at(-1)?.address === true ? 1 : 0} overflow="hidden">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <View key={crumb.key} flexDirection="row" alignItems="center" gap={5} minWidth={0} flexShrink={last ? 1 : 0} {...(crumb.address === true ? { flexGrow: 1 } : {})}>
              {i > 0 ? <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>›</Txt> : null}
              {crumb.glyph !== undefined ? (
                <View width={16} height={16} borderRadius={4} backgroundColor={t.v("panel-3") as never} alignItems="center" justifyContent="center" flexShrink={0}>
                  <Text color={t.v("accent") as never} fontSize={10}>
                    {crumb.glyph}
                  </Text>
                </View>
              ) : null}
              {crumb.address === true ? (
                <View flexDirection="row" alignItems="center" flex={1} minWidth={0}>
                  <RoomAddress />
                </View>
              ) : last ? (
                <Press onPress={onPath} label={`${crumb.label}: this pane's history`} title="This pane's history" {...({ "aria-haspopup": "menu" } as object)} minWidth={0} flexShrink={1}>
                  <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "text" }} ellip>
                    {crumb.label}
                  </Txt>
                </Press>
              ) : crumb.to !== undefined ? (
                <Press onPress={crumb.to} label={`Go to ${crumb.label}`} title={`Go to ${crumb.label}`} maxWidth={160}>
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
      {/* The head's empty stretch: what the window is moved by under the narrow room's tabs too. */}
      <View flex={1} minWidth={8} alignSelf="stretch" style={DRAG_REGION as never} />
      <Press onPress={onMenu} label="This pane's menu" title="This pane's menu" {...({ "aria-haspopup": "menu" } as object)} width={26} height={26} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 1.1, color: hovered ? "text" : "dim" }} lineHeight={16}>
            ⋯
          </Txt>
        )}
      </Press>
      {closable ? <SpIcon icon="cross" label="Close this pane" onPress={onClose} /> : null}
      {gutter !== 0 ? <View width={gutter as never} alignSelf="stretch" flexShrink={0} style={DRAG_REGION as never} /> : null}
      </DragStrip>
    </View>
  );
}

/**
 * One pane: its head, and what its path stands on — the room (kept mounted under anything on top of
 * it, when this pane holds it) or an entry drawn as the main view draws it (`PaneBody`).
 */
function Pane({ pane, room, roomBox, narrow, width, lead, gutter }: { pane: number; room: ReactNode | null; roomBox: Record<string, unknown>; narrow: boolean; width: number | null; lead: boolean; gutter: number | string }): JSX.Element | null {
  const t = useTokens();
  const { state } = useShell();
  const split = splitView.use();
  const faces = paneFaces.use();
  const phone = usePhone();
  const roomCrumbs = useRoomCrumbs();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const path = split.panes[pane];
  const face = faces?.[pane] ?? null;
  const titleOf = (entry: PaneEntry): string => (isRoom(entry) ? roomCrumbs.join(" › ") : face !== null ? face(entry).titleText : entry.kind === "preview" ? entry.preview.title : entry.key);
  const top = topOfPath(path);
  const shown = top === undefined ? "" : isRoom(top) ? (roomCrumbs.at(-1) ?? "") : titleOf(top);
  useEffect(() => {
    const was = paneTitles.get();
    if (was[pane] !== shown) paneTitles.set(was.map((one, i) => (i === pane ? shown : one)).concat(was.length <= pane ? [shown] : []));
  }, [pane, shown]);
  if (path === undefined || top === undefined) return null;
  const splitOn = isSplit(split);
  const onStep = (step: (path: PanePath) => PanePath): void => splitView.set(onPane(splitView.get(), pane, step));
  // The crumbs say where what the pane shows stands (`trailOf`: an artifact under its conversation),
  // not where the pane has been — that is ‹ and ›, and the history menu. One pressed goes there, a step.
  const crumbs: Crumb[] = isRoom(top)
    ? [{ key: "room", label: roomCrumbs.join(" › "), address: true }]
    : trailOf(top).map((entry, i, all) => ({
        key: entry.key,
        label: titleOf(entry),
        glyph: crumbGlyphOf(entry),
        ...(i < all.length - 1 ? { to: () => onStep((was) => pushPath(was, entry)) } : {}),
      }));
  // A step in the history menu: the room's own view by its name when it is not what the pane shows (the
  // room's crumbs say where it stands NOW, which the start page in the history is not).
  const stepTitleOf = (entry: PaneEntry, here: boolean): string => (isRoom(entry) && !here ? (state.view === "chat" ? "New conversation" : (roomCrumbs[0] ?? "")) : titleOf(entry));
  const roomEntry = (): PanelEntry | null =>
    roomEntryOf(state.view, {
      chatTaskId: state.chat.taskId,
      chatProject: state.chat.project ?? undefined,
      selected: state.selected,
      selectedProject: state.selectedProject ?? undefined,
      stateId: state.stateId,
      docStateId: state.doc?.stateId,
      project: state.at,
    });
  const onPath = (e: GestureResponderEvent): void =>
    setMenu({
      ...menuPointOf(e),
      title: "This pane's history",
      items: historyOf(path).map((line) => ({
        label: stepTitleOf(line.entry, line.offset === 0),
        note: `${isRoom(line.entry) ? "the room" : line.entry.kind === "preview" ? "an artifact" : line.entry.kind === "state" ? "a state" : "the task"}${line.offset === 0 ? " · here" : ""}`,
        checked: line.offset === 0,
        onSelect: () => onStep((was) => walkTo(was, line.offset)),
      })),
    });
  const close = (): void => splitView.set(closePane(splitView.get(), pane));
  const onMenu = (e: GestureResponderEvent): void => {
    const carried = isRoom(top) ? roomEntry() : top;
    setMenu({
      ...menuPointOf(e),
      items: [
        { label: "Swap the panes", disabled: !splitOn, onSelect: () => splitView.set(swapPanes(splitView.get())) },
        // The other pane closes; this one is the main view, its path kept.
        { label: "Only this pane", disabled: !splitOn, onSelect: () => splitView.set(onlyPane(splitView.get(), pane)) },
        {
          label: "Move to the side panel",
          disabled: panelOnStack.get() === null || carried === null,
          onSelect: () => {
            if (carried === null) return;
            // The room stays where it is, the side panel opening on what it stands on; an artifact moves
            // by its own move; anything else is a step back in this pane's history.
            if (isRoom(top)) openInPanel(carried);
            else if (publishedOfEntry(carried) !== undefined) placeEntry("panel", carried, phone);
            else {
              splitView.set(leavePane(splitView.get(), pane));
              openInPanel(carried);
            }
          },
        },
        { label: "Close this pane", separator: true, disabled: !splitOn, onSelect: close },
      ],
    });
  };
  const hidden = splitOn && narrow && split.tab !== pane;
  return (
    <View
      {...((isWeb ? { "aria-label": "Pane", "data-pane": String(pane), "data-place": pane === 0 ? "main" : "split" } : {}) as object)}
      {...(width !== null ? { width, flexShrink: 0 } : { flex: 1 })}
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      overflow="hidden"
      position="relative"
      // Each pane is a layer of its own, on the window's ground: its text is smoothed the same way
      // whichever pane it is and whatever stands beside it (overlapping another layer changes that).
      backgroundColor={t.v("bg") as never}
      {...((isWeb ? { willChange: "transform" } : {}) as object)}
      {...(splitOn ? focusProps(pane) : {})}
      {...((hidden ? { display: "none" } : {}) as object)}
    >
      {/* The focused pane's line: a 2px row every pane has, --accent on the focused one. In the flow,
          so the panes on one path lay out alike focused or not; not a box laid over the pane, whose
          overlap paints the pane's text in another layer, nor an inset shadow, which bled a hairline
          along the pane's foot. The panes on one path are the same picture but for this row. */}
      <View height={2} flexShrink={0} backgroundColor={(splitOn && !narrow && split.focus === pane ? t.v("accent") : "transparent") as never} />
      {splitOn && narrow ? <SplitTabs shown={pane} gutter={gutter} /> : null}
      <PaneHead pane={pane} path={path} crumbs={crumbs} closable={splitOn} lead={lead} gutter={splitOn && narrow ? 0 : gutter} strip={!(splitOn && narrow)} onStep={onStep} onPath={onPath} onMenu={onMenu} onClose={close} />
      <View flex={1} minWidth={0} minHeight={0} position="relative" flexDirection="column">
        {room !== null ? (
          // The room, kept mounted under what is put on top of it: back finds it where it was.
          <View flex={1} minWidth={0} minHeight={0} position="relative" {...roomBox} {...((!isRoom(top) ? { display: "none" } : {}) as object)}>
            {room}
          </View>
        ) : null}
        {isRoom(top) ? null : face === null ? <PanelEmpty>Opening…</PanelEmpty> : <PaneBody key={top.key} entry={top} face={face} onOpen={(entry) => splitView.set(openInPane(splitView.get(), pane, entry))} />}
      </View>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/**
 * A room's middle column as its panes: one, or two side by side with the divider between (decision
 * 0025) — and one pane is the unsplit main view, the same pane: its head at the window's top (the title
 * bar is not drawn over a room with panes, `UniversalApp.tsx`). `here` is what the room stands on as a
 * path's entry: the room's own view (`ROOM`, drawn by `room` in the box `roomBox` — a row for Files),
 * or the Chat room's conversation by its own entry, drawn as any pane draws it (`PaneBody`). `at` says
 * where in the room it stands; when either moves, the room is shown (`roomMoved`). A phone has no
 * panes: the room alone.
 */
export function Panes({ here = ROOM, at: where, room, roomBox = {}, onFollow }: {
  here?: PaneEntry;
  at?: string | null | undefined;
  room: ReactNode;
  roomBox?: Record<string, unknown>;
  /**
   * The room goes on to what the focused pane shows (`followOf`): the focused pane is the main view as
   * far as the rest of the app is concerned — the sidebar's selected row, the side panel, the address.
   * A conversation (as a pane opens it), or the room's own view. None: the room stays where it is.
   */
  onFollow?: (entry: PaneEntry) => void;
}): JSX.Element {
  const { state, actions } = useShell();
  const split = splitView.use();
  const phone = usePhone();
  const roomWidth = useRoomWidth();
  const narrow = !splitFits(roomWidth);
  // What the room stands on, as a path's entry: by key, so the same place drawn again moves nothing.
  const at = useRef(here);
  at.current = here;
  const whereNow = useRef(where);
  whereNow.current = where;
  // And by where it is: a conversation moved to another workspace keeps its key, and is drawn there now.
  const whose = (here as { project?: string }).project;
  // The first move is the window coming to this room (or opening on it): what was on top is dropped.
  // Every later one is a step within the room, kept on the pane's path for its ‹ and ›.
  const arrived = useRef(false);
  useEffect(() => {
    if (phone) return;
    splitView.set(roomMoved(splitView.get(), at.current, whereNow.current, arrived.current));
    arrived.current = true;
  }, [here.key, whose, where, phone]);
  // The focused pane on something else the room could stand on: the room follows it. After the room's
  // own move above (an effect before this one), so a room just come to is not taken for the pane's.
  const follow = useRef(onFollow);
  follow.current = onFollow;
  const following = phone || onFollow === undefined ? null : (followOf(split, where)?.key ?? null);
  useEffect(() => {
    if (following === null) return;
    const entry = followOf(splitView.get(), whereNow.current);
    if (entry !== null) follow.current?.(entry);
  }, [following]);
  // The window's buttons are drawn over the top row's right end: the side panel's head keeps them clear
  // while it stands open; else the last pane's head does (less the folded panel's rail under them).
  const fit = useColumnsFit();
  const panelWidth = panelOpenWidth.use();
  const gutter = panelWidth > 0 && fit.panel ? 0 : isWeb ? (panelWidth > 0 ? `max(0px, ${String(WINDOW_GUTTER.right(-PANEL_RAIL))})` : WINDOW_GUTTER.right(0)) : 0;
  if (phone) {
    return (
      <View flex={1} minWidth={0} minHeight={0} position="relative" {...((isWeb ? { "data-place": "main" } : {}) as object)} {...roomBox}>
        {room}
      </View>
    );
  }
  // The pane whose path holds the room's own view draws it: one view, mounted once.
  const holder = ((): number | null => {
    const at = split.panes.findIndex((path) => path.entries.some(isRoom));
    return at < 0 ? null : at;
  })();
  const splitOn = isSplit(split);
  const width = rightWidthOf(paneOf(state.settings.ui, PANE.splitRight), roomWidth);
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      {split.panes.map((_, pane) => (
        <Fragment key={pane}>
          {pane === 1 && splitOn && !narrow ? (
            <Splitter label="Resize the split" value={width} reset={paneDefault(PANE.splitRight)} invert min={SPLIT_PANE_MIN} max={Math.max(SPLIT_PANE_MIN, roomWidth - SPLIT_PANE_MIN - 6)} onChange={(size) => actions.setPane(PANE.splitRight, size)} />
          ) : null}
          {/* The sidebar's toggle leads the pane at the window's left: the first, or, while the two
              are tabs (`narrow`), whichever is shown. */}
          <Pane pane={pane} room={holder === pane ? room : null} roomBox={roomBox} narrow={narrow} width={pane === 1 && splitOn && !narrow ? width : null} lead={pane === 0 || narrow} gutter={pane === split.panes.length - 1 || narrow ? gutter : 0} />
        </Fragment>
      ))}
      {/* No pane holds the room: kept mounted out of sight, until it is put on one again. */}
      {holder === null ? (
        <View display="none" {...roomBox}>
          {room}
        </View>
      ) : null}
    </View>
  );
}

