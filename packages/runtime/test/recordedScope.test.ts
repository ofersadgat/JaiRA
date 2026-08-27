/**
 * Resolving a run's bindings after it happened — see `recordedScope.ts`.
 *
 * The claims worth testing are about the SEAM, not about arithmetic: hw's resolver does the
 * evaluating, and re-testing `op.gt` here would be testing a dependency. What is ours is the scope —
 * what it offers, what it refuses, and where an impure call's value comes from.
 *
 * ⚠️ Every fixture is a LOWERED op tree in the shape a snapshot actually stores, taken from
 * `feature/product/confidence.json` and `explore/verdict.json`. The authored surface
 * (`.inputs.a > .inputs.b ? … : …`) is not in a snapshot at all — the loader lowers it and the
 * snapshot keeps only the tree — so a fixture written in surface syntax would be testing a shape
 * nothing on disk has. Two details fall out of that and are easy to get wrong from memory:
 * `op.member`'s slots are `value`/`prop`, and a producer whose slots are free is bound through a
 * sibling `parameters` map rather than inline.
 */
import { describe, expect, it } from "vitest";
import { hashCanonical } from "@declarative-ai/ops";
import type { InlineFamily, JsonValue, Ref } from "@declarative-ai/exec";
import { resolveRecorded, type RecordedResult } from "../src/recordedScope";

const ref = (r: unknown): Ref<InlineFamily> => r as Ref<InlineFamily>;

/** `context.get('inputs')` — how every authored expression reaches the state's own slots. */
const inputs = (): unknown => ({
  kind: "function",
  functionRef: "context.get",
  input: { name: { kind: "text", binding: { text: "inputs" } } },
  output: { name: "value", kind: "json" },
});

/** `.inputs.<name>`, lowered — a member read off that record. */
const input = (name: string): unknown => ({
  op: {
    kind: "function",
    functionRef: "op.member",
    input: {
      value: { kind: "json", binding: { op: inputs() } },
      prop: { kind: "text", binding: { text: name } },
    },
    output: { name: "value", kind: "json" },
  },
});

describe("resolving a pure expression", () => {
  it("reads a state's own input, through hw's own member semantics", () => {
    const out = resolveRecorded(ref(input("score")), { inputs: { score: 0.0713 }, record: () => undefined });
    expect(out).toEqual({ value: 0.0713, pending: false, calls: [] });
  });

  it("makes no call at all — which is why 97% of bindings need no record", () => {
    // The census in the module note: everything an expression lowers onto is pure. `calls` being
    // empty is the observable form of that, and it is what makes a computed state explicable from
    // the snapshot and its recorded inputs alone.
    const gt = ref({
      op: {
        kind: "function",
        functionRef: "op.gt",
        input: { left: { kind: "json", binding: input("a") }, right: { kind: "json", binding: input("b") } },
        output: { name: "value", kind: "json" },
      },
    });
    expect(resolveRecorded(gt, { inputs: { a: 3, b: 1 }, record: () => undefined })).toEqual({
      value: true,
      pending: false,
      calls: [],
    });
  });

  it("walks a nested member chain, which is what a real binding mostly is", () => {
    // `.inputs.composite_score.total` — `op.member` 681 times in one workflow, and this is why.
    const nested = ref({
      op: {
        kind: "function",
        functionRef: "op.member",
        input: {
          value: { kind: "json", binding: input("composite_score") },
          prop: { kind: "text", binding: { text: "total" } },
        },
        output: { name: "value", kind: "json" },
      },
    });
    const out = resolveRecorded(nested, { inputs: { composite_score: { total: 0.62 } }, record: () => undefined });
    expect(out.value).toBe(0.62);
  });
});

/**
 * An impure call — the other 3%.
 *
 * `resolveRef` never RUNS an operation; it reads the result through `operationResult`. So a recorded
 * run resolves one by looking the record up, and the lookup is content-addressed: `hashCanonical` of
 * the resolved operation is the record's own id.
 */
