/**
 * What a run SAID, as one list of entries — the model behind the transcript view.
 *
 * Two records describe a run and neither is sufficient alone. The SESSION holds every model call
 * verbatim: the messages, the thinking, the tool calls and their results. The JOURNAL holds what
 * happened around those calls: a state entered, a policy escalation, a human gate, a failure, a
 * transition. The old panel showed both by stacking two components, one above the other, and left
 * the reader to interleave them by eye — which is also why selecting a task appeared to show "all
 * sessions": the lower half was a projection of the whole task, not of the state you were looking at.
 *
 * This normalises the two into one time-ordered list, so the renderer has no idea there were ever
 * two sources.
 *
 * ## What is a card and what is not
 *
 * Chrome marks a CHILD boundary. A leaf has no children, so its transcript is bare content. A
 * composite's own operation is also bare — it is this state speaking, not a child — and its
 * children's runs are cards below it. One rule, and it is why a leaf and a composite's own half look
 * identical: they are the same thing.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { ConversationTurn, InstanceNode, SessionTurn, SessionView } from "@jaira/shared/browser";

// --- entries ------------------------------------------------------------------

/** A message somebody sent or a model returned. `system` is first in a conversation, never hidden. */
export interface MessageEntry {
  kind: "message";
  /** `system` · `user` · `assistant`, or whatever else the provider labelled it. */
  role: string;
  at?: number;
  text?: string;
  /** Tool calls and results carried on the turn, kept structured — see {@link toolPartsOf}. */
  parts?: JsonValue;
}

/** One tool call and its result, paired. Collapsed to a line until asked. */
export interface ToolEntry {
  kind: "tool";
  at?: number;
  name: string;
  /** The first argument worth showing on the collapsed line — a path, a command. */
  summary: string;
  ok?: boolean;
  /** What it was called with. Absent means the record kept no arguments, which is not `null`. */
  args?: JsonValue;
  /** What came back, once it has. Absent while the call is still in flight. */
  result?: JsonValue;
  /**
   * The provider's own id for the call.
   *
   * Kept because a call and its result are frequently in DIFFERENT turns — an assistant turn holds
   * `tool_use`, the user turn after it holds `tool_result` — so pairing cannot be done inside one
   * turn and this is the only thing that connects them across two.
   */
  callId?: string;
  /**
   * Set when this call SPAWNED a subagent whose conversation the record kept — the key into
   * `SessionView.sidechains`. The row becomes the doorway: the subagent's turns render behind it,
   * never folded into the thread they did not happen in.
   */
  sidechain?: string;
  /**
   * The agent's OWN record of the execution — the native file's `toolUseResult`, when the record
   * captured it. Richer than {@link result}, which is the wire form the model saw: this is what the
   * agent kept for itself (split stdout/stderr, file metadata, structured patches).
   */
  detail?: JsonValue;
}

/**
 * A model's private reasoning, when the record kept it.
 *
 * Its own kind rather than a tool call whose name happens to be "thinking", which is what it used to
 * be: a thinking block has text and no arguments, so everything a tool line shows about it was empty
 * and the payload printed as `null`.
 */
export interface ThoughtEntry {
  kind: "thought";
  at?: number;
  text: string;
}

/** Something recorded that nobody said: a journal fact (a gate, a policy call, a failure, a
 *  transition), a pinned provider event, or a native session line (a context injection, a piece of
 *  the agent's bookkeeping). */
export interface EventEntry {
  kind: "event";
  at?: number;
  tone: "plain" | "warn" | "bad";
  text: string;
  /** The full line behind the fact, when {@link text} is a compression of it. Absent means the text
   *  IS the whole fact, and the row has nothing to open. */
  detail?: JsonValue;
}

/** The answer being written right now, before it is a turn. */
export interface LiveEntry {
  kind: "live";
  text: string;
}

export type TranscriptEntry = MessageEntry | ToolEntry | EventEntry | LiveEntry | ThoughtEntry;

// --- work blocks --------------------------------------------------------------

/** An entry nobody SAID: a call, a piece of reasoning, a fact the journal recorded. */
export type WorkEntry = ToolEntry | ThoughtEntry | EventEntry;

