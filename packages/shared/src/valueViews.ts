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
export type ViewId = "text" | "json" | "form" | "markdown" | "html" | "code" | "media" | "changes";

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
 * SVG is INCLUDED, and the reason it was once excluded no longer holds. The worry was that treating
 * markup as an opaque picture takes away the source — the one view that answers "why is this
 * wrong". But {@link viewsFor} adds a media view without returning early, so a picture that is also
 * text keeps its `code` and `text` views underneath it. Nothing is taken away; a rendering is added,
 * and it leads because "what does this look like" is the question somebody has about a drawing.
 *
 * It is also the safe way to show one: {@link mediaSrcOf} hands it to an `<img>`, and an SVG in an
 * `<img>` runs no script and fetches nothing however the document is written.
 */
export function mediaKindOf(mime: string | undefined): MediaKind | undefined {
  if (mime === undefined) return undefined;
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
 * An SVG document or fragment — the `<svg>` root, wherever in the preamble it starts.
 *
 * Bounded rather than searching the whole string: a root element that has not appeared within a
 * kilobyte of prolog and comments is not one this needs to find, and the cost of the search would be
 * paid on every value that merely CLAIMS to be an image.
 */
function looksLikeSvg(text: string): boolean {
  return /<svg[\s>]/i.test(text.slice(0, 1000));
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
    // SVG travels as its own source, so the `src` IS the document. Percent-encoded rather than
    // base64: it survives the `#` and `%` that appear in ordinary markup (a fill colour, a url()),
    // and it stays legible in dev tools when a drawing comes out wrong.
    if (mime === "image/svg+xml" && looksLikeSvg(value)) {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`;
    }
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

/** The same marks, counted rather than merely detected — see {@link looksLikeMarkdown}. */
const MARKDOWN_COUNTERS = MARKDOWN_MARKS.map((mark) => new RegExp(mark.source, `${mark.flags}g`));

/**
 * A C-style block comment, which is where the sniffer's worst false positive lives.
 *
 * The continuation lines of a doc comment are ` * like this`, and that is the bullet mark exactly.
 * Two of them is every header this repo writes — and every C++, Java, TypeScript and JavaScript
 * file in the world — so a tool result holding source code sniffed as markdown and came back as a
 * bullet list with the code run together underneath it as prose. Measured before the fix: a C++
 * file carrying a doc-comment header said `true`, the same file without one said `false`, which is
 * the whole bug in two lines.
 *
 * Removed for the COUNT only, never from anything rendered. Inside a comment, `*` is punctuation
 * and `#` is nothing at all; the marks there are not the document's structure, whatever else they
 * look like. A real markdown document that happens to quote a block comment loses those marks and
 * keeps every mark outside it, which is the correct trade in both directions.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * Whether a string reads as markdown.
 *
 * TWO marks, not one. A single `- ` at the start of a line appears in every stack trace and every
 * bulleted sentence somebody typed into a plain-text field, and offering a markdown view over those
 * is noise; two structural marks is a document. Bold and italic are deliberately not on the list —
 * asterisks are punctuation as often as they are emphasis.
 *
 * ## Two OCCURRENCES, not two different kinds
 *
 * It used to want two marks of different kinds, which failed on the single most common thing a
 * person actually writes: a sentence and a bullet list under it. Three bullets and nothing else is
 * one kind of mark, and it was read as plain text — while a stack trace with one stray `- ` in it
 * was too, which is the case the rule was written for and the only one it needs to keep excluding.
 *
 * Counting occurrences separates them. One `- ` is still not a document; two lines that both begin
 * with one is a list, and a list is a document. Getting this wrong in either direction now costs a
 * click rather than a rendering, because the type is something a reader can simply assert.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length === 0) return false;
  // Block comments first — see {@link BLOCK_COMMENT}. Only when there is one to strip, so the
  // ordinary case pays nothing for a scan that would find nothing.
  const counted = text.includes("/*") ? text.replace(BLOCK_COMMENT, "") : text;
  if (counted.length === 0) return false;
  let marks = 0;
  for (const counter of MARKDOWN_COUNTERS) {
    counter.lastIndex = 0;
    // Capped per kind, so no single repeated mark can carry the verdict alone beyond what it is
    // worth — two bullets is a list, and two hundred is the same list.
    marks += Math.min(counted.match(counter)?.length ?? 0, 2);
    if (marks >= 2) return true;
  }
  return false;
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
  // `text/plain` is a STATEMENT, and until this line it was the one declaration the sniffer was
  // allowed to overrule — a value explicitly declared plain still had markdown offered over it if it
  // happened to carry two hashes. It matters now that a person can make the declaration themselves:
  // "no, this really is just text" has to be sayable, and it is only sayable if it sticks.
  //
  // The type ITSELF, not its chain, for the same reason `isCodeMime` checks it that way: every text
  // type ends at `text/plain` in `mimeFallbacks`, so asking the chain would silence sniffing for all
  // of them rather than for the one that asked.
  if (mime === "text/plain") return "text";
  for (const candidate of mimeFallbacks(mime)) {
    if (candidate === "markdown" || candidate === "text/markdown" || candidate.endsWith("+markdown")) return "markdown";
    if (candidate === "html" || candidate === "text/html" || candidate.endsWith("+html")) return "html";
    if (candidate === "json" || candidate === "application/json" || candidate.endsWith("+json")) return "json";
  }
  return undefined;
}

/** A slot schema's `contentMediaType`, which is how a workflow declares "this string is markdown". */
/**
 * The type a slot's schema declares, when it declares one.
 *
 * Exported because a surface that draws a control for the type has to be able to SAY which type is
 * in force, and "whatever `viewsFor` worked out internally" is not something it can put on a chip.
 * One resolution order, read the same way by the function that picks the views and by the control
 * that names them — see `typeNames.ts`.
 */
export function mimeOfSchema(schema: unknown): string | undefined {
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
/**
 * How an artifact should be EDITED, decided by media type the way `viewsFor` decides how it is read.
 *
 * `readonly` is a real answer and the important one: a PNG has no text to edit, and the honest
 * response is to show it and say so rather than to hand someone a textarea full of base64.
 *
 * The type wins over the text for the same reason it does in `viewsFor` — the producer said what it
 * made, and sniffing is what you do when nobody did. So the markdown sniff fires only where there
 * is no declared type at all.
 */
export function editorKindOf(mime: string | undefined, text: string): "markdown" | "json" | "text" | "readonly" {
  if (mediaKindOf(mime) !== undefined) return "readonly";
  // `application/…+json` inherits JSON's editor, the way `mimeFallbacks` walks a vendor type.
  if (mime !== undefined && (mime === "application/json" || mime.endsWith("+json"))) return "json";
  if (mime === "text/markdown") return "markdown";
  if (mime === undefined && looksLikeMarkdown(text)) return "markdown";
  return "text";
}

export function viewsFor(value: unknown, hint: ViewHint = {}): ViewId[] {
  // An ARTIFACT is a reference to content rather than the content itself, so it is read as what it
  // carries — with the envelope kept behind it, because the media type and the reference are exactly
  // what you want when the rendering is not what you expected. See {@link artifactOf}.
  const artifact = artifactOf(value);
  if (artifact !== undefined) {
    const inner =
      artifact.content === undefined ? [] : viewsFor(artifact.content, { mime: artifact.mime ?? hint.mime });
    return [...inner, "json"];
  }

  const views: ViewId[] = [];
  if (changesOf(value) !== undefined) views.push("changes");

  const mime = hint.mime ?? mimeOfSchema(hint.schema);
  // A picture, a clip or a track is the whole of what such a value IS, so it leads — and it is only
  // offered when there is something a player can actually be pointed at, never on the type alone.
  if (mediaKindOf(mime) !== undefined && mediaSrcOf(value, mime) !== undefined) views.push("media");
  const rendered = views.includes("media");

  const text = textOf(value);
  const declared = viewOfMime(hint.mime) ?? viewOfMime(mimeOfSchema(hint.schema));
  if (text !== undefined) {
    // A declared type is a statement and beats the sniffer, which only ever offers.
    //
    // `!rendered` is what keeps SVG from earning two renderings of one picture: it is markup, so
    // `looksLikeHtml` recognises it, and a toggle whose first two buttons show the same drawing is a
    // toggle where one of them can only be pressed to no effect. A DECLARED type still wins — an
    // author who says `text/html` gets the HTML view whatever else applies.
    if (declared === "markdown" || (declared === undefined && !rendered && looksLikeMarkdown(text))) views.push("markdown");
    if (declared === "html" || (declared === undefined && !rendered && looksLikeHtml(text))) views.push("html");
    // Highlighted, for text that has a grammar. Below the rendered views and above the raw one: for
    // HTML or JSON the rendering answers "what does this look like" and this answers "what does it
    // say", and the plain source answers neither better than a coloured copy of itself.
    if (isCodeMime(mime)) views.push("code");
    views.push("text");
    return views;
  }
  // Highlighted, with the schema's own descriptions ghosted beside the keys where there is one.
  // It LEADS, which is a decision about where these are read: a value in a transcript is a record
  // of what a run produced, and the coloured value is the compact honest form of that. A form is
  // the better reading of a big nested object and the worse one of a three-key result, and three
  // keys is what most of these are.
  views.push("json");
  // A value that came with a SCHEMA can also be read as the thing the schema describes — labelled
  // fields in the order somebody declared them, rather than a brace at every level.
  if (isObjectSchema(hint.schema)) views.push("form");
  // …and the raw serialization under it, always last and always present. The rendering above is a
  // claim you must be able to check — the same argument that keeps `text` under every rendered
  // string, applied one level up.
  views.push("text");
  return views;
}

/** Whether a schema describes an object with named members — what a form can be built from. */
function isObjectSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  const node = schema as Record<string, unknown>;
  if (node["type"] === "object") return true;
  const props = node["properties"];
  return props !== null && typeof props === "object" && !Array.isArray(props);
}

/**
 * What this value would be CALLED, once everything that gets a say has said it.
 *
 * The other half of {@link viewsFor}, and it exists because a control that lets somebody correct a
 * type has to be able to name the one currently in force — and "whatever `viewsFor` worked out
 * internally" is not something that can go on a chip. Same declarations, same predicates, in the
 * same order, so the name and the list of readings can never disagree about what they are looking at.
 *
 * `undefined` means DETECTION DECLINED, which is a different answer from `text/plain` and the reason
 * this does not simply fall back to it: the caller knows things this does not. An assistant's answer
 * with no markdown marks in it is still markdown — that is what an answer is — and only the surface
 * drawing it knows whose words these are.
 */
export function detectedMime(value: unknown, hint: ViewHint = {}): string | undefined {
  const declared = hint.mime ?? mimeOfSchema(hint.schema);
  if (declared !== undefined) return declared;
  const text = textOf(value);
  if (text === undefined) return "application/json";
  if (looksLikeMarkdown(text)) return "text/markdown";
  if (looksLikeHtml(text)) return "text/html";
  return undefined;
}

// --- artifacts ---------------------------------------------------------------

/**
 * An artifact as a VALUE: content a producer made, and what it is.
 *
 * Deliberately not a new transport. Three producers already make one and they all end up in the
 * artifact map — a `blob` output slot the engine registers, an agent's `write_file`, and a tool that
 * exists to show something — so the rendering keys off the one shape rather than off whichever
 * producer happened to make it.
 */
export interface ArtifactValue {
  /** The declared media type: the engine's `format`, or an envelope's `mediaType`. */
  mime?: string;
  /** The content, when it travelled with the reference. Absent for one too large to inline. */
  content?: string;
  /** Where the content resolves when it did not travel — see the artifact map. */
  uri?: string;
  name?: string;
  /** The logical path, which is how a surface asks for this artifact by name. */
  path?: string;
  /**
   * Whether the producer asked for this to be able to RUN when shown.
   *
   * A claim carried through, never a conclusion drawn here. A renderer still has to have the artifact
   * served to it before anything can execute, and the RECORD is what that grant consults — so this
   * being wrong costs a wasted request, not an execution nobody asked for.
   */
  interactive?: boolean;
}

/**
 * Read a value as an ARTIFACT, or answer that it is not one.
 *
 * Two shapes reach here because two producers exist, and they are the same fact told differently:
 * the engine's own registration (`{artifact: true, name, format, content}` — what a `blob` output
 * slot becomes) and a tool's envelope (a declared media type beside the bytes or a reference to
 * them). Recognising both here is what lets one renderer serve a workflow that writes a document and
 * an agent that shows one mid-conversation.
 *
 * A SINGLE-KEY WRAPPER counts, because that is what a state with one blob output slot actually
 * produces: `{plan_doc: {artifact: true, …}}`. The restriction to one key is the whole safety of it —
 * unwrapping `{plan_doc: …, notes: […]}` would render the document and silently hide the notes
 * beside it, which is worse than showing JSON.
 *
 * `undefined` rather than a partial value for "not an artifact": a media type with nothing behind it
 * is a claim about content that does not exist, and rendering the envelope as though it were the
 * document is how an empty pane comes to look like a produced one.
 */
export function artifactOf(value: unknown): ArtifactValue | undefined {
  if (!isRecord(value)) return undefined;
  const direct = artifactEnvelopeOf(value);
  if (direct !== undefined) return direct;
  const keys = Object.keys(value);
  return keys.length === 1 ? artifactEnvelopeOf(value[keys[0]!]) : undefined;
}

/** One envelope, in either spelling. See {@link artifactOf} for why there are two. */
function artifactEnvelopeOf(value: unknown): ArtifactValue | undefined {
  if (!isRecord(value)) return undefined;
  const content = typeof value["content"] === "string" ? (value["content"] as string) : undefined;
  const uri = typeof value["uri"] === "string" && value["uri"] !== "" ? (value["uri"] as string) : undefined;
  const name = typeof value["name"] === "string" && value["name"] !== "" ? (value["name"] as string) : undefined;
  // `format` is the engine's word for it and `mediaType` is the envelope's; they mean the same thing.
  const declared = value["format"] ?? value["mediaType"];
  const mime = typeof declared === "string" && declared !== "" ? declared : undefined;

  const engine = value["artifact"] === true && name !== undefined;
  // A tool's envelope has to SAY what it is. Without that this would match any object that happens
  // to carry a `content` string — a tool result, a file read, half the payloads in a transcript.
  const envelope = mime !== undefined && (content !== undefined || uri !== undefined);
  if (!engine && !envelope) return undefined;

  const path = typeof value["path"] === "string" && value["path"] !== "" ? (value["path"] as string) : undefined;
  return {
    ...(mime !== undefined ? { mime } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(uri !== undefined ? { uri } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(value["interactive"] === true ? { interactive: true } : {}),
  };
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
