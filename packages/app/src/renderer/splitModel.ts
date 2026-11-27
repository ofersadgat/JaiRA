/**
 * The SPLIT — the room's middle column as one or two panes, and the three places an artifact can be put
 * (decision 0025: the person's rulings of 2026-11-13, "07 and 09 are the correct design for split view
 * panels", and "both panels should be fully self contained. I.e. their ui should be identical. You
 * should be able to close either of them.").
 *
 * A PANE is a main view with a HISTORY of its own, walked by its own ‹ and ›. There are one or two, and
 * they are the same thing: nothing here is about a left or a right pane but the order they stand in. A
 * history (`PanePath`) is where the pane has been, oldest first, what it shows on top, and what › goes
 * forward to in `ahead`; its entries are the side panel's kinds — a task or a conversation, an artifact,
 * a state — and one more, the ROOM: the Tasks room's board, the Files room's file, the Chat room's start
 * page, which only the room draws.
 *
 * The crumbs in a pane's head are not its history but WHERE what it shows stands (`trailOf`, the
 * person, 2026-11-24: "the breadcrumb is meant to be a resource path / hierarchy, not history"): an
 * artifact under its conversation, a run's subagent under its task. Pressing one goes there — a step in
 * the history like any other. What the room stands on is `here`: that room entry, or — the Chat
 * room on a conversation — the conversation's own entry, the same path any pane opens it by, so it is
 * drawn the same wherever it stands (the person, 2026-11-13: "if you opened the same path, the two
 * panels should look pixel identical"). `here` is on whichever pane holds it; the window opens on one
 * pane whose path is `here` alone, and one pane is the unsplit main view.
 *
 * Pure: a value in, a new value out. The shell holds the split (`viewState.ts`' `splitView`) and the
 * panes draw it (`SplitPane.tsx`); the rules are tested here without a window.
 */
import type { PanelEntry, ShownSet, SubagentWalkStep } from "./panelStack";
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

/** One pane's history: where it has been, oldest first, what it shows last; what › goes forward to, nearest first. */
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
  /** What the room stands on, as a path's entry: the room's own view, or the Chat room's conversation. */
  here: PaneEntry;
}

export const ROOM_PATH: PanePath = { entries: [ROOM], ahead: [] };
export const NO_SPLIT: SplitState = { panes: [ROOM_PATH], focus: 0, tab: 0, changed: null, here: ROOM };

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

/** The focused pane, as an index of a pane there is. */
export function focusedPaneOf(split: SplitState): number {
  return Math.min(split.focus, split.panes.length - 1);
}

/**
 * The pane holding what the room stands on (`here`), and how deep in its path; null when no pane holds
 * it. The focused pane first: two panes on one conversation, the room is the one the person is in.
 */
export function roomPaneOf(split: SplitState): { pane: number; at: number } | null {
  const focused = focusedPaneOf(split);
  const order = [focused, ...split.panes.map((_, i) => i).filter((i) => i !== focused)];
  for (const pane of order) {
    const at = split.panes[pane]!.entries.findIndex((entry) => entry.key === split.here.key);
    if (at >= 0) return { pane, at };
  }
  return null;
}

/**
 * What the room goes on to because the focused pane shows it (the person, 2026-11-24: "whatever panel is
 * focused should be treated as the active/main panel as far as the rest of the app is concerned") — the
 * sidebar's selected row, the side panel, the address are the focused pane's. A conversation on top (a
 * task as a pane opens it), or the room's own view; null when the room already stands there, or the
 * pane stands on something the room cannot (an artifact, a state, a run's subagent).
 *
 * `where`: in a room whose own view is not a conversation (Tasks: the board), the task it has selected —
 * the room follows by selecting it, its own view staying where it is.
 */
export function followOf(split: SplitState, where?: string | null): PaneEntry | null {
  const top = topOfPath(split.panes[focusedPaneOf(split)]);
  if (top === undefined || top.key === split.here.key) return null;
  if (isRoom(top)) return top;
  if (top.kind !== "task") return null;
  return where !== undefined && top.taskId === where ? null : top;
}

