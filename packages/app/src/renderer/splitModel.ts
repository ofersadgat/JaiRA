/**
 * The SPLIT — the room's middle column as one or two panes, and the three places an artifact can be put
 * (decision 0025: the person's rulings of 2026-11-13, "07 and 09 are the correct design for split view
 * panels", and "both panels should be fully self contained. I.e. their ui should be identical. You
 * should be able to close either of them.").
 *
 * A PANE is a main view with a PATH of its own, walked by its own ‹ and › and shown as crumbs in its own
 * head. There are one or two, and they are the same thing: nothing here is about a left or a right pane
 * but the order they stand in. A path is a panel stack's shape (`panelStack.ts`: `entries`, what › goes
 * forward to in `ahead`), its entries the side panel's kinds — a task or a conversation, an artifact, a
 * state — and one more, the ROOM: what the Tasks, Files or Chat room shows from the store. The room is
 * an entry like any other, on whichever pane holds it (at most one: it is one view), and the window
 * opens on one pane whose path is the room alone.
 *
 * Pure: a value in, a new value out. The shell holds the split (`viewState.ts`' `splitView`) and the
 * panes draw it (`SplitPane.tsx`); the rules are tested here without a window.
 */
import type { PanelEntry } from "./panelStack";
import type { PublishedRef } from "./transcriptRows";

/** Where an artifact, or anything a pane can hold, can be put: the first pane (the main view), the second (a split), the side panel. */
export type Place = "main" | "split" | "panel";
export const PLACES: readonly Place[] = ["main", "split", "panel"];

/** The room's own view as a pane entry: what the store says the Tasks, Files or Chat room shows. */
export interface RoomEntry {
  kind: "room";
  key: "room";
}
export const ROOM: RoomEntry = { kind: "room", key: "room" };

export type PaneEntry = PanelEntry | RoomEntry;

/** One pane's path: root first; what › goes forward to, nearest first. */
export interface PanePath {
  entries: readonly PaneEntry[];
  ahead: readonly PaneEntry[];
}

export interface SplitState {
  /** The panes, in the order they stand: one, or two side by side. Never none. */
  panes: readonly PanePath[];
  /** The pane last pressed in — where a sidebar row lands, and whose context the side panel shows. */
  focus: number;
  /** Which pane shows while the window is too narrow for both (`splitFits`): two tabs over one pane. */
  tab: number;
  /** The hidden tab's pane changed since it was last shown: its tab carries a dot. */
  changed: number | null;
}

export const ROOM_PATH: PanePath = { entries: [ROOM], ahead: [] };
export const NO_SPLIT: SplitState = { panes: [ROOM_PATH], focus: 0, tab: 0, changed: null };

/** The narrowest a pane may be: a conversation's composer still fits in it. */
export const SPLIT_PANE_MIN = 360;
/** The divider between the panes (`files/Splitter.tsx`), as `shellFit.ts`' `SPLITTER`. */
const DIVIDER = 6;

/** Whether the column is split into two panes. */
export function isSplit(split: SplitState): boolean {
  return split.panes.length > 1;
}

/** What a path stands on. */
export function topOfPath(path: PanePath | undefined): PaneEntry | undefined {
  return path?.entries[path.entries.length - 1];
}

/** Whether an entry is the room's own view. */
export function isRoom(entry: PaneEntry | undefined | null): entry is RoomEntry {
  return entry?.kind === "room";
}

/** The pane holding the room, and how deep in its path; null when no pane holds it. */
export function roomPaneOf(split: SplitState): { pane: number; at: number } | null {
  for (let pane = 0; pane < split.panes.length; pane++) {
    const at = split.panes[pane]!.entries.findIndex(isRoom);
    if (at >= 0) return { pane, at };
  }
  return null;
}

/**
 * Whether a pane draws its head (‹ › crumbs ⋯ ✕): always while split; alone, once its path is more than
 * the room — the window's title bar says where the room stands while it is all there is.
 */
