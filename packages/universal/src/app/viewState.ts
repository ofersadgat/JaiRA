import { useSyncExternalStore } from "react";

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
 * question showing, so at least half. A request, with a stamp so the same one twice means "again".
 */
export const sheetAsk = shared<{ detent: "peek" | "half" | "full"; at: number } | null>(null);
