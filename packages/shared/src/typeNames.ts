/**
 * What a type is CALLED, and which family it belongs to — the vocabulary a person picks from.
 *
 * `mime.ts` decides what a thing is and `valueViews.ts` decides how it can be read; neither has ever
 * had to say the word "Markdown" out loud, because neither has ever had to ask anybody anything. A
 * MIME type is how this app talks to itself: precise, stable, and nobody's idea of a label. The
 * moment a control asks a person to CHOOSE a type it needs the other vocabulary — the name of the
 * thing, and a glyph you can pick out of a menu at a glance.
 *
 * So `text/x-typescript` stays in the code and `TypeScript` goes on the screen. The MIME string is
 * not hidden — it is on the control's tooltip, because this is a tool for people who occasionally
 * need it — but it is never what the control READS.
 *
 * ## One icon per family, not per type
 *
 * The families are deliberately coarse. An icon for every language is a set nobody maintains and a
 * row of glyphs nobody can tell apart at twelve pixels, so the icon answers "what KIND of thing is
 * this" and the name answers "which one". TypeScript, Python and CSS share a glyph and are never
 * confused with each other, because their names were never in any danger of being confused.
 *
 * ## Why resolution walks the fallback chain
 *
 * The same reason `fileTypes.ts` resolves its surfaces that way: a vendor type is written IN a
 * syntax, and `text/vnd.jaira.workflow-description+markdown` is markdown whatever else it is. One
 * entry for `text/markdown` therefore names every dialect of markdown that will ever exist, and a
 * type this table has never heard of still comes back wearing the name of the syntax underneath it.
 */
import { CONFIG_JSON, WORKFLOW_DESCRIPTION, WORKFLOW_JSON, WORKFLOW_YAML, mimeFallbacks } from "./mime";

/**
 * The kinds of thing a value can be, at the resolution an icon can carry.
 *
 * Not a partition of MIME space and not trying to be. These are the distinctions somebody scanning a
 * menu actually makes — is this writing, is this code, is this data, is this a picture — and the
 * list is short because a list of twenty families is a list nobody scans.
 */
export type TypeFamily = "prose" | "plain" | "code" | "data" | "table" | "changes" | "media";

export interface TypeName {
  /** What a person calls it: `Markdown`, `TypeScript`, `Plain text`. */
  label: string;
  family: TypeFamily;
}

/**
 * The names, by registered type.
 *
 * Capitalised the way the thing itself is capitalised — `TypeScript`, not `Typescript`, and `HTML`,
 * not `Html`. These are product names, and a product name spelled wrong is the fastest way to look
 * like software that does not know what it is holding.
 */
const NAMES: Record<string, TypeName> = {
  "text/markdown": { label: "Markdown", family: "prose" },
  "text/plain": { label: "Plain text", family: "plain" },
  "text/html": { label: "HTML", family: "code" },
  "text/css": { label: "CSS", family: "code" },
  "text/javascript": { label: "JavaScript", family: "code" },
  "text/x-typescript": { label: "TypeScript", family: "code" },
  "text/x-python": { label: "Python", family: "code" },
  "application/x-sh": { label: "Shell", family: "code" },
  // `text/x-sql`, which is what `mimeOfPath` produces for a `.sql` file. It was written here as
  // `application/sql` — a type nothing in this app ever carries — so SQL files showed as Plain text.
  "text/x-sql": { label: "SQL", family: "code" },
  "application/xml": { label: "XML", family: "code" },
  "application/json": { label: "JSON", family: "data" },
  "application/yaml": { label: "YAML", family: "data" },
  "application/toml": { label: "TOML", family: "data" },
  "text/csv": { label: "CSV", family: "table" },
  "text/tab-separated-values": { label: "TSV", family: "table" },
  "text/x-diff": { label: "Diff", family: "changes" },
  /**
   * JaiRA's own four, which until now came back wearing the name of the syntax underneath them.
   *
   * That was right while nothing asked: `text/vnd.jaira.workflow-description+markdown` IS markdown,
   * and the chain saying so is the whole reason a vendor type needs no entry here. It stopped being
   * right when a control started listing types by name for a person to set a preference against —
   * three separate rows called "JSON" is a list nobody can use, and the thing that distinguishes
   * them is exactly what the vendor type says.
   *
   * The two workflow types are named by syntax rather than one being "Workflow" and the other
   * "Workflow (YAML)", because they are not a type and its variant: the authoring form serialises
   * JSON and must never be offered for the YAML one. A name that hid that would be hiding the reason
   * they are two types.
   */
  [WORKFLOW_JSON]: { label: "Workflow (JSON)", family: "data" },
  [WORKFLOW_YAML]: { label: "Workflow (YAML)", family: "data" },
  [WORKFLOW_DESCRIPTION]: { label: "Workflow description", family: "prose" },
  [CONFIG_JSON]: { label: "Project settings", family: "data" },
  // Markup that is also a picture. `media`, because what somebody wants from an SVG is to see it —
  // `viewsFor` keeps the source underneath, so naming it a picture takes nothing away.
  "image/svg+xml": { label: "SVG", family: "media" },
};