/**
 * A run of consecutive work, between one message and the next.
 *
 * It exists because the interesting unit in an agent loop is not the individual call — it is the
 * stretch of forty of them between "do this" and "here is what I found". Grouping them lets the
 * renderer treat that stretch as one thing it can fold, which is the difference between a transcript
 * you scroll past and one you read.
 */
export interface WorkBlock {
  kind: "work";
  entries: WorkEntry[];
}

/** What the renderer walks: things that were said, and the work between them. */
export type TranscriptBlock = MessageEntry | LiveEntry | WorkBlock;

/**
 * Fold a flat entry list into messages and the work between them.
 *
 * Order is preserved exactly — this only decides where the seams are, never what is on which side
 * of one. A transcript that opens with fifteen tool calls before anybody speaks is one leading work
 * block, which is the right answer and also the common one.
 */
export function blocksOf(entries: readonly TranscriptEntry[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === "message" || entry.kind === "live") {
      out.push(entry);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "work") last.entries.push(entry);
    else out.push({ kind: "work", entries: [entry] });
  }
  return out;
}

/**
 * What a line of work IS, as far as a reader skimming the left margin is concerned.
 *
 * Declared here rather than beside the paths, because this is a fact about the transcript and not
 * about SVG: `icons.tsx` imports it and will not compile until it can draw every member.
 */
export type WorkIconName = "terminal" | "read" | "write" | "web" | "search" | "agent" | "tool" | "think" | "note" | "alert";

/**
 * Which family of thing a tool name belongs to.
 *
 * Matched on the NAME rather than on the arguments, because the name is the one field every
 * provider agrees on and every tool has. It is a heuristic and it is allowed to be: the row says the
 * tool's name in words right beside the glyph, so the worst case of a wrong guess is a slightly
 * misleading silhouette, not a misread transcript.
 *
 * Order is the whole design. `WebSearch` and `WebFetch` both contain "search"/"fetch" AND "web", and
 * they are web things; `Glob` and `Grep` are searches. So the web family is tested first and the
 * search family after it. Likewise `NotebookEdit` is a write before it is anything else.
 */
function toolIconOf(name: string): WorkIconName {
  const n = name.toLowerCase();
  if (/task|agent|spawn|delegate|dispatch/.test(n)) return "agent";
  if (/web|http|url|browser|fetch|navigate/.test(n)) return "web";
  if (/bash|shell|exec|command|terminal|powershell|process/.test(n)) return "terminal";
  if (/write|edit|patch|apply|replace|create|insert|append|delete|remove/.test(n)) return "write";
  if (/read|cat|view|open|show|inspect/.test(n)) return "read";
  if (/search|grep|glob|find|list|ls|query|lookup/.test(n)) return "search";
  return "tool";
}

/**
 * The glyph for one work row.
 *
 * A failed call keeps its own icon rather than turning into a warning sign — what it WAS is the
 * thing you are scanning the margin for, and whether it worked is already said twice on the row, by
 * the mark at the end and by the colour of the icon itself.
 */
export function iconOf(entry: WorkEntry): WorkIconName {
  if (entry.kind === "thought") return "think";
  if (entry.kind === "event") return entry.tone === "plain" ? "note" : "alert";
  return toolIconOf(entry.name);
}

/**
 * A result that has not been attached to its call yet — an intermediate, never rendered.
 *
 * It exists because pairing is not a per-turn job: Anthropic's shape puts `tool_use` on the
 * assistant turn and `tool_result` on the user turn that follows, so the call this belongs to was
 * emitted by an earlier pass through {@link messagePartsOf}. {@link entriesOf} is where the two meet.
 */
export interface ResultPart {
  kind: "result";
  callId?: string;
  result: JsonValue;
  /**
   * The provider said so itself, on the part rather than in the payload.
   *
   * Anthropic's `is_error` travels beside the content, so a failed command whose output is the plain
   * string `exit 1` looks like a perfectly good result to anything reading only the payload.
   */
  failed?: boolean;
  /** The native `toolUseResult` for this result's turn, riding along to land on the paired call. */
  detail?: JsonValue;
}

export type MessagePart = ToolEntry | ThoughtEntry | ResultPart;

/**
 * Parts that carry nothing anybody reads — stream bookkeeping the SDKs emit between the real ones.
 *
 * Dropped by name rather than by "has no payload", because they are known noise and an unknown part
 * with no payload is a different thing: possibly a shape we should be showing and are not.
 */
