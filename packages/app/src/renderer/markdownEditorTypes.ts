/**
 * What the markdown editor is handed to show a change inside the document — the one type its hosts
 * (the island pages, `markdownDocument.tsx`) name without importing CodeMirror.
 */

/**
 * Render a change WITHOUT leaving the document, and without giving up editing it.
 *
 * Two things this has to get right, and the first version got both wrong.
 *
 * **The document stays the new text.** An earlier version built a merged string with both versions
 * in it and showed that — which meant the moment you typed one character the artifact turned into a
 * read-only diff and you could not carry on writing. Here the document is exactly what you are
 * writing, always editable, and the REMOVED text is drawn as widgets that are not in the document at
 * all. Nothing about reading the change interrupts making it.
 *
 * **The granularity is words, not lines.** The stored hunks are line-ranges — the right unit for
 * APPLYING a change, since applying them has to reproduce the new text byte for byte — and the
 * wrong unit for reading prose, where a one-word fix showed the whole paragraph struck through and
 * then again intact. So each hunk is refined into word-level pieces for display only. This never
 * feeds back into what gets applied; it is a reading of a decision already made.
 */
export interface MarkdownDiff {
  before: string;
  after: string;
  hunks: readonly { start: number; end: number; text: string }[];
}