export function paneHeaded(split: SplitState, pane: number): boolean {
  if (isSplit(split)) return true;
  const path = split.panes[pane];
  return path !== undefined && !(path.entries.length === 1 && isRoom(path.entries[0]));
}

/**
 * Something on a path. Pushing what is on top is nothing; what is lower down is going back to it; what
 * › would go forward to is going forward; anything else starts a new way ahead.
 */
export function pushPath(path: PanePath, entry: PaneEntry): PanePath {
  if (topOfPath(path)?.key === entry.key) return path;
  const at = path.entries.findIndex((one) => one.key === entry.key);
  if (at >= 0) return crumbTo(path, at);
  const ahead = path.ahead[0]?.key === entry.key ? path.ahead.slice(1) : [];
  return { entries: [...path.entries, entry], ahead };
}

/** ‹ — one level back. A path's root stays: ✕ is how a pane goes. */
export function paneBack(path: PanePath): PanePath {
  return path.entries.length <= 1 ? path : crumbTo(path, path.entries.length - 2);
}

/** › — forward again to where ‹ came back from. */
export function paneForward(path: PanePath): PanePath {
  const next = path.ahead[0];
  return next === undefined ? path : { entries: [...path.entries, next], ahead: path.ahead.slice(1) };
}

/** A crumb pressed: back to that level, what it passes kept ahead. */
export function crumbTo(path: PanePath, index: number): PanePath {
  if (index < 0 || index >= path.entries.length - 1) return path;
  return { entries: path.entries.slice(0, index + 1), ahead: [...path.entries.slice(index + 1), ...path.ahead] };
}

/** The room moves to a pane: taken off any other path first (it is one view, on one pane). */
function withoutRoomElsewhere(panes: readonly PanePath[], keep: number, entry: PaneEntry): PanePath[] {
  if (!isRoom(entry)) return [...panes];
  return panes.map((path, i) => (i === keep || !path.entries.some(isRoom) ? path : { entries: path.entries.filter((e) => !isRoom(e)), ahead: path.ahead.filter((e) => !isRoom(e)) }));
}

/** A pane's path replaced; a path left with nothing closes its pane (or, the only one, stands on the room). */
export function setPath(split: SplitState, pane: number, path: PanePath): SplitState {
  const was = split.panes[pane];
  if (was === undefined || was === path) return split;
  if (path.entries.length === 0) return closePane(split, pane, true);
  const panes = split.panes.map((one, i) => (i === pane ? path : one));
  const moved = topOfPath(path)?.key !== topOfPath(was)?.key;
  const hidden = isSplit(split) && split.tab !== pane;
  return { ...split, panes, ...(moved && hidden ? { changed: pane } : {}) };
}

/** A change to a pane's path (‹, ›, a crumb, a link inside it). */
export function onPane(split: SplitState, pane: number, step: (path: PanePath) => PanePath): SplitState {
  const was = split.panes[pane];
  return was === undefined ? split : setPath(split, pane, step(was));
}

/**
 * Open something on a pane's path, the pane focused and shown. Pane 1 with the column not split splits
 * it, the new pane's path the entry alone.
 */
export function openInPane(split: SplitState, pane: number, entry: PaneEntry): SplitState {
  if (pane >= split.panes.length) {
    const panes = withoutRoomElsewhere(split.panes, -1, entry).filter((path) => path.entries.length > 0);
    return { panes: [...panes, { entries: [entry], ahead: [] }], focus: panes.length, tab: panes.length, changed: null };
  }
  const panes = withoutRoomElsewhere(split.panes, pane, entry);
  panes[pane] = pushPath(panes[pane]!, entry);
  return { ...split, panes: panes.filter((path) => path.entries.length > 0), focus: pane, tab: pane, changed: split.changed === pane ? null : split.changed };
}