/**
 * A step in a pane's history: it goes to `entry`. Going to what it shows is nothing (another version of
 * the artifact on top is the same place, at that version); going to what › would go forward to is going
 * forward; anything else is a new step, and what was ahead is dropped. Somewhere it has been before is
 * a new step too — the history is where it went, in order, not a trail to walk back up.
 */
export function pushPath(path: PanePath, entry: PaneEntry): PanePath {
  const top = topOfPath(path);
  if (top?.key === entry.key) return sameVersion(top, entry) ? path : { entries: [...path.entries.slice(0, -1), entry], ahead: path.ahead };
  const ahead = path.ahead[0]?.key === entry.key ? path.ahead.slice(1) : [];
  return { entries: [...path.entries, entry], ahead };
}

/** ‹ — one step back. The first stays: ✕ is how a pane goes. */
export function paneBack(path: PanePath): PanePath {
  return path.entries.length <= 1 ? path : crumbTo(path, path.entries.length - 2);
}

/** › — forward again to where ‹ came back from. */
export function paneForward(path: PanePath): PanePath {
  const next = path.ahead[0];
  return next === undefined ? path : { entries: [...path.entries, next], ahead: path.ahead.slice(1) };
}

/** Back to step `index` of the history at once (its menu), what it passes kept ahead. */
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
    return { panes: [...panes, { entries: [entry], ahead: [] }], focus: panes.length, tab: panes.length, changed: null, here: split.here };
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
  if (!isSplit(split)) return emptied ? { ...NO_SPLIT, panes: [{ entries: [split.here], ahead: [] }], here: split.here } : split;
  const rest = split.panes.filter((_, i) => i !== pane);
  return { panes: rest, focus: 0, tab: 0, changed: null, here: split.here };
}

/** Only this pane: the other closes. */
export function onlyPane(split: SplitState, pane: number): SplitState {
  return isSplit(split) ? closePane(split, pane === 0 ? 1 : 0) : split;
}

/** Swap the panes: each stands where the other stood, with its path; focus goes with the pane. */
export function swapPanes(split: SplitState): SplitState {
  if (!isSplit(split)) return split;
  const flip = (i: number | null): number | null => (i === null ? null : 1 - i);
  return { panes: [split.panes[1]!, split.panes[0]!], focus: 1 - split.focus, tab: 1 - split.tab, changed: flip(split.changed), here: split.here };
}

/**
 * The room moved (another task, conversation or file; another room): it stands on `here` now, and is
 * shown. The pane that held where it stood goes on to it there; no pane holding it, it goes on the
 * focused pane's path.
 *
 * `step`: the room moved WITHIN itself (another conversation opened from the sidebar, a new one
 * started) — it goes on that pane's path as anything else does (`pushPath`), so the pane's ‹ comes back
 * (the person, 2026-11-24: "each pane should have its own history that the arrows should navigate
 * through"). Not a step (the window come to this room, or opened on it), or a step off the room's own
 * view (the start page, which what is opened from it takes the place of), what was on top is dropped.
 * The room's own view moved under the same key (Tasks: another task selected on the board) is shown
 * by dropping what was put over it, step or not.
 *
 * Unless it went to what the focused pane already shows (`followOf`: the room follows the focused
 * pane) — then nothing on any path moves: a conversation on top of the focused pane is what the room
 * stands on now; in a room whose own view is not a conversation, the task `where` it selected is.
 */
