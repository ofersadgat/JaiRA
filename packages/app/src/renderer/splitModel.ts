/**
 * The SPLIT — the room's middle column as two panes side by side, and the three places an artifact can
 * be put (decision 0025, the person's rulings of 2026-11-13, and their correction the same day: "07 and
 * 09 are the correct design for split view panels").
 *
 * The two panes are equal. Each is a main view with a PATH of its own, walked by its own ‹ and › and
 * shown as crumbs in its own head. A path is a panel stack's shape (`panelStack.ts`: `entries`, what ›
 * goes forward to in `ahead`), its entries the side panel's kinds — a task or a conversation, an
 * artifact, a state — but a pane draws each as the main view does, not as a panel face.
 *
 * The left pane stands on the ROOM: what the Tasks, Files or Chat room shows, from the store, is the
 * bottom of its path, and its own entries are what was put on top of that (a drop, Swap, Only this
 * pane). An empty left path is the room as it always was; ‹ from its first entry goes back to the
 * room. The room moving (a press in the sidebar, a link that navigates) drops what was on top of it.
 * The right pane's path is its own from its first entry, which is its root.
 *
 * Pure: a value in, a new value out. The shell holds the split (`viewState.ts`' `splitView`) and the
 * panes draw it (`SplitPane.tsx`); the rules are tested here without a window.
 */
import { EMPTY_STACK, forward, push, topOf, type PanelEntry, type PanelStack } from "./panelStack";
import type { PublishedRef } from "./transcriptRows";

/** Where an artifact, or anything a pane can hold, can be put: the main view (the left pane), a split's right pane, the side panel. */
export type Place = "main" | "split" | "panel";
export const PLACES: readonly Place[] = ["main", "split", "panel"];

export type PaneSide = "left" | "right";

export interface SplitState {
  /** What the left pane shows on top of the room; empty is the room itself. */
  left: PanelStack;
  /** The right pane's path; null while the column is not split. */
  right: PanelStack | null;
  /** The pane last pressed in — where a sidebar row lands, and whose context the side panel shows. */
  focus: PaneSide;
  /** Which pane shows while the window is too narrow for both (`splitFits`): two tabs over one pane. */
  tab: PaneSide;
  /** The hidden tab's pane changed since it was last shown: its tab carries a dot. */
  changed: PaneSide | null;
}

export const NO_SPLIT: SplitState = { left: EMPTY_STACK, right: null, focus: "left", tab: "left", changed: null };

/** The narrowest a pane may be: a conversation's composer still fits in it. */
export const SPLIT_PANE_MIN = 360;
/** The divider between the panes (`files/Splitter.tsx`), as `shellFit.ts`' `SPLITTER`. */
const DIVIDER = 6;

/** A pane's path. */
export function pathOf(split: SplitState, side: PaneSide): PanelStack | null {
  return side === "left" ? split.left : split.right;
}

/** Whether the left pane has a path to walk: then it draws a head of its own, split or not. */
export function leftWalked(split: SplitState): boolean {
  return split.left.entries.length > 0 || split.left.ahead.length > 0;
}

/**
 * Open something in the right pane: on its path, splitting the column if it was not, the right pane
 * focused and shown. Pushing what is already on top changes nothing on the path.
 */
export function openInSplit(split: SplitState, entry: PanelEntry): SplitState {
  const right = split.right === null ? { ...EMPTY_STACK, entries: [entry], motion: "replace" as const } : push(split.right, entry);
  return { ...split, right, focus: "right", tab: "right", changed: null };
}

/** Open something in a pane, on its path: the left goes on from the room, the right as `openInSplit`. */
export function openInPane(split: SplitState, side: PaneSide, entry: PanelEntry): SplitState {
  if (side === "right") return openInSplit(split, entry);
  return { ...split, left: push(split.left, entry), focus: "left", tab: "left", changed: split.changed === "left" ? null : split.changed };
}

/** The right pane closed: the column is one again, the left focused, and what it shows kept. */
export function closeSplit(split: SplitState): SplitState {
  return { ...NO_SPLIT, left: split.left };
}

/** ‹ — one level back. The right pane's root stays (✕ closes it); the left's first entry goes back to the room. */
export function paneBack(stack: PanelStack, side: PaneSide): PanelStack {
  if (stack.entries.length <= (side === "right" ? 1 : 0)) return stack;
  return crumbTo(stack, stack.entries.length - 2);
}

