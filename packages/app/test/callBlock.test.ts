/**
 * What a state that ran FUNCTIONS says about itself — see `SilentState` and `CallBlock`.
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
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InstanceNode, OperationRecordView } from "@jaira/shared/browser";
import { SilentState } from "../src/renderer/runViews";

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

const draw = (n: InstanceNode, records: Record<string, OperationRecordView>): string =>
  renderToStaticMarkup(createElement(SilentState, { node: n, records }));

describe("a state that computed its outputs by calling functions", () => {
  it("names every function it ran, and not just the namespace they share", () => {
    const html = draw(CONFIDENCE, RECORDS);
    expect(html).toContain("confidence.score");
    expect(html).toContain("confidence.reasons");
  });

  it("keeps the whole reference on the hover, because where it lives is not what it is called", () => {
    expect(draw(CONFIDENCE, RECORDS)).toContain("confidence.ts#confidence.score");
  });

  it("shows the RESOLVED arguments, so the answer can be checked against what was handed over", () => {
    const html = draw(CONFIDENCE, RECORDS);
    expect(html).toContain("maxSeverityRank");
    expect(html).toContain("thresholdRank");
  });

  it("shows what each call answered", () => {
    const html = draw(CONFIDENCE, RECORDS);
    expect(html).toContain("0.6333333333333333");
    expect(html).toContain("it took more than one pass to converge");
  });

  it("falls back to the state's inputs when it dispatched nothing at all", () => {
    // A genuinely computed state — every output an expression over values it was handed. It keeps
    // the reading it already had rather than gaining an empty heading.
    const html = draw(node({ instanceId: "9", stateId: "verdict", inputs: { score: 0.6 } }), {});
    expect(html).toContain("ss-slot-name");
    expect(html).not.toContain("ss-call");
  });

  it("keeps the calls under a FAILURE, which is where knowing which ones got through matters most", () => {
    const failed = node({
      ...CONFIDENCE,
      status: "failed",
      operation: { kind: "function", status: "failed", reason: "output 'score': no function is registered" },
    });
    const html = draw(failed, RECORDS);
    expect(html).toContain("no function is registered");
    expect(html).toContain("confidence.score");
  });

  it("drops a call whose record has been pruned rather than drawing a row about nothing", () => {
    const html = draw(CONFIDENCE, { score: RECORDS["score"]! });
    expect(html).toContain("confidence.score");
    expect(html).not.toContain("confidence.reasons");
  });
});