export function roomMoved(split: SplitState, here: PaneEntry, where?: string | null, step = false): SplitState {
  const focused = focusedPaneOf(split);
  const top = topOfPath(split.panes[focused]);
  if (top !== undefined && top.key === here.key && (!isRoom(here) || split.here.key !== here.key)) {
    if (split.here === here && top === here) return split;
    const path = split.panes[focused]!;
    const panes = split.panes.map((one, i) => (i === focused ? { ...path, entries: [...path.entries.slice(0, -1), here] } : one));
    return { ...split, panes, here };
  }
  if (isRoom(here) && where !== undefined && where !== null && top?.kind === "task" && top.taskId === where && split.here.key === here.key) return split;
  if (step && split.here.key !== here.key && top !== undefined) {
    // A step within the room is a step in the focused pane's history. Off the start page (a form) to
    // a conversation, what is opened from it takes its place.
    const path = split.panes[focused]!;
    const offStart = isRoom(top) && isRoom(split.here) && !isRoom(here);
    const panes = withoutRoomElsewhere(split.panes, focused, here);
    panes[focused] = offStart ? { entries: [...path.entries.slice(0, -1), here], ahead: path.ahead } : pushPath(path, here);
    const kept = panes.filter((one) => one.entries.length > 0);
    return { ...split, panes: kept, here, focus: Math.min(focused, kept.length - 1), tab: Math.min(split.tab, kept.length - 1) };
  }
  const held = roomPaneOf(split);
  const moved = { ...split, here };
  if (held === null) return openInPane(moved, focused, here);
  const path = split.panes[held.pane]!;
  if (split.here.key === here.key && held.at === path.entries.length - 1 && path.ahead.length === 0) {
    if (split.here === here) return split;
    // The same subject somewhere else — a conversation moved to another workspace keeps its id: the pane
    // draws it where it is now.
    const panes = [...split.panes];
    panes[held.pane] = { ...path, entries: [...path.entries.slice(0, held.at), here] };
    return { ...moved, panes };
  }
  const panes = withoutRoomElsewhere(split.panes, held.pane, here);
  panes[held.pane] = { entries: [...path.entries.slice(0, held.at), here], ahead: [] };
  return { ...moved, panes };
}

/**
 * Take the top off a pane — what it showed has gone somewhere else (another place). It goes back a
 * level, as ‹ does: what it showed is ahead of it, › away; a pane whose path runs out closes, or, the
 * only one, stands on the room.
 */
export function leavePane(split: SplitState, pane: number): SplitState {
  const path = split.panes[pane];
  if (path === undefined) return split;
  if (path.entries.length <= 1) return closePane(split, pane, true);
  return setPath(split, pane, paneBack(path));
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
  if (topOfPath(split.panes[pane])?.key === split.here.key) return null;
  return openInPane(split, pane, entry);
}

/** One line of a pane's history menu: what it is, and how far from where the pane stands (negative behind, 0 here, positive ahead). */
export interface PathLine {
  entry: PaneEntry;
  offset: number;
}

/** The pane's history, as its menu lists it (‹ held, or its last crumb pressed): newest first, what › goes to above where it stands. */
export function historyOf(path: PanePath): PathLine[] {
  const ahead = path.ahead.map((entry, i) => ({ entry, offset: i + 1 })).reverse();
  const here = path.entries.map((entry, i) => ({ entry, offset: i - (path.entries.length - 1) })).reverse();
  return [...ahead, ...here];
}

/** A line of the history menu chosen: back to that step, or forward to it. */
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
  const top = topOfPath(split.panes[Math.min(split.focus, split.panes.length - 1)]);
  if (top?.key === split.here.key) return null;
  const task = taskOfEntry(top);
  if (task === undefined) return null;
  return { kind: "convo", key: `convo:${task.taskId}`, taskId: task.taskId, ...(task.project !== undefined ? { project: task.project } : {}), tab: "steps" };
}

/** A task as a pane opens it: its conversation. */
export function taskPaneEntryOf(taskId: string, project?: string): PanelEntry {
  return { kind: "task", key: `task:${taskId}`, taskId, ...(project !== undefined ? { project } : {}), tab: "conversation" };
}

/**
 * A subagent of a task's conversation as an entry: `at` is the instance whose session holds the walk's
 * first call (the conversation's own thread, or the run it started that the first step's `host` names),
 * `chain` the walk to it, outermost first. Keyed by its host and its own call, as the side panel keys one.
 */
export function subagentEntryOf(taskId: string, project: string | undefined, at: { instanceId: string; stateId: string }, chain: readonly SubagentWalkStep[]): PanelEntry {
  const last = chain[chain.length - 1]!;
  return {
    kind: "subagent",
    key: `subagent:${at.instanceId}:${last.call}`,
    taskId,
    ...(project !== undefined ? { project } : {}),
    step: { instanceId: at.instanceId, stateId: at.stateId, sidechain: last.call, name: last.name },
    chain,
  };
}

