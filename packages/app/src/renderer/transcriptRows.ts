/**
 * What a transcript's work rows say: the reading `WorkRows`
 * (`packages/universal/src/components/panel/WorkRows.tsx`) draws its rows from.
 */
import { artifactOf, isCodeMime, isLazy, knownText, mediaKindOf, mimeOfPath, structuredFormatOf, toolDisplayOf, workflowToolOf, type AgentQuestion, type LazyValue, type SettledByView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { answersOfAnsweredText } from "./choicesModel";
import { approvalAboutOf, approvalAnswerOf, approvalWordsOf, checkWordsOf, isApprovalCall, isCheckCall, refusalWordsOf } from "./workSummary";
import { isAskUserQuestion, resultValueOf, shellLineOf, type ToolEntry, type TranscriptEntry, type WorkEntry } from "./transcript";

/**
 * The type a tool call's OWN arguments say its payload is.
 *
 * A `Read` of `main.cpp` produces a string, and nothing downstream knew what kind of string — so
 * `viewsFor` sniffed, and sniffing is weakest exactly on source code. The call already carries the
 * answer: a path, in an argument the tool itself named. Reading it turns a guess into a
 * declaration, and a declaration beats the sniffer everywhere in `viewsFor`.
 *
 * Absolute paths are what a tool is given, so the vendor rules in {@link mimeOfPath} — which key
 * off a position under a layer root — simply do not fire, and the extension answers. `text/plain`
 * comes back as `undefined` for the same reason it does in `mimeOfFenceLang`: it is not a
 * statement worth making, and making it would silence sniffing on a value nobody classified.
 */
export function pathMimeOf(args: JsonValue | undefined): string | undefined {
  if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) return undefined;
  const at = args as Record<string, JsonValue | undefined>;
  for (const key of ["file_path", "filePath", "notebook_path", "path"]) {
    const named = at[key];
    if (typeof named === "string" && named !== "") {
      const mime = mimeOfPath(named.replace(/\\/g, "/"));
      return mime === "text/plain" ? undefined : mime;
    }
  }
  return undefined;
}

/**
 * The page a call PRODUCED, when it produced one — `show_artifact`'s half of the artifact story.
 *
 * Read off the result rather than off the tool's NAME, deliberately. `show_artifact` reaches an
 * agent under several names (bare, and MCP-prefixed per transport), and it is not the only producer
 * an artifact envelope can come out of; what makes a result showable is that it says what its bytes
 * are, which is exactly what {@link artifactOf} asks. A name test would have to be kept in step with
 * every transport, and would answer wrongly the first time it was not.
 *
 * `content` decides. The envelope carries the bytes inline whenever they are small enough
 * (`inlineMaxBytes`), which is the common case and the cheap one — there is nothing to fetch and
 * nothing to serve. Above that the envelope is metadata and a `uri`, and the page stays where the
 * artifacts panel can open it: an artifact too large to inline is also too large to unfold into the
 * middle of a conversation unasked.
 */
export function producedArtifact(result: JsonValue | undefined): JsonValue | undefined {
  if (result === undefined) return undefined;
  const artifact = artifactOf(result);
  return artifact?.content !== undefined ? result : undefined;
}

/**
 * An agent's question to the person, out of the call that asked it — `AskUserQuestion`.
 *
 * The questions are the call's arguments. The answers are what came back, read from the richest
 * record there is: the agent's own `toolUseResult` keeps them as a map, and the wire result the
 * model saw spells them out as text, which is parsed when the map was not captured. A call still in
 * flight, or a dismissal, answers nothing and is drawn unanswered.
 *
 * A call that FAILED is not a question. The binary refuses the tool's input on its own rules — five
 * questions where it takes four — before any person is asked, and the agent goes on as if answered.
 * Drawn as a question, that read as one nobody could answer: options a reader could not pick and a
 * run that did not wait. It is the failed tool call it was, with the refusal behind the row.
 */