const NOISE = new Set(["step-start", "step-finish", "start-step", "finish-step", "start", "finish"]);

/** The first key present, so one reader covers two spellings of the same field. */
function pick(part: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) if (part[key] !== undefined) return part[key];
  return undefined;
}

/**
 * What one content part IS.
 *
 * Two families of spelling reach here and both have to work. The Vercel SDK writes `tool-call` /
 * `tool-result` with `toolName`, `args` and `toolCallId`; Anthropic — which is what a Claude CLI
 * session records — writes `tool_use` / `tool_result` with `name`, `input` and `id`. The old rule
 * was "anything that is not text is a tool call, and its payload is `args`", which for an Anthropic
 * record found no arguments on anything and printed `null` under every line, and turned every
 * `thinking` block into a nameless tool.
 *
 * Order matters: `tool_result` contains both "tool" and "result", and it is a result. A result is
 * matched on the END of the type rather than anywhere in it, because `tool-<name>` is also a legal
 * spelling for a CALL and a tool called `search_results` must not be read as somebody's answer.
 */
function kindOfPart(type: string): "text" | "thought" | "result" | "call" | "noise" | "other" {
  if (type === "text") return "text";
  if (NOISE.has(type)) return "noise";
  if (type.includes("thinking") || type.includes("reasoning")) return "thought";
  if (type === "result" || type.endsWith("-result") || type.endsWith("_result")) return "result";
  if (type.includes("tool")) return "call";
  return "other";
}

/** `tool-call` and `tool_use` both name a tool; `tool-search` names itself. */
function toolNameOf(part: Record<string, unknown>, type: string): string {
  const named = pick(part, ["toolName", "name", "tool_name"]);
  if (typeof named === "string" && named.length > 0) return named;
  // `tool-<name>` is the SDK's typed-tool spelling, where the type IS the name.
  const bare = type.replace(/^tool[-_]/, "");
  return bare.length > 0 && bare !== "call" && bare !== "use" && bare !== "invocation" ? bare : type;
}

/**
 * One turn's content parts, in the order they were written.
 *
 * Text is skipped — it is the message itself, and {@link messageOf} has already joined it. What is
 * left is what the old panel could not show: reasoning, calls, and results.
 */
export function messagePartsOf(parts: JsonValue | undefined): MessagePart[] {
  if (!Array.isArray(parts)) return [];
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;
    const type = typeof p["type"] === "string" ? (p["type"] as string) : "";
    if (type === "") continue;
    const kind = kindOfPart(type);
    if (kind === "text" || kind === "noise") continue;

    if (kind === "thought") {
      const text = pick(p, ["thinking", "text", "reasoning", "content"]);
      // A redacted block is a real fact — the model thought and the provider withheld it — so it is
      // said rather than dropped.
      out.push({ kind: "thought", text: typeof text === "string" && text.length > 0 ? text : "(withheld by the provider)" });
      continue;
    }

    const callId = pick(p, ["toolCallId", "tool_use_id", "toolUseId", "id"]);
    if (kind === "result") {
      const flagged = pick(p, ["is_error", "isError"]) === true;
      out.push({
        kind: "result",
        ...(typeof callId === "string" ? { callId } : {}),
        ...(flagged ? { failed: true } : {}),
        result: (pick(p, ["result", "output", "content"]) ?? null) as JsonValue,
      });
      continue;
    }

    const args = pick(p, ["args", "input", "arguments", "parameters"]);
    // An unrecognised part is shown only when it has something in it. A shape nobody anticipated
    // that carries a payload is worth seeing; one that carries nothing is noise we have not named.
    if (kind === "other" && args === undefined) continue;
    out.push({
      kind: "tool",
      name: kind === "other" ? type : toolNameOf(p, type),
      summary: firstArgOf(args),
      ...(typeof callId === "string" ? { callId } : {}),
      ...(args === undefined ? {} : { args: args as JsonValue }),
    });
  }
  return out;
}

