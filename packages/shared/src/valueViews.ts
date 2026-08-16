/**
 * How a VALUE can be looked at — the model behind every view toggle in the app.
 *
 * A value produced by a model arrives as JSON and is shown as JSON, and for most values that is the
 * honest rendering. For some it is the worst one available: markdown shown as text is a wall of `#`
 * and `-`, HTML shown as text is tags, and a set of file edits shown as text is the single least
 * readable form of the one thing the run exists to produce. Each of those has a better rendering,
 * and none of them has only ONE right rendering — the raw form is what you check the rich one
 * against, so a viewer that renders and cannot un-render has taken the source away.
 *
 * So the unit here is not "the renderer for this type". It is **which views apply to this value**,
 * and the surface shows them as a toggle. This module is the whole decision, kept out of React so
 * it can be tested as what it is: a function from a value to a list of ways to read it.
 *
 * ## Why the hint is optional
 *
 * A file has a MIME type and a state's output slot has a schema, so where a caller knows what it is
 * holding it says so. Where nothing knows — a tool call's arguments, a model's answer — the value
 * itself is the only evidence, and {@link viewsFor} sniffs it. Sniffing is deliberately timid: it
 * offers a view, never chooses a type. Being wrong costs one extra button; refusing to guess costs
 * the reader the rendering entirely.
 */
import type { Change, ChangeAction, Changeset } from "./changeset";
import { CHANGE_ACTIONS } from "./changeset";
import { isTextMime, mimeFallbacks } from "./mime";

/**
 * The ways a value can be read.
 *
 * A closed set on purpose. An open registry would let any surface add a view nobody else has, which
 * is how two panels come to disagree about what markdown looks like — the point of this module is
 * that a model's answer renders the same way in the transcript, in the sync report and in a file.
 */
export type ViewId = "text" | "json" | "markdown" | "html" | "code" | "media" | "changes";

/** What a caller already knows about the value, when it knows anything. */
export interface ViewHint {
  /** A MIME type — a file's, or a slot's `contentMediaType`. Resolved along `mimeFallbacks`. */
  mime?: string | undefined;
  /** The declared schema of the slot this came out of, when there is one. */
  schema?: unknown;
}

/** Which player a media type wants. `undefined` ⇒ not media this app can show. */
export type MediaKind = "image" | "video" | "audio";

/**
 * The media a type names, when it names one.
 *
 * SVG is deliberately absent: it is markup, `isTextMime` says so, and it has a source worth reading
 * — treating it as an opaque picture would take the one view that answers "why is this wrong".
 * It still renders, through the code and HTML views its type already earns.
 */
