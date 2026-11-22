/**
 * A program's calls, drawn among its conversation's messages (decision 0033 §1, §5).
 *
 * A conversation written as a script (decision 0029) runs every `llm()`, `input()` and registry call as
 * a state of its own. Chat drew only the conversation the program threads through its replies; the
 * task view drew a sheet per state, which read as a trace. Both now draw the same thing: the thread's
 * messages, with every other call the program made woven in where it happened, each drawn by the
 * renderer the registry gives its (function, role) — and each view showing, folding or hiding it by
 * its role.
 *
 * The person's message is drawn once. A reply's prompt IS the message `input()` returned, and the thread
 * already holds it as a turn: so `input()` and an `llm()` whose prompt the thread holds add nothing, and
 * an `llm()` the thread does not hold (a check, a classifier) is a row with its answer.
 *
 * Pure, so the rules are tested: `chatThreadModel.ts` and `RunTranscript.tsx` call it.
 */
import { createContext } from "react";
import type { JsonValue } from "@declarative-ai/json";
import { readCall, type InstanceNode, type OperationRecordView } from "@jaira/shared/browser";
import { CALL_RENDERERS, functionNameOf, lookup, roleOf, visibilityOf, withOverrides, type CallRegistry, type CallView, type RendererEntry, type RendererId } from "./callRenderers";
import type { EventEntry, MessageEntry, ToolEntry, TranscriptEntry } from "./transcript";

/** How a script asked a call to be drawn (`renderUI`, §4) — resolved down its call path. */
export interface CallPresentation {
  role?: string;
  title?: string;
  /** `null`: draw nothing. */
  renderer?: RendererEntry | null;
  /** Registry entries for this call's scope: `[function, role, entry]`, `"*"` for either. */
  renderers?: Array<readonly [string, string, RendererEntry]>;
}

const RENDERERS: ReadonlySet<string> = new Set<RendererId>(["conversation", "message", "tool", "child-run", "told", "none"]);

/** A script's renderer reference — an id, or an id with options — as a registry entry; `null` draws nothing. */
function entryOf(written: JsonValue | undefined): RendererEntry | null | undefined {
  if (written === null) return null;
  if (typeof written === "string") return RENDERERS.has(written) ? { renderer: written as RendererId } : undefined;
  const object = objectOf(written);
  const id = object?.["id"];
  if (typeof id !== "string" || !RENDERERS.has(id)) return undefined;
  const options = objectOf(object?.["options"]);
  return { renderer: id as RendererId, ...(options !== undefined ? { options } : {}) };
}

/**
 * A `renderUI` config as the view reads it: the scopes from the root down to the call merged, the
 * nearest naming a field winning, and the scopes' `renderers` adding up. A renderer the app does not
 * have is left out, so the registry's own stands.
 */
export function presentationOf(scopes: ReadonlyArray<Record<string, JsonValue> | undefined>): CallPresentation | undefined {
  let found = false;
  const out: CallPresentation = {};
  const renderers: Array<readonly [string, string, RendererEntry]> = [];
  for (const scope of scopes) {
    if (scope === undefined) continue;
    found = true;
    if (typeof scope["role"] === "string") out.role = scope["role"];
    if (typeof scope["title"] === "string") out.title = scope["title"];
    if ("renderer" in scope) {
      const entry = entryOf(scope["renderer"]);
      if (entry !== undefined) out.renderer = entry;
    }
    for (const row of Array.isArray(scope["renderers"]) ? scope["renderers"] : []) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string") continue;
      const entry = entryOf(row[2]);
      if (entry !== undefined) renderers.push([row[0], row[1], entry ?? { renderer: "none" }]);
    }
  }
  if (renderers.length > 0) out.renderers = renderers;
  return found ? out : undefined;
}

