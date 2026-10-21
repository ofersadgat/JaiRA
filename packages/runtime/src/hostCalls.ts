/**
 * Calls a TOOL made — `approve_tool_call` — as the ordinary calls they are, in the conversation's
 * record (the person, 2026-09-26: "this should essentially function like a tool calling another tool
 * … the tool call with result should be a normal part of the conversation record. therefore, it
 * should be able to survive a restart with no special mechanics").
 *
 * A call that needs permission calls `approve_tool_call`; the person answers; the call goes on. The
 * approval is two entries in the one array: the call (`tool_use`) and its result (`tool_result`),
 * each marked `calledBy` — the id of the call that made it, the way a subagent's turns name the call
 * that spawned them. From there nothing about it is special:
 *
 *  - while the turn streams they ride the live tail like any entry, and the throttled partial writes
 *    them down, so a turn cut off keeps them;
 *  - when the record settles, {@link withHostCalls} folds them in right after the call that made them,
 *    because the executor's own output never held them;
 *  - they are never replayed to a model (`messagesOfRecord`), and never paired with the agent's own
 *    session file (`foldIntoEntries`): the model made no such call.
 */
import type { JsonValue, RecordStore } from "@declarative-ai/exec";
import { ASK_USER_TOOL } from "@declarative-ai/agents-api";
import { APPROVAL_PROMPT_FUNCTION } from "@jaira/shared";

/**
 * What `approve_tool_call` was called with, as the record keeps it — the WHOLE request, because the
 * record is where a question still waiting when the app closed is found again: what the prompt draws
 * and what the answer is matched by have to be in it.
 */
export interface ApprovalCallInput {
  /** The tool that needed permission — `shell`, `write_file`, an MCP tool. */
  tool: string;
  command?: string;
  reason?: string;
  /** The permission function that asked, when one put the call to the person (`smart`). */
  asker?: string;
  /** The line as the requests it is made of, as the prompt draws it (decision 0007 §4). */
  parts?: JsonValue;
  /**
   * The tool's input, when the call that needed permission is NOT in the record beside it (a transport
   * whose record holds no tool calls). Otherwise it is that call's own `input`, and is not written twice.
   */
  input?: JsonValue;
  /** The workflow instance whose operation asked. */
  instanceId?: string;
}

/** How it was answered — the `data` on its result. */
export interface ApprovalCallAnswer {
  decision: "allow" | "deny";
  /** How far the answer reached, as the person chose it (`once`, `workflow-run`, …). */
  scope: string;
  /** "For this run", for a shell line: the widths of its asking parts the answer covers. */
  remember?: string[];
  /** Who answered: the person, or nobody — a stop, or the app closing. */
  by: "person" | "stopped" | "closed";
  /** How long the call waited on the answer. */
  waitedMs: number;
}

/** An entry as the live stream carries it: the provider-shaped message under `content`. */
function streamed(role: "assistant" | "user", calledBy: string | undefined, parts: JsonValue[]): JsonValue {
  return { kind: "message", role, ...(calledBy !== undefined ? { calledBy } : {}), content: { role, content: parts } } as JsonValue;
}

/** The same entry as a settled record keeps it: its parts directly under `content`, timed. */
function recorded(role: "assistant" | "user", calledBy: string | undefined, parts: JsonValue[], at: number): JsonValue {
  return {
    kind: "message",
    role,
    content: parts,
    timestamp: new Date(at).toISOString(),
    provider: "jaira",
    ...(calledBy !== undefined ? { calledBy } : {}),
    timing: { at },
  } as JsonValue;
}

/** `approve_tool_call` being called — the live entry, and the record's. */
export function approvalCallEntries(callId: string, calledBy: string | undefined, input: ApprovalCallInput, at: number): { live: JsonValue; record: JsonValue } {
  const parts: JsonValue[] = [{ type: "tool_use", id: callId, name: APPROVAL_PROMPT_FUNCTION, input: input as unknown as JsonValue }];
  return { live: streamed("assistant", calledBy, parts), record: recorded("assistant", calledBy, parts, at) };
}

/** Its result — the words the call it gated reads, and the answer itself as `data`. */
export function approvalResultEntries(callId: string, calledBy: string | undefined, answer: ApprovalCallAnswer, at: number): { live: JsonValue; record: JsonValue } {
  const words = answer.decision === "allow" ? "allowed" : answer.by === "person" ? "denied" : answer.by === "closed" ? "not answered: the app closed" : "not answered: the run stopped";
  const parts: JsonValue[] = [{ type: "tool_result", tool_use_id: callId, content: words, data: answer as unknown as JsonValue }];
  return { live: streamed("user", calledBy, parts), record: recorded("user", calledBy, parts, at) };
}

/** Canonical JSON, keys sorted — two inputs that are the same call compare equal whatever their key order. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** The `tool_use` parts of an entry in either shape — streamed (`content.content`) or recorded (`content`). */
function toolUsesOf(entry: JsonValue): Array<{ id: string; input: unknown }> {
  const e = entry as { kind?: unknown; role?: unknown; content?: unknown } | null;
  if (e === null || typeof e !== "object" || e.kind !== "message" || e.role !== "assistant") return [];
  const content = Array.isArray(e.content) ? e.content : (e.content as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; input: unknown }> = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part?.["type"] === "tool_use" && typeof part["id"] === "string") out.push({ id: part["id"], input: part["input"] });
  }
  return out;
}