/** The one argument worth putting on a collapsed line: a path, a command, the first string there is. */
function firstArgOf(args: unknown): string {
  // Some tools take a bare string, and it is the whole of what they were called with.
  if (typeof args === "string") return args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "";
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file", "file_path", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  const first = Object.values(record).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

function isErrorish(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  // `is_error` is Anthropic's spelling and travels on a `tool_result` block — the one a Claude CLI
  // session actually records.
  return r["error"] !== undefined || r["isError"] === true || r["is_error"] === true || r["ok"] === false;
}

// --- building the list --------------------------------------------------------

/** How a journal turn reads once it is not a message. `operation` and `output` are dropped — see below. */
const EVENT_TONE: Record<string, EventEntry["tone"] | undefined> = {
  policy: "warn",
  interaction: "warn",
  failure: "bad",
  transition: "plain",
  // `operation` and `tool` are the session's own material, told worse. Keeping them would double
  // every model call: once as the turn it actually was, once as a journal line saying it happened.
  operation: undefined,
  tool: undefined,
  output: undefined,
};

function eventOf(turn: ConversationTurn): EventEntry | undefined {
  const tone = EVENT_TONE[turn.kind];
  if (tone === undefined) return undefined;
  const text = turn.text ?? (turn.kind === "transition" ? `went to ${turn.stateId ?? "the next state"}` : turn.kind);
  return { kind: "event", at: turn.at, tone, text };
}

/**
 * One turn as entries: what it thought, what it said, what it then did.
 *
 * That is also the order, and it is the order the parts arrive in — a model reasons, answers, and
 * calls. Reasoning is lifted above the message rather than left in part order because the message is
 * assembled from every text part at once, so there is no single position left to interleave it at.
 */
function messageOf(turn: SessionTurn, at?: number, toolRecord?: JsonValue): Array<TranscriptEntry | ResultPart> {
  const entries: Array<TranscriptEntry | ResultPart> = [];
  const hasText = turn.text !== undefined && turn.text.length > 0;
  const parts = messagePartsOf(turn.parts);
  // The native `toolUseResult` is one record per user turn, so it can only be placed when the turn
  // holds exactly one result — ambiguity drops the annotation rather than guessing which call it
  // describes.
  const results = parts.filter((part): part is ResultPart => part.kind === "result");
  if (toolRecord !== undefined && results.length === 1) results[0]!.detail = toolRecord;
  const stamp = <T extends { at?: number }>(entry: T): T => (at !== undefined ? { ...entry, at } : entry);

  for (const part of parts) if (part.kind === "thought") entries.push(stamp(part));
  // A turn that is nothing but tool calls contributes no message — an empty assistant bubble above
  // three tool lines is a bubble that says only that the model spoke, which the lines already do.
  if (hasText || parts.length === 0) {
    entries.push({
      kind: "message",
      role: turn.role,
      ...(at !== undefined ? { at } : {}),
      ...(turn.text !== undefined ? { text: turn.text } : {}),
    });
  }
  for (const part of parts) {
    if (part.kind === "thought") continue;
    entries.push(part.kind === "result" ? part : stamp(part));
  }
  return entries;
}

/**
 * Attach each result to the call it answers, wherever that call was.
 *
 * A result is not an entry of its own: on screen it is the verdict on the line that made the call,
 * and the payload behind it. An ORPHAN — a result whose call is not in this conversation — becomes
 * its own line instead of vanishing, because a result nobody asked for is a fact about the record.
 */
/** Did it fail — because the provider flagged it, or because the payload says so. */
function failed(part: ResultPart): boolean {
  return part.failed === true || isErrorish(part.result);
}

function pairResults(entries: Array<TranscriptEntry | ResultPart>): TranscriptEntry[] {
  const byId = new Map<string, ToolEntry>();
  const unanswered: ToolEntry[] = [];
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool") {
      if (entry.callId !== undefined) byId.set(entry.callId, entry);
      unanswered.push(entry);
      out.push(entry);
      continue;
    }
    if (entry.kind !== "result") {
      out.push(entry);
      continue;
    }
    // By id where there is one; otherwise the oldest call still waiting, which is the only reading
    // available and the right one for a provider that answers in order.
    const call = entry.callId !== undefined ? byId.get(entry.callId) : unanswered[0];
    if (call === undefined) {
      out.push({
        kind: "tool",
        name: "result",
        summary: "",
        ok: !failed(entry),
        result: entry.result,
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      });
      continue;
    }
    call.result = entry.result;
    if (entry.detail !== undefined) call.detail = entry.detail;
    // Absent, not false: a call still in flight has no verdict, and rendering one as a failure is
    // the kind of wrong that gets acted on.
    call.ok = !failed(entry);
    const at = unanswered.indexOf(call);
    if (at >= 0) unanswered.splice(at, 1);
  }
  return out;
}

