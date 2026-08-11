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

/** Something the journal recorded that nobody said: a gate, a policy call, a failure, a transition. */
export interface EventEntry {
  kind: "event";
  at?: number;
  tone: "plain" | "warn" | "bad";
  text: string;
}

/** The answer being written right now, before it is a turn. */
export interface LiveEntry {
  kind: "live";
  text: string;
}

export type TranscriptEntry = MessageEntry | ToolEntry | EventEntry | LiveEntry | ThoughtEntry;

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
function messageOf(turn: SessionTurn, at?: number): Array<TranscriptEntry | ResultPart> {
  const entries: Array<TranscriptEntry | ResultPart> = [];
  const hasText = turn.text !== undefined && turn.text.length > 0;
  const parts = messagePartsOf(turn.parts);
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
      out.push({ kind: "tool", name: "result", summary: "", ok: !failed(entry), result: entry.result });
      continue;
    }
    call.result = entry.result;
    // Absent, not false: a call still in flight has no verdict, and rendering one as a failure is
    // the kind of wrong that gets acted on.
    call.ok = !failed(entry);
    const at = unanswered.indexOf(call);
    if (at >= 0) unanswered.splice(at, 1);
  }
  return out;
}

/**
 * One instance's transcript: its conversation, with the journal facts that belong to it.
 *
 * `journal` is filtered to THIS instance's state — the projection is per task, and dropping that
 * filter is precisely the bug where opening one state showed the whole run's events underneath it.
 * A journal turn carries a `stateId` and nothing finer, so a state that ran twice shows both passes'
 * events on both cards; the alternative is showing neither, and an event attributed to the right
 * state and the wrong iteration is still the right event.
 */
export function entriesOf(
  session: SessionView | null,
  journal: readonly ConversationTurn[] = [],
  live?: string | null,
): TranscriptEntry[] {
  const said: Array<TranscriptEntry | ResultPart> = [];
  for (const turn of session?.turns ?? []) said.push(...messageOf(turn));
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
  if (live !== undefined && live !== null && live.length > 0) entries.push({ kind: "live", text: live });
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