/**
 * The call that needs permission: the newest `tool_use` in the turn whose input IS the one the
 * permission request carries. The request names no call id — upstream's permission request has none —
 * but it carries the tool's input exactly as the model wrote it, and that input is the call's.
 */
export function callingCallOf(entries: readonly JsonValue[], input: unknown): string | undefined {
  const want = canonical(input);
  for (let i = entries.length - 1; i >= 0; i--) {
    const uses = toolUsesOf(entries[i]!);
    for (let k = uses.length - 1; k >= 0; k--) if (canonical(uses[k]!.input) === want) return uses[k]!.id;
  }
  return undefined;
}

/**
 * A question a record was left asking: a call put to the person that has no result. What a conversation
 * cut off by the app closing is found to be waiting on when it opens again — the record is the whole of
 * it (the person, 2026-10-21: "the agent record should be written, so we should be able to replay that
 * record and thus present the permission and have it properly run if permission is given").
 */
export type UnansweredAsk =
  | {
      kind: "approval";
      /** `approve_tool_call`'s own call id — the name the request goes by from now on. */
      callId: string;
      /** The call that needed permission, when the record holds it. */
      calledBy?: string;
      request: ApprovalCallInput;
      /** That call's input — what a call made again is matched by. */
      toolInput: JsonValue;
      at?: number;
    }
  | {
      kind: "question";
      /** The agent's `AskUserQuestion` call. */
      toolUseId: string;
      input: JsonValue;
      at?: number;
    };

/** The agent's own question tool, by its own name or as an MCP server serves it (`mcp__…__AskUserQuestion`). */
function isAskUserTool(name: unknown): boolean {
  return typeof name === "string" && (name === ASK_USER_TOOL || name.endsWith(`__${ASK_USER_TOOL}`));
}