/** The answer being written right now: the text tail, the thinking tail, and every whole stream item so far. */
export interface LiveTail {
  text: string;
  /** The reasoning being written, before its block lands on the finished turn. */
  thinking?: string;
  /** `{kind:"message", role, content}` turns and `{kind:"event", event}` passthroughs, in order. */
  items?: readonly JsonValue[];
  /**
   * SUBAGENT turns streaming by, keyed by the spawning call — the live counterpart of
   * `SessionView.sidechains`, which does not exist until the record closes. Kept out of `items`
   * because they are not this thread's; the doorway row and the sidechain panel are where they
   * render, while the run is still going.
   */
  sidechains?: Readonly<Record<string, readonly JsonValue[]>>;
}

/**
 * One event as entries, wherever it came from — a live `{kind:"event"}` passthrough (the executor's
 * event, payload nested under `provider_event`) or a record's pinned provider event (the payload
 * itself). Shown rather than dropped: the two everyone recognises get said in words, the rest keep
 * the provider's own name, and every row opens to the whole payload — with ONE named exception:
 * `stream_event` is delta bookkeeping whose content arrives again on the finished turn, and a row
 * per fragment would bury the conversation under it.
 */
export function eventEntry(event: JsonValue): TranscriptEntry[] {
  const e = (event ?? {}) as Record<string, unknown>;
  if (e["type"] === "progress" && typeof e["message"] === "string") {
    return [{ kind: "event", tone: "plain", text: e["message"] as string }];
  }
  if (e["type"] === "events_dropped") {
    return [{ kind: "event", tone: "warn", text: `${String(e["count"] ?? "?")} stream events were dropped before anything could show them` }];
  }
  const payload = e["type"] === "provider_event" ? ((e["payload"] ?? {}) as Record<string, unknown>) : e;
  if (payload["type"] === "stream_event") return [];
  const detail = payload as JsonValue;
  const type = typeof payload["type"] === "string" ? (payload["type"] as string) : "provider event";
  const subtype = typeof payload["subtype"] === "string" ? (payload["subtype"] as string) : "";
  if (subtype === "init") return [{ kind: "event", tone: "plain", text: "session started", detail }];
  if (subtype === "compact_boundary") return [{ kind: "event", tone: "plain", text: "context compacted", detail }];
  return [{ kind: "event", tone: "plain", text: subtype.length > 0 ? `${type}: ${subtype}` : type, detail }];
}

// --- native session lines -----------------------------------------------------

/**
 * What the agent's own session file said around the conversation — `SessionView.native`, captured at
 * operation close because the file itself is the agent's and prunable.
 *
 * Two kinds of line reach here. A message ENVELOPE (`type: "user" | "assistant"`, body already in
 * the record's turns) is a position marker: it is paired with its turn by role, in order, and its
 * `toolUseResult` — the agent's structured record of a tool execution — lands on that turn's tool
 * line. Everything else (`attachment`, `queue-operation`, `ai-title`, whatever the agent adds next)
 * becomes an event row at its woven position.
 *
 * Paired by ROLE AND ORDER rather than by the stored index, deliberately: the file has message
 * lines the stream never carried (the prompt itself), so index arithmetic against the turns is off
 * by one the moment a run begins, and drifts further every time the agent's vocabulary grows. Role
 * pairing degrades instead of derailing — an envelope that matches no turn is dropped, and the
 * worst case is an annotation lost, never a conversation reordered.
 */
function nativeRecordOf(raw: JsonValue): Record<string, JsonValue> | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JsonValue>) : undefined;
}

/** The envelope's role, when the line is a main-chain message envelope. */
function envelopeRoleOf(line: Record<string, JsonValue> | undefined): "user" | "assistant" | undefined {
  if (line === undefined || line["isSidechain"] === true) return undefined;
  return line["type"] === "user" || line["type"] === "assistant" ? (line["type"] as "user" | "assistant") : undefined;
}