export function askedOf(entry: ToolEntry): { questions: AgentQuestion[]; answers: Record<string, JsonValue> | undefined } | undefined {
  if (entry.name !== "AskUserQuestion" && !entry.name.endsWith("__AskUserQuestion")) return undefined;
  if (entry.ok === false) return undefined;
  const args = entry.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const questions = (args as Record<string, JsonValue>)["questions"];
  if (!Array.isArray(questions)) return undefined;
  const sound = questions.filter(
    (q): q is JsonValue & Record<string, JsonValue> =>
      q !== null && typeof q === "object" && !Array.isArray(q) && typeof (q as Record<string, JsonValue>)["question"] === "string",
  );
  if (sound.length === 0) return undefined;
  const asked = sound.map(
    (q): AgentQuestion => ({
      question: q["question"] as string,
      ...(typeof q["header"] === "string" ? { header: q["header"] } : {}),
      ...(q["multiSelect"] === true ? { multiSelect: true } : {}),
      options: Array.isArray(q["options"])
        ? q["options"]
            .filter((o): o is JsonValue & Record<string, JsonValue> => o !== null && typeof o === "object" && !Array.isArray(o))
            .map((o) => ({
              label: String(o["label"] ?? ""),
              ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
            }))
        : [],
    }),
  );
  const detail = entry.detail;
  const kept =
    detail !== undefined && detail !== null && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, JsonValue>)["answers"]
      : undefined;
  if (kept !== undefined && kept !== null && typeof kept === "object" && !Array.isArray(kept)) {
    return { questions: asked, answers: kept as Record<string, JsonValue> };
  }
  const text = resultTextOf(entry.result);
  const parsed =
    text === undefined
      ? undefined
      : answersOfAnsweredText(
          text,
          asked.map((q) => q.question),
        );
  return { questions: asked, answers: parsed };
}

/** The text of a tool's result, out of whichever envelope the transport left it in. */
function resultTextOf(result: JsonValue | undefined): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block !== null && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, JsonValue>)["text"] === "string"
          ? ((block as Record<string, JsonValue>)["text"] as string)
          : typeof block === "string"
            ? block
            : "",
      )
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * What a surface lends the CALL rows of its transcript — the placement decisions a transcript cannot
 * make for itself (a component has no opinion about its place).
 */
export interface CallSurface {
  /**
   * Where a workflow tool's note goes. `inline` (the default) draws it under the call — right for a
   * one-column conversation. `rail`: the host draws it as a row beside the panel, from the journal
   * (`jaira.moved`), so the call's row says nothing more.
   */
  outcomes?: "inline" | "rail";
  /** Take back an answer the conversation gave — the rewind "Answer it yourself" is. Absent ⇒ no button. */
  onAnswerYourself?: ((by: SettledByView) => void) | undefined;
  /**
   * The publishes a later one of the same artifact replaced before the person spoke
   * ({@link replacedPublishes}): drawn as their line alone, a step like any other, with no card.
   */
  replaced?: ReadonlySet<ToolEntry> | undefined;
}

/**
 * The rows no summary may hide — drawn under it, whatever it says.
 *
 * The same argument the old fold made for its exemptions, and for the same rows: a page the model
 * drew, an artifact it published, the call that delivered the operation's output, a question the agent
 * put to the person (half of which the person wrote), what a workflow tool did and a subagent's
 * conversation are not steps towards the answer, they are pieces of it. A summary that counted them into
 * "3 commands · 2 edited" would be saying, of work done on request, that it was bookkeeping.
 */
export function keptUnderSummary(entry: WorkEntry, calls?: CallSurface): boolean {
  if (entry.kind !== "tool") return false;
  // A subagent's call: its conversation is a child of this one, not a step of it.
  if (entry.sidechain !== undefined) return true;
  if (entry.output !== undefined || producedArtifact(entry.result) !== undefined || askedOf(entry) !== undefined) return true;
  if (maybePublished(entry)) return calls?.replaced?.has(entry) !== true;
  return workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false && calls?.outcomes !== "rail";
}

/** How a row's glyph and name are coloured. Not the same axis as the mark at the end. */
export type RowTone = "plain" | "muted" | "warn" | "bad";
/**
 * The verdict at the end of a row, when there is one to give: ✓ it worked, ✕ it broke, a lock it was
 * denied, "–" nobody answered; `waiting` while it waits.
 */