/** › — forward again to where ‹ came back from. */
export function paneForward(stack: PanelStack): PanelStack {
  return forward(stack);
}

/** A crumb pressed: back to that level, what it passes kept ahead. -1 is the room, under the left pane's path. */
export function crumbTo(stack: PanelStack, index: number): PanelStack {
  if (index < -1 || index >= stack.entries.length - 1) return stack;
  return { ...stack, entries: stack.entries.slice(0, index + 1), ahead: [...stack.entries.slice(index + 1), ...stack.ahead], motion: "pop" };
}

/**
 * A change to a pane's path (‹, ›, a crumb, a link inside it). A right path left with nothing closes
 * the pane. A change the person cannot see — the pane behind its tab — marks its tab.
 */
export function onPane(split: SplitState, side: PaneSide, step: (stack: PanelStack) => PanelStack): SplitState {
  const was = pathOf(split, side);
  if (was === null) return split;
  const next = step(was);
  if (next === was) return split;
  if (side === "right" && next.entries.length === 0) return closeSplit(split);
  const moved = topOf(next)?.key !== topOf(was)?.key;
  const hidden = split.right !== null && split.tab !== side;
  return { ...split, [side]: next, ...(moved && hidden ? { changed: side } : {}) };
}

/**
 * The room under the left pane moved (another task, conversation or file): what was on top of it is
 * gone — the left shows the room — and its tab is marked while it is hidden.
 */
export function leftMoved(split: SplitState): SplitState {
  const cleared = leftWalked(split) ? { ...split, left: EMPTY_STACK } : split;
  if (cleared.right === null || cleared.tab === "left" || cleared.changed === "left") return cleared;
  return { ...cleared, changed: "left" };
}

/** A press in a pane focuses it. With no split there is only the left. */
export function focusOn(split: SplitState, side: PaneSide): SplitState {
  if (split.right === null || split.focus === side) return split;
  return { ...split, focus: side };
}

/** A tab pressed while narrow: that pane shown and focused, its dot gone. */
export function showTab(split: SplitState, side: PaneSide): SplitState {
  if (split.right === null) return split;
  if (split.tab === side && split.focus === side && split.changed !== side) return split;
  return { ...split, tab: side, focus: side, changed: split.changed === side ? null : split.changed };
}

/**
 * Where a row PRESSED in the sidebar lands: on the right pane's path when that pane is focused (the new
 * split, else `null` — the room goes there as it always did). A phone has no split. A row DROPPED on a
 * pane goes on that pane's path (`openInPane`), the left's too.
 */
export function routeOpen(split: SplitState, entry: PanelEntry, phone = false): SplitState | null {
  if (phone || split.right === null || split.focus !== "right") return null;
  return openInSplit(split, entry);
}

/**
 * One line of a pane's path menu: what it is (null: the room, under the left pane's path), and how far
 * from where the pane stands — negative behind, 0 here, positive ahead (what › would go forward to).
 */
export interface PathLine {
  entry: PanelEntry | null;
  offset: number;
}

/**
 * The pane's path, as its menu lists it (board 07, "This pane's path"): newest first — what › would go
 * to, furthest first, then where it stands, then back to its root; the left's ends at the room.
 */
export function historyOf(stack: PanelStack, side: PaneSide): PathLine[] {
  const ahead = stack.ahead.map((entry, i) => ({ entry, offset: i + 1 })).reverse();
  const here = stack.entries.map((entry, i) => ({ entry, offset: i - (stack.entries.length - 1) })).reverse();
  return [...ahead, ...here, ...(side === "left" ? [{ entry: null, offset: -stack.entries.length }] : [])];
}

/** A line of the path menu chosen: back to that level, or forward to it. */
export function walkTo(stack: PanelStack, offset: number): PanelStack {
  if (offset < 0) return crumbTo(stack, stack.entries.length - 1 + offset);
  let at = stack;
  for (let i = 0; i < offset; i++) at = forward(at);
  return at;
}

/** The task an entry is about, when it is one of a task's kinds. */
export function taskOfEntry(entry: PanelEntry | undefined | null): { taskId: string; project?: string } | undefined {
  if (entry === undefined || entry === null) return undefined;
  if (entry.kind !== "task" && entry.kind !== "convo" && entry.kind !== "subagent" && entry.kind !== "rerun" && entry.kind !== "chat") return undefined;
  return { taskId: entry.taskId, ...(entry.project !== undefined ? { project: entry.project } : {}) };
}

