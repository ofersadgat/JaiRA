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
  /** Everything else, shown when expanded. */
  detail?: JsonValue;
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

export type TranscriptEntry = MessageEntry | ToolEntry | EventEntry | LiveEntry;

/**
 * The tool calls on one turn, paired with their results.
 *
 * A call and its result arrive as two entries on the same wire and only this layer knows both
 * shapes, which is why the record keeps `parts` structured rather than flattening it to text.
 */
export function toolPartsOf(parts: JsonValue | undefined): ToolEntry[] {
  if (!Array.isArray(parts)) return [];
  const out: ToolEntry[] = [];
  const results = new Map<string, unknown>();
  for (const part of parts) {
    const p = part as { type?: string; toolCallId?: string; result?: unknown };
    if (typeof p?.type === "string" && p.type.includes("result") && typeof p.toolCallId === "string") {
      results.set(p.toolCallId, p.result);
    }
  }
  for (const part of parts) {
    const p = part as { type?: string; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
    if (typeof p?.type !== "string" || p.type === "text" || p.type.includes("result")) continue;
    const args = p.args as Record<string, unknown> | undefined;
    const result = p.toolCallId !== undefined ? results.get(p.toolCallId) : p.result;
    out.push({
      kind: "tool",
      name: p.toolName ?? p.type,
      summary: firstArgOf(args),
      // Absent, not false: a call still in flight has no verdict, and rendering one as a failure is
      // the kind of wrong that gets acted on.
      ...(result === undefined ? {} : { ok: !isErrorish(result) }),
      ...(result === undefined ? { detail: (args ?? null) as JsonValue } : { detail: result as JsonValue }),
    });
  }
  return out;
}

/** The one argument worth putting on a collapsed line: a path, a command, the first string there is. */
function firstArgOf(args: Record<string, unknown> | undefined): string {
  if (args === undefined) return "";
  for (const key of ["command", "path", "file", "file_path", "pattern", "query", "url"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  const first = Object.values(args).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

function isErrorish(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  return r["error"] !== undefined || r["isError"] === true || r["ok"] === false;
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

function messageOf(turn: SessionTurn, at?: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const hasText = turn.text !== undefined && turn.text.length > 0;
  const tools = toolPartsOf(turn.parts);
  // A turn that is nothing but tool calls contributes no message — an empty assistant bubble above
  // three tool lines is a bubble that says only that the model spoke, which the lines already do.
  if (hasText || tools.length === 0) {
    entries.push({
      kind: "message",
      role: turn.role,
      ...(at !== undefined ? { at } : {}),
      ...(turn.text !== undefined ? { text: turn.text } : {}),
    });
  }
  // After the text, because that is the order they happened in: the model says what it is about to
  // do, then does it.
  for (const tool of tools) entries.push(at !== undefined ? { ...tool, at } : tool);
  return entries;
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
  const entries: TranscriptEntry[] = [];
  for (const turn of session?.turns ?? []) entries.push(...messageOf(turn));
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