/**
 * Whether this envelope has a turn in the record to pair with.
 *
 * An assistant line always does. A user line does only when it carries a tool result — the PROMPT
 * user line (and a mid-run steering message) is input, and input never rides the stream back, so
 * there is no turn for it and pairing it with the next tool-result turn would shift every
 * annotation after it by one.
 */
function pairsWithTurn(line: Record<string, JsonValue>, role: "user" | "assistant"): boolean {
  return role === "assistant" || line["toolUseResult"] !== undefined;
}

/** How a non-message native line reads as a row. `undefined` means it is not worth one. */
function nativeEventOf(raw: JsonValue): EventEntry | undefined {
  const line = nativeRecordOf(raw);
  // A line that would not parse was captured as the raw string — a fact about the file, shown as one.
  if (line === undefined) return { kind: "event", tone: "warn", text: "unreadable native line", detail: raw };
  const type = typeof line["type"] === "string" ? line["type"] : "unknown line";
  // Bookkeeping that duplicates what the transcript already shows: the prompt is the conversation's
  // own first message. Stored faithfully, told never.
  if (type === "last-prompt") return undefined;
  if (type === "attachment") {
    const attachment = nativeRecordOf(line["attachment"] ?? null);
    const sub = typeof attachment?.["type"] === "string" ? (attachment["type"] as string) : "";
    return { kind: "event", tone: "plain", text: sub.length > 0 ? `context: ${sub}` : "context", detail: raw };
  }
  if (type === "queue-operation") {
    const op = typeof line["operation"] === "string" ? (line["operation"] as string) : "operation";
    return { kind: "event", tone: "plain", text: `queued: ${op}`, detail: raw };
  }
  if (type === "ai-title") {
    // The whole fact fits on the line, so there is nothing to open.
    return typeof line["aiTitle"] === "string" ? { kind: "event", tone: "plain", text: `titled "${line["aiTitle"]}"` } : undefined;
  }
  // A type this reader has no name for is shown rather than hidden — the vocabulary is the agent's,
  // and it grows; a filter here would quietly shrink the transcript every time it did.
  return { kind: "event", tone: "plain", text: type, detail: raw };
}

/**
 * One live stream item as entries — the same reading a stored turn gets, before the record exists.
 *
 * A `message` item is a finished turn and goes through {@link messageOf} exactly as a stored one
 * would, tool calls and all. Everything else is shown rather than dropped, named as well as it can
 * be, with the raw payload behind the row: the contract with the person watching is that the whole
 * stream reaches the screen in order, understood or not.
 *
 * `within` names the sidechain being rendered, when one is. A tagged turn renders only into ITS
 * chain and an untagged one only into the main flow — the same rule read from both sides, and the
 * reason a subagent's words can stream live without ever being misattributed to the thread that
 * spawned it.
 */
export function liveItemEntries(item: JsonValue, within?: string): Array<TranscriptEntry | ResultPart> {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return [{ kind: "tool", name: "stream", summary: "", args: item }];
  }
  const rec = item as Record<string, unknown>;
  if (rec["kind"] === "message") {
    // A turn belongs to exactly one flow: the chain its tag names, or the main thread if untagged.
    // Anywhere else it is withheld rather than misattributed.
    if (rec["parentToolUseId"] !== within) return [];
    const role = typeof rec["role"] === "string" ? (rec["role"] as string) : "assistant";
    // The content is the provider's whole message object — {role, content} with provider-shaped
    // parts — the very shape a stored turn holds, so it is read the same way.
    const message = (rec["content"] ?? {}) as { content?: unknown };
    if (typeof message.content === "string") return messageOf({ role, text: message.content });
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts
      .filter((p): p is { type: string; text: string } => (p as { type?: unknown })?.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("");
    return messageOf({
      role,
      ...(text.length > 0 ? { text } : {}),
      ...(parts.length > 0 ? { parts: parts as JsonValue } : {}),
    });
  }
  if (rec["kind"] === "event") return eventEntry(rec["event"] as JsonValue);
  return [{ kind: "tool", name: "stream", summary: "", args: item }];
}