/** Open something in a split: on the second pane's path, splitting the column if it was not. */
export function openInSplit(split: SplitState, entry: PaneEntry): SplitState {
  return openInPane(split, 1, entry);
}

/**
 * ✕ on a pane: it closes, and the other is the only (unsplit) main view, its path kept. The same for
 * either pane. The only pane does not close; `emptied` (its path ran out) leaves it on the room.
 */
export function closePane(split: SplitState, pane: number, emptied = false): SplitState {
  if (!isSplit(split)) return emptied ? NO_SPLIT : split;
  const rest = split.panes.filter((_, i) => i !== pane);
  return { panes: rest, focus: 0, tab: 0, changed: null };
}

/** Only this pane: the other closes. */
export function onlyPane(split: SplitState, pane: number): SplitState {
  return isSplit(split) ? closePane(split, pane === 0 ? 1 : 0) : split;
}

/** Swap the panes: each stands where the other stood, with its path; focus goes with the pane. */
export function swapPanes(split: SplitState): SplitState {
  if (!isSplit(split)) return split;
  const flip = (i: number | null): number | null => (i === null ? null : 1 - i);
  return { panes: [split.panes[1]!, split.panes[0]!], focus: 1 - split.focus, tab: 1 - split.tab, changed: flip(split.changed) };
}

/**
 * The room moved (another task, conversation or file; another room): it is shown. The pane holding it
 * goes back to it, what was on top dropped; no pane holding it, it goes on the focused pane's path.
 */
export function roomMoved(split: SplitState): SplitState {
  const held = roomPaneOf(split);
  if (held === null) return openInPane(split, Math.min(split.focus, split.panes.length - 1), ROOM);
  const path = split.panes[held.pane]!;
  if (held.at === path.entries.length - 1 && path.ahead.length === 0) return split;
  return setPath(split, held.pane, { entries: path.entries.slice(0, held.at + 1), ahead: [] });
}

/**
 * Take the top off a pane — what it showed has gone somewhere else (another place). It goes back a
 * level; a pane whose path runs out closes, or, the only one, stands on the room.
 */
export function leavePane(split: SplitState, pane: number): SplitState {
  const path = split.panes[pane];
  if (path === undefined) return split;
  if (path.entries.length <= 1) return closePane(split, pane, true);
  return setPath(split, pane, { entries: path.entries.slice(0, -1), ahead: [] });
}

/** A press in a pane focuses it. */
export function focusOn(split: SplitState, pane: number): SplitState {
  if (!isSplit(split) || split.focus === pane) return split;
  return { ...split, focus: pane };
}

/** A tab pressed while narrow: that pane shown and focused, its dot gone. */
export function showTab(split: SplitState, pane: number): SplitState {
  if (!isSplit(split)) return split;
  if (split.tab === pane && split.focus === pane && split.changed !== pane) return split;
  return { ...split, tab: pane, focus: pane, changed: split.changed === pane ? null : split.changed };
}

/**
 * Where a row PRESSED in the sidebar lands: in the focused pane. A pane standing on the room is the room
 * as it always was — the room goes there (null: the caller navigates it); any other goes on to the row,
 * on its path. A phone has no panes of its own.
 */
export function routeOpen(split: SplitState, entry: PanelEntry, phone = false): SplitState | null {
  if (phone) return null;
  const pane = Math.min(split.focus, split.panes.length - 1);
  if (isRoom(topOfPath(split.panes[pane]))) return null;
  return openInPane(split, pane, entry);
}

/** One line of a pane's path menu: what it is, and how far from where the pane stands (negative behind, 0 here, positive ahead). */
export interface PathLine {
  entry: PaneEntry;
  offset: number;
}

/** The pane's path, as its menu lists it (board 07, "This pane's path"): newest first, what › goes to above where it stands. */
export function historyOf(path: PanePath): PathLine[] {
  const ahead = path.ahead.map((entry, i) => ({ entry, offset: i + 1 })).reverse();
  const here = path.entries.map((entry, i) => ({ entry, offset: i - (path.entries.length - 1) })).reverse();
  return [...ahead, ...here];
}

