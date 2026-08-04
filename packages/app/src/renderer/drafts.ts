/**
 * Unsaved edits, held per file for as long as the window is open.
 *
 * Every editing surface used to keep its draft in component state. That is fine while the surface is
 * mounted and wrong the moment it is not: clicking another file in the tree unmounts the editor, and
 * switching to Tasks unmounts the whole Files view, so a half-written prompt was discarded by a
 * glance at the board. Nothing warned, because from React's side nothing happened — the component
 * simply stopped existing.
 *
 * So a draft belongs to the FILE rather than to the editor showing it, and it lives beside the other
 * session-scoped view state in the store. Three properties fall out of that, and they are the whole
 * design:
 *
 *  - **Keyed by `layer:path`.** The same relative path exists in both roots and they are two
 *    different files; an id would not do either, because most of the tree has none.
 *  - **A draft is a DIFFERENCE from disk, not a copy of the document.** An entry equal to
 *    `doc.text` is deleted rather than kept, which is what makes `dirty` a question about the map
 *    and not a second flag that has to be marched in step with it. It is also what lets the tree
 *    mark unsaved files by listing the keys.
 *  - **Nothing here is persisted.** These are edits someone has not committed to yet; writing them
 *    to disk would mean deciding which layer they belonged to, and reloading them a week later
 *    would resurrect a change whose reason is gone.
 *
 * The functions are pure and the store owns the map, so the rules above are testable without a DOM —
 * which matters, because "what happens to my typing" is the one thing here nobody wants to discover
 * by trying it. The one hook here — {@link useDraftBox} — is the seam for a surface rendered without
 * a store, and it is deliberately the only place holding anything.
 */
import { useState } from "react";

/** Unsaved text by `layer:path`. Absent ⇒ the file is as it is on disk. */
export type Drafts = Readonly<Record<string, string>>;

/** How a surface reports a change: text, or `null` to say "there is no longer a draft". */
export type SetDraft = (key: string, text: string | null) => void;

/**
 * How a file is addressed in every session-scoped map.
 *
 * Shared with the schema picker deliberately: both answer a question about one document, and two
 * spellings of the same key is how they would end up disagreeing about which document that is.
 */
export function docKey(layer: string, path: string): string {
  return `${layer}:${path}`;
}

/** What an editing surface needs: the text to show, whether it differs from disk, and two writes. */
export interface DraftBox {
  /** The draft if there is one, the file otherwise. What the editor renders. */
  text: string;
  /** Whether there is anything to save. */
  dirty: boolean;
  /** Record a change. Typing the file back to what it was clears the draft, rather than storing a
   *  copy of the document and calling it modified. */
  set: (next: string) => void;
  /** Throw the draft away — Revert means "forget what I typed", not "undo the last save". */
  revert: () => void;
}

/**
 * The draft for one document, as a surface sees it.
 *
 * Fully derived — no component state at all, which is what stops the old failure from coming back
 * in a new place. There is nothing to lose on unmount because there is nothing being held.
 *
 * `onDisk` is the file as it currently reads, so a save that lands (or an external change to a file
 * nobody is editing) is reflected without a reload effect: the entry it equals is dropped by
 * {@link settled}, and `text` falls back to the new contents.
 */
export function draftBox(drafts: Drafts, onDraft: SetDraft, key: string, onDisk: string): DraftBox {
  const held = drafts[key];
  return {
    text: held ?? onDisk,
    dirty: held !== undefined && held !== onDisk,
    set: (next) => onDraft(key, next === onDisk ? null : next),
    revert: () => onDraft(key, null),
  };
}

/**
 * The same box, for a surface that may or may not have a store behind it.
 *
 * The fallback is not a nicety. `draftBox` is fully derived, so a component handed an inert
 * `onDraft` would render a text box that ignores typing — a far worse failure than the one this
 * module exists to fix, and a silent one. Absent handler ⇒ the draft is kept locally, which is
 * exactly where every editor kept it before: it works, and it lasts until the component unmounts.
 *
 * The local copy is keyed too, so a host that reuses one mounted surface for two documents does not
 * show the first one's text over the second.
 */
