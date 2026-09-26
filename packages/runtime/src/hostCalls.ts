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
import { APPROVAL_PROMPT_FUNCTION } from "@jaira/shared";

/** What `approve_tool_call` was called with, as the record keeps it. */
export interface ApprovalCallInput {
  /** The tool that needed permission — `bash`, `write_file`, an MCP tool. */
  tool: string;
  command?: string;
  reason?: string;
  /** The permission function that asked, when one put the call to the person (`smart`). */
  asker?: string;
}

/** How it was answered — the `data` on its result. */
export interface ApprovalCallAnswer {
  decision: "allow" | "deny";
  /** How far the answer reached, as the person chose it (`once`, `run`, …). */
  scope: string;
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
function canonical(value: unknown): string {
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
 * Fold the calls a tool made into a record's entries, right after the call that made each — call then
 * result, in the order they happened. Returns what it could not place: calls whose caller is not in
 * THIS record belong to another one (a run's parallel operations each settle their own).
 */
export function mergeHostCalls(entries: readonly JsonValue[], pending: readonly JsonValue[]): { entries: JsonValue[]; left: JsonValue[] } {
  const out = [...entries];
  const left: JsonValue[] = [];
  // Where each call of this record sits, and how many host entries already follow it.
  const placed = new Map<string, number>();
  for (const entry of pending) {
    const caller = (entry as { calledBy?: unknown }).calledBy;
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
