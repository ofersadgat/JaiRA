/**
 * What was typed into a composer and not sent, kept per conversation — so leaving a chat or a task's
 * conversation and coming back finds the words where they were left (the person, 2026-09-26: "the
 * composer should save the last text that was in it per view").
 *
 * Kept by a KEY the host names — `chat:<task>`, `task:<task>`, `chat:new` — in memory for the window,
 * and in the renderer's `localStorage` so a restart keeps them too. Not in `user-settings.json` with the
 * rest of the window's state: that file is written whole, and this changes on every keystroke. A
 * storage that throws or is gone costs the restart, never the draft on screen.
 *
 * Only the text: files dropped on the box are the host's to read at send time, and a path held across a
 * restart would be a claim about a file that may have moved.
 */
import { useCallback, useState } from "react";

const STORE = "jaira.composer.drafts";
/** Enough for every conversation somebody leaves half-typed; the oldest go first past it. */
const KEEP = 200;

let drafts: Map<string, string> | null = null;
let writing: ReturnType<typeof setTimeout> | undefined;

function all(): Map<string, string> {
  if (drafts !== null) return drafts;
  drafts = new Map();
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORE) ?? "{}") as unknown;
    if (saved !== null && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, text] of Object.entries(saved)) if (typeof text === "string" && text.length > 0) drafts.set(key, text);
    }
  } catch {
    // Unreadable or unavailable: start empty.
  }
  return drafts;
}

function save(): void {
  clearTimeout(writing);
  writing = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(STORE, JSON.stringify(Object.fromEntries(all())));
    } catch {
      // Full or refused: the drafts still hold for this window.
    }
  }, 300);
}

/** The words left in the composer kept under `key`; "" when there are none. */
export function draftOf(key: string): string {
  return all().get(key) ?? "";
}

/** Keep `text` under `key` — the newest last, so the oldest is the one dropped. "" forgets it. */
export function keepDraft(key: string, text: string): void {
  const map = all();
  map.delete(key);
  if (text.length > 0) map.set(key, text);
  while (map.size > KEEP) map.delete(map.keys().next().value!);
  save();
}

/**
 * A composer's text, kept under `key`: what was left there when the view opens, and every change
 * written back. A new key — another conversation in the same mounted view — reads that one's words.
 * No key keeps nothing, which is plain `useState`.
 */
export function useKeptDraft(key: string | undefined): [string, (next: string) => void] {
  const [held, setHeld] = useState(() => ({ key, text: key !== undefined ? draftOf(key) : "" }));
  let current = held;
  if (held.key !== key) {
    current = { key, text: key !== undefined ? draftOf(key) : "" };
    setHeld(current);
  }
  const set = useCallback(
    (next: string) => {
      if (key !== undefined) keepDraft(key, next);
      setHeld({ key, text: next });
    },
    [key],
  );
  return [current.text, set];
}