/** One call a program made, read off its state and its record. */
export interface ProgramCall {
  /** The state that made it — what an interrupt of it reaches. */
  instanceId: string;
  /** The call's own record id: a state in the coarser modes makes several. */
  operationId: string;
  /** When the call's state was entered — where it is woven. */
  at: number;
  endedAt?: number;
  /** In the registry's terms (`functionNameOf`): `llm`, `input`, `conversation_digest`. */
  fn: string;
  ref?: string;
  /** What the step is called: its `label`, else its function. */
  label: string;
  /** What it was called with. An `llm()`'s are its prompt and system prompt. */
  args: Record<string, JsonValue>;
  result?: JsonValue;
  error?: JsonValue;
  status: string;
  present?: CallPresentation;
}

/** A state id with the version it ran under taken out — `session@v1a2b…/call_0` → `session/call_0`. */
const baseOf = (stateId: string): string => stateId.replace(/@v[0-9a-f]+(?=\/|$)/g, "");

/** Whether `child` is a state of `root`'s own program — its calls, or an improved version of it. */
function isOwnProgram(root: InstanceNode, child: InstanceNode): boolean {
  const own = baseOf(root.stateId);
  const it = baseOf(child.stateId);
  return it === own || it.startsWith(`${own}/`);
}

const objectOf = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined;

/**
 * The calls a state made: every operation it dispatched that has a record — its own call where a script
 * is cut a call per state (the code after the call keeps none), or each call its code made in the
 * coarser modes, told apart by what the script said of each at its site (`InstanceNode.scriptCalls`).
 */
function callsOf(node: InstanceNode, records: Readonly<Record<string, OperationRecordView>>, path: ReadonlyArray<Record<string, JsonValue> | undefined>): ProgramCall[] {
  const recorded = (node.calls ?? []).flatMap((call) => {
    const record = records[call.operationId];
    return record === undefined ? [] : [{ call, record }];
  });
  const single = recorded.length === 1;
  return recorded.map(({ call, record }) => {
    const read = readCall(record);
    const kind = read.kind ?? call.kind;
    const fn = functionNameOf(read.name, kind);
    const request = objectOf(record.request);
    const args: Record<string, JsonValue> =
      kind === "prompt"
        ? {
            ...(typeof request?.["user"] === "string" ? { prompt: request["user"] } : {}),
            ...(typeof request?.["system"] === "string" ? { system: request["system"] } : {}),
          }
        : read.args;
    // A prompt's answer is `{ value, finishReason, entries, … }`: the value is what the call returned.
    // Only once it has: a call still going already keeps what it has said so far in its record's result.
    const answered = read.status === "completed";
    const answer = !answered ? undefined : kind === "prompt" ? (objectOf(read.result)?.["value"] ?? read.result) : read.result;
    const said = call.site !== undefined ? node.scriptCalls?.[call.site] : undefined;
    const present = presentationOf([...path, node.present, said?.present]);
    // A state that is one call is named by its state; one of several, by what the script called it.
    const named = single ? (node.label ?? said?.label ?? labelOfState(node)) : (said?.label ?? node.label);
    return {
      instanceId: node.instanceId,
      operationId: call.operationId,
      at: record.startedAt ?? node.startedAt,
      ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : node.endedAt !== undefined && single ? { endedAt: node.endedAt } : {}),
      fn,
      ...(read.ref !== undefined ? { ref: read.ref } : {}),
      label: present?.title ?? (named !== undefined && named !== "input()" ? named : fn),
      args,
      ...(answer !== undefined ? { result: answer } : {}),
      ...(read.error !== undefined ? { error: read.error } : {}),
      status: read.status,
      ...(present !== undefined ? { present } : {}),
    };
  });
}

/** A call state's key is its call site (`call_2`): a name only when nothing better is known. */
function labelOfState(node: InstanceNode): string | undefined {
  const key = node.childKey ?? node.stateId.split("/").pop();
  return key === undefined || /^call_\d+$/.test(key) ? undefined : key.replace(/_\d+$/, "");
}

/**
 * Every call `root`'s program made, in the order they were made — superseded passes of its loop
 * included, since each pass is a message of the conversation. Empty for a run that is not a program.
 */
