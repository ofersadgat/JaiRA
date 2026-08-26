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
import { mimeFallbacks } from "./mime";

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
  "application/sql": { label: "SQL", family: "code" },
  "application/xml": { label: "XML", family: "code" },
  "application/json": { label: "JSON", family: "data" },
  "application/yaml": { label: "YAML", family: "data" },
  "application/toml": { label: "TOML", family: "data" },
  "text/csv": { label: "CSV", family: "table" },
  "text/tab-separated-values": { label: "TSV", family: "table" },
  "text/x-diff": { label: "Diff", family: "changes" },
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