/** The parts of a record-shaped entry, or `[]`. */
function partsOf(entry: JsonValue): Array<Record<string, unknown>> {
  const e = entry as { kind?: unknown; content?: unknown } | null;
  if (e === null || typeof e !== "object" || e.kind !== "message") return [];
  const content = Array.isArray(e.content) ? e.content : (e.content as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** The host clock an entry was stamped with, when it carries one. */
function atOf(entry: JsonValue): number | undefined {
  const at = (entry as { timing?: { at?: unknown } } | null)?.timing?.at;
  return typeof at === "number" ? at : undefined;
}

/**
 * Every ask in a record's entries that was never answered — an `approve_tool_call` with no result, and
 * an `AskUserQuestion` of the main conversation with no result — oldest first.
 */
export function unansweredAsksOf(entries: readonly JsonValue[]): UnansweredAsk[] {
  const answered = new Set<string>();
  const inputs = new Map<string, unknown>();
  for (const entry of entries) {
    for (const part of partsOf(entry)) {
      if (part["type"] === "tool_result" && typeof part["tool_use_id"] === "string") answered.add(part["tool_use_id"]);
      if (part["type"] === "tool_use" && typeof part["id"] === "string") inputs.set(part["id"], part["input"]);
    }
  }
  const out: UnansweredAsk[] = [];
  for (const entry of entries) {
    const e = entry as { role?: unknown; calledBy?: unknown; sidechain?: unknown };
    if (e.role !== "assistant") continue;
    for (const part of partsOf(entry)) {
      const id = part["id"];
      if (part["type"] !== "tool_use" || typeof id !== "string" || answered.has(id)) continue;
      const at = atOf(entry);
      if (part["name"] === APPROVAL_PROMPT_FUNCTION) {
        const request = (part["input"] ?? {}) as unknown as ApprovalCallInput;
        if (typeof request.tool !== "string") continue;
        const calledBy = typeof e.calledBy === "string" ? e.calledBy : undefined;
        const toolInput = (request.input ?? (calledBy !== undefined ? inputs.get(calledBy) : undefined) ?? {}) as JsonValue;
        out.push({ kind: "approval", callId: id, ...(calledBy !== undefined ? { calledBy } : {}), request, toolInput, ...(at !== undefined ? { at } : {}) });
      } else if (isAskUserTool(part["name"]) && e.sidechain === undefined) {
        out.push({ kind: "question", toolUseId: id, input: (part["input"] ?? {}) as JsonValue, ...(at !== undefined ? { at } : {}) });
      }
    }
  }
  return out;
}

/**
 * What the person answered "for this run" about the parts of shell lines, as the record keeps it: each
 * `approve_tool_call` whose result the PERSON gave with widths to remember, paired with the parts its
 * call carried. What a run resumed in a new process remembers again (`ApprovalHub.rememberAgain`).
 */
export function rememberedAnswersOf(entries: readonly JsonValue[]): Array<{ parts: JsonValue; decision: "allow" | "deny"; remember: string[] }> {
  const parts = new Map<string, JsonValue>();
  const out: Array<{ parts: JsonValue; decision: "allow" | "deny"; remember: string[] }> = [];
  for (const entry of entries) {
    for (const part of partsOf(entry)) {
      if (part["type"] === "tool_use" && part["name"] === APPROVAL_PROMPT_FUNCTION && typeof part["id"] === "string") {
        const asked = (part["input"] as { parts?: JsonValue } | undefined)?.parts;
        if (asked !== undefined) parts.set(part["id"], asked);
      }
      if (part["type"] === "tool_result" && typeof part["tool_use_id"] === "string") {
        const answer = part["data"] as Partial<ApprovalCallAnswer> | undefined;
        const asked = parts.get(part["tool_use_id"]);
        if (asked === undefined || answer?.by !== "person" || !Array.isArray(answer.remember)) continue;
        if (answer.decision !== "allow" && answer.decision !== "deny") continue;
        out.push({ parts: asked, decision: answer.decision, remember: answer.remember });
      }
    }
  }
  return out;
}

/**
 * How a question the agent asked was answered when its own call could not carry the answer back: by the
 * person after the app closed under it (their answers, or left to the agent), or by nobody — the run was
 * stopped while it waited. Written as the result of the agent's own call, so the record says the
 * question was answered, by whom and with what; the words are what a transport that REPLAYS the
 * conversation hands the model.
 */
export function questionResultEntries(
  toolUseId: string,
  answered: { answers: Record<string, string | readonly string[]> } | { leftToAgent: true } | { stopped: true },
  at: number,
): { live: JsonValue; record: JsonValue } {
  let words: string;
  let data: JsonValue;
  if ("answers" in answered) {
    const lines = Object.entries(answered.answers).map(([question, answer]) => `${question} → ${Array.isArray(answer) ? answer.join(", ") : String(answer)}`);
    words = `The person answered:\n${lines.join("\n")}`;
    data = { answers: answered.answers, by: "person" } as unknown as JsonValue;
  } else if ("leftToAgent" in answered) {
    words = "The person left it to you: use your own judgment.";
    data = { by: "person" };
  } else {
    words = "not answered: the run stopped";
    data = { by: "stopped" };
  }
  const parts: JsonValue[] = [{ type: "tool_result", tool_use_id: toolUseId, content: words, data }];
  return { live: streamed("user", undefined, parts), record: recorded("user", undefined, parts, at) };
}

/**
 * Fold the calls a tool made into a record's entries, right after the call that made each — call then
 * result, in the order they happened. A result the host gave one of the MODEL's own calls (a question
 * nobody answered because the run stopped) goes right after that call. Returns what it could not place:
 * calls whose caller is not in THIS record belong to another one (a run's parallel operations each
 * settle their own).
 */
export function mergeHostCalls(entries: readonly JsonValue[], pending: readonly JsonValue[]): { entries: JsonValue[]; left: JsonValue[] } {
  const out = [...entries];
  const left: JsonValue[] = [];
  // Where each call of this record sits, and how many host entries already follow it.
  const placed = new Map<string, number>();
  for (const entry of pending) {
    const answers = partsOf(entry).find((part) => part["type"] === "tool_result")?.["tool_use_id"];
    const caller = (entry as { calledBy?: unknown }).calledBy ?? answers;
    if (typeof caller !== "string") {
      left.push(entry);
      continue;
    }
    const at = out.findIndex((e) => toolUsesOf(e).some((use) => use.id === caller));
    if (at < 0) {
      left.push(entry);
      continue;
    }
    const after = placed.get(caller) ?? 0;
    out.splice(at + 1 + after, 0, entry);
    placed.set(caller, after + 1);
  }
  return { entries: out, left };
}

/**
 * A record store that folds the calls a tool made into the record of the call that made them, when it
 * settles. `take` hands over what is waiting (and forgets it); `keep` is given back what this record
 * could not place. A payload that is not a conversation has nowhere to put them, and is stored as it is.
 */
export function withHostCalls(inner: RecordStore, take: () => JsonValue[], keep: (left: JsonValue[]) => void): RecordStore {
  return {
    append: (stub) => inner.append(stub),
    ...(inner.update !== undefined ? { update: (at, partial) => inner.update!.call(inner, at, partial) } : {}),
    ...(inner.bySession !== undefined ? { bySession: (session, upTo) => inner.bySession!.call(inner, session, upTo) } : {}),
    finish: (ref, settled) => {
      const pending = take();
      const result = settled.result as { value?: unknown } | undefined;
      const value = result?.value as { entries?: unknown } | undefined;
      if (pending.length === 0 || value === null || typeof value !== "object" || !Array.isArray(value.entries)) {
        if (pending.length > 0) keep(pending);
        return inner.finish(ref, settled);
      }
      const merged = mergeHostCalls(value.entries as JsonValue[], pending);
      if (merged.left.length > 0) keep(merged.left);
      return inner.finish(ref, { ...settled, result: { ...result, value: { ...value, entries: merged.entries } } as never });
    },
  };
}
