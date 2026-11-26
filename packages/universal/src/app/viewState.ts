import { useSyncExternalStore } from "react";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { NO_SPLIT, type SplitState } from "@jaira/ui/splitModel";
import type { PanelEntry } from "@jaira/ui/panelStack";
import type { PanelFace } from "../components/panel/SidePanel";

/**
 * The few facts more than one of the shell's regions reads or sets — the reading of a drilled run (the
 * title bar's toggle, the column's `RunView`), which board group the column is scrolled to (the column
 * measures it, the title bar names it), and the New-task button's link to the panel stack (the panel
 * column holds the stack, the title bar has the button).
 *
 * The regions are separate files (`TitleBar.tsx`, `BoardColumn.tsx`, `PanelColumn.tsx`) under one
 * `UniversalApp`, so the state is here, one small store per fact, for any of them to read and set.
 * There is one shell per page, so one of each is enough.
 */
function shared<T>(initial: T): { get: () => T; set: (next: T) => void; use: () => T } {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (on: () => void): (() => void) => {
    listeners.add(on);
    return () => listeners.delete(on);
  };
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const on of listeners) on();
    },
    use: () => useSyncExternalStore(subscribe, () => value, () => value),
  };
}

/** Which reading of a drilled run is on screen — its board, or its conversation. */
export const runMode = shared<"board" | "conversation">("board");

/**
 * The published artifact drawn over the main view (`ArtifactInMain.tsx`), put there by its Main view
 * place button (`places.ts`) from wherever it was drawn: the conversation, the side panel, a split.
 */
export const artifactInMain = shared<{ published: PublishedRef; artifacts: ArtifactSurface; /** The publish call it goes on from (`artifactEntryOf`'s `follows`). */ follows?: number | undefined } | null>(null);

/**
 * The split (decision 0025, `splitModel.ts`): the right pane's path, which pane is focused, which shows
 * while narrow. One for the window, as a pinned panel stack is: drawn by the Tasks, Files and Chat rooms
 * beside their middle column (`SplitPane.tsx`), and not kept across a reload.
 */
export const splitView = shared<SplitState>(NO_SPLIT);

/** The room on screen can split its middle column: the panel column says so while it draws a room that can. */
export const splitHere = shared(false);

/**
 * What each pane shows, by name: the right's tab says it while the room is too narrow for both panes,
 * and a drop zone over a pane says what ‹ will return to.
 */
export const paneTitles = shared<readonly string[]>(["Main view", "Split"]);

/**
 * How each pane draws what is on its path that is not a conversation or an artifact (a state, a run's
 * subagent, a value), by the pane's place: the side panel's faces over that pane's own path, which the
 * panel column makes from its host (`PanelColumn.tsx`) — a link inside one goes on that pane's path.
 */
export const paneFaces = shared<readonly ((entry: PanelEntry) => PanelFace)[] | null>(null);

/**
 * The side panel as the person left it, for the window to fit the columns by (`columnsFit.ts`): how wide
 * it stands open (0 while the room has none, or nothing is on it) and whether they left it open. The
 * panel column sets both — as it would be, never as it is drawn, so fitting it cannot move it.
 */
export const panelOpenWidth = shared<number>(0);
export const panelLeftOpen = shared<boolean>(true);

/**
 * The board group the Tasks column is scrolled to, while it lists every group. The column sets it as it
 * scrolls (`BoardColumn`'s `track`); null until it has, and then the address stands on the first group,
 * which is the one at the top of an unscrolled column.
 */
export const boardAt = shared<string | null>(null);

/**
 * The New-task button's side of the panel stack: what the stack's top is (the button is pressed while
 * the form is open), and how to open the form (`panelHost.ts`' `openNewTaskWith`: push it, unfold the
 * panel).
 * The panel column, which holds the stack, sets both; until it does, the button opens nothing.
 */
export const panelTopKind = shared<string | null>(null);
export const newTaskOpener = shared<(() => void) | null>(null);

/**
 * The diagnostic the state inspector last asked the editor to show. The inspector (the panel's Checks)
 * and the editor (the Files room's middle) are siblings; the nonce makes a second click on the same
 * issue mean "show me again". See `FileSurfaceContext.revealIssue`.
 */
export const issueReveal = shared<{ path: string; nonce: number } | null>(null);

/**
 * Where a "Go to Definition" asked the caret to land, and in which file. The editor that asks is gone by
 * the time the file it asked for opens, so the request is kept here, outside both; it carries its path
 * and is applied only to a file of that path. See `FileSurfaceContext.revealAt` (and why it has no nonce).
 */
export const definitionReveal = shared<{ path: string; line: number; column: number } | null>(null);

/**
 * About opened from the sidebar's Update row with its release notes showing (the row's menu, "Release
 * notes"). The sidebar sets it and folds it again once Settings → About is left; `AboutPage` opens its
 * notes by it — only for that one opening.
 */
export const aboutNotes = shared(false);

/** A phone's sidebar, slid over the room (`PhoneFrame`): the title bar's ▸| opens it, a choice in it closes it. */
export const phoneDrawer = shared(false);

/** A phone's Inbox room is the one showing, in place of the store's view (`PhoneFrame`). */
export const phoneInbox = shared(false);

/**
 * The height a phone's context panel is asked to stand at (`PanelSheet`): the Inbox opens a task with its
 * question showing, so at least half. A request, with a stamp so the same one twice means "again";
 * `atLeast`, it only raises — a sheet already higher stays where it is.
 */
/**
 * The phone's sheet stands at full, settled and not held: the room under it is out of sight, and is kept
 * hidden (`PhoneFrame`'s `Room`, an `Activity`) rather than drawn for nobody — the board under it was 700
 * components drawn again with every change on the machine.
 */
export const sheetCovers = shared(false);

export const sheetAsk = shared<{ detent: "peek" | "half" | "full"; at: number; atLeast?: boolean } | null>(null);

/**
 * How a phone's swipe in from the screen's right edge opens the room's context panel (`PhoneFrame`): the
 * panel column sets it while its room has a panel with something on it (unfold it, raise its sheet to
 * half), null while there is nothing to open — and then the swipe is not taken.
 */
export const phonePanelOpener = shared<(() => void) | null>(null);

/**
 * Whether the touch going on began on something that owns the screen's right edge itself — a run's Steps
 * rail (`StepsRail`), pulled left from it. The frame clears it as a touch begins (its capture is asked
 * first, from the root down), the rail sets it as the same touch reaches it, and a swipe that began there
 * is left to the rail rather than opening the panel. Read and written within one touch: no one redraws on it.
 */
export const rightEdgeTouch = { owned: false };