export function useDraftBox(
  drafts: Drafts | undefined,
  onDraft: SetDraft | undefined,
  key: string,
  onDisk: string,
): DraftBox {
  const [local, setLocal] = useState<{ key: string; text: string } | null>(null);
  if (drafts !== undefined && onDraft !== undefined) return draftBox(drafts, onDraft, key, onDisk);
  const held = local !== null && local.key === key ? local.text : undefined;
  return {
    text: held ?? onDisk,
    dirty: held !== undefined && held !== onDisk,
    set: (next) => setLocal(next === onDisk ? null : { key, text: next }),
    revert: () => setLocal(null),
  };
}

/** Record or clear one draft. `null` clears. */
export function withDraft(drafts: Drafts, key: string, text: string | null): Drafts {
  if (text === null) {
    if (drafts[key] === undefined) return drafts;
    const next = { ...drafts };
    delete next[key];
    return next;
  }
  if (drafts[key] === text) return drafts;
  return { ...drafts, [key]: text };
}

/**
 * Drop a draft that the file has caught up with.
 *
 * Called whenever a document is re-read. A draft identical to disk is not an unsaved edit — it is
 * the file — and keeping it would leave the row marked forever and mask the next external change to
 * that file behind text that merely happens to match.
 */
export function settled(drafts: Drafts, key: string, onDisk: string): Drafts {
  return drafts[key] === onDisk ? withDraft(drafts, key, null) : drafts;
}

/**
 * Follow a file that has been renamed.
 *
 * A rename is not a reason to lose an edit — it is usually part of the same piece of work — so the
 * draft moves to where the file went. `to` is `null` when the new path could not be resolved, which
 * degrades to forgetting it: showing someone's text over a file nobody can name would be worse than
 * losing it, because there would be no way to tell what it was about to overwrite.
 */
export function movedDraft(drafts: Drafts, from: string, to: string | null): Drafts {
  const held = drafts[from];
  if (held === undefined) return drafts;
  const next = { ...drafts };
  delete next[from];
  if (to !== null) next[to] = held;
  return next;
}

/**
 * Forget the drafts for a path and everything under it.
 *
 * A rename or a delete is addressed by path and may be a DIRECTORY, which takes every file inside it.
 * A draft left behind under a path that no longer exists is not merely stale: creating a file with
 * that name again would open it showing someone's abandoned edit to the file it replaced.
 */
export function withoutDraftsUnder(drafts: Drafts, layer: string, path: string): Drafts {
  const covered = coveredBy(drafts, layer, path);
  if (covered.length === 0) return drafts;
  const next = { ...drafts };
  for (const k of covered) delete next[k];
  return next;
}

/**
 * Follow a path that has been renamed, and everything under it.
 *
 * The directory case is why this is not {@link movedDraft} in a loop: renaming `workflows/review/`
 * moves every file inside it, and each of their drafts has to arrive at the corresponding new path
 * rather than at the directory's.
 */
export function movedDraftsUnder(drafts: Drafts, layer: string, from: string, to: string): Drafts {
  const covered = coveredBy(drafts, layer, from);
  if (covered.length === 0) return drafts;
  const at = docKey(layer, from);
  const next = { ...drafts };
  for (const key of covered) {
    const text = drafts[key]!;
    delete next[key];
    next[docKey(layer, to) + key.slice(at.length)] = text;
  }
  return next;
}

/**
 * The keys a path covers: the file itself, and — if it is a directory — what is inside it.
 *
 * The trailing slash is the whole of it. `workflows/reviewer.json` shares a prefix with
 * `workflows/review` as a STRING and is not under it, and a bare `startsWith` would take the
 * neighbour's draft along with the directory's.
 */
function coveredBy(drafts: Drafts, layer: string, path: string): string[] {
  const key = docKey(layer, path);
  const prefix = `${key}/`;
  return Object.keys(drafts).filter((k) => k === key || k.startsWith(prefix));
}