/**
 * One instance's transcript: its conversation, with the journal facts that belong to it.
 *
 * `journal` is filtered to THIS instance's state — the projection is per task, and dropping that
 * filter is precisely the bug where opening one state showed the whole run's events underneath it.
 * A journal turn carries a `stateId` and nothing finer, so a state that ran twice shows both passes'
 * events on both cards; the alternative is showing neither, and an event attributed to the right
 * state and the wrong iteration is still the right event.
 *
 * `live` is the stream so far — appended after the stored turns, in stream order, with the text
 * tail last: while the record is open the stream IS the conversation, and everything on it is
 * rendered whether or not it has a name here. A bare string is accepted for callers that only
 * carry the text.
 */
export function entriesOf(
  session: SessionView | null,
  journal: readonly ConversationTurn[] = [],
  live?: LiveTail | string | null,
): TranscriptEntry[] {
  const said: Array<TranscriptEntry | ResultPart> = [];
  // The record's pinned provider events, spliced where they happened — an event's index counts the
  // turns that preceded it, so it renders before the turn it interrupted. Unlike the native lines
  // below, these were measured against exactly the messages the turns came from: the index IS the seam.
  const stored = session?.providerEvents ?? [];
  let nextEvent = 0;
  // The agent's own session-file lines, woven by role and order — see the native section above for
  // why the stored index cannot be trusted the way the pinned events' can.
  const native = session?.native ?? [];
  let cursor = 0;
  /**
   * Emit the native lines that precede this turn, up to and including its own envelope; hand back
   * the envelope's `toolUseResult` so it lands on the turn's tool line.
   */
  const drainFor = (turn: SessionTurn): JsonValue | undefined => {
    while (cursor < native.length) {
      const raw = native[cursor]!.line;
      const line = nativeRecordOf(raw);
      const role = envelopeRoleOf(line);
      if (role === undefined) {
        const event = nativeEventOf(raw);
        if (event !== undefined) said.push(event);
        cursor += 1;
        continue;
      }
      if (!pairsWithTurn(line!, role)) {
        cursor += 1;
        continue;
      }
      if (role !== turn.role) return undefined; // an envelope for a later turn — leave it queued
      cursor += 1;
      return line!["toolUseResult"];
    }
    return undefined;
  };
  const turns = session?.turns ?? [];
  for (const [i, turn] of turns.entries()) {
    for (; nextEvent < stored.length && stored[nextEvent]!.index <= i; nextEvent++) {
      said.push(...eventEntry(stored[nextEvent]!.event));
    }
    said.push(...messageOf(turn, undefined, drainFor(turn)));
  }
  // Whatever the file said after the last turn — a title, bookkeeping. Envelopes that never found a
  // turn are dropped here: an annotation lost beats a conversation misattributed.
  for (; cursor < native.length; cursor += 1) {
    const raw = native[cursor]!.line;
    if (envelopeRoleOf(nativeRecordOf(raw)) !== undefined) continue;
    const event = nativeEventOf(raw);
    if (event !== undefined) said.push(event);
  }
  for (; nextEvent < stored.length; nextEvent++) said.push(...eventEntry(stored[nextEvent]!.event));
  // Across the whole conversation, not per turn: `tool_use` and its `tool_result` are on different
  // turns in every Anthropic-shaped record, which is most of them.
  const entries: TranscriptEntry[] = pairResults(said);
  for (const turn of journal) {
    const event = eventOf(turn);
    if (event !== undefined) entries.push(event);
  }
  // Stable: entries with no timestamp keep the order they were produced in, which for a session's
  // turns is the order they were said in. Sorting them to the front by treating absent as zero
  // would put a whole conversation before the first event it caused.
  entries.sort((a, b) => ("at" in a ? (a.at ?? 0) : 0) - ("at" in b ? (b.at ?? 0) : 0));
  const tail: LiveTail | null = typeof live === "string" ? { text: live } : (live ?? null);
  if (tail !== null) {
    const streamed: Array<TranscriptEntry | ResultPart> = [];
    for (const item of tail.items ?? []) streamed.push(...liveItemEntries(item));
    // Paired within the stream: a live tool_result answers a live tool_use, and the record's own
    // entries are already settled above.
    entries.push(...pairResults(streamed));
    // Thinking before text, because that is the order a turn happens in — the model reasons, then
    // answers. The tail is a thought row like any settled one, growing as the deltas arrive.
    if (tail.thinking !== undefined && tail.thinking.length > 0) entries.push({ kind: "thought", text: tail.thinking });
    if (tail.text.length > 0) entries.push({ kind: "live", text: tail.text });
  }
  // A call whose subagent conversation exists becomes the doorway to it — whether the record kept
  // the chain, or its turns are still streaming by. After the live append on purpose: while the run
  // is going the Task call itself is a live entry, and it is a doorway the moment its chain speaks.
  const chains = session?.sidechains ?? {};
  const liveChains = tail?.sidechains ?? {};
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.callId === undefined) continue;
    if (chains[entry.callId] !== undefined || liveChains[entry.callId] !== undefined) entry.sidechain = entry.callId;
  }
  return entries;
}

