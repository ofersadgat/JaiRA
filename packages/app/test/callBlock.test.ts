/**
 * What a state that ran FUNCTIONS says about itself — the calls its panel lists (`callsOf`).
 *
 * The state this exists for is `feature/product/confidence`: three outputs, each bound to a function
 * expression, so three calls dispatched and no `operation.started` at all. The projection therefore
 * gave it no operation, the letterhead called it `computed`, and the body listed the state's INPUTS
 * and stopped — which is how a state that ran `confidence.score`, `confidence.reasons` and
 * `confidence.mustAsk` came to be drawn as a state that had done nothing, with all three names,
 * their arguments and their answers sitting in `operation_records` the whole time.
 *
 * The join is `InstanceNode.calls` (stamped from `operation.dispatched`) against the record store;
 * the fixtures below are the real run's rows.
 *
 * This file rendered the DOM's `SilentState`, which went with the DOM renderer. The universal one
 * (`packages/universal/src/components/panel/RunTranscript.tsx`) draws the same list from the same
 * join, so the cases are on the join: which calls it gives, and what each one carries to be drawn.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, OperationRecordView } from "@jaira/shared/browser";
import { callsOf } from "../src/renderer/runConversationModel";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

const record = (id: string, name: string, args: Record<string, unknown>, value: unknown): OperationRecordView => ({
  recordId: id,
  status: "completed",
  request: {
    kind: "function",
    functionRef: `user:C:/Users/Ofer/.jaira/functions/confidence.ts#${name}`,
    input: Object.fromEntries(Object.entries(args).map(([key, json]) => [key, { kind: "json", binding: { json } }])),
  } as never,
  result: { value } as never,
});

const RECORDS: Record<string, OperationRecordView> = {
  score: record("score", "confidence.score", { maxSeverityRank: 1, iteration: 3 }, 0.6333333333333333),
  reasons: record("reasons", "confidence.reasons", { thresholdRank: 2 }, ["it took more than one pass to converge"]),
};

const CONFIDENCE = node({
  instanceId: "04d854",
  stateId: "feature/product/confidence",
  childKey: "confidence",
  inputs: { findings: "…" },
  calls: [
    { operationId: "score", kind: "function" },
    { operationId: "reasons", kind: "function" },
  ],
});

describe("a state that computed its outputs by calling functions", () => {
  it("names every function it ran, and not just the namespace they share", () => {
    expect(callsOf(CONFIDENCE, RECORDS).map((call) => call.name)).toEqual(["confidence.score", "confidence.reasons"]);
  });

  it("keeps the whole reference on the hover, because where it lives is not what it is called", () => {
    expect(callsOf(CONFIDENCE, RECORDS).map((call) => call.ref)).toEqual([
      "user:C:/Users/Ofer/.jaira/functions/confidence.ts#confidence.score",
      "user:C:/Users/Ofer/.jaira/functions/confidence.ts#confidence.reasons",
    ]);
  });

  it("shows the RESOLVED arguments, so the answer can be checked against what was handed over", () => {
    expect(callsOf(CONFIDENCE, RECORDS).map((call) => call.args)).toEqual([{ maxSeverityRank: 1, iteration: 3 }, { thresholdRank: 2 }]);
  });

  it("shows what each call answered", () => {
    expect(callsOf(CONFIDENCE, RECORDS).map((call) => call.result)).toEqual([0.6333333333333333, ["it took more than one pass to converge"]]);
  });

  it("falls back to the state's inputs when it dispatched nothing at all", () => {
    // A genuinely computed state — every output an expression over values it was handed. It has no
    // call to list, which is what leaves its panel to the inputs rather than to an empty heading.
    expect(callsOf(node({ instanceId: "9", stateId: "verdict", inputs: { score: 0.6 } }), {})).toEqual([]);
  });

  it("keeps the calls under a FAILURE, which is where knowing which ones got through matters most", () => {
    const failed = node({
      ...CONFIDENCE,
      status: "failed",
      operation: { kind: "function", status: "failed", reason: "output 'score': no function is registered" },
    });
    expect(callsOf(failed, RECORDS).map((call) => [call.name, call.status])).toEqual([
      ["confidence.score", "completed"],
      ["confidence.reasons", "completed"],
    ]);
  });

  it("drops a call whose record has been pruned rather than drawing a row about nothing", () => {
    expect(callsOf(CONFIDENCE, { score: RECORDS["score"]! }).map((call) => call.name)).toEqual(["confidence.score"]);
  });
});