export function programCallsOf(root: InstanceNode | undefined, records: Readonly<Record<string, OperationRecordView>>): ProgramCall[] {
  if (root === undefined) return [];
  const out: ProgramCall[] = [];
  // The scopes down the call path: a state a helper or a workflow was mounted as carries its own. A
  // composite's own code makes calls too (a phase between its children), so every state is read.
  const visit = (node: InstanceNode, path: ReadonlyArray<Record<string, JsonValue> | undefined>): void => {
    for (const child of node.children) {
      if (!isOwnProgram(root, child) || child.made !== undefined) continue;
      out.push(...callsOf(child, records, path));
      if (child.children.length > 0) visit(child, [...path, child.present]);
    }
  };
  out.push(...callsOf(root, records, []));
  visit(root, [root.present]);
  return out.sort((a, b) => a.at - b.at);
}

/** The text the thread's person said, to tell a call the thread already holds. */
function heldMessages(entries: readonly TranscriptEntry[]): Set<string> {
  const held = new Set<string>();
  for (const entry of entries) if (entry.kind === "message" && entry.role === "user" && entry.text !== undefined) held.add(entry.text.trim());
  return held;
}

const firstArgOf = (args: Record<string, JsonValue>): string => {
  const first = Object.values(args)[0];
  const value = objectOf(first) !== undefined ? Object.values(objectOf(first)!)[0] : first;
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  return value === undefined ? "" : JSON.stringify(value).slice(0, 80);
};

/** A call as a tool row: what any function without a renderer of its own reads as. */
function toolOf(call: ProgramCall, name: string = call.label): ToolEntry {
  const settled = call.status === "completed" ? true : call.status === "failed" ? false : undefined;
  return {
    kind: "tool",
    at: call.at,
    name,
    summary: firstArgOf(call.args),
    args: call.args as JsonValue,
    ...(call.error !== undefined ? { result: call.error } : call.result !== undefined ? { result: call.result } : {}),
    ...(settled !== undefined ? { ok: settled } : {}),
    // A wait for the person is no call to interrupt: its row is named apart, so it offers no Interrupt.
    callId: call.fn === "input" ? `wait:${call.instanceId}#${call.operationId}` : `${PROGRAM_CALL_PREFIX}${call.instanceId}#${call.operationId}`,
  };
}

/** What one call adds to the thread, drawn by `entry` — nothing when the thread already says it. */
function entriesOfCall(call: ProgramCall, entry: RendererEntry, held: ReadonlySet<string>, everyStep: boolean): TranscriptEntry[] {
  switch (entry.renderer) {
    case "none":
      return everyStep ? [toolOf(call)] : [];
    case "message": {
      const text = objectOf(call.result)?.["text"];
      // The wait, as a step of its own, where every step is asked for: what it was answered with is its result.
      if (typeof text !== "string" || held.has(text.trim())) return everyStep ? [toolOf(call)] : [];
      const message: MessageEntry = { kind: "message", role: "user", at: call.endedAt ?? call.at, text };
      return everyStep ? [toolOf(call), message] : [message];
    }
    case "conversation": {
      // The thread's reply: its prompt is a message the thread holds, and what it added is the thread's.
      const prompt = call.args["prompt"];
      if (typeof prompt === "string" && held.has(prompt.trim())) return everyStep ? [toolOf(call)] : [];
      // A call of its own — a check, a classifier: a row, with what it answered.
      return [toolOf(call)];
    }
    case "child-run":
      return [toolOf(call, "start_task")];
    case "told": {
      const text = objectOf(call.result)?.["text"];
      if (typeof text !== "string") return [toolOf(call)];
      const about = objectOf(call.result)?.["event"];
      const told: EventEntry = { kind: "event", at: call.at, tone: "plain", text: `told you: ${text}${typeof about === "string" ? ` · ${about}` : ""}` };
      return [told];
    }
    case "tool":
      return [toolOf(call)];
  }
}