/**
 * What the side panel stands on while a pane's own path shows a task (board 10: the panel follows the
 * focused pane): that task's context — its conversation is on screen in the pane, so the panel holds
 * what is beside it. Null while the focused pane shows the room (the room's rule stands) or no task.
 */
export function focusRuleOf(split: SplitState): PanelEntry | null {
  const side = split.right === null ? "left" : split.focus;
  const path = pathOf(split, side);
  const task = taskOfEntry(path === null ? undefined : topOf(path));
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
export function publishedOfEntry(entry: PanelEntry | undefined | null): { ref: PublishedRef; project?: string | undefined } | undefined {
  return entry?.kind === "preview" ? entry.preview.published : undefined;
}

/**
 * Every place an artifact stands in now: the main view (over the room, or on top of the left pane's
 * path), on top of the right pane, on top of the side panel. By its id — another version of the same
 * artifact is the same artifact.
 */
export function shownPlacesOf(id: string, at: { main: PublishedRef | null; left?: PanelEntry | undefined; split: PanelEntry | undefined; panel: PanelEntry | undefined }): Place[] {
  const out: Place[] = [];
  if (at.main?.id === id || publishedOfEntry(at.left)?.ref.id === id) out.push("main");
  if (publishedOfEntry(at.split)?.ref.id === id) out.push("split");
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

/** The right pane's width: as the person left it, but never so wide the left falls under its floor. */
export function rightWidthOf(kept: number, roomWidth: number): number {
  const most = Math.max(SPLIT_PANE_MIN, roomWidth - SPLIT_PANE_MIN - DIVIDER);
  return Math.max(SPLIT_PANE_MIN, Math.min(kept, most));
}

/**
 * What the room under the left pane stands on, as an entry — what Swap and "Move to the side panel"
 * carry when nothing is on top of it: the open conversation in the Chat room, the selected task in the
 * Tasks room, the open state in Files.
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

/** What a pane shows now, as an entry: its path's top, or (the left's, with nothing on it) the room's. */
export function paneShows(split: SplitState, side: PaneSide, room: PanelEntry | null): PanelEntry | null {
  const path = pathOf(split, side);
  return (path === null ? undefined : topOf(path)) ?? (side === "left" ? room : null);
}

/**
 * Swap the panes (board 12): each goes on to what the other showed. The left's top is replaced (or,
 * standing on the room, the right's goes on top of it, ‹ returning to the room); the right's path is
 * what the left showed, alone. A left showing nothing a pane can hold closes the right.
 */
export function swapPanes(split: SplitState, room: PanelEntry | null): SplitState {
  const right = split.right === null ? undefined : topOf(split.right);
  if (right === undefined) return split;
  const left = paneShows(split, "left", room);
  const leftPath = split.left.entries.length > 0 ? { ...split.left, entries: [...split.left.entries.slice(0, -1), right], ahead: [], motion: "replace" as const } : push(split.left, right);
  if (left === null) return { ...closeSplit(split), left: leftPath };
  return { ...split, left: leftPath, right: { ...EMPTY_STACK, entries: [left], motion: "replace" } };
}

/**
 * Only this pane (board 12): the other closes. The right's content becomes the main view — on top of
 * the left's path, ‹ returning to what the left showed.
 */
export function onlyPane(split: SplitState, side: PaneSide): SplitState {
  if (side === "left" || split.right === null) return closeSplit(split);
  const right = topOf(split.right);
  return closeSplit(right === undefined ? split : { ...split, left: push(split.left, right) });
}

/**
 * Take the top off a pane — what it showed has gone somewhere else (the side panel, another place). It
 * goes back a level; a right pane left with nothing closes; the left goes back to the room.
 */
export function leavePane(split: SplitState, side: PaneSide): SplitState {
  const path = pathOf(split, side);
  if (path === null || path.entries.length === 0) return split;
  if (side === "right" && path.entries.length <= 1) return closeSplit(split);
  return { ...split, [side]: { ...path, entries: path.entries.slice(0, -1), ahead: [], motion: "pop" } };
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
 * An artifact (`places`): with a split, each pane is its own zone and the panel its own, as they are
 * on screen. Without one, the room (the middle column and the panel beside it, if open) is cut into
 * three bands, left to right: Main view, Split, Side panel — the panel's band its own column where it
 * stands open.
 *
 * A row of the sidebar (`panes`, board 09): with a split, the two panes and nothing else — a row goes
 * on a pane's path. Without one, the bands as for an artifact.
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