/**
 * A subagent conversation's entries — the turns behind one spawning call, read exactly the way the
 * main thread is: same pairing, same thinking rows, same everything, because it IS a conversation
 * and differs only in who was speaking.
 *
 * `live` is the chain's turns still streaming by (see {@link LiveTail.sidechains}), appended after
 * whatever the record already holds — for an open record that is everything, because the sidechains
 * land with the record at close.
 *
 * A spawning call INSIDE the chain is marked as a doorway of its own: a subagent that spawned a
 * subagent keys the nested chain by its own call id in the same flat map, so the walk can continue.
 */
export function sidechainEntriesOf(
  session: SessionView | null,
  call: string,
  live?: readonly JsonValue[],
): TranscriptEntry[] {
  const said: Array<TranscriptEntry | ResultPart> = [];
  for (const turn of session?.sidechains?.[call] ?? []) said.push(...messageOf(turn));
  for (const item of live ?? []) said.push(...liveItemEntries(item, call));
  const entries = pairResults(said);
  const chains = session?.sidechains ?? {};
  for (const entry of entries) {
    if (entry.kind === "tool" && entry.callId !== undefined && entry.callId !== call && chains[entry.callId] !== undefined) {
      entry.sidechain = entry.callId;
    }
  }
  return entries;
}

/** Journal turns belonging to one state. See {@link entriesOf} on why this is by state, not instance. */
export function journalFor(turns: readonly ConversationTurn[], stateId: string | undefined): ConversationTurn[] {
  if (stateId === undefined) return [];
  return turns.filter((turn) => turn.stateId === stateId);
}

// --- the signature line -------------------------------------------------------

/** How long a previewed value may be before it is cut. Roughly one line of a card header. */
const PREVIEW = 48;

/**
 * A value as it appears in a card header — short enough for one line.
 *
 * A preview, not a description: the first words of a 4 kB document tell you which document it is,
 * where `markdown, 4.2 kB` tells you only that documents exist. The full value is shown in the
 * conversation, so this never has to be the whole story.
 */
export function previewOf(value: JsonValue | undefined): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") {
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > PREVIEW ? `"${flat.slice(0, PREVIEW)}…"` : `"${flat}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const printed = JSON.stringify(value);
    return printed.length > PREVIEW ? `${value.length} items` : printed;
  }
  const printed = JSON.stringify(value);
  return printed.length > PREVIEW ? `${Object.keys(value).length} fields` : printed;
}

/** One parameter of a card's signature. */
export interface SignatureParam {
  name: string;
  preview: string;
}

/**
 * The call-signature line for a run: `draft {goals=3 items, context="# Context…"}`.
 *
 * It is the same information a board card carries, in the same shape, because they are the same
 * object seen twice — a run, and what it was called with.
 *
 * When the state named itself (see `resolveLabel`), that name IS the signature and the parameters
 * are dropped: a label of `.inputs.description` already shows the input that identifies the run, and
 * repeating the rest is noise on a line with no room for it. With no label, every parameter is
 * listed, which is the honest fallback — something has to tell four runs apart.
 */
export function signatureOf(node: Pick<InstanceNode, "childKey" | "stateId" | "label" | "inputs">): {
  name: string;
  label?: string;
  params: SignatureParam[];
} {
  // The child KEY, not the state id: one state file can be mounted under several keys, and the key
  // is what the parent called it. Falls back to the last segment of the id for a state entered as a
  // root, which has no key.
  const name = node.childKey ?? node.stateId.split("/").pop() ?? node.stateId;
  if (node.label !== undefined && node.label.length > 0) return { name, label: node.label, params: [] };
  const inputs = node.inputs ?? {};
  return { name, params: Object.entries(inputs).map(([key, value]) => ({ name: key, preview: previewOf(value) })) };
}
