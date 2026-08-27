/**
 * Resolving a run's bindings AFTER it happened — the derivation behind a computed state.
 *
 * ## What this is for
 *
 * A state with no operation produces its outputs entirely from bindings: `explore/verdict`'s
 * `winner` is one expression over the scores it was handed, and `product/confidence`'s `score` is a
 * call into a user function. The conversation view had nothing to say about either — a state that
 * ran no model call answered with one sentence — because the values live in two places and neither
 * is the journal.
 *
 * They are recoverable, and this is how.
 *
 * ## The two halves, and why they are one mechanism
 *
 * A census of the feature workflow's 1,684 binding calls splits them cleanly:
 *
 *  - **1,640 (97.4%) are PURE** — `op.member`, `context.get`, `select`, `op.strictEq`, `maxBy`,
 *    `find`, and a dozen more. They write no record and need none: they are a function of values
 *    the run already has.
 *  - **44 are IMPURE** — a user's `.ts`, `run_command`, and the interactive components. Not one of
 *    them is evaluable after the fact, and every one of them wrote an operation record.
 *
 * The sets are exactly complementary, so nothing is dark. And they need no separate treatment,
 * because `resolveRef` already draws that line: it does not RUN operations, it reads their results
 * through {@link ResolutionScope.operationResult} — the same protocol a child follows. So a
 * recorded run resolves by implementing that one method against the record store.
 *
 * ## Why hw's own resolver rather than an interpreter of our own
 *
 * Because a derivation that disagrees with the run is worse than no derivation. A second
 * implementation of `op.member`'s semantics — property access on `null` yields `undefined`,
 * `.length` is the only property a string exposes, objects expose own properties only — would be a
 * second thing to keep in step, and the first time it drifted the view would report a value the run
 * never computed. `resolveRef` is the engine's; calling it means the operators cannot disagree.
 *
 * ## What it CANNOT do, and says so
 *
 * A binding whose impure call has no record resolves to hw's `PENDING`, not to a guess. That is the
 * honest answer for a call that was memoized from an earlier run, or one this run never reached, and
 * it is the same sentinel the engine uses for a producer still in flight — so a consumer of this
 * resolves to PENDING too rather than to a plausible number.
 */
import { PENDING, resolveRef, type ResolutionScope } from "@declarative-ai/hw";
import { hashCanonical } from "@declarative-ai/ops";
import type { InlineFamily, JsonValue, Operation, Ref } from "@declarative-ai/exec";

/**
 * A call this run made, as the record store hands it over.
 *
 * Structurally `RecordedCall` from `@jaira/persistence`, restated rather than imported: the runtime
 * does not depend on persistence (the dependency runs the other way), and what this needs is three
 * fields rather than a table's shape.
 */
export interface RecordedResult {
  status: string;
  result?: JsonValue;
  error?: JsonValue;
}

/** Where a resolved value CAME FROM — the two halves above, told apart. */
export type ValueSource =
  /** Computed here, by hw's resolver, from values the run already had. */
  | "computed"
  /** Read from the record of what the call actually returned. */
  | "recorded"
  /** An impure call with no record — see the module note. Nothing is claimed. */
  | "unrecorded";

/**
 * What one binding resolved to, and how.
 *
 * `source` is the whole point of returning more than a value: a number computed from an expression
 * and a number read off a record are the same number and different claims, and a worksheet that drew
 * them identically would be asserting that it had checked something it had not.
 */
export interface ResolvedBinding {
  value?: JsonValue;
  /** Set when resolution failed outright — a wiring error rather than a missing record. */
  error?: string;
  /** True when the answer is PENDING: something it depends on has no recorded value. */
  pending: boolean;
  /** Every impure call this resolution went through, in the order it reached them. */
  calls: ResolvedCall[];
}

/** One impure call a resolution passed through, with what the record said about it. */
export interface ResolvedCall {
  /** The callee — `user:…/confidence.ts#confidence.score`, `review_artifact`. */
  functionRef: string;
  /** `hashCanonical` of the resolved request: the record's own id, and the join to it. */
  recordId: string;
  source: ValueSource;
  /** The arguments as the run settled them, by slot name. */
  args: Record<string, JsonValue>;
  /** What the callee returned, UNWRAPPED from the record's `{ value }` envelope. */
  result?: JsonValue;
  error?: JsonValue;
  status?: string;
}

/** What a recorded run offers a resolution — the four things a scope reads, from stored data. */
export interface RecordedRun {
  /** This state's resolved inputs, as `instance.entered` recorded them. */
  inputs: Record<string, JsonValue>;
  /** A declared child's outputs, by the key the parent mounted it under. */
  childOutputs?: (key: string) => JsonValue | undefined;
  /** Which input names the state declared optional — its `slotMeta`. */
  optional?: ReadonlySet<string>;
  /** A call's record, by content id. `hashCanonical` of the request is that id. */
  record: (recordId: string) => RecordedResult | undefined;
}

