/**
 * What a run's CONVERSATION derives beside its bands — the call a settled gate is drawn from and the
 * request rebuilt from it, a `notify` call read as the line it told you, what one conversation cost, the
 * states an armed rewind deletes said as a list, a rewind armed from an entered row, and how full a
 * conversation was after its last answer. Nothing here draws: `RunTranscript.tsx` and `RunActivity.tsx`
 * (`packages/universal/src/components/panel`) and `run/RunConversation.tsx` do.
 */
import type { JsonValue } from "@declarative-ai/json";
import { isComponentName, parseComponentConfig, readCall, type ContextReading, type InstanceNode, type OperationRecordView, type PendingInteraction, type ReadCall, type SessionRef, type SessionView } from "@jaira/shared/browser";
import type { BandNote } from "./sessionBands";
import { cutNameOf } from "./sessionRows";
import { surfaceKindOf } from "./stateSurfaceModel";

/**
 * An events automation's `notify` call, settled: what it told the person, and what about — the
 * notice the inbox strip showed. One line, because it asked nothing and answered nothing: the call's
 * answer is `{ text, event? }`, the event in a line (`eventSummary`). A failed `notify` is not a told line.
 */
export function toldOf(call: ReadCall): { text: string; about?: string } | undefined {
  if (call.name !== "notify" || call.error !== undefined || call.status !== "completed") return undefined;
  const result = call.result !== null && typeof call.result === "object" && !Array.isArray(call.result) ? (call.result as Record<string, JsonValue>) : {};
  const text = typeof result["text"] === "string" ? result["text"] : undefined;
  if (text === undefined) return undefined;
  return { text, ...(typeof result["event"] === "string" ? { about: result["event"] } : {}) };
}

/** The calls a state dispatched, joined to what they ran — a call whose record was pruned is dropped. */
export function callsOf(node: InstanceNode, records: Record<string, OperationRecordView>): ReadCall[] {
  return (node.calls ?? [])
    .map((call) => records[call.operationId])
    .filter((row): row is OperationRecordView => row !== undefined)
    .map(readCall);
}

/**
 * The function call a settled `asked` state made, when its record is still there.
 *
 * Settled means the operation is no longer running, or the instance was cut from under it — a
 * cancel leaves `operation.status` at `running` (nothing ever completes it), so the instance's own
 * status has to be read too; see `headerToneOf` for the same rule. `asking` is the live gate being
 * hosted right now, which is never settled however the node reads.
 *
 * `undefined` when the record has been pruned, and then the panel falls back to the call listing:
 * a gate cannot be drawn from a call nothing remembers.
 */
export function settledGateCallOf(node: InstanceNode, records: Record<string, OperationRecordView>, asking: boolean): ReadCall | undefined {
  if (asking || surfaceKindOf(node) !== "asked") return undefined;
  const operation = node.operation;
  if (operation === undefined) return undefined;
  const cut = node.status === "canceled" || node.status === "failed" || node.status === "timeout";
  if (operation.status === "running" && !cut) return undefined;
  const calls = callsOf(node, records);
  return calls.filter((call) => call.ref !== undefined || call.kind === "function").at(-1) ?? calls.at(-1);
}

/**
 * The request a settled gate is drawn from, rebuilt from its record.
 *
 * Everything `GateSurface` reads is on the call: the component is the function it called, the
 * inputs are the arguments it was called with (a component's authored surface IS its args — see
 * `withContract` in main), and the contract is parsed from those the way main parses it for a live
 * gate. What the record does not carry is which project parked it, spelled here as the empty
 * project, which `GateSurface` reads as "the focused one".
 */
export function settledGateOf(call: ReadCall, node: InstanceNode, taskId: string | undefined, project: string | undefined): PendingInteraction {
  const component = call.name ?? call.ref ?? "function";
  const pending: PendingInteraction = {
    requestId: `settled:${node.instanceId}`,
    taskId: taskId ?? "",
    project: project ?? "",
    component,
    inputs: call.args,
  };
  if (isComponentName(component)) {
    try {
      pending.config = parseComponentConfig(component, call.args);
    } catch (e) {
      pending.configError = (e as Error).message;
    }
  }
  return pending;
}

/** "a, b and c" — the deleted states, said as a list. */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What one conversation has cost: the priced calls its instance made, summed; `undefined` when none was priced. */
export function costOfConversation(rows: readonly SessionRef[], instanceId: string): number | undefined {
  let total: number | undefined;
  for (const row of rows) if (String(row.instanceId) === instanceId && row.costUsd !== undefined) total = (total ?? 0) + row.costUsd;
  return total;
}

/** A rewind that is armed and not yet confirmed — what the strip asks about. See `RunConversation`. */
export interface ArmedRewind {
  seq: number;
  at: number;
  /** The state the cut is before. */
  name: string;
  /** Every state the cut deletes, the named one first. */
  doomed: string[];
}

/**
 * The rewind a reader arms from an entered row: its position and clock, the state it is before, and
 * every state entered at or after the cut, named — the sentence in the strip is what makes
 * "everything after it" a checkable claim.
 */
export function armedRewindOf(note: BandNote, notes: readonly BandNote[], root: string): ArmedRewind {
  return {
    seq: note.seq,
    at: note.at,
    name: cutNameOf(note, root),
    doomed: notes.filter((one) => one.kind === "entered" && one.at >= note.at).map((one) => cutNameOf(one, root)),
  };
}

/** How full a conversation was after its last answer: the reading on the newest turn that has one. */
export function lastContextOf(view: SessionView | null | undefined): ContextReading | undefined {
  return [...(view?.turns ?? [])].reverse().find((turn) => turn.context !== undefined)?.context;
}