/** A line of the path menu chosen: back to that level, or forward to it. */
export function walkTo(path: PanePath, offset: number): PanePath {
  if (offset < 0) return crumbTo(path, path.entries.length - 1 + offset);
  let at = path;
  for (let i = 0; i < offset; i++) at = paneForward(at);
  return at;
}

/** The task an entry is about, when it is one of a task's kinds. */
export function taskOfEntry(entry: PaneEntry | undefined | null): { taskId: string; project?: string } | undefined {
  if (entry === undefined || entry === null) return undefined;
  if (entry.kind !== "task" && entry.kind !== "convo" && entry.kind !== "subagent" && entry.kind !== "rerun" && entry.kind !== "chat") return undefined;
  return { taskId: entry.taskId, ...(entry.project !== undefined ? { project: entry.project } : {}) };
}

/**
 * What the side panel stands on (board 10: it follows the focused pane): with the focused pane on a task
 * of its own path, that task's context — its conversation is on screen in the pane, so the panel holds
 * what is beside it. Null on the room (the room's rule stands) or on anything that is not a task.
 */
export function focusRuleOf(split: SplitState): PanelEntry | null {
  const task = taskOfEntry(topOfPath(split.panes[Math.min(split.focus, split.panes.length - 1)]));
  if (task === undefined) return null;
  return { kind: "convo", key: `convo:${task.taskId}`, taskId: task.taskId, ...(task.project !== undefined ? { project: task.project } : {}), tab: "steps" };
}

/** A task as a pane opens it: its conversation. */
export function taskPaneEntryOf(taskId: string, project?: string): PanelEntry {
  return { kind: "task", key: `task:${taskId}`, taskId, ...(project !== undefined ? { project } : {}), tab: "conversation" };
}

/** An artifact as an entry: what the side panel and a pane hold for one. */
export function artifactEntryOf(ref: PublishedRef, project?: string): PanelEntry {
  const title = ref.title ?? ref.entry;
  return { kind: "preview", key: `preview:${title}`, preview: { title, published: { ref, ...(project !== undefined ? { project } : {}) } } };
}

/** The artifact an entry holds, if it holds one. */
export function publishedOfEntry(entry: PaneEntry | undefined | null): { ref: PublishedRef; project?: string | undefined } | undefined {
  return entry?.kind === "preview" ? entry.preview.published : undefined;
}

/**
 * Every place an artifact stands in now: the main view (drawn over a room with no panes of its own, or
 * on top of the first pane), on top of the second pane, on top of the side panel. By its id — another
 * version of the same artifact is the same artifact.
 */
export function shownPlacesOf(id: string, at: { main: PublishedRef | null; first?: PaneEntry | undefined; second?: PaneEntry | undefined; panel: PanelEntry | undefined }): Place[] {
  const out: Place[] = [];
  if (at.main?.id === id || publishedOfEntry(at.first)?.ref.id === id) out.push("main");
  if (publishedOfEntry(at.second)?.ref.id === id) out.push("split");
  if (publishedOfEntry(at.panel)?.ref.id === id) out.push("panel");
  return out;
}

/**
 * A place button pressed: where it opens, and the places it leaves. A phone has no split, so "split"
 * opens it over the main view. It is never in two places after a move.
 */
export function placeMoveOf(shownIn: readonly Place[], target: Place, phone = false): { open: Place; close: Place[] } {
  const open: Place = phone && target === "split" ? "main" : target;
  return { open, close: shownIn.filter((place) => place !== open) };
}

/** The places a group offers: no split on a phone. */
export function placesOffered(phone: boolean): readonly Place[] {
  return phone ? PLACES.filter((place) => place !== "split") : PLACES;
}

