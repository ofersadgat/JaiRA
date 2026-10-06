/**
 * Where this window stands — the project, the view, the task and the conversation open in it — kept
 * so a RELOAD comes back to the same place.
 *
 * The window is a view onto what is recorded, so reloading it must lose nothing but the frame. It did
 * lose the place: seen 2026-10-06, a window reloaded by One's skew protection (its build replaced under
 * it) came back standing on the last project it had OPENED rather than the one it was on, with no
 * conversation open, and the two being read were nowhere in the list it showed.
 *
 * In `sessionStorage`, which is the window's own and outlives a reload but not a close: a new window,
 * or the app started again, begins where the engine says (`project:current`). Ids only — the engine
 * finds a task from its id alone (`AppService.homeOf`), so nothing here has to name a project for it.
 * A storage that throws or is gone costs the restore, never the window.
 */
import type { View } from "./store";

const STORE = "jaira.window.address";

export interface WindowAddress {
  at: string | null;
  view: View;
  selected: string | null;
  conversation: string | null;
}

export function readAddress(): WindowAddress | null {
  try {
    const saved = JSON.parse(globalThis.sessionStorage?.getItem(STORE) ?? "null") as Partial<WindowAddress> | null;
    if (saved === null || typeof saved !== "object" || typeof saved.view !== "string") return null;
    const id = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
    return { at: id(saved.at), view: saved.view, selected: id(saved.selected), conversation: id(saved.conversation) };
  } catch {
    return null;
  }
}

export function writeAddress(address: WindowAddress): void {
  try {
    globalThis.sessionStorage?.setItem(STORE, JSON.stringify(address));
  } catch {
    // Full or refused: this window still stands where it does.
  }
}
