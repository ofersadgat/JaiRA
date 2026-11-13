/**
 * The SPLIT — the room's middle column as two panes side by side, and the three places an artifact can
 * be put (decision 0025, the person's rulings of 2026-11-13).
 *
 * The left pane is the room's middle column as it always was. The right pane has a path of its own, and
 * that path is a panel stack (`panelStack.ts`): the same entries the side panel shows, pushed, popped and
 * gone forward through the same way, drawn by the same faces. What is here is the rest: which pane is
 * focused, which shows when the window is too narrow for both, the path as a menu, where a press in the
 * sidebar lands, what the side panel stands on while the right pane is focused, and how a place button
 * moves an artifact.
 *
 * Pure: a value in, a new value out. The shell holds the split (`viewState.ts`' `splitView`) and the
 * pane draws it (`SplitPane.tsx`); the rules are tested here without a window.
 */
import { EMPTY_STACK, forward, popTo, push, topOf, type PanelEntry, type PanelStack } from "./panelStack";
import type { PublishedRef } from "./transcriptRows";

/** Where an artifact, or anything a pane can hold, can be put: over the main view, in a split, in the side panel. */
export type Place = "main" | "split" | "panel";
export const PLACES: readonly Place[] = ["main", "split", "panel"];

export type PaneSide = "left" | "right";

export interface SplitState {
  /** The right pane's path; null while the column is not split. */
  right: PanelStack | null;
  /** The pane last pressed in — where a sidebar row lands, and whose context the side panel shows. */
  focus: PaneSide;
  /** Which pane shows while the window is too narrow for both (`splitFits`): two tabs over one pane. */
  tab: PaneSide;
  /** The hidden tab's pane changed since it was last shown: its tab carries a dot. */
  changed: PaneSide | null;
}

export const NO_SPLIT: SplitState = { right: null, focus: "left", tab: "left", changed: null };

/** The narrowest a pane may be: a conversation's composer still fits in it. */
export const SPLIT_PANE_MIN = 360;
/** The divider between the panes (`files/Splitter.tsx`), as `shellFit.ts`' `SPLITTER`. */
const DIVIDER = 6;

/**
 * Open something in the right pane: on its path, splitting the column if it was not, the right pane
 * focused and shown. Pushing what is already on top changes nothing on the path.
 */
export function openInSplit(split: SplitState, entry: PanelEntry): SplitState {
  const right = split.right === null ? { ...EMPTY_STACK, entries: [entry], motion: "replace" as const } : push(split.right, entry);
  return { right, focus: "right", tab: "right", changed: null };
}

/** The right pane closed: the column is one again, and the left focused. */
export function closeSplit(): SplitState {
  return NO_SPLIT;
}

/**
 * A change to the right pane's path (‹, ›, a crumb, a link inside it). A path left with nothing on it
 * closes the pane. A change the person cannot see — the right pane behind its tab — marks its tab.
 */
export function onRight(split: SplitState, step: (stack: PanelStack) => PanelStack): SplitState {
  if (split.right === null) return split;
  const next = step(split.right);
  if (next === split.right) return split;
  if (next.entries.length === 0) return closeSplit();
  const moved = topOf(next)?.key !== topOf(split.right)?.key;
  return { ...split, right: next, ...(moved && split.tab === "left" ? { changed: "right" as const } : {}) };
}

/** The left pane's content moved (another task, conversation or file): its tab is marked while it is hidden. */
export function leftMoved(split: SplitState): SplitState {
  if (split.right === null || split.tab === "left" || split.changed === "left") return split;
  return { ...split, changed: "left" };
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
 * Where a row pressed in the sidebar lands: on the right pane's path when that pane is focused (the
 * new split, else `null` — the left goes there as it always did). A phone has no split.
 */
export function routeOpen(split: SplitState, entry: PanelEntry, phone = false): SplitState | null {
  if (phone || split.right === null || split.focus !== "right") return null;
  return openInSplit(split, entry);
}

/**
 * One line of a pane's path menu: what it is, and how far from where the pane stands — negative behind,
 * 0 here, positive ahead (what › would go forward to).
 */
export interface PathLine {
  entry: PanelEntry;
  offset: number;
}