/**
 * The DSL context a state's own bindings read.
 *
 * `inputs` and `children.<key>.outputs` are what an authored expression names (`.inputs.scores`,
 * `.children.draft.outputs.docs`), and they are the two the recorded run can answer. Anything else
 * an expression reaches for — `run`, `limits` — is absent rather than invented, and reading it
 * yields `undefined` through hw's own `memberOf`, which is what it would have done for a state that
 * never had one.
 */
function contextOf(run: RecordedRun, children: ReadonlyMap<string, JsonValue>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [key, value] of children) outputs[key] = { outputs: value };
  return { inputs: run.inputs, children: outputs };
}

/**
 * Resolve one binding against a recorded run.
 *
 * The calls it went through are collected as it goes — `operationResult` is the only place an impure
 * callee can be reached, so recording there catches every one of them exactly once, in resolution
 * order, without walking the tree twice.
 */
export function resolveRecorded(ref: Ref<InlineFamily>, run: RecordedRun): ResolvedBinding {
  const calls: ResolvedCall[] = [];
  /** Children are read lazily and remembered: one key can be named several times in one expression. */
  const children = new Map<string, JsonValue>();
  const childOutputs = (key: string): JsonValue | undefined => {
    if (children.has(key)) return children.get(key);
    const value = run.childOutputs?.(key);
    if (value !== undefined) children.set(key, value);
    return value;
  };

  const scope: ResolutionScope = {
    // Built once per resolution rather than per read: `resolveRef` walks the tree synchronously, so
    // a child reached after the context was made would be missing from it. Every key the run has is
    // asked for up front by `childOutputs` below, which fills the map before this is read.
    get exprContext() {
      return contextOf(run, children);
    },
    childOutputs,
    scopeValue: (name) => run.inputs[name],
    optionalInput: (name) => run.optional?.has(name) === true,
    // Neither is recoverable from a record, and both answer `undefined` rather than throwing — which
    // is what an expression reaching for an artifact the run did not keep would have got anyway.
    artifact: () => undefined,
    conversation: () => undefined,
    /**
     * The join, and the whole reason this works.
     *
     * `hashCanonical` of the resolved operation IS its `record_id` — the store's own key, verified
     * against a real run. So an impure call does not need to be attributed by time, by state id or
     * by anything else that could be ambiguous under concurrency: the content addresses the record.
     *
     * A record that is present but did not succeed resolves to PENDING rather than to its partial
     * value. A failed call produced no output, and letting a consumer read one would put a number in
     * front of somebody that the run never had.
     */
    operationResult: (op: Operation<InlineFamily>) => {
      const recordId = hashCanonical(op as unknown as JsonValue);
      const found = run.record(recordId);
      const call: ResolvedCall = {
        // A prompt op has no callee to name — it is a model call, and an expression can embed one.
        // `(prompt)` rather than a blank, because the row is about to say what it returned.
        functionRef: op.kind === "function" ? op.functionRef : "(prompt)",
        recordId,
        source: found === undefined ? "unrecorded" : "recorded",
        args: argsOf(op),
        ...(found?.status !== undefined ? { status: found.status } : {}),
        ...(valueOf(found?.result) !== undefined ? { result: valueOf(found?.result)! } : {}),
        ...(found?.error !== undefined ? { error: found.error } : {}),
      };
      calls.push(call);
      if (found === undefined || found.status !== "completed") return PENDING;
      /**
       * UNWRAP the envelope. A stored result is `{ value }` or `{ error, value? }` — `StoredRecord`'s
       * shape, not the callee's — so passing it through hands every consumer an object where the run
       * had a number. It reads correctly in a debug dump and is wrong everywhere else, which is
       * exactly the kind of bug a worksheet would render as fact.
       *
       * An envelope carrying an `error` is refused even when the status says otherwise: the two are
       * written at different moments, and the envelope is the one the executor filled in.
       */
      const settled = found.result as { value?: JsonValue; error?: unknown } | undefined;
      if (settled === undefined || settled.error !== undefined) return PENDING;
      return { value: (settled.value ?? null) as JsonValue };
    },
  };

  const resolved = resolveRef(ref, scope);
  if (resolved === PENDING) return { pending: true, calls };
  if ("error" in resolved) return { error: resolved.error, pending: false, calls };
  return { value: resolved.value as JsonValue, pending: false, calls };
}

/** The value inside a stored result's envelope — see the note in `operationResult`. */
function valueOf(result: JsonValue | undefined): JsonValue | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  return (result as { value?: JsonValue }).value;
}

/**
 * A call's arguments as the run settled them.
 *
 * Read off the operation the resolver hands over, which is the RESOLVED one — every binding below it
 * has already been evaluated, so `binding.json` is the value that actually went in rather than the
 * expression that produced it. That is what makes a worksheet's argument list the run's own numbers.
 */
function argsOf(op: Operation<InlineFamily>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const input = (op as { input?: Record<string, { binding?: { json?: unknown } }> }).input;
  for (const [name, slot] of Object.entries(input ?? {})) {
    const value = slot?.binding?.json;
    if (value !== undefined) out[name] = value as JsonValue;
  }
  return out;
}