export type RowMark = "ok" | "bad" | "waiting" | "cut" | "denied";

/** What goes under a call's line without being asked for (`Tool`'s `shown`), by kind. */
export type ToolShown = "sidechain" | "outcome" | "asked" | "published" | "publishedList" | "produced" | "picture" | "output" | undefined;

/**
 * A `show_artifact` call that may have published, though its result cannot be read yet: the answer that
 * carries the Design type's instructions runs to 35 KB, and the window is handed a string that large as a
 * placeholder (decision 0018 §6), fetched only where it is drawn. So the line is drawn as published from
 * the call itself — succeeded, and not a list, quickstart or read — and the drawing fetches the result and
 * reads the artifact out of it ({@link publishedOf}), drawing nothing when there is none. A refusal is
 * short enough to read here, and it answers without failing: that is a call that published nothing.
 */
export function maybePublished(entry: ToolEntry): boolean {
  if (entry.name !== "show_artifact" && !entry.name.endsWith("__show_artifact")) return false;
  if (entry.ok !== true || entry.result === undefined) return false;
  const args = entry.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  const action = (args as Record<string, JsonValue>)["action"];
  if (action !== undefined && action !== "publish") return false;
  const read = resultValueOf(entry.result);
  return read === null || typeof read !== "object" || Array.isArray(read) || !("error" in read);
}

/**
 * Whether a call LISTED the task's published artifacts (`show_artifact`'s `action: "list"`): drawn as the
 * same list the side panel shows (decision 0020 §3). Under any of the tool's names, as an agent reaches it.
 */
export function listedPublished(entry: ToolEntry): boolean {
  if (entry.name !== "show_artifact" && !entry.name.endsWith("__show_artifact")) return false;
  if (entry.ok === false) return false;
  const args = entry.args;
  return args !== null && typeof args === "object" && !Array.isArray(args) && (args as Record<string, JsonValue>)["action"] === "list" && !("type" in (args as object));
}

/** A published artifact, as `show_artifact` names it in what it returns (decision 0020): which one, and at which version. */
export interface PublishedRef {
  /** The task it belongs to, read off its url (`artifact://<task>/@<id>`). */
  taskId: string;
  id: string;
  url: string;
  version: number;
  kind: "page" | "markdown" | "canvas" | "file";
  type?: string;
  title?: string;
  icon?: string;
  entry: string;
  /** Where a shown file came from when not this machine: a web address's host, another artifact's name. */
  from?: string;
  /** The line written over it (under its tile, in a gallery). */
  caption?: string;
}

/**
 * The artifact a call published, out of its result's `artifact` — read off the result, not the tool's
 * name, for the reason {@link producedArtifact} gives. `undefined` for anything else, a refusal included.
 */
export function publishedOf(raw: JsonValue | undefined): PublishedRef | undefined {
  // What MCP delivered — the value serialized in a text block — unwrapped as the transcript unwraps it;
  // here too, since a large answer reaches the window as a placeholder the transcript could not open.
  const result = raw === undefined ? undefined : resultValueOf(raw);
  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) return undefined;
  const artifact = (result as Record<string, JsonValue>)["artifact"];
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
  return publishedRefOf(artifact);
}

/** One artifact as a result names it — `{ url, version, kind, entry, … }` — or `undefined`. */
function publishedRefOf(artifact: JsonValue | undefined): PublishedRef | undefined {
  if (artifact === null || artifact === undefined || typeof artifact !== "object" || Array.isArray(artifact)) return undefined;
  const a = artifact as Record<string, JsonValue>;
  const url = typeof a["url"] === "string" ? a["url"] : "";
  const at = /^artifact:\/\/([^/]+)\/@([A-Za-z0-9_-]+)$/.exec(url);
  const kind = a["kind"];
  if (at === null || typeof a["version"] !== "number" || typeof a["entry"] !== "string" || (kind !== "page" && kind !== "markdown" && kind !== "canvas" && kind !== "file")) return undefined;
  return {
    taskId: at[1]!,
    id: at[2]!,
    url,
    version: a["version"],
    kind,
    ...(typeof a["type"] === "string" ? { type: a["type"] } : {}),
    ...(typeof a["title"] === "string" ? { title: a["title"] } : {}),
    ...(typeof a["icon"] === "string" ? { icon: a["icon"] } : {}),
    entry: a["entry"],
    ...(typeof a["from"] === "string" ? { from: a["from"] } : {}),
    ...(typeof a["caption"] === "string" ? { caption: a["caption"] } : {}),
  };
}

