/**
 * An operation record, read as the CALL it was — what a state actually ran.
 *
 * `run:records` hands back rows whose `request` and `result` are opaque JSON, and every surface that
 * wanted to say "this state called `confidence.score(maxSeverityRank: 1, …) → 0.63`" had to know the
 * engine's request shape to do it. One reader here, so a surface asks a question about a call rather
 * than picking apart a wire format, and the day the shape changes there is one place that notices.
 *
 * ## What was actually missing
 *
 * A state whose outputs are bound to function expressions dispatches a call per output and emits no
 * `operation.started` at all — so the projection gave it no `operation`, `surfaceKindOf` called it
 * `computed`, and the panel said it ran nothing. The three function names, their resolved arguments
 * and their answers were all in `operation_records` the whole time, unreachable because nothing
 * joined the journal's attribution to the store's content. `InstanceNode.calls` is that join;
 * this is what makes the result legible.
 *
 * ## Reading is TOTAL, never a throw
 *
 * Every field is optional and every shape is checked, for the same reason `structured.ts` returns a
 * complaint rather than throwing: the moment a reader most wants to know what a call was is when
 * something about it went wrong, and a viewer that gave up on an unexpected record would go blank
 * exactly then. A record it cannot read at all comes back as a call with no name and no arguments,
 * which is still more than the silence it replaces.
 */
import type { JsonValue } from "@declarative-ai/json";
import type { OperationRecordView } from "./view";

/** One call, as a surface wants to draw it. */
export interface ReadCall {
  /**
   * What to put on the line — `confidence.score`, `review_artifact`.
   *
   * The part of `functionRef` after the `#`, which is the name the workflow author wrote. The whole
   * ref is {@link ref} and belongs on a hover: `user:C:/Users/Ofer/.jaira/functions/confidence.ts`
   * is where the function lives, and where it lives is not what it is called.
   */
  name?: string;
  /** The reference exactly as recorded, when there was one. */
  ref?: string;
  /** `prompt` or `function` — from the record itself rather than from the journal event. */
  kind?: string;
  /** The arguments it was called with, resolved: name → the value the engine bound. */
  args: Record<string, JsonValue>;
  /** What it answered, when it answered. */
  result?: JsonValue;
  /** Why it did not, when it did not. */
  error?: JsonValue;
  status: string;
}

/** A JSON object and nothing else — arrays and null are not records, whatever `typeof` says. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The short name in a function reference.
 *
 * `user:<path>#confidence.score` → `confidence.score`. A ref with no `#` is already the name — a
 * component is registered under a bare `review_artifact` — so the whole string stands.
 */
export function functionNameOf(ref: string): string {
  const at = ref.lastIndexOf("#");
  return at < 0 ? ref : ref.slice(at + 1);
}

/**
 * The value an input binding resolved to.
 *
 * `{ binding: { json: 3 } }` is the engine's spelling for "this argument came out as 3", and it is
 * what makes these worth showing: the arguments are the resolved ones, so a call whose answer looks
 * wrong can be checked against what it was actually handed rather than against the expression that
 * was supposed to produce it. Anything else — a binding still symbolic, a shape this does not know —
 * comes back as the binding itself, which is at least honest about being unresolved.
 */
function argOf(slot: unknown): JsonValue | undefined {
  const node = objectOf(slot);
  if (node === undefined) return slot as JsonValue;
  const binding = objectOf(node["binding"]);
  if (binding === undefined) return node["binding"] as JsonValue | undefined;
  return "json" in binding ? (binding["json"] as JsonValue) : (binding as JsonValue);
}

/**
 * A record, read as a call. Never throws — see the module note.
 *
 * The result is UNWRAPPED from its `{ value: … }` envelope, because the envelope is transport: a
 * reader asking what `confidence.score` answered wants `0.63`, and `{"value":0.63}` is the same
 * answer with a word in front of it. An error is left whole, because its shape (`classification`,
 * `reason`) is the content rather than a wrapper.
 */
export function readCall(record: OperationRecordView): ReadCall {
  const request = objectOf(record.request);
  const ref = typeof request?.["functionRef"] === "string" ? (request["functionRef"] as string) : undefined;
  const input = objectOf(request?.["input"]) ?? {};
  const args: Record<string, JsonValue> = {};
  for (const [name, slot] of Object.entries(input)) {
    const value = argOf(slot);
    if (value !== undefined) args[name] = value;
  }
  const result = objectOf(record.result);
  return {
    ...(ref !== undefined ? { name: functionNameOf(ref), ref } : {}),
    ...(typeof request?.["kind"] === "string" ? { kind: request["kind"] as string } : {}),
    args,
    ...(record.result !== undefined
      ? { result: (result !== undefined && "value" in result ? result["value"] : record.result) as JsonValue }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    status: record.status,
  };
}