/**
 * The walk a subagent entry stands for, as the conversation's thread walks it (`ChatSurface.walkedChain`):
 * its own `chain`, else its call alone under its host — which the thread reads as its own subagent when
 * the host is not a run it started.
 */
export function walkOfEntry(entry: PaneEntry | undefined | null): readonly SubagentWalkStep[] | undefined {
  if (entry?.kind !== "subagent" || entry.step.sidechain === undefined) return undefined;
  if (entry.chain !== undefined && entry.chain.length > 0) return entry.chain;
  return [{ call: entry.step.sidechain, name: entry.step.name ?? "subagent", host: entry.step.instanceId }];
}

/**
 * What a pane's body is keyed by: a task's entries — the task, its subagents — by the task, so walking
 * in and out of its subagents is the one thread drawn again, not a new one read from nothing.
 */
export function bodyKeyOf(entry: PaneEntry): string {
  return entry.kind === "subagent" ? `task:${entry.taskId}` : entry.key;
}

/**
 * What an entry stands under, as a pane would open it: an artifact under its conversation; a subagent
 * under the one that started it, the first under its task; a rerun, a command's terminal, a step of a
 * task's run under its task. A conversation, a task, a state, the room's own view stand alone.
 */
export function parentOf(entry: PaneEntry): PaneEntry | undefined {
  const published = publishedOfEntry(entry);
  if (published !== undefined) return taskPaneEntryOf(published.ref.taskId, published.project);
  if (entry.kind === "subagent" && entry.chain !== undefined && entry.chain.length > 1) {
    return subagentEntryOf(entry.taskId, entry.project, { instanceId: entry.step.instanceId, stateId: entry.step.stateId }, entry.chain.slice(0, -1));
  }
  if (entry.kind === "subagent" || entry.kind === "rerun" || entry.kind === "terminal") return taskPaneEntryOf(entry.taskId, entry.project);
  if (entry.kind === "convo" && entry.step !== undefined) return taskPaneEntryOf(entry.taskId, entry.project);
  return undefined;
}

/**
 * Where an entry stands, outermost first and itself last: the crumbs of a pane's head (the person,
 * 2026-11-24: "the breadcrumb is meant to be a resource path / hierarchy, not history"). The same
 * whatever way the pane came to it.
 */
export function trailOf(entry: PaneEntry): PaneEntry[] {
  const out: PaneEntry[] = [entry];
  for (let up = parentOf(entry); up !== undefined && out.length < 8; up = parentOf(up)) out.unshift(up);
  return out;
}

/**
 * An artifact as an entry: what the side panel and a pane hold for one. Keyed by the artifact's id, so
 * two artifacts of one title are two entries and two versions of one are the same place on a path.
 *
 * `follows`: the version of the publish CALL it was opened from, when it was opened from a call's card
 * at what that card showed of its own accord (not a version picked off its menu). Such an entry goes on
 * to a later publish of the artifact in the same run, as the conversation's card does
 * (`publishSuccessorsOf`, the person's ruling of 2026-11-14); one opened any other way stays where it was put.
 */
export function artifactEntryOf(ref: PublishedRef, project?: string, follows?: number): PanelEntry {
  const title = ref.title ?? ref.entry;
  return {
    kind: "preview",
    key: `artifact:${ref.id}`,
    preview: { title, published: { ref, ...(project !== undefined ? { project } : {}), ...(follows !== undefined ? { follows } : {}) } },
  };
}

/** The artifact an entry holds, if it holds one. */
export function publishedOfEntry(entry: PaneEntry | undefined | null): { ref: PublishedRef; project?: string | undefined; follows?: number | undefined } | undefined {
  return entry?.kind === "preview" ? entry.preview.published : undefined;
}

/** Two entries at one place on a path, the same in all but an artifact's version: whether that is the same too. */
function sameVersion(a: PaneEntry, b: PaneEntry): boolean {
  const one = publishedOfEntry(a);
  const two = publishedOfEntry(b);
  return one === undefined || two === undefined || (one.ref.version === two.ref.version && one.follows === two.follows);
}


/** What stands on top of each place. */
export interface PlacesAt {
  main: PublishedRef | null;
  first?: PaneEntry | undefined;
  second?: PaneEntry | undefined;
  panel: PanelEntry | undefined;
}

