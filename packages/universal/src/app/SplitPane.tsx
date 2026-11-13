import { Fragment, useEffect, useState, type JSX, type ReactNode } from "react";
import type { GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { PanelEntry } from "@jaira/ui/panelStack";
import {
  PLACES,
  SPLIT_PANE_MIN,
  closePane,
  crumbTo,
  focusOn,
  historyOf,
  isRoom,
  isSplit,
  leavePane,
  onPane,
  onlyPane,
  openInPane,
  paneBack,
  paneForward,
  paneHeaded,
  publishedOfEntry,
  rightWidthOf,
  roomEntryOf,
  roomMoved,
  roomPaneOf,
  showTab,
  splitFits,
  swapPanes,
  topOfPath,
  walkTo,
  type PaneEntry,
  type PanePath,
} from "@jaira/ui/splitModel";
import { PANE, paneDefault, paneOf } from "@jaira/ui/uiState";
import { Splitter } from "../components/files/Splitter";
import { anchorRectOf } from "../components/floats/anchor";
import { ContextMenu, type MenuAt } from "../components/Menu";
import { panelOnStack } from "../components/panel/panelBridge";
import { PanelEmpty } from "../components/panel/PanelViews";
import { PlaceButtons } from "../components/panel/PlaceButtons";
import { SpIcon } from "../components/panel/SidePanel";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { useRoomWidth } from "./columnsFit";
import { PaneBody } from "./PaneBody";
import { openInPanel, placeArtifact, placeEntry, surfaceOf, usePlacesHere, useShownPlaces } from "./places";
import { useShell } from "./shell";
import { RoomAddress } from "./TitleBar";
import { paneFaces, paneTitles, splitView } from "./viewState";
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
 *                    ‹ and › (26 square; --dim, at 0.4 where there is nowhere to go), the path as crumbs,
 *                    what stands on top's own controls, ⋯, and ✕ while split. Drawn while split, or while
 *                    the pane's path is more than the room; else the window's title bar says the room's
 *                    place, as it always did
 *   the crumbs       row, centred, gap 5, padding-left 4, app 12/12.5, --dim, one line, clipped; each
 *                    but the last a link back to it (--accent underlined hovered); the last 600 --text;
 *                    an artifact's crumb led by its 16 glyph box (--panel-3, --accent). Pressing the
 *                    last, or holding ‹, lists "This pane's path" (newest first, here marked). The room on
 *                    top is its own address (`RoomAddress`: the Tasks room's crumbs, its run reading
 *                    toggle and New task; the conversation's name; the file's)
 *   on top's own     an artifact: its three place buttons (`PlaceButtons`), lit where it is — its body
 *                    has no title bar of its own, so it has one head on either side
 *   the divider      the splitter before the second pane (`files/Splitter.tsx`); it sizes that pane,
 *                    kept as `PANE.splitRight`, never so wide the first goes under 360
 *   focus            the pane last pressed in: a 2px --accent line along its top, an inset shadow over
 *                    what it shows (`FocusLine`) — never a coloured left edge
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

/** The focused pane's line: 2px of --accent along its top, an inset shadow over what the pane shows. */
function FocusLine(): JSX.Element {
  const t = useTokens();
  return <View position="absolute" top={0} left={0} right={0} height={2} zIndex={11} pointerEvents="none" {...({ boxShadow: `inset 0 2px 0 ${String(t.v("accent"))}` } as object)} />;
}

/**
 * The two panes as tabs, while the room cannot hold both (decision 0025, chosen: board 14). How it looks:
 * a row, a --line under, padding 0 8; a tab padding 7 10 6, 2px under it (--accent on the one shown),
 * --dim (--text shown); the hidden one's dot 6 round, --accent, after its name.
 */
function SplitTabs({ shown }: { shown: number }): JSX.Element {
  const t = useTokens();
  const split = splitView.use();
  const titles = paneTitles.use();
  return (
    <View role="tablist" flexDirection="row" paddingHorizontal={8} flexShrink={0} {...(edge(t, { bottom: 1 }) as object)}>
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

/** An artifact's three places, in the head of the pane it stands in: lit where it is, a press moving it. */
function ArtifactPlaces({ entry }: { entry: PaneEntry }): JSX.Element | null {
  const phone = usePhone();
  const published = publishedOfEntry(entry);
  const here = usePlacesHere(phone);
  const lit = useShownPlaces(published?.ref.id ?? "");
  if (published === undefined) return null;
  const offered = PLACES.filter((place) => place === "main" || here[place] || lit.includes(place));
  return <PlaceButtons offered={offered} lit={lit} onPlace={(place) => placeArtifact(place, published.ref, surfaceOf(published.ref.taskId, published.project), phone)} />;
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
 * A pane's head (boards 07 and 09): ‹ › and the pane's path as crumbs, what is on top's own controls,
 * then ⋯ and (split) ✕. The same for every pane.
 */
function PaneHead({ pane, path, crumbs, tools, closable, onStep, onPath, onMenu, onClose }: {
  pane: number;
  path: PanePath;
  crumbs: readonly Crumb[];
  tools: ReactNode;
  closable: boolean;
  onStep: (step: (path: PanePath) => PanePath) => void;
  onPath: (e: GestureResponderEvent) => void;
  onMenu: (e: GestureResponderEvent) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  return (
    <View role="toolbar" aria-label="Pane" {...((isWeb ? { "data-pane-head": String(pane) } : {}) as object)} flexDirection="row" alignItems="center" gap={4} minHeight={40} paddingHorizontal={6} flexShrink={0} minWidth={0} {...(edge(t, { bottom: 1 }) as object)}>
      <SpIcon icon="back" label="Back" disabled={path.entries.length <= 1} onPress={() => onStep(paneBack)} onLongPress={onPath} />
      <SpIcon icon="back" flip label="Forward" disabled={path.ahead.length === 0} onPress={() => onStep(paneForward)} />
      <View role="navigation" aria-label="This pane's path" flexDirection="row" alignItems="center" gap={5} paddingLeft={4} minWidth={0} flexShrink={1} flexGrow={crumbs.at(-1)?.address === true ? 1 : 0} overflow="hidden">
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
      {/* The room's address fills the head itself; crumbs leave the rest to a filler. */}
      {crumbs.at(-1)?.address === true ? null : <View flex={1} minWidth={8} />}
      {tools}
      <Press onPress={onMenu} label="This pane's menu" title="This pane's menu" {...({ "aria-haspopup": "menu" } as object)} width={26} height={26} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 1.1, color: hovered ? "text" : "dim" }} lineHeight={16}>
            ⋯
          </Txt>
        )}
      </Press>
      {closable ? <SpIcon icon="cross" label="Close this pane" onPress={onClose} /> : null}
    </View>
  );
}

/**
 * One pane: its head, and what its path stands on — the room (kept mounted under anything on top of
 * it, when this pane holds it) or an entry drawn as the main view draws it (`PaneBody`).
 */
function Pane({ pane, room, roomBox, narrow, width }: { pane: number; room: ReactNode | null; roomBox: Record<string, unknown>; narrow: boolean; width: number | null }): JSX.Element | null {
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
  const crumbs: Crumb[] = path.entries.flatMap((entry, i): Crumb[] => {
    const to = (): void => onStep((was) => crumbTo(was, i));
    if (isRoom(entry)) {
      if (i === path.entries.length - 1) return [{ key: "room", label: roomCrumbs.join(" › "), address: true }];
      return roomCrumbs.map((label, j) => ({ key: `room:${String(j)}`, label, ...(j === roomCrumbs.length - 1 ? { to } : {}) }));
    }
    return [{ key: entry.key, label: titleOf(entry), glyph: crumbGlyphOf(entry), to }];
  });
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
      title: "This pane's path",
      items: historyOf(path).map((line) => ({
        label: titleOf(line.entry),
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
            // by its own move; anything else leaves this pane's path.
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
  const headed = paneHeaded(split, pane);
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
      {...(splitOn ? focusProps(pane) : {})}
      {...((hidden ? { display: "none" } : {}) as object)}
    >
      {splitOn && narrow ? <SplitTabs shown={pane} /> : null}
      {headed ? <PaneHead pane={pane} path={path} crumbs={crumbs} tools={<ArtifactPlaces entry={top} />} closable={splitOn} onStep={onStep} onPath={onPath} onMenu={onMenu} onClose={close} /> : null}
      <View flex={1} minWidth={0} minHeight={0} position="relative" flexDirection="column">
        {room !== null ? (
          // The room, kept mounted under what is put on top of it: back finds it where it was.
          <View flex={1} minWidth={0} minHeight={0} position="relative" {...roomBox} {...((!isRoom(top) ? { display: "none" } : {}) as object)}>
            {room}
          </View>
        ) : null}
        {isRoom(top) ? null : face === null ? <PanelEmpty>Opening…</PanelEmpty> : <PaneBody key={top.key} entry={top} face={face} onOpen={(entry) => splitView.set(openInPane(splitView.get(), pane, entry))} />}
      </View>
      {splitOn && !narrow && split.focus === pane ? <FocusLine /> : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

/**
 * A room's middle column as its panes: one, or two side by side with the divider between (decision
 * 0025). `room` is what the room draws there; `roomBox` the box it stands in (a row for Files, the
 * phone's sheet inset for Chat). `at` is what the room stands on: when it moves, the room is shown
 * (`roomMoved`). A phone has no panes: the room alone.
 */
export function Panes({ at, room, roomBox = {} }: { at?: string | null | undefined; room: ReactNode; roomBox?: Record<string, unknown> }): JSX.Element {
  const { state, actions } = useShell();
  const split = splitView.use();
  const phone = usePhone();
  const roomWidth = useRoomWidth();
  const narrow = !splitFits(roomWidth);
  useEffect(() => {
    if (!phone) splitView.set(roomMoved(splitView.get()));
  }, [at, phone]);
  if (phone) {
    return (
      <View flex={1} minWidth={0} minHeight={0} position="relative" {...((isWeb ? { "data-place": "main" } : {}) as object)} {...roomBox}>
        {room}
      </View>
    );
  }
  const holder = roomPaneOf(split)?.pane ?? null;
  const splitOn = isSplit(split);
  const width = rightWidthOf(paneOf(state.settings.ui, PANE.splitRight), roomWidth);
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      {split.panes.map((_, pane) => (
        <Fragment key={pane}>
          {pane === 1 && splitOn && !narrow ? (
            <Splitter label="Resize the split" value={width} reset={paneDefault(PANE.splitRight)} invert min={SPLIT_PANE_MIN} max={Math.max(SPLIT_PANE_MIN, roomWidth - SPLIT_PANE_MIN - 6)} onChange={(size) => actions.setPane(PANE.splitRight, size)} />
          ) : null}
          <Pane pane={pane} room={holder === pane ? room : null} roomBox={roomBox} narrow={narrow} width={pane === 1 && splitOn && !narrow ? width : null} />
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