/** Whether the room between the sidebar and the side panel holds two panes and the divider between them. */
export function splitFits(roomWidth: number): boolean {
  return roomWidth >= SPLIT_PANE_MIN * 2 + DIVIDER;
}

/** The second pane's width: as the person left it, but never so wide the first falls under its floor. */
export function rightWidthOf(kept: number, roomWidth: number): number {
  const most = Math.max(SPLIT_PANE_MIN, roomWidth - SPLIT_PANE_MIN - DIVIDER);
  return Math.max(SPLIT_PANE_MIN, Math.min(kept, most));
}

/**
 * What the room stands on, as an entry a panel can hold — what "Move to the side panel" carries from a
 * pane on the room: the open conversation in the Chat room, the selected task in Tasks, the open state
 * in Files.
 */
export function roomEntryOf(
  room: string,
  at: { chatTaskId: string | null; chatProject?: string | undefined; selected: string | null; selectedProject?: string | undefined; stateId: string | null; docStateId?: string | undefined; project: string | null },
): PanelEntry | null {
  if (room === "chat") return at.chatTaskId === null ? null : taskPaneEntryOf(at.chatTaskId, at.chatProject);
  if (room === "tasks") return at.selected === null ? null : taskPaneEntryOf(at.selected, at.selectedProject);
  if (room === "files" && at.stateId !== null && at.docStateId === at.stateId) {
    return { kind: "state", key: `state:${at.project ?? ""}:${at.stateId}`, stateId: at.stateId, project: at.project, tab: "run" };
  }
  return null;
}

/** A box on screen, in the window's pixels. */
export interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a drop would put what is dragged, and the box that takes it. */
export interface DropZone {
  place: Place;
  rect: ZoneRect;
}

/**
 * The drop zones while something is dragged (decision 0025, boards 08 and 09), from where the panes
 * and the side panel stand.
 *
 * An artifact: with a split, each pane is its own zone and the panel its own, as they are on screen.
 * Without one, the room (the middle column and the panel beside it, if open) is cut into three bands,
 * left to right: Main view, Split, Side panel — the panel's band its own column where it stands open.
 *
 * A row of the sidebar (`panes`, board 09): with a split, the two panes and nothing else — a row goes on
 * a pane's path. Without one, the bands as for an artifact.
 */
export function dropZonesOf(at: { main?: ZoneRect | undefined; split?: ZoneRect | undefined; panel?: ZoneRect | undefined }, panes = false): DropZone[] {
  const { main, split, panel } = at;
  if (main === undefined) return [];
  if (split !== undefined) return [{ place: "main", rect: main }, { place: "split", rect: split }, ...(panel !== undefined && !panes ? [{ place: "panel" as const, rect: panel }] : [])];
  if (panel !== undefined) {
    const half = Math.round(main.width / 2);
    return [
      { place: "main", rect: { ...main, width: half } },
      { place: "split", rect: { ...main, left: main.left + half, width: main.width - half } },
      { place: "panel", rect: panel },
    ];
  }
  const third = Math.round(main.width / 3);
  return [
    { place: "main", rect: { ...main, width: third } },
    { place: "split", rect: { ...main, left: main.left + third, width: third } },
    { place: "panel", rect: { ...main, left: main.left + 2 * third, width: main.width - 2 * third } },
  ];
}

/** The zone under the pointer, if any. */
export function zoneAt(zones: readonly DropZone[], x: number, y: number): DropZone | undefined {
  return zones.find(({ rect }) => x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height);
}

/** What the "Open here" zone over a pane says (board 09): where the pane goes, and what ‹ comes back to. */
export function openHereLine(going: string, showing: string | null): string {
  return showing === null || showing === "" ? `This pane goes on to ${going}` : `This pane goes on to ${going}; ‹ Back returns to ${showing}`;
}

/** The pane a place is: the main view is the first pane, a split the second. */
export function paneOfPlace(place: Place): number {
  return place === "split" ? 1 : 0;
}