/**
 * Every place an artifact stands in now: the main view (drawn over a room with no panes of its own, or
 * on top of the first pane), on top of the second pane, on top of the side panel. By its id — another
 * version of the same artifact is the same artifact, and a move takes it from wherever it is.
 */
export function shownPlacesOf(id: string, at: PlacesAt): Place[] {
  return placesWhere(at, ({ ref }) => ref.id === id);
}

/**
 * The places a view of an artifact LIGHTS: those showing this artifact at this version (the person,
 * 2026-11-14 — another version, or another artifact, lights nothing). A call's card that `follows` its
 * call lights a place opened from that same call, whichever version the two then went on to show (the
 * person's edits after the call, which both show).
 */
export function litPlacesOf(shown: { id: string; version: number; follows?: number | undefined }, at: PlacesAt): Place[] {
  return placesWhere(at, ({ ref, follows }) => ref.id === shown.id && (ref.version === shown.version || (shown.follows !== undefined && follows === shown.follows)));
}

/**
 * The set an entry shows, of what one `show_artifact` call showed together: the set itself (`shown`), or
 * one of its items with the others beside it (a `preview` opened `within` it). A picture of it opened on
 * its own is not the set's.
 */
export function setOfEntry(entry: PaneEntry | undefined | null): ShownSet | undefined {
  if (entry?.kind === "shown") return entry.set;
  if (entry?.kind === "preview") return entry.within;
  return undefined;
}

/**
 * Every place a shown set stands in now, by its key: the places whose top is the set, or one of its items
 * with the others beside it — what the set's own place buttons light (the person, 2026-11-27). The main
 * view drawn over a room with no panes holds one artifact alone, never a set.
 */
export function setPlacesOf(key: string, at: PlacesAt): Place[] {
  const holds = (entry: PaneEntry | undefined): boolean => setOfEntry(entry)?.key === key;
  return [...(holds(at.first) ? (["main"] as const) : []), ...(holds(at.second) ? (["split"] as const) : []), ...(holds(at.panel) ? (["panel"] as const) : [])];
}

function placesWhere(at: PlacesAt, is: (held: { ref: PublishedRef; follows?: number | undefined }) => boolean): Place[] {
  const out: Place[] = [];
  const holds = (entry: PaneEntry | undefined): boolean => {
    const held = publishedOfEntry(entry);
    return held !== undefined && is(held);
  };
  if ((at.main !== null && is({ ref: at.main })) || holds(at.first)) out.push("main");
  if (holds(at.second)) out.push("split");
  if (holds(at.panel)) out.push("panel");
  return out;
}

/**
 * The later publish an entry goes on to, by the call it follows: `successors` maps `<url>@<call
 * version>` to the newest publish of that artifact in the same run (`publishSuccessorsOf`). The entry
 * itself when nothing replaced its call.
 */
export function followedEntry<E extends PaneEntry>(entry: E, successors: ReadonlyMap<string, PublishedRef>): E | PanelEntry {
  const published = publishedOfEntry(entry);
  if (published?.follows === undefined) return entry;
  const next = successors.get(`${published.ref.url}@${String(published.follows)}`);
  if (next === undefined || next.version === published.follows) return entry;
  return artifactEntryOf(next, published.project, next.version);
}

/** Every entry of a path (and ahead of it) gone on to its later publish; the same path when none moved. */
export function followedPath(path: PanePath, successors: ReadonlyMap<string, PublishedRef>): PanePath {
  let moved = false;
  const step = (entry: PaneEntry): PaneEntry => {
    const next = followedEntry(entry, successors);
    if (next !== entry) moved = true;
    return next;
  };
  const entries = path.entries.map(step);
  const ahead = path.ahead.map(step);
  return moved ? { entries, ahead } : path;
}

/** Every pane's path gone on to the later publishes; the same split when nothing moved. */
export function followedSplit(split: SplitState, successors: ReadonlyMap<string, PublishedRef>): SplitState {
  if (successors.size === 0) return split;
  const panes = split.panes.map((path) => followedPath(path, successors));
  return panes.every((path, i) => path === split.panes[i]) ? split : { ...split, panes };
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