export function mediaKindOf(mime: string | undefined): MediaKind | undefined {
  if (mime === undefined || mime === "image/svg+xml") return undefined;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

/**
 * Whether a type is text with a GRAMMAR — the ones an editor can colour.
 *
 * Not the same question as `isTextMime`, which asks whether a thing can be decoded at all. Plain
 * text has no grammar and markdown has a renderer that beats highlighting it, so neither earns a
 * code view; everything else that is text does, because for those the structure IS the reading.
 */
export function isCodeMime(mime: string | undefined): boolean {
  if (mime === undefined || !isTextMime(mime)) return false;
  // The type ITSELF, not its chain: `mimeFallbacks` ends every text type at `text/plain`, so asking
  // the chain whether plain text is in it is asking whether the value is text at all.
  if (mime === "text/plain") return false;
  // Markdown in any spelling — the bare word a slot declares, the registered type, a vendor type
  // that resolves to it. Rendering beats colouring for all three.
  if (mime === "markdown") return false;
  for (const candidate of mimeFallbacks(mime)) if (candidate === "text/markdown") return false;
  return true;
}

/** `data:` / `http(s):` / `blob:` — a reference a player can be pointed at as-is. */
function isPlayableUrl(text: string): boolean {
  return /^(data:|https?:\/\/|blob:)/i.test(text.trimStart());
}

/** Roughly base64: the alphabet, no spaces, and long enough not to be a word that happens to fit. */
function isBase64(text: string): boolean {
  return text.length > 32 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(text.trim());
}

/**
 * What to point a player at, or `undefined` when this value carries no media.
 *
 * Four shapes reach here because four producers exist: a URL or `data:` URI as a bare string, raw
 * base64 (what a blob slot holds when its `contentEncoding` says so), and the two object forms an
 * artifact reference takes. Nothing is decoded and nothing is fetched — this returns a `src`, and
 * whether it resolves is the browser's question.
 */
export function mediaSrcOf(value: unknown, mime: string | undefined): string | undefined {
  if (typeof value === "string") {
    if (isPlayableUrl(value)) return value.trim();
    if (mime !== undefined && isBase64(value)) return `data:${mime};base64,${value.replace(/\s+/g, "")}`;
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["uri", "url", "src", "href"]) {
    const at = value[key];
    if (typeof at === "string" && at !== "") return at;
  }
  const data = value["data"] ?? value["content"] ?? value["base64"];
  const type = typeof value["mediaType"] === "string" ? (value["mediaType"] as string) : mime;
  if (typeof data === "string" && type !== undefined && isBase64(data)) {
    return `data:${type};base64,${data.replace(/\s+/g, "")}`;
  }
  return undefined;
}

/** How many lines a change adds and removes — the `+12 −3` on a collapsed row. */
export interface ChangeStats {
  added: number;
  removed: number;
}

/**
 * Whether a value is text at all.
 *
 * Everything else is JSON, and JSON has exactly one honest rendering — so the toggle does not appear
 * over a value that has nothing to toggle to.
 */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Markdown structure, as the least ambiguous marks only — see {@link viewsFor} on timidity. */
const MARKDOWN_MARKS = [
  /^#{1,6}\s+\S/m, // a heading
  /^\s*[-*+]\s+\S/m, // a bullet
  /^\s*\d+\.\s+\S/m, // a numbered item
  /^```/m, // a fence
  /^>\s+\S/m, // a quote
  /\[[^\]]+\]\([^)]+\)/, // a link
  /^\s*\|.+\|\s*$/m, // a table row
];

/**
 * Whether a string reads as markdown.
 *
 * TWO marks, not one. A single `- ` at the start of a line appears in every stack trace and every
 * bulleted sentence somebody typed into a plain-text field, and offering a markdown view over those
 * is noise; two independent structural marks is a document. Bold and italic are deliberately not on
 * the list — asterisks are punctuation as often as they are emphasis.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length === 0) return false;
  return MARKDOWN_MARKS.filter((mark) => mark.test(text)).length >= 2;
}

/** Whether a string reads as an HTML document or fragment. */
export function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return true;
  // A fragment: an opening tag with a matching close somewhere. Timid on purpose — `<T>` in a type
  // signature and `a < b` are not documents.
  return /<([a-z][a-z0-9-]*)\b[^>]*>[\s\S]*<\/\1>/i.test(text);
}

/**
 * The view a MIME type names outright, when it names one.
 *
 * BARE SUBTYPES are accepted alongside full types, because that is what the workflows in this repo
 * actually author: a blob slot is declared `{contentMediaType: "markdown"}`, not
 * `"text/markdown"` — JSON Schema's keyword takes a media type and nobody spells one out for a
 * field whose whole purpose is to say "this string is markdown". Refusing the short form would mean
 * the declaration that exists never reached the renderer, which is the only reason it is written.
 */
function viewOfMime(mime: string | undefined): ViewId | undefined {
  if (mime === undefined || mime === "") return undefined;
  for (const candidate of mimeFallbacks(mime)) {
    if (candidate === "markdown" || candidate === "text/markdown" || candidate.endsWith("+markdown")) return "markdown";
    if (candidate === "html" || candidate === "text/html" || candidate.endsWith("+html")) return "html";
    if (candidate === "json" || candidate === "application/json" || candidate.endsWith("+json")) return "json";
  }
  return undefined;
}

/** A slot schema's `contentMediaType`, which is how a workflow declares "this string is markdown". */
function mimeOfSchema(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const media = (schema as Record<string, unknown>)["contentMediaType"];
  return typeof media === "string" ? media : undefined;
}

/**
 * Every way this value can be read, best first.
 *
 * ORDER IS THE DEFAULT: a surface shows the first and offers the rest, so "best first" is a claim
 * about which rendering answers the question the reader has. The raw form is always last and always
 * present — it is what the rich one is checked against.
 */
export function viewsFor(value: unknown, hint: ViewHint = {}): ViewId[] {
  const views: ViewId[] = [];
  if (changesOf(value) !== undefined) views.push("changes");

  const mime = hint.mime ?? mimeOfSchema(hint.schema);
  // A picture, a clip or a track is the whole of what such a value IS, so it leads — and it is only
  // offered when there is something a player can actually be pointed at, never on the type alone.
  if (mediaKindOf(mime) !== undefined && mediaSrcOf(value, mime) !== undefined) views.push("media");

  const text = textOf(value);
  const declared = viewOfMime(hint.mime) ?? viewOfMime(mimeOfSchema(hint.schema));
  if (text !== undefined) {
    // A declared type is a statement and beats the sniffer, which only ever offers.
    if (declared === "markdown" || (declared === undefined && looksLikeMarkdown(text))) views.push("markdown");
    if (declared === "html" || (declared === undefined && looksLikeHtml(text))) views.push("html");
    // Highlighted, for text that has a grammar. Below the rendered views and above the raw one: for
    // HTML or JSON the rendering answers "what does this look like" and this answers "what does it
    // say", and the plain source answers neither better than a coloured copy of itself.
    if (isCodeMime(mime)) views.push("code");
    views.push("text");
    return views;
  }
  // The raw form, always last and always present — a set of changes is still a JSON value, and the
  // rendering of it is a claim you must be able to check.
  views.push("json");
  return views;
}

// --- changes -----------------------------------------------------------------

/** A row of a whole-file proposal, which is the shape a sync's `edits` output has. */
interface ProposedFile {
  path?: unknown;
  action?: unknown;
  text?: unknown;
  after?: unknown;
  before?: unknown;
  reason?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** An action word we recognise; anything else is an update, because it names a file that changes. */
function actionOf(raw: unknown): ChangeAction {
  return typeof raw === "string" && (CHANGE_ACTIONS as readonly string[]).includes(raw) ? (raw as ChangeAction) : "update";
}

/**
 * Read a value as a set of FILE CHANGES, or answer that it is not one.
 *
 * Three shapes reach here and all three are the same fact told by different producers: a
 * {@link Changeset} (what the review gate takes), a bare `Change[]`, and the whole-file proposal
 * rows a prompt state returns when its output schema asks for files (`{path, action, text}`). The
 * third is why this exists at all — a model that has just written fourteen files should not have
 * that shown as fourteen JSON strings with `\n` in them.
 *
 * `undefined` rather than an empty list for "not changes", because an empty changeset is a real
 * value with a real rendering ("nothing to change") and must not be confused with a value that was
 * never about files.
 */
export function changesOf(value: unknown): Change[] | undefined {
  if (isRecord(value)) {
    // A changeset, or an envelope carrying one under the name a sync's output slot uses.
    if (Array.isArray(value["changes"]) && typeof value["source"] === "string") {
      return changesOf((value as unknown as Changeset).changes);
    }
    for (const key of ["changes", "edits", "files"]) {
      if (Array.isArray(value[key])) return changesOf(value[key]);
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const out: Change[] = [];
  for (const [i, raw] of value.entries()) {
    if (!isRecord(raw)) return undefined;
    const row = raw as ProposedFile;
    // A PATH is the whole test. Every producer names the file; nothing else in a workflow's output
    // vocabulary carries a `path` beside content, so it is specific without being a schema check.
    if (typeof row.path !== "string" || row.path === "") return undefined;
    const after = typeof row.after === "string" ? row.after : typeof row.text === "string" ? row.text : undefined;
    const before = typeof row.before === "string" ? row.before : undefined;
    const action = actionOf(row.action);
    if (after === undefined && before === undefined && action !== "delete") return undefined;
    out.push({
      id: typeof raw["id"] === "string" ? (raw["id"] as string) : `c${i + 1}`,
      path: row.path,
      action,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(typeof row.reason === "string" && row.reason !== "" ? { reason: row.reason } : {}),
    });
  }
  return out;
}

/**
 * How many lines a change adds and removes.
 *
 * Counted with the SAME line diff the Monaco pane renders (`diffStrategyFor`'s text strategy runs
 * `linesDiffComputers`), so the `+12 −3` on a collapsed row is the diff you get when you open it.
 * A count computed some other way is a count that disagrees with the picture under it, which is
 * worse than no count.
 *
 * A create counts every line as added and a delete every line as removed, which is what git says
 * and what a reader expects — there is no `before` to diff against.
 */
export function changeStats(change: Pick<Change, "before" | "after">): ChangeStats {
  const before = change.before;
  const after = change.after;
  if (before === undefined) return { added: after === undefined ? 0 : lineCount(after), removed: 0 };
  if (after === undefined) return { added: 0, removed: lineCount(before) };
  if (before === after) return { added: 0, removed: 0 };
  return countLines(before, after);
}

/** Lines in a text. A trailing newline does not invent an extra line. */
function lineCount(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/**
 * The added/removed counts between two texts.
 *
 * Imported lazily through `diffStrategyFor`'s own computer would drag Monaco into every consumer of
 * this module, so the line walk is here: a hunk-free count needs no ranges, only the sizes of the
 * regions that differ. Common prefix and suffix are stripped first, which is what makes a one-line
 * edit in a two-thousand-line file cost two scans rather than a matrix.
 */
function countLines(before: string, after: string): ChangeStats {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** Every change's counts, summed — the header figure over a list of files. */
export function totalStats(changes: readonly Pick<Change, "before" | "after">[]): ChangeStats {
  return changes.reduce<ChangeStats>(
    (sum, change) => {
      const stats = changeStats(change);
      return { added: sum.added + stats.added, removed: sum.removed + stats.removed };
    },
    { added: 0, removed: 0 },
  );
}