/**
 * The pane's path, as its menu lists it: newest first — what › would go to (furthest first), where it
 * stands, then back to the root.
 */
export function historyOf(stack: PanelStack): PathLine[] {
  const ahead = stack.ahead.map((entry, i) => ({ entry, offset: i + 1 })).reverse();
  const here = stack.entries.map((entry, i) => ({ entry, offset: i - (stack.entries.length - 1) })).reverse();
  return [...ahead, ...here];
}

/** A line of the path menu chosen: back to that level, or forward to it. */
export function walkTo(stack: PanelStack, offset: number): PanelStack {
  if (offset < 0) return popTo(stack, stack.entries.length - 1 + offset);
  let at = stack;
  for (let i = 0; i < offset; i++) at = forward(at);
  return at;
}

/** The task an entry is about, when it is one of a task's kinds. */
export function taskOfEntry(entry: PanelEntry | undefined): { taskId: string; project?: string } | undefined {
  if (entry === undefined) return undefined;
  if (entry.kind !== "task" && entry.kind !== "convo" && entry.kind !== "subagent" && entry.kind !== "rerun" && entry.kind !== "chat") return undefined;
  return { taskId: entry.taskId, ...(entry.project !== undefined ? { project: entry.project } : {}) };
}

/**
 * What the side panel stands on while the right pane is focused (the person's board 10: the panel
 * follows the focused pane): the context of the task the right pane shows — its conversation is on
 * screen there already, so the panel holds what is beside it. Null while the left is focused, or the
 * right shows no task (an artifact, a state): then the room's own rule stands.
 */
export function focusRuleOf(split: SplitState): PanelEntry | null {
  if (split.right === null || split.focus !== "right") return null;
  const task = taskOfEntry(topOf(split.right));
  if (task === undefined) return null;
  return { kind: "convo", key: `convo:${task.taskId}`, taskId: task.taskId, ...(task.project !== undefined ? { project: task.project } : {}), tab: "steps" };
}

/** A task as a pane opens it: its conversation. */
export function taskPaneEntryOf(taskId: string, project?: string): PanelEntry {
  return { kind: "task", key: `task:${taskId}`, taskId, ...(project !== undefined ? { project } : {}), tab: "conversation" };
}

/** An artifact as an entry: what the side panel and the right pane hold for one. */
export function artifactEntryOf(ref: PublishedRef, project?: string): PanelEntry {
  const title = ref.title ?? ref.entry;
  return { kind: "preview", key: `preview:${title}`, preview: { title, published: { ref, ...(project !== undefined ? { project } : {}) } } };
}

/** The artifact an entry holds, if it holds one. */
export function publishedOfEntry(entry: PanelEntry | undefined): { ref: PublishedRef; project?: string | undefined } | undefined {
  return entry?.kind === "preview" ? entry.preview.published : undefined;
}

/**
 * Every place an artifact stands in now: over the main view, on top of the right pane, on top of the
 * side panel. By its id — another version of the same artifact is the same artifact.
 */
export function shownPlacesOf(id: string, at: { main: PublishedRef | null; split: PanelEntry | undefined; panel: PanelEntry | undefined }): Place[] {
  const out: Place[] = [];
  if (at.main?.id === id) out.push("main");
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
 * What the left pane stands on, as an entry — what Swap and "Move to the side panel" carry: the open
 * conversation in the Chat room, the selected task in the Tasks room, the open state in Files.
 */
export function leftEntryOf(
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

/** The right pane's top swapped for what the left showed (null: the right pane closes). */
export function swapRight(split: SplitState, left: PanelEntry | null): SplitState {
  if (split.right === null) return split;
  if (left === null) return closeSplit();
  return { ...split, right: { ...EMPTY_STACK, entries: [left], motion: "replace" }, focus: "left" };
}

/**
 * Take the top off the right pane — what it showed has gone somewhere else (to the main view, the side
 * panel). The pane goes back a level; a pane left with nothing closes.
 */
export function leaveRight(split: SplitState): SplitState {
  if (split.right === null) return split;
  if (split.right.entries.length <= 1) return closeSplit();
  const entries = split.right.entries.slice(0, -1);
  return { ...split, right: { ...split.right, entries, ahead: [], motion: "pop" } };
}
