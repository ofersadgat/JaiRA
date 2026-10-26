/**
 * How the desktop's two columns give way in a narrow window (the narrow-window mockups, 2026-10-25; the
 * person picked "A + E"). The room between them — the conversation, the board — keeps at least
 * {@link ROOM_FLOOR}: when the window would leave it less, the sidebar folds to its rail first, then the
 * side panel to its own. Neither touches the person's folds (`FOLD` in `uiState.ts`), so a column folded
 * here comes back by itself as the window widens.
 *
 * A column the person opens while the window is too narrow for it — its rail pressed, or the app opening
 * the panel to show something — is KEPT open, and the other gives way instead (`noteFold`, from the
 * store's `setFold`). Under `PHONE_WIDTH` the window takes the phone's layout (`phoneModel.ts`), where
 * neither is a column and this does not apply.
 */
import { useSyncExternalStore } from "react";
import { FOLD, PANEL_RAIL, SIDEBAR_RAIL } from "./uiState";

/** The narrowest the room between the columns may be made by them: the composer's chips still fit in it. */
export const ROOM_FLOOR = 460;

/** A splitter's width (`files/Splitter.tsx`): one stands beside each open column. */
export const SPLITTER = 6;

export type Column = "sidebar" | "panel";

export interface ColumnsIn {
  /** The window's width. */
  width: number;
  /** The sidebar as the person left it. */
  sidebar: { open: boolean; width: number };
  /** The side panel as the person left it; `width` 0 when the room has none, or nothing is on it. */
  panel: { open: boolean; width: number };
  /** The column the person last opened, which stays open. */
  kept?: Column | undefined;
}

/** Which of the two stand open in the window: the sidebar folds first, then the panel, until the room fits. */
export function columnsFitOf({ width, sidebar, panel, kept }: ColumnsIn): { sidebar: boolean; panel: boolean } {
  const present = panel.width > 0;
  const open = { sidebar: sidebar.open, panel: present && panel.open };
  const room = (): number => width - (open.sidebar ? sidebar.width + SPLITTER : SIDEBAR_RAIL) - (!present ? 0 : open.panel ? panel.width + SPLITTER : PANEL_RAIL);
  const order: Column[] = kept === "sidebar" ? ["panel"] : kept === "panel" ? ["sidebar"] : ["sidebar", "panel"];
  for (const column of order) {
    if (room() >= ROOM_FLOOR) break;
    open[column] = false;
  }
  return { sidebar: open.sidebar, panel: present ? open.panel : panel.open };
}

const PANEL_FOLDS: ReadonlySet<string> = new Set([FOLD.panelFiles, FOLD.panelTasks, FOLD.panelChat, FOLD.panelDebug]);

/** The column a fold key is, if it is one. */
export function columnOfFold(id: string): Column | undefined {
  return id === FOLD.shellSidebar ? "sidebar" : PANEL_FOLDS.has(id) ? "panel" : undefined;
}

/** What `kept` becomes when a fold is set: an opened column is kept; folding the kept one forgets it. */
export function keptAfter(kept: Column | undefined, id: string, open: boolean): Column | undefined {
  const column = columnOfFold(id);
  if (column === undefined) return kept;
  return open ? column : kept === column ? undefined : kept;
}

let kept: Column | undefined;
const watchers = new Set<() => void>();

/** A fold was set (the store's `setFold`): remember the column opened, or forget the one folded. */
export function noteFold(id: string, open: boolean): void {
  const next = keptAfter(kept, id, open);
  if (next === kept) return;
  kept = next;
  for (const watcher of [...watchers]) watcher();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** The column the person last opened. */
export function useKeptColumn(): Column | undefined {
  return useSyncExternalStore(subscribe, () => kept, () => kept);
}
