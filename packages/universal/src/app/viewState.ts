import { useSyncExternalStore } from "react";

/**
 * The few facts `App.tsx` keeps in its own `useState` and hands to more than one region — the reading of
 * a drilled run (the title bar's toggle, the column's `RunView`), which board group the column is
 * scrolled to (the column measures it, the title bar names it), and the New-task button's link to the
 * panel stack (the panel column holds the stack, the title bar has the button).
 *
 * In the universal shell those regions are separate files (`TitleBar.tsx`, `BoardColumn.tsx`,
 * `PanelColumn.tsx`) under one `UniversalApp`, so the state is here, one small store per fact, for any
 * of them to read and set. There is one shell per page, as there is one `App` per window.
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

/** `App.tsx`'s `runMode`: which reading of a drilled run is on screen — its board, or its conversation. */
export const runMode = shared<"board" | "conversation">("board");

/**
 * `App.tsx`'s `atProject`: the board group the Tasks column is scrolled to, while it lists every group.
 * The column sets it as it scrolls (`trackBoards`); null until it has, and then the address stands on
 * the first group, which is what the desktop measures at the top of the column.
 */
export const boardAt = shared<string | null>(null);

/**
 * The New-task button's side of the panel stack: what the stack's top is (the button is pressed while
 * the form is open), and how to open the form (`App.tsx`'s `openNewTask`: push it, unfold the panel).
 * The panel column, which holds the stack, sets both; until it does, the button opens nothing.
 */
export const panelTopKind = shared<string | null>(null);
export const newTaskOpener = shared<(() => void) | null>(null);

/**
 * `App.tsx`'s `reveal`: the diagnostic the state inspector last asked the editor to show. The inspector
 * (the panel's Checks) and the editor (the Files room's middle) are siblings; the nonce makes a second
 * click on the same issue mean "show me again". See `FileSurfaceContext.revealIssue`.
 */
export const issueReveal = shared<{ path: string; nonce: number } | null>(null);