/**
 * The thread's messages, each with a time: a conversation whose record keeps none (an agent that writes
 * no timestamps) would have every call woven after its last message. A message the program answered is
 * dated by the program's own calls — the person's by the `input()` it answered, a reply by the `llm()`
 * whose prompt was the message before it — each call used once, in order. A message with a time keeps it.
 */
function datedByCalls(entries: readonly TranscriptEntry[], calls: readonly ProgramCall[]): readonly TranscriptEntry[] {
  if (!entries.some((entry) => entry.kind === "message" && entry.at === undefined)) return entries;
  const used = new Set<ProgramCall>();
  const find = (test: (call: ProgramCall) => boolean, after: number): ProgramCall | undefined => calls.find((call) => !used.has(call) && call.at >= after && test(call));
  let after = Number.NEGATIVE_INFINITY;
  let said: string | undefined;
  return entries.map((entry) => {
    if (entry.kind !== "message") return entry;
    const text = entry.text?.trim();
    let at = entry.at;
    if (at === undefined && text !== undefined) {
      const call =
        entry.role === "user"
          ? find((one) => (one.fn === "input" && objectOf(one.result)?.["text"] === text) || (one.fn === "llm" && typeof one.args["prompt"] === "string" && one.args["prompt"].trim() === text), after)
          : entry.role === "assistant" && said !== undefined
            ? find((one) => one.fn === "llm" && typeof one.args["prompt"] === "string" && one.args["prompt"].trim() === said, after)
            : undefined;
      if (call !== undefined) {
        // The reply that answers a first message dates the reply too: only a wait is the person's alone.
        if (entry.role === "assistant" || call.fn === "input") used.add(call);
        // A person's message lands when the wait for it ends; the first, which no wait asked for, as its reply starts.
        at = entry.role === "user" ? (call.fn === "input" ? (call.endedAt ?? call.at) : call.at) : (call.endedAt ?? call.at);
      }
    }
    if (entry.role === "user" && text !== undefined) said = text;
    if (at === undefined) return entry;
    after = Math.max(after, entry.role === "user" ? at - 1 : at);
    return entry.at === at ? entry : { ...entry, at };
  });
}

/** When an entry happened, for weaving; a live tail is after everything recorded. */
function timeOf(entry: TranscriptEntry): number | undefined {
  if (entry.kind === "live" || entry.kind === "writing") return Number.POSITIVE_INFINITY;
  return entry.at;
}

/**
 * The thread's entries with the program's calls woven in where they happened, as `view` draws them.
 *
 * A call's renderer is its `renderUI` renderer, else the registry's for its (function, role); its role
 * decides whether `view` shows it. A call is placed before the first entry that happened after it; an
 * entry with no time stands where the one before it did.
 */
export function weaveProgramCalls(
  entries: readonly TranscriptEntry[],
  calls: readonly ProgramCall[],
  view: CallView,
  registry: CallRegistry = CALL_RENDERERS,
  /**
   * Every step a row of its own, in order — the waits and the replies the thread already says, and what
   * a role hides — as the task view offers it ("Every step"): the program at the level of its calls,
   * drawn among its messages rather than in place of them.
   */
  everyStep = false,
): TranscriptEntry[] {
  if (calls.length === 0) return [...entries];
  entries = datedByCalls(entries, calls);
  const held = heldMessages(entries);
  const added: TranscriptEntry[] = [];
  for (const call of calls) {
    // A scope's own registry entries, laid over the app's for this call.
    const scoped = call.present?.renderers !== undefined ? withOverrides(registry, { entries: call.present.renderers }) : registry;
    const role = roleOf(scoped, call.fn, call.present?.role);
    if (visibilityOf(scoped, role, view) === "hidden" && !everyStep) continue;
    const entry = call.present?.renderer === null ? { renderer: "none" as const } : (call.present?.renderer ?? lookup(scoped, call.fn, role));
    added.push(...entriesOfCall(call, entry, held, everyStep));
  }
  if (added.length === 0) return [...entries];
  added.sort((a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0));
  const out: TranscriptEntry[] = [];
  let next = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const at = timeOf(entry) ?? last;
    while (next < added.length && (timeOf(added[next]!) ?? 0) < at) out.push(added[next++]!);
    out.push(entry);
    last = Math.max(last, at);
  }
  while (next < added.length) out.push(added[next++]!);
  return out;
}