/**
 * A shown file's type: a `data:` URI's own, else its entry's — the source it was shown from, whose last
 * segment names it (a web address's query and fragment aside).
 */
export function shownMimeOf(entry: string, content: string | undefined): string {
  const data = content === undefined ? null : /^data:([^;,]+)[;,]/.exec(content);
  if (data !== null) return data[1]!.toLowerCase();
  const path = entry.replace(/[?#].*$/, "").replace(/\\/g, "/");
  return mimeOfPath(path.slice(path.lastIndexOf("/") + 1));
}

/** The word a shown file's title bar calls it by, and the glyph beside it. */
export function shownKindOf(mime: string): { word: string; glyph: string } {
  const media = mediaKindOf(mime);
  if (media === "image") return { word: "picture", glyph: "▣" };
  if (media === "video") return { word: "clip", glyph: "▶" };
  if (media === "audio") return { word: "track", glyph: "♪" };
  if (mime === "text/x-diff" || mime === "text/x-patch") return { word: "diff", glyph: "±" };
  const format = structuredFormatOf(mime);
  if (format === "delimited") return { word: "table", glyph: "▦" };
  if (format !== undefined) return { word: "data", glyph: "{}" };
  if (isCodeMime(mime)) return { word: "code", glyph: "‹›" };
  return { word: "text", glyph: "¶" };
}

/** What one `show_artifact` call showed the person (2026-11-13): the line over it, each file shown, and each it could not. */
export interface ShownFiles {
  caption?: string;
  items: PublishedRef[];
  refused: Array<{ source: string; why: string }>;
}

/**
 * What a call showed, out of its result's `shown` and `refused` — the answer to `artifacts`, or to a
 * `file_path` that is not a page. `undefined` for a result that is not one (a page's or a canvas's
 * publish answers `artifact`, read by {@link publishedOf}).
 */
export function shownOf(raw: JsonValue | undefined): ShownFiles | undefined {
  const result = raw === undefined ? undefined : resultValueOf(raw);
  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) return undefined;
  const r = result as Record<string, JsonValue>;
  if (!Array.isArray(r["shown"])) return undefined;
  const items = r["shown"].map(publishedRefOf).filter((ref): ref is PublishedRef => ref !== undefined);
  const refused = (Array.isArray(r["refused"]) ? r["refused"] : []).flatMap((x) =>
    x !== null && typeof x === "object" && !Array.isArray(x) && typeof x["why"] === "string" ? [{ source: typeof x["source"] === "string" ? x["source"] : "", why: x["why"] }] : [],
  );
  return { ...(typeof r["caption"] === "string" ? { caption: r["caption"] } : {}), items, refused };
}

/**
 * What a subagent showed the person, and the subagents it started (2026-11-13): each file its chain's
 * `show_artifact` calls showed, the newest version of each, in the order they were last shown — drawn
 * under the subagent's line, since showing is for the person and they should not have to walk in to
 * find it. Refusals stay inside the subagent, at their calls. `undefined` when it showed nothing.
 */
export function shownInChain(entries: readonly TranscriptEntry[], sidechainOf?: (call: string) => TranscriptEntry[] | undefined, depth = 0): ShownFiles | undefined {
  const byUrl = new Map<string, PublishedRef>();
  const walk = (list: readonly TranscriptEntry[], level: number): void => {
    for (const entry of list) {
      if (entry.kind !== "tool") continue;
      if (entry.sidechain !== undefined && sidechainOf !== undefined && level < 8) {
        const inner = sidechainOf(entry.sidechain);
        if (inner !== undefined) walk(inner, level + 1);
        continue;
      }
      if (entry.ok === false) continue;
      for (const item of shownOf(entry.result)?.items ?? []) {
        byUrl.delete(item.url);
        byUrl.set(item.url, item);
      }
    }
  };
  walk(entries, depth);
  return byUrl.size === 0 ? undefined : { items: [...byUrl.values()], refused: [] };
}

/**
 * Which artifact a publish wrote to (its `artifact://<task>/@<id>`), when it published and that can be
 * read now: off the result's `artifact` where the result is here; else the `url` the call named (an
 * update names it); else, for a create whose answer reached the window as a placeholder (a phone's 4 KB
 * threshold; the Design type's runs to 35 KB), the address its answer opens with — "Created a new
 * Artifact at artifact://…", which the placeholder's preview keeps.
 */
export function publishTargetsOf(entry: ToolEntry): string[] {
  const shown = shownOf(entry.result);
  if (shown !== undefined) return shown.items.map((item) => item.url);
  const one = publishTargetOf(entry);
  return one === undefined ? [] : [one];
}

function publishTargetOf(entry: ToolEntry): string | undefined {
  const published = publishedOf(entry.result);
  if (published !== undefined) return published.url;
  if (!maybePublished(entry)) return undefined;
  const args = entry.args as Record<string, JsonValue> | null | undefined;
  const named = args?.["url"];
  if (typeof named === "string" && ARTIFACT_URL.test(named)) return named;
  const blocks = Array.isArray(entry.result) ? entry.result : [entry.result];
  for (const block of blocks) {
    const text = knownText(block !== null && typeof block === "object" && !Array.isArray(block) && "text" in block ? block["text"] : block);
    const at = text === undefined ? null : /artifact:\/\/[^/\s"]+\/@[A-Za-z0-9_-]+/.exec(text);
    if (at !== null) return at[0];
  }
  return undefined;
}

const ARTIFACT_URL = /^artifact:\/\/[^/\s]+\/@[A-Za-z0-9_-]+$/;

/**
 * The publishes whose card a later one replaces: a publish of an artifact that is published again before
 * the person next speaks. Claude builds a canvas a call at a time — sixteen options, sixteen publishes, a
 * thought or a line of narration between each ("Option 10, grouped by workspace:") — and every card was
 * the same canvas a step less done. The newest says all they did, and their versions are a press away
 * on it (v▾); each earlier call stays as its line, a step like any other.
 *
 * What ends a run is the person: a message of theirs (a new turn), or a question the agent put to them,
 * which they answer looking at what is drawn. The agent's own words, its thoughts and its other calls do
 * not. Only a call that published replaces: one still running or refused leaves the card before it.
 * A publish in an earlier turn keeps its card, drawn as replaced by `PublishedView` (its title bar, and
 * "vN is newer").
 */
export function replacedPublishes(entries: readonly TranscriptEntry[]): ReadonlySet<ToolEntry> {
  const replaced = new Set<ToolEntry>();
  let later = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ((entry.kind === "message" && entry.role === "user") || (entry.kind === "tool" && isAskUserQuestion(entry))) {
      later = new Set();
      continue;
    }
    if (entry.kind !== "tool") continue;
    const targets = publishTargetsOf(entry);
    if (targets.length === 0) continue;
    // A call that showed several is replaced only when every one of them was shown again after it.
    if (targets.every((target) => later.has(target))) replaced.add(entry);
    for (const target of targets) later.add(target);
  }
  return replaced;
}

/**
 * Where each replaced publish's card went (the rule of {@link replacedPublishes}): `<url>@<version>` of
 * a publish a later one in the same run replaced, to the run's newest publish of that artifact. A view
 * opened from the earlier call's card goes on to it, as the card did (the person, 2026-11-14: "if there
 * is a new show artifact before the turn ends and the user hasnt typed anything then we move forward").
 * Only what a result names: a create still a placeholder says its address but not its version.
 */
export function publishSuccessorsOf(entries: readonly TranscriptEntry[]): Map<string, PublishedRef> {
  const out = new Map<string, PublishedRef>();
  let newest = new Map<string, PublishedRef>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ((entry.kind === "message" && entry.role === "user") || (entry.kind === "tool" && isAskUserQuestion(entry))) {
      newest = new Map();
      continue;
    }
    if (entry.kind !== "tool") continue;
    const one = publishedOf(entry.result);
    const refs = one !== undefined ? [one] : (shownOf(entry.result)?.items ?? []);
    for (const ref of refs) {
      const later = newest.get(ref.url);
      if (later === undefined) newest.set(ref.url, ref);
      else if (later.version !== ref.version) out.set(`${ref.url}@${String(ref.version)}`, later);
    }
  }
  return out;
}

