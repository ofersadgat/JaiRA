/**
 * What the Monaco diff island is handed and what a host may ask of it once it is on screen — the
 * props and the handle, apart from `monacoDiff.tsx` so the hosts that only pass them along (the
 * universal `Island`, a phone's island page) do not import Monaco to name them.
 */
import type { FileCheck, FileDefinitions, FileHover, FileLocation, FileReferences } from "@jaira/shared/browser";
import type { PendingSelection } from "./reviewSelection";

/**
 * What a pane can ask about the text in it, and what it can do with the answer.
 *
 * One object rather than three props because the three belong together: they are all "this text is a
 * file in a project, and here is who to ask about it". A pane with none is a pane showing code that
 * is not a file — a sample, a value drawn as source — and it gets no diagnostics and no navigation,
 * which is the honest rendering of that.
 */
export interface CodeIntel {
  /** Diagnostics for this text, from the real compiler — see `CheckFileRequest`. */
  check?: (text: string) => Promise<FileCheck>;
  /** Where the symbol at a position is defined — see `DefineFileRequest`. */
  definitions?: (text: string, at: { line: number; column: number }) => Promise<FileDefinitions>;
  /** Everywhere the symbol at a position is used — see `FileReferences`. */
  references?: (text: string, at: { line: number; column: number }) => Promise<FileReferences>;
  /** What the symbol at a position is — see `FileHover`. */
  hover?: (text: string, at: { line: number; column: number }) => Promise<FileHover>;
  /**
   * The text of another file, for {@link shadowModels}.
   *
   * Peek needs it. Monaco can only preview a file it already holds a model for, so a result in a
   * file nobody has opened has to be READ before it can be shown — which is not something the
   * editor can do, and is why Peek Definition did nothing while Go to Definition worked.
   */
  read?: (to: FileLocation) => Promise<string | undefined>;
  /**
   * Take the window to a definition in ANOTHER file. `false` when it cannot go there.
   *
   * Needed because Monaco cannot do it. A standalone editor has one model, so following a definition
   * out of it is not navigation the editor knows how to perform — it hands the request to whoever
   * registered an opener, and that is the app.
   */
  open?: (to: FileLocation) => boolean | Promise<boolean>;
}

/**
 * What a host can ask of a diff editor that is already on screen.
 *
 * Imperative on purpose. Reverting a hunk is not a value the host can compute and hand down — it
 * needs the editor's own alignment between the two sides, which is derived from the diff algorithm
 * rather than from the two strings.
 */
export interface DiffActions {
  /**
   * Put the original's text back over the lines the person has selected.
   *
   * Selecting nothing reverts nothing: that case is the CHANGE-level decision, which belongs to the
   * reviewer rather than to the editor, and doing it silently here would make one button mean two
   * very different things depending on where the caret happened to be.
   *
   * Returns the modified text afterwards, or `null` when there was nothing to do.
   */
  revertSelectedLines(): string | null;
  /** Whether the selection currently covers any changed line — what the button's enabled state reads. */
  hasChangedSelection(): boolean;
}

export interface MonacoDiffProps {
  original: string;
  modified: string;
  /** A MIME type — mapped through {@link monacoGrammarOf}. */
  mime: string;
  /** Called with the modified side's full text on every edit — §4.1's `merged.content` feed. */
  onModified?: (text: string) => void;
  /**
   * A selection in the modified side, in the terms a review note anchors to — or `null` when there
   * is none. See the subscription in the body for why this cannot come from the DOM.
   */
  onSelect?: (selection: PendingSelection | null) => void;
  /** Hands the host the actions that only the live editor can perform — see {@link DiffActions}. */
  onReady?: (actions: DiffActions | null) => void;
  readOnly?: boolean;
  /**
   * Two columns, or one with the removals struck through above the additions.
   *
   * Both are worth having and neither is right everywhere, which is why it is a prop rather than the
   * `renderSideBySide: true` this had hard-coded. Side by side is the better reading of a rewrite
   * and needs width; inline is the better reading of a scattered edit and is the only one that
   * survives a narrow panel — which is where most of these are read.
   */
  sideBySide?: boolean;
  /**
   * What file the two sides ARE — a NAME, not a way of loading anything, so a path relative to the
   * checkout is as good as an absolute one.
   *
   * The same reason {@link MonacoCodePane} takes one, minus the diagnostics: Monaco reads a model's
   * script kind off its URI's extension, so an unnamed model holding a `.tsx` file is parsed as
   * plain TypeScript and every tag in it is underlined as a syntax error — in a diff of code that
   * compiles. Both sides get the name; {@link modelUriFor} is what keeps them two models.
   *
   * Absent where the two sides are not a file, which is what a value diffed against another value is.
   */
  file?: string;
  /**
   * What the compiler says about each side — the two questions a diff of code actually raises.
   *
   * They are two because the sides are two different trees, and a check is only worth anything when
   * it is asked in the right one. The PROPOSED side is on a disk: an agent's worktree holds every
   * changed file at its new content, with the same `tsconfig.json` and the same `node_modules`, so
   * it is checked there and is re-asked as the reviewer edits it. The BASE side is a git revision
   * that nothing holds a tree of, so it is checked against a program built by putting the changeset's
   * files back — see `CheckFileRequest.baseline` — and asked once, because a revision does not
   * change.
   *
   * Having both is the point. One red underline in a review means nothing on its own; the same
   * underline present on the left and absent on the right means the change fixed something, and
   * absent on the left and present on the right means it broke something. That is the question a
   * reviewer is actually asking, and neither side answers it alone.
   *
   * A {@link CodeIntel} rather than a bare function each, so the same shape serves here and in
   * {@link MonacoCodePane} — and so a side can grow navigation later without changing this prop.
   */
  intel?: {
    modified?: CodeIntel;
    original?: CodeIntel;
  };
}