describe("resolving through a record", () => {
  /**
   * `confidence.score(.inputs.rank)` in the shape the snapshot stores it.
   *
   * The producer's slot is declared on the `op` and FILLED by `parameters` — the form every real
   * call in the feature workflow takes, and the one an inline binding would not exercise.
   */
  const call = (): unknown => ({
    op: {
      kind: "function",
      functionRef: "user:/fn.ts#confidence.score",
      input: { rank: { kind: "json", index: 0, schema: { type: "number" } } },
      output: { name: "result", kind: "json", schema: { type: "number" } },
    },
    parameters: { rank: { kind: "json", binding: input("rank") } },
  });

  /** The store: one answer, and a note of every id it was asked for. */
  const store = (found?: RecordedResult) => {
    const seen: string[] = [];
    return {
      seen,
      record: (id: string): RecordedResult | undefined => {
        seen.push(id);
        return found;
      },
    };
  };

  it("takes the value the call actually returned, and says where it came from", () => {
    const db = store({ status: "completed", result: { value: 0.0713 } });
    const out = resolveRecorded(ref(call()), { inputs: { rank: 2 }, record: db.record });
    expect(out.value).toBe(0.0713);
    expect(out.pending).toBe(false);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({
      functionRef: "user:/fn.ts#confidence.score",
      source: "recorded",
      status: "completed",
      result: 0.0713,
      // The arguments as the run SETTLED them: the resolver hands over the resolved operation, so
      // `2` is the value that actually went in rather than the expression that produced it.
      args: { rank: 2 },
    });
  });

  it("looks the record up by the content hash of the resolved request", () => {
    // The join, asserted rather than described. Nothing is attributed by time, by state id or by
    // anything else that could be ambiguous when two instances run at once.
    const db = store({ status: "completed", result: { value: 1 } });
    const out = resolveRecorded(ref(call()), { inputs: { rank: 2 }, record: db.record });
    expect(db.seen).toHaveLength(1);
    expect(out.calls[0]!.recordId).toBe(db.seen[0]);
    expect(db.seen[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks for a DIFFERENT record when the arguments differ", () => {
    // What makes the address content and not identity: two passes of one looping state that were
    // called with different numbers are two records, and each resolves to its own.
    const a = store({ status: "completed", result: { value: 1 } });
    const b = store({ status: "completed", result: { value: 1 } });
    resolveRecorded(ref(call()), { inputs: { rank: 2 }, record: a.record });
    resolveRecorded(ref(call()), { inputs: { rank: 3 }, record: b.record });
    expect(a.seen[0]).not.toBe(b.seen[0]);
  });

  it("refuses to invent a value when the call has no record", () => {
    // A call memoized from an earlier run, or one this run never reached. PENDING is hw's own
    // sentinel for "not available", so a consumer of this parks too rather than reading a guess.
    const out = resolveRecorded(ref(call()), { inputs: { rank: 2 }, record: () => undefined });
    expect(out.pending).toBe(true);
    expect(out.value).toBeUndefined();
    expect(out.calls[0]).toMatchObject({ source: "unrecorded" });
  });

  it("refuses a FAILED call's partial value", () => {
    // A failed call produced no output. Letting a consumer read one would put a number in front of
    // somebody that the run never had — the difference between "this is what happened" and "this is
    // roughly what happened".
    const out = resolveRecorded(ref(call()), {
      inputs: { rank: 2 },
      record: () => ({ status: "failed", error: { reason: "boom" }, result: { value: 999 } }),
    });
    expect(out.pending).toBe(true);
    expect(out.value).toBeUndefined();
    expect(out.calls[0]).toMatchObject({ source: "recorded", status: "failed", error: { reason: "boom" } });
  });

  it("UNWRAPS the record's envelope, which is not the callee's value", () => {
    // A stored result is `{ value }` — `StoredRecord`'s shape, not the function's. Passing it through
    // hands every consumer an object where the run had a number: it reads fine in a debug dump and is
    // wrong everywhere else, which is the kind of thing a worksheet would render as fact.
    const out = resolveRecorded(ref(call()), {
      inputs: { rank: 2 },
      record: () => ({ status: "completed", result: { value: 0.0713 } }),
    });
    expect(out.value).toBe(0.0713);
    expect(out.calls[0]!.result).toBe(0.0713);
  });

  it("refuses an envelope carrying an error, whatever the status column says", () => {
    // The two are written at different moments; the envelope is the one the executor filled in.
    const out = resolveRecorded(ref(call()), {
      inputs: { rank: 2 },
      record: () => ({ status: "completed", result: { error: { reason: "threw" }, value: 999 } }),
    });
    expect(out.pending).toBe(true);
    expect(out.value).toBeUndefined();
  });

  it("reports the call even when it could not be resolved, because that IS the finding", () => {
    // The row is what tells a reader why a worksheet has a hole in it. Dropping it would leave the
    // hole unexplained, which is the failure the whole surface exists to stop.
    const out = resolveRecorded(ref(call()), { inputs: { rank: 2 }, record: () => undefined });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.args).toEqual({ rank: 2 });
  });
});

describe("the property the join rests on", () => {
  it("hashes one request to one id, whatever order its keys arrive in", () => {
    // `hashCanonical` is the store's own key function — canonical, so key order cannot change the
    // address. A guard against it drifting under us rather than a test of hashing.
    const op = { kind: "function", functionRef: "f", input: { a: { kind: "json", binding: { json: 1 } } } };
    const reordered = { input: { a: { binding: { json: 1 }, kind: "json" } }, functionRef: "f", kind: "function" };
    expect(hashCanonical(op as unknown as JsonValue)).toBe(hashCanonical(reordered as unknown as JsonValue));
  });
});
