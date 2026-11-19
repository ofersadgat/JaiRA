/**
 * What a simulation's pass is decided under and how it reads back (decision 0029 §5 step 5).
 *
 * An improver tries a proposed change on a FORK of the conversation where the correction was made: the
 * fork reads the proposed files as if they were written (`definitionOverlay.ts`), works in a throwaway
 * workspace (`makeThrowawayWorkspace`), and sends again the message whose reply the person corrected —
 * one pass, with nobody to ask. This module is the two pure parts of that: the permission set the pass
 * decides its calls under, and what the pass said and did, read off its thread for the judge.
 */
import type { JsonValue } from "@declarative-ai/json";
import { declOfPermissionSet, mergeLayerDecls, parsePermissionSet, type PermissionSet, type PermissionSetEntry, type SessionTurn } from "@jaira/shared";

/** The set that stands over a simulation's — `$/permission-sets/improve/simulation`, which a layer may override. */
export const SIMULATION_SET = "$/permission-sets/improve/simulation";

/** A line's mode, whichever spelling it was written in — `undefined` for one it cannot read. */
function modeOfLine(line: unknown): unknown {
  if (line === null || typeof line !== "object" || Array.isArray(line)) return line;
  const keys = Object.keys(line);
  const wrapper = keys.length > 0 && keys.every((key) => key === "mode" || key === "implementation");
  return wrapper ? (line as { mode?: unknown }).mode : line;
}

/**
 * The set a simulation's pass decides its calls under: the conversation's own, with `sandbox` standing
 * over it as its newest layer (decision 0023 §2.5) — and a sandbox line that says where it STOPS (a
 * place map with `**`) fences its line: what the conversation's set said of that line elsewhere goes
 * (a plain decision under it first, as `mergePermissionMode` reads one), so a place the conversation
 * allowed outside the throwaway workspace is not still allowed. A line the sandbox only adds places to
 * (the reads) merges as any newer layer's does.
 *
 * Whether a tool is offered, and whose code runs it, stay the conversation's: the sandbox decides what a
 * call may do, never what the agent is handed.
 */
export function sandboxedPermissionSet(base: PermissionSet, sandbox: Readonly<Record<string, unknown>>): PermissionSet {
  const fences: Record<string, unknown> = {};
  for (const [subject, line] of Object.entries(sandbox)) {
    const mode = modeOfLine(line);
    if (mode !== null && typeof mode === "object" && !Array.isArray(mode) && Object.keys(mode).some((place) => place.trim() === "**")) fences[subject] = "deny";
  }
  const { decl } = mergeLayerDecls([
    { id: "conversation", decl: declOfPermissionSet(base) as Record<string, unknown> },
    { id: "fence", decl: fences },
    { id: "simulation", decl: { ...sandbox } },
  ]);
  const merged = parsePermissionSet(decl).permissionSet;
  const entries: Record<string, PermissionSetEntry> = {};
  for (const [subject, entry] of Object.entries(merged.entries)) {
    const held = Object.hasOwn(base.entries, subject) ? base.entries[subject] : undefined;
    if (entry.kind !== "tool") {
      entries[subject] = entry;
      continue;
    }
    const { implementation: _implementation, offered: _offered, ...rest } = entry;
    entries[subject] = {
      ...rest,
      ...(held?.implementation !== undefined ? { implementation: held.implementation } : {}),
      // A tool the conversation does not hold is not handed to the pass because the sandbox names it.
      ...(held === undefined || held.offered === false ? { offered: false } : {}),
    } as PermissionSetEntry;
  }
  return { ...merged, entries, ...(base.other !== undefined && merged.other === undefined ? { other: base.other } : {}) };
}

/** One call of a pass, as the judge reads it. */
export interface PassCall {
  tool: string;
  /** What it was called with, cut short. */
  input?: string;
  /** What it answered when it failed or was refused, cut short. */
  refused?: string;
}

/** One turn of a pass, as the judge reads it: who spoke, what they said, the calls made. */
export interface PassTurn {
  role: string;
  text?: string;
  calls?: PassCall[];
}

const cut = (text: string, at = 400): string => (text.length > at ? `${text.slice(0, at)}…` : text);

/** A tool part's text — a string, or the text parts of a content array. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * A thread's turns as the judge reads them: each turn's text, and the calls its parts made — by tool,
 * with what they were called with, and what a call that failed or was refused answered.
 */
export function passTurnsOf(turns: readonly SessionTurn[]): PassTurn[] {
  const out: PassTurn[] = [];
  // A call's result may come back in a later turn (the tool results the agent is handed next).
  const byId = new Map<string, PassCall>();
  for (const turn of turns) {
    const calls: PassCall[] = [];
    for (const part of Array.isArray(turn.parts) ? turn.parts : []) {
      if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
      const p = part as Record<string, JsonValue>;
      const type = p["type"];
      if (type === "tool_use" || type === "tool-call") {
        const name = typeof p["name"] === "string" ? p["name"] : typeof p["toolName"] === "string" ? p["toolName"] : "tool";
        const input = p["input"] ?? p["args"];
        const call: PassCall = { tool: name, ...(input !== undefined ? { input: cut(JSON.stringify(input)) } : {}) };
        calls.push(call);
        const id = p["id"] ?? p["toolCallId"];
        if (typeof id === "string") byId.set(id, call);
      } else if (type === "tool_result" || type === "tool-result") {
        const failed = p["is_error"] === true || p["isError"] === true;
        const said = textOfContent(p["content"] ?? p["output"] ?? p["result"]);
        if (!failed && !/^Not run:/.test(said)) continue;
        const id = p["tool_use_id"] ?? p["toolCallId"];
        const call = typeof id === "string" ? byId.get(id) : undefined;
        if (call !== undefined) call.refused = cut(said, 300);
        else calls.push({ tool: "(result)", refused: cut(said, 300) });
      }
    }
    const text = typeof turn.text === "string" && turn.text.trim().length > 0 ? turn.text : undefined;
    if (text === undefined && calls.length === 0) continue;
    out.push({ role: turn.role, ...(text !== undefined ? { text } : {}), ...(calls.length > 0 ? { calls } : {}) });
  }
  return out;
}
