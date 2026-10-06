/**
 * What was typed into a composer and not sent — so leaving a conversation and coming back finds the
 * words where they were left (the person, 2026-09-26: "the composer should save the last text that was
 * in it per view"), on this device or another (decision 0018 §9: a draft is the person's).
 *
 * Kept by a KEY the host names — `chat:<task>`, `task:<task>#<instance>`, `chat:new:<project>` — by the
 * engine that owns the conversation (`draft:get`/`draft:put`, routed by the task in the key), which is
 * what carries it to the person's other devices: it is in the change log, and a composer opened there
 * reads it. While a composer is open its own text is the truth — a write from elsewhere does not move
 * the words under the cursor — and it is written back a moment after typing stops.
 *
 * Words typed before this lived in the engine were in the renderer's `localStorage`: a key the engine
 * has nothing for takes them from there once, and writes them on.
 *
 * Only the text: files dropped on the box are the host's to read at send time, and a path held across a
 * restart would be a claim about a file that may have moved.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "./store";
import { useView } from "./useView";

/** How long typing has to stop before the words are written to the engine. */
const WRITE_AFTER_MS = 600;
const LEGACY_STORE = "jaira.composer.drafts";

/** The task a key belongs to, if it does — what routes it to the engine that owns it. */
export function taskOfDraftKey(key: string): string | undefined {
  return /^(?:chat|task):(t-[^#:]+)/.exec(key)?.[1];
}

/** What this window typed, by key, since it opened: the truth while the composer is open, and on coming back before the write lands. */
const typed = new Map<string, string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function write(key: string, text: string, now = false): void {
  clearTimeout(pending.get(key));
  const go = (): void => {
    pending.delete(key);
    const taskId = taskOfDraftKey(key);
    void invoke("draft:put", { key, text, ...(taskId !== undefined ? { taskId } : {}) }).catch(() => undefined);
  };
  if (now) go();
  else pending.set(key, setTimeout(go, WRITE_AFTER_MS));
}

/** Keep `text` under `key` now — a composer's words handed to another (a message taken back). "" forgets it. */
export function keepDraft(key: string, text: string): void {
  typed.set(key, text);
  write(key, text, true);
}

/** The words `localStorage` kept for `key` before drafts lived in the engine, taken out as they are read. */
function legacyDraft(key: string): string | undefined {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LEGACY_STORE) ?? "{}") as Record<string, unknown>;
    const text = saved[key];
    if (typeof text !== "string" || text.length === 0) return undefined;
    delete saved[key];
    globalThis.localStorage?.setItem(LEGACY_STORE, JSON.stringify(saved));
    return text;
  } catch {
    return undefined;
  }
}

/**
 * A composer's text, kept under `key`: what was left there when it opens, and every change written
 * back. A new key — another conversation in the same mounted view — reads that one's words. No key
 * keeps nothing, which is plain `useState`.
 */
export function useKeptDraft(key: string | undefined): [string, (next: string) => void] {
  const taskId = key === undefined ? undefined : taskOfDraftKey(key);
  const kept = useView("draft:get", key === undefined ? null : { key, ...(taskId !== undefined ? { taskId } : {}) });
  const [own, setOwn] = useState<{ key: string | undefined; text: string | undefined }>(() => ({ key, text: key !== undefined ? typed.get(key) : undefined }));
  let current = own;
  if (own.key !== key) {
    current = { key, text: key !== undefined ? typed.get(key) : undefined };
    setOwn(current);
  }
  // Nothing in the engine yet, and words from before it kept them: those, written on.
  const answered = !kept.loading && kept.error === undefined && kept.value === null;
  useEffect(() => {
    if (key === undefined || !answered || typed.has(key)) return;
    const old = legacyDraft(key);
    if (old !== undefined) {
      keepDraft(key, old);
      setOwn({ key, text: old });
    }
  }, [key, answered]);
  const set = useCallback(
    (next: string) => {
      if (key !== undefined) {
        typed.set(key, next);
        write(key, next);
      }
      setOwn({ key, text: next });
    },
    [key],
  );
  return [current.text ?? kept.value?.text ?? "", set];
}
