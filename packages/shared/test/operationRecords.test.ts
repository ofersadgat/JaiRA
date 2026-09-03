/**
 * Reading a record as the CALL it was — see `operationRecords.ts`.
 *
 * The fixtures are copied out of a real run's `operation_records` rather than invented, because the
 * whole value of this module is that it agrees with the shape the engine actually writes. An
 * invented fixture tests the reader against itself.
 */
import { describe, expect, it } from "vitest";
import { functionNameOf, readCall } from "../src/operationRecords";
import type { OperationRecordView } from "../src/view";

/** `feature/product/confidence`, output `score` — the state that read as silence. */
const SCORE: OperationRecordView = {
  recordId: "8922c304888b1a7d191feedd52006b2db71642f5c7ab34fd30593af2b34ef1cd",
  status: "completed",
  request: {
    kind: "function",
    functionRef: "user:C:/Users/Ofer/.jaira/functions/confidence.ts#confidence.score",
    input: {
      maxSeverityRank: { kind: "json", index: 0, schema: { type: "number" }, binding: { json: 1 } },
      iteration: { kind: "json", index: 1, schema: { type: "number" }, binding: { json: 3 } },
    },
    output: { name: "result", kind: "json", schema: { type: "number" } },
  },
  result: { value: 0.6333333333333333 },
};

describe("a function reference, as the name somebody wrote", () => {
  it("takes the part after the `#`, which is what the workflow file says", () => {
    expect(functionNameOf("user:C:/Users/Ofer/.jaira/functions/confidence.ts#confidence.score")).toBe(
      "confidence.score",
    );
  });

  it("leaves a bare name alone — a registered component has no file to point at", () => {
    expect(functionNameOf("review_artifact")).toBe("review_artifact");
  });
});

describe("a record, read as a call", () => {
  it("names the function and resolves its arguments", () => {
    const call = readCall(SCORE);
    expect(call.name).toBe("confidence.score");
    // The whole ref survives for the hover: where it lives is not what it is called.
    expect(call.ref).toContain("confidence.ts");
    expect(call.args).toEqual({ maxSeverityRank: 1, iteration: 3 });
  });

  it("unwraps the result envelope, because `{value: 0.63}` is 0.63 with a word in front of it", () => {
    expect(readCall(SCORE).result).toBe(0.6333333333333333);
  });

  it("keeps an error whole — its shape IS the content", () => {
    const canceled: OperationRecordView = {
      recordId: "82c4d1bb",
      status: "failed",
      request: { kind: "function", functionRef: "review_artifact", input: {} },
      error: { classification: "canceled", reason: "the operation was canceled" },
    };
    const call = readCall(canceled);
    expect(call.name).toBe("review_artifact");
    expect(call.error).toEqual({ classification: "canceled", reason: "the operation was canceled" });
    expect(call.result).toBeUndefined();
    expect(call.status).toBe("failed");
  });

  it("reads a record it does not recognise without throwing", () => {
    // The point of being total: the moment a reader most wants to know what a call was is when
    // something about it is unexpected, and a viewer that gave up would go blank exactly then.
    const odd = readCall({ recordId: "x", status: "open", request: "not an object" as never });
    expect(odd.name).toBeUndefined();
    expect(odd.args).toEqual({});
    expect(odd.status).toBe("open");
  });

  it("shows an unresolved binding as itself rather than dropping the argument", () => {
    const pending: OperationRecordView = {
      recordId: "y",
      status: "open",
      request: { kind: "function", functionRef: "f", input: { a: { kind: "json", binding: { ref: "state.out" } } } },
    };
    expect(readCall(pending).args).toEqual({ a: { ref: "state.out" } });
  });
});
