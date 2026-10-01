/**
 * What the state editor's link controls and value boxes compute: the link toggle's words, whether a
 * typed reference names a file, what a link's preview shows, and a value as its box shows it. The
 * components (`packages/universal/src/components/workflow/Links.tsx`) draw; this decides.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { JsonValue } from "@declarative-ai/json";
import type { WorkflowLayer } from "@jaira/shared/browser";
import type { UiSurface } from "./fileTypes";
import { isKnownRef } from "./completions";

// --- the link control --------------------------------------------------------------

/**
 * The datalist every link control completes against.
 *
 * One list for the whole editor rather than one per control: a state form renders a link control per
 * linkable field, per slot row and once for the operation, and a datalist id has to be unique.
 */
export const LINK_TARGETS_ID = "link-targets";

/** The link toggle's tooltip, for either way it is pressed. */
export function linkToggleTitle(linked: boolean): string {
  return linked
    ? "hold this value inline instead of in a file — what you had before linking comes back"
    : "hold this value in a file and reference it (WORKFLOWS.md §2.2)";
}

/** The link toggle's words: a chain glyph and what pressing it would leave you with. */
export const linkToggleWords = (linked: boolean): string => `🔗 ${linked ? "Linked" : "Link"}`;

/** True when a typed reference names nothing the tree offers — advisory; the linter has the final word. */
export function isUnresolvedLink(value: string, targets: readonly string[]): boolean {
  return value.trim().length > 0 && !isKnownRef(value, targets);
}

/** What an unresolved link says under its box. */
export const UNRESOLVED_NOTE = "no file here yet — the linter will call this unresolved";

/** A link box's placeholder when its caller names none. */
export const LINK_PLACEHOLDER = "$/prompts/feature_goals.md";

// --- a link's preview --------------------------------------------------------------

export interface LinkReader {
  /** The file a reference names, or `null` when this window cannot see one. */
  resolve: (ref: string) => { layer: WorkflowLayer; path: string } | null;
  /** That file's text. `null` for anything unreadable — a preview is never worth an error. */
  read: (layer: WorkflowLayer, path: string) => Promise<string | null>;
  /** Where the disclosure's state is remembered, so a fold survives clicking another file. */
  ui?: UiSurface | undefined;
}

const LinkReaderContext = createContext<LinkReader | null>(null);

export const LinkReaderProvider = LinkReaderContext.Provider;

/** One link's preview, as far as this window can show one — what `LinkPreview` (`Links.tsx`) draws. */
export interface LinkPreviewState {
  at: { layer: WorkflowLayer; path: string };
  /** The target's text, `"reading"` while it is fetched, `null` when nothing readable is there. */
  text: string | null | "reading";
  open: boolean;
  toggle: () => void;
}

/**
 * The target of one link: where it is, what it says, and whether its fold is open — or `null` where
 * nothing is shown (no reader, or a reference this window cannot place; the linter reports that).
 */
export function useLinkPreview(reference: string): LinkPreviewState | null {
  const reader = useContext(LinkReaderContext);
  const at = reader === null ? null : reader.resolve(reference);
  const [text, setText] = useState<string | null | "reading">("reading");
  /**
   * The fold, when there is no window layout to remember it in.
   *
   * The bar was always a button and always said "▾", and where the surface was absent it was also
   * `disabled` — so the one control on it did nothing, forever, and the preview could not be shut.
   * A form rendered outside the shell has nowhere to persist the choice; it can still honour it for
   * as long as it is on screen, which is the whole of what the reader asked for.
   */
  const [localOpen, setLocalOpen] = useState(true);

  useEffect(() => {
    if (reader === null || at === null) return;
    let live = true;
    setText("reading");
    void reader.read(at.layer, at.path).then((found) => {
      if (live) setText(found);
    });
    return () => {
      live = false;
    };
    // `at` is a fresh object every render; the two strings in it are what identify the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, at?.layer, at?.path]);

  if (reader === null) return null;
  // A reference this window cannot place says nothing here. The linter is what reports it — a
  // preview that announced "not found" would be a second, worse diagnostic in a smaller typeface.
  if (at === null) return null;

  const foldId = `link:${at.layer}:${at.path}`;
  const open = reader.ui === undefined ? localOpen : reader.ui.open(foldId, true);
  const toggle = (): void => {
    if (reader.ui === undefined) setLocalOpen(!open);
    else reader.ui.setOpen(foldId, !open);
  };
  return { at, text, open, toggle };
}

/** The preview bar's tooltip. */
export const linkPreviewTitle = (path: string, open: boolean): string => `${path} — click to ${open ? "hide" : "show"} what it says`;

// --- a run's value -----------------------------------------------------------------

/**
 * A value as the box under a slot shows it.
 *
 * A string is itself — prose in quotes is prose nobody can read — and everything else is JSON, which
 * is what it is.
 */
export function valueTextOf(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