/**
 * The picture a tool handed back — a screenshot, a picture off the clipboard (decision 0019) — as a
 * `data:` address, out of whichever envelope it travelled in: MCP's `image` content (`{ type, data,
 * mimeType }`), the Anthropic block an agent's own record keeps (`{ type, source: { media_type, data } }`),
 * or the value's own `$images`. The first picture, or `undefined` — and `undefined` too while its data is
 * still a placeholder (`hasPicture` says there is one to fetch).
 */
export function pictureOf(result: JsonValue | undefined): string | undefined {
  const found = pictureSourceOf(result);
  return found !== undefined && typeof found.data === "string" ? `data:${found.mime};base64,${found.data}` : undefined;
}

/**
 * Whether a tool handed back a picture, fetched or not. A screenshot's base64 is hundreds of KB, far over
 * the 64 KB a window on this machine is handed whole (4 KB on a phone), so its data almost always
 * reaches the view as a `$lazy` placeholder (decision 0018 §6); the call is still a picture's, and is
 * drawn as one once the data is fetched.
 */
export function hasPicture(result: JsonValue | undefined): boolean {
  return pictureSourceOf(result) !== undefined;
}

/** The first picture in a result, its data a string or a placeholder for one. */
function pictureSourceOf(result: JsonValue | undefined): { mime: string; data: string | LazyValue } | undefined {
  const dataOf = (value: JsonValue | undefined): string | LazyValue | undefined =>
    typeof value === "string" ? (value.length > 0 ? value : undefined) : isLazy(value) ? value : undefined;
  const fromBlock = (block: JsonValue): { mime: string; data: string | LazyValue } | undefined => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
    const b = block as Record<string, JsonValue>;
    if (b["type"] !== "image") return undefined;
    const source = b["source"] !== null && typeof b["source"] === "object" && !Array.isArray(b["source"]) ? (b["source"] as Record<string, JsonValue>) : b;
    const mime = typeof source["media_type"] === "string" ? source["media_type"] : typeof source["mimeType"] === "string" ? source["mimeType"] : undefined;
    const data = dataOf(source["data"]);
    return mime !== undefined && mime.startsWith("image/") && data !== undefined ? { mime, data } : undefined;
  };
  if (Array.isArray(result)) {
    for (const block of result) {
      const found = fromBlock(block);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (result === null || typeof result !== "object") return undefined;
  const images = (result as Record<string, JsonValue>)["$images"];
  if (!Array.isArray(images)) return undefined;
  for (const image of images) {
    if (image === null || typeof image !== "object" || Array.isArray(image)) continue;
    const { mimeType } = image as Record<string, JsonValue>;
    const data = dataOf((image as Record<string, JsonValue>)["data"]);
    if (typeof mimeType === "string" && mimeType.startsWith("image/") && data !== undefined) return { mime: mimeType, data };
  }
  return undefined;
}

/**
 * One tool call's line — what `Tool` hands its `Row`: the name, what it was called as, the server, the
 * preview (a shell line in its parts' colours where it is one), the tone and the mark, and what is drawn
 * under it unasked. `open` is whether the call's stretch is the last thing in a record still being
 * written; `hasSidechain` whether the host can show or walk into a subagent's conversation.
 */
export function toolLineOf(
  entry: ToolEntry,
  open: boolean,
  hasSidechain: boolean,
  calls?: CallSurface,
): {
  name: string;
  called: string;
  server?: string;
  preview: string;
  command: string | undefined;
  prose: boolean;
  tone: RowTone;
  mark?: RowMark;
  /** Grey words before the time saying who stopped a refused call — "denied by auto", "not answered". */
  note?: string;
  shown: ToolShown;
  /** No answer recorded — still running (the call's stretch is open) or never answered. */
  unanswered: boolean;
  running: boolean;
  /** The subagent crumb's name: the Task's short description, or the tool's own title. */
  chainName: string;
  pathMime: string | undefined;
} {
  // No answer recorded is one of two different facts: the call is still running (the record is still
  // being written, and this is its last stretch), or it never answered (the record went on, or ended,
  // without one). Only the first may be called running.
  const unanswered = entry.ok === undefined && entry.result === undefined;
  const running = unanswered && open;
  const display = toolDisplayOf(entry.name);
  const chainName = `⑂ ${entry.summary.length > 0 ? entry.summary : display.title}`;
  const pathMime = pathMimeOf(entry.args);
  // The approval prompt, a tool the tool called: its verdict is its name, and who, how far and after
  // how long are the rest of the line (the person, 2026-09-26).
  if (isApprovalCall(entry)) {
    const words = approvalWordsOf(entry, unanswered && open);
    return {
      name: words.name,
      called: entry.name,
      preview: words.preview,
      command: approvalAnswerOf(entry) === undefined ? approvalAboutOf(entry).command : undefined,
      prose: approvalAnswerOf(entry) !== undefined,
      tone: words.tone,
      ...(words.mark !== undefined ? { mark: words.mark } : {}),
      shown: undefined,
      unanswered,
      running,
      chainName,
      pathMime,
    };
  }
  // A permission function asked about the call, the same way: who is checking it, then what it came to
  // and why (the person, 2026-10-24, option B).
  if (isCheckCall(entry)) {
    const words = checkWordsOf(entry, unanswered && open);
    return {
      name: words.name,
      called: entry.name,
      preview: words.preview,
      command: undefined,
      prose: true,
      tone: words.tone,
      ...(words.mark !== undefined ? { mark: words.mark } : {}),
      shown: undefined,
      unanswered,
      running,
      chainName,
      pathMime,
    };
  }
  const shown: ToolShown =
    entry.sidechain !== undefined && hasSidechain
      ? "sidechain"
      : workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false
        ? calls?.outcomes === "rail"
          ? undefined
          : "outcome"
        : askedOf(entry) !== undefined
          ? "asked"
          : (publishedOf(entry.result) !== undefined || maybePublished(entry)) && calls?.replaced?.has(entry) !== true
            ? "published"
          : listedPublished(entry)
            ? "publishedList"
          : producedArtifact(entry.result) !== undefined
            ? "produced"
            : hasPicture(entry.result)
              ? "picture"
              : entry.output !== undefined
                ? "output"
                : undefined;
  return {
    name: display.title,
    called: entry.name,
    ...(display.server !== undefined ? { server: display.server } : {}),
    preview: entry.sidechain !== undefined ? `⑂ ${entry.summary}` : entry.summary,
    command: entry.sidechain === undefined ? shellLineOf(entry) : undefined,
    prose: false,
    // A call that did not do its work FAILED, whatever stopped it (the person, 2026-10-24, D+E): red, and
    // its glyph says why — ✕ it broke, a lock it was denied, "–" nobody answered — and grey words, who.
    tone: entry.ok === false || entry.refused !== undefined ? "bad" : "plain",
    mark:
      entry.refused !== undefined
        ? entry.refused.kind === "denied"
          ? "denied"
          : "cut"
        : entry.ok === undefined
          ? running || !unanswered
            ? "waiting"
            : "cut"
          : entry.ok
            ? "ok"
            : "bad",
    ...(entry.refused !== undefined ? { note: refusalWordsOf(entry.refused) } : {}),
    shown,
    unanswered,
    running,
    chainName,
    pathMime,
  };
}