/**
 * The short spellings a slot is allowed to declare, resolved before anything else.
 *
 * `viewOfMime` accepts these for the same reason: nobody writing `{contentMediaType: "markdown"}`
 * in a workflow means anything other than markdown, and refusing the short form would mean the
 * declaration that exists never reaches the person reading it.
 */
const BARE: Record<string, string> = {
  markdown: "text/markdown",
  md: "text/markdown",
  text: "text/plain",
  plain: "text/plain",
  html: "text/html",
  json: "application/json",
  yaml: "application/yaml",
  csv: "text/csv",
  diff: "text/x-diff",
};

/** The families a whole top-level type belongs to, for the ones with hundreds of members. */
const BY_PREFIX: ReadonlyArray<readonly [string, TypeName]> = [
  ["image/", { label: "Image", family: "media" }],
  ["video/", { label: "Video", family: "media" }],
  ["audio/", { label: "Audio", family: "media" }],
  ["font/", { label: "Font", family: "media" }],
];

/**
 * What to call a type, always — this never answers "I don't know".
 *
 * The last resort is the MIME string itself, which is the one label that is certainly not a lie, and
 * is exactly what somebody who needs to add an entry above wants to see on screen. An invented name
 * for an unregistered type would be a guess presented as a fact, and this control's whole job is to
 * let a person correct a guess.
 */
export function typeNameOf(mime: string | undefined): TypeName {
  if (mime === undefined || mime === "") return NAMES["text/plain"]!;
  const base = (BARE[mime.toLowerCase()] ?? mime.split(";")[0]!.trim()).toLowerCase();
  for (const candidate of mimeFallbacks(base)) {
    const named = NAMES[candidate];
    if (named !== undefined) return named;
  }
  for (const [prefix, named] of BY_PREFIX) if (base.startsWith(prefix)) return named;
  return { label: base, family: "plain" };
}

/**
 * The types a person may ASSERT a piece of text is, in the order the menu lists them.
 *
 * Ordered by how often a body of text turns out to be one of them rather than alphabetically: the
 * first two are the pair almost every correction moves between, and the rest descend by how likely
 * a model is to have produced one. Not every registered type is here — this is the list of things
 * worth OFFERING, and offering a font is offering a reading nothing can produce.
 */
/**
 * The families the Appearance pane groups types into — coarser than {@link TypeFamily}, on purpose.
 *
 * The icon families answer "what sort of thing is this" for a glyph in a tree, where `plain` and
 * `table` earn their own marks. The settings pane is asking a different question — "which of these
 * do I want to set together" — and the answer to that is coarser twice over: text with nothing
 * claimed about it is prose, and a CSV is a document that denotes a value like any other data file.
 * Folding them leaves five groups, each with enough members to be worth opening.
 */
export type PaneFamily = "prose" | "code" | "data" | "changes" | "media";

/** In the order the pane lists them, with the line each group's row carries. */
export const PANE_FAMILIES: ReadonlyArray<{ id: PaneFamily; label: string; note: string }> = [
  { id: "prose", label: "Prose", note: "documents — including text with nothing claimed about it" },
  { id: "code", label: "Code", note: "source files, drawn by grammar" },
  { id: "data", label: "Data", note: "documents that denote a value — rows included" },
  { id: "changes", label: "Changes", note: "a patch, and the edit it describes" },
  { id: "media", label: "Media", note: "pictures, and the markup that draws them" },
];

/** Which of the five a type belongs to. Total, like {@link typeNameOf} — an unknown type is prose. */
export function paneFamilyOf(mime: string | undefined): PaneFamily {
  const family = typeNameOf(mime).family;
  if (family === "plain") return "prose";
  if (family === "table") return "data";
  return family;
}

/**
 * The types the Appearance pane offers a row for, in the order it lists them within each family.
 *
 * A LIST rather than every type this app can name, because the question here is which types a person
 * might want to draw differently — and because two of the names that exist are not answers to it. A
 * workflow description is markdown, and the chain already says so, so a row for it would be a second
 * row called Markdown that somebody then has to tell apart from the first. Project settings is a
 * particular FILE rather than a kind of file, and it is deliberately restricted to the editor that
 * parses before it writes; offering a preference against it would offer to break that.
 *
 * Distinct from {@link OFFERED_TYPES}, which answers a different question — what a person may assert
 * a piece of text IS — and which would be the wrong list here in both directions.
 */
export const PANE_TYPES: readonly string[] = [
  "text/markdown",
  "text/plain",
  "text/x-typescript",
  "text/javascript",
  "text/x-python",
  "application/x-sh",
  "text/css",
  "text/html",
  "application/xml",
  "text/x-sql",
  "application/json",
  "application/yaml",
  "application/toml",
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  "text/csv",
  "text/tab-separated-values",
  "text/x-diff",
  "image/svg+xml",
];

export const OFFERED_TYPES: readonly string[] = [
  "text/markdown",
  "text/plain",
  "application/json",
  "text/html",
  "text/x-diff",
  "application/yaml",
  "text/csv",
  "text/x-typescript",
  "text/javascript",
  "text/x-python",
  "application/x-sh",
  "text/css",
  "application/xml",
];