/**
 * How far a step may start after the block it belongs to: a reply's state is entered a moment after the
 * message it answers was sent, a check's call a moment after its state.
 */
export const STEP_SLACK_MS = 250;

/** A drawn block's first and last moments (`data-from`, `data-to` on its element). */
export interface BlockSpan {
  from: number;
  to: number;
}

/**
 * The block a step that started at `at` is found in (a Steps pick, decision 0033 §1): the block it
 * falls in, or the nearest within a moment of it — the work it is a row of, else the message it is or
 * answered; failing that, the first block that had not ended before it, and past them all the last.
 * `-1` with no blocks.
 */
export function stepBlockOf(spans: readonly BlockSpan[], at: number): number {
  if (spans.length === 0) return -1;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  spans.forEach((span, i) => {
    const off = at < span.from ? span.from - at : at > span.to ? at - span.to : 0;
    if (off < distance) {
      nearest = i;
      distance = off;
    }
  });
  if (distance <= STEP_SLACK_MS) return nearest;
  const found = spans.findIndex((span) => span.to >= at - STEP_SLACK_MS);
  return found === -1 ? spans.length - 1 : found;
}

/** Every state under `root`, depth first. */
function descendantsOf(root: InstanceNode): InstanceNode[] {
  const out: InstanceNode[] = [];
  const visit = (node: InstanceNode): void => {
    for (const child of node.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/**
 * The step the thread is at when it shows what happened at `at` — the last state of the program that
 * started by then — and, given the moments the screen spans, every state that started within them; the
 * root where nothing under it had started yet. What the Steps index beside the thread marks.
 */
export function stepsAt(root: InstanceNode | undefined, at: number, shown?: { from: number; to: number }): { current: string | undefined; onScreen: Set<string> } {
  const onScreen = new Set<string>();
  if (root === undefined) return { current: undefined, onScreen };
  let current: InstanceNode = root;
  for (const node of descendantsOf(root)) {
    if (node.startedAt <= at + STEP_SLACK_MS && node.startedAt >= current.startedAt) current = node;
    if (shown !== undefined && node.startedAt >= shown.from - STEP_SLACK_MS && node.startedAt <= shown.to + STEP_SLACK_MS) onScreen.add(node.instanceId);
  }
  onScreen.add(current.instanceId);
  return { current: current.instanceId, onScreen };
}

/** The state `instanceId` names under `root` (the root itself included). */
export function stepOf(root: InstanceNode | undefined, instanceId: string): InstanceNode | undefined {
  if (root === undefined) return undefined;
  if (root.instanceId === instanceId) return root;
  return descendantsOf(root).find((node) => node.instanceId === instanceId);
}

/** The row id a program's call is drawn under, and the state it names — what an interrupt reaches. */
export const PROGRAM_CALL_PREFIX = "program:";

/** The state a program call's row stands for, when the row is one (`toolOf`'s `callId`). */
export function programCallInstance(callId: string | undefined): string | undefined {
  if (callId === undefined || !callId.startsWith(PROGRAM_CALL_PREFIX)) return undefined;
  const id = callId.slice(PROGRAM_CALL_PREFIX.length);
  return id.includes("#") ? id.slice(0, id.indexOf("#")) : id;
}

/**
 * Interrupt the call a program's row stands for (decision 0033 §6): handed to the rows by the thread
 * drawing them, so a running call's row carries its own Interrupt. Absent, rows offer none.
 */
export const CallInterruptContext = createContext<((instanceId: string) => void) | undefined>(undefined);
