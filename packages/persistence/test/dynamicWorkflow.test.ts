/**
 * The dynamic workflow generator, pure half (decision 0005 §3, step 4) — see `dynamicWorkflow.ts`.
 *
 * Everything here is decided from SCHEMAS: the slot names below are deliberately unhelpful (`a`,
 * `b`, `p`, `q`), because the platform never names a workflow's input and a generator that passed
 * these tests by reading names would be the bug the decision forbids.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/exec";
import {
  generateDynamicWorkflow,
  isStandingMoveRule,
  standingMoveRule,
  wireExpression,
  type AuthoredState,
  type Producer,
  type StateSurface,
} from "../src/dynamicWorkflow";

const STRING: JsonValue = { type: "string" };
const NUMBER: JsonValue = { type: "number" };
const FEATURE: JsonValue = { type: "object", properties: { id: { type: "string" }, story: { type: "string" } }, required: ["id"] };
const FEATURES: JsonValue = { type: "array", items: FEATURE };

const CONVERSATION: AuthoredState = {
  label: "Stand-in conversation",
  outputs: { said: { schema: STRING, binding: ".operation.output.said" } },
  operation: { kind: "prompt", prompt: "talk", model: "anthropic/claude-sonnet-5", output: { said: { schema: STRING } } },
};

const surface = (id: string, inputs: Record<string, JsonValue>, outputs: Record<string, JsonValue>, optional: string[] = []): StateSurface => ({
  id,
  inputs: Object.fromEntries(Object.entries(inputs).map(([name, schema]) => [name, { schema, ...(optional.includes(name) ? { optional: true } : {}) }])),
  outputs: Object.fromEntries(Object.entries(outputs).map(([name, schema]) => [name, { schema }])),
});

const product: Producer = {
  key: "product",
  state: surface("lib/product", { a: STRING }, { p: STRING, q: FEATURES }),
  inputs: { a: "an idea" },
  outputs: { p: "a brief", q: [{ id: "f1" }, { id: "f2" }] },
  taskId: "t-1",
};

const rulesOf = (document: AuthoredState): AuthoredState[] => document["transitions"] as AuthoredState[];
const mountsOf = (document: AuthoredState): Record<string, AuthoredState> => document["children"] as Record<string, AuthoredState>;

describe("a new document", () => {
  it("is the conversation state with children: what ran, mounted with what it ran with, and the target wired by schema fit", () => {
    const result = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [product], target: surface("lib/write", { b: STRING }, { r: STRING }) });
    expect(result.ok).toBe(true);
    const document = result.document!;
    // The root is a state with an OPERATION and CHILDREN, and nothing on a spine.
    expect(document["operation"]).toEqual(CONVERSATION["operation"]);
    expect(document["sequence"]).toEqual([]);
    expect(Object.keys(mountsOf(document))).toEqual(["product", "write"]);
    expect(mountsOf(document)["product"]).toEqual({ state: "lib/product", inputs: { a: { json: "an idea", provenance: { via: "recorded", by: "t-1" } } } });
    expect(mountsOf(document)["write"]).toEqual({ state: "lib/write", inputs: { b: ".children.product.output.p" } });
    expect(result.wires).toEqual([{ input: "b", from: { child: "product", output: "p" } }]);
    expect(result.mount).toBe("plain");
  });

  it("writes every rule as a standing task_move, and nothing else", () => {
    const result = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [product], target: surface("lib/write", { b: STRING }, {}) });
    expect(rulesOf(result.document!)).toEqual([
      { when: "on_user_event('task_move', { to_state: 'product' })", to: "product", standing: true },
      { when: "on_user_event('task_move', { to_state: 'write' })", to: "write", standing: true },
    ]);
    expect(rulesOf(result.document!).every((rule) => isStandingMoveRule(rule))).toBe(true);
    expect(standingMoveRule("it's")).toEqual({ when: "on_user_event('task_move', { to_state: 'it\\'s' })", to: "it's", standing: true });
  });
});

describe("one output, many inputs", () => {
  it("splits over a list when the target takes ONE element — held, nothing confirmed", () => {
    const result = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [product], target: surface("lib/ux", { b: FEATURE }, {}) });
    expect(result.mount).toBe("split");
    expect(mountsOf(result.document!)["ux"]).toEqual({
      state: "lib/ux",
      inputs: { b: { $expr: ".children.product.output.q", each: "split", start: "manual" } },
    });
    expect(result.wires).toEqual([{ input: "b", from: { child: "product", output: "q" }, each: "split" }]);
  });

  it("mounts a target that takes the LIST plainly — a join. Arity decides, not a name", () => {
    const result = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [product], target: surface("lib/plan", { b: FEATURES }, {}) });
    expect(result.mount).toBe("plain");
    expect(mountsOf(result.document!)["plan"]).toEqual({ state: "lib/plan", inputs: { b: ".children.product.output.q" } });
  });

  it("splits one mount on one list: an element of a SECOND list is returned, not wired", () => {
    const two: Producer = { key: "two", state: surface("lib/two", {}, { q: FEATURES, n: { type: "array", items: NUMBER } }) };
    const result = generateDynamicWorkflow({ base: { kind: "clone", children: ["two"], offered: [] }, producers: [two], target: surface("lib/t", { b: FEATURE, c: NUMBER }, {}) });
    expect(result.ok).toBe(false);
    expect(result.unsettled.map((u) => [u.input, u.reason])).toEqual([["c", "second-list"]]);
  });
});

describe("what it cannot settle", () => {
  it("is RETURNED with its schema, and nothing is generated while a required input is open", () => {
    const result = generateDynamicWorkflow({
      base: { kind: "new", conversation: CONVERSATION },
      producers: [product],
      target: { id: "lib/cost", inputs: { b: { schema: STRING }, c: { schema: NUMBER, description: "what it may spend" } }, outputs: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.document).toBeUndefined();
    expect(result.additions).toEqual({ children: {}, transitions: [] });
    expect(result.unsettled).toEqual([{ input: "c", schema: NUMBER, description: "what it may spend", required: true, reason: "no-fit" }]);
  });

  it("stores a supplied value as a literal with its provenance, and it wins over a wire", () => {
    const result = generateDynamicWorkflow({
      base: { kind: "new", conversation: CONVERSATION },
      producers: [product],
      target: surface("lib/cost", { b: STRING, c: NUMBER }, {}),
      supplied: { c: { value: 40, provenance: { via: "asked", by: "person" } }, b: { value: "mine", provenance: { via: "inferred", by: "control" } } },
    });
    expect(result.ok).toBe(true);
    expect(mountsOf(result.document!)["cost"]!["inputs"]).toEqual({
      b: { json: "mine", provenance: { via: "inferred", by: "control" } },
      c: { json: 40, provenance: { via: "asked", by: "person" } },
    });
    expect(result.wires).toEqual([]);
  });

  it("does not guess between two outputs that fit equally: the candidates are returned", () => {
    const twin: Producer = { key: "twin", state: surface("lib/twin", {}, { p: STRING, q: STRING }) };
    const result = generateDynamicWorkflow({ base: { kind: "clone", children: ["twin"], offered: [] }, producers: [twin], target: surface("lib/t", { b: STRING }, {}) });
    expect(result.ok).toBe(false);
    expect(result.unsettled[0]).toMatchObject({
      input: "b",
      reason: "ambiguous",
      candidates: [
        { child: "twin", output: "p", element: false },
        { child: "twin", output: "q", element: false },
      ],
    });
  });

  it("takes the one output that fits BOTH ways over one that is merely acceptable", () => {
    const loose: Producer = { key: "loose", state: surface("lib/loose", {}, { p: { type: "string", enum: ["x"] }, q: { type: ["string", "null"] } }) };
    // `q` does not fit a string slot at all; `p` fits one way (an enum is a string). A slot of the enum's own type fits both.
    const narrow = generateDynamicWorkflow({ base: { kind: "clone", children: ["loose"], offered: [] }, producers: [loose], target: surface("lib/t", { b: { type: "string", enum: ["x"] } }, {}) });
    expect(narrow.wires).toEqual([{ input: "b", from: { child: "loose", output: "p" } }]);
  });

  it("prefers the NEAREST producer — where the task stands — over an earlier one that also fits", () => {
    const earlier: Producer = { key: "earlier", state: surface("lib/e", {}, { p: STRING }) };
    const nearest: Producer = { key: "nearest", state: surface("lib/n", {}, { p: STRING }) };
    const result = generateDynamicWorkflow({ base: { kind: "clone", children: ["earlier", "nearest"], offered: [] }, producers: [nearest, earlier], target: surface("lib/t", { b: STRING }, {}) });
    expect(result.wires).toEqual([{ input: "b", from: { child: "nearest", output: "p" } }]);
  });

  it("never wires an output the producer did not record, and leaves an optional input open without blocking", () => {
    const partial: Producer = { ...product, outputs: { q: [] } };
    const result = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [partial], target: surface("lib/t", { b: STRING }, {}, ["b"]) });
    expect(result.ok).toBe(true);
    expect(mountsOf(result.document!)["t"]).toEqual({ state: "lib/t" });
    expect(result.unsettled).toEqual([{ input: "b", schema: STRING, required: false, reason: "no-fit" }]);
  });
});

describe("augmenting", () => {
  const first = generateDynamicWorkflow({ base: { kind: "new", conversation: CONVERSATION }, producers: [product], target: surface("lib/ux", { b: FEATURE }, { d: STRING }) }).document!;

  it("appends after what is there and rewrites none of it", () => {
    const ux: Producer = { key: "ux", state: surface("lib/ux", { b: FEATURE }, { d: STRING }) };
    const next = generateDynamicWorkflow({ base: { kind: "dynamic", document: first }, producers: [ux, product], target: surface("lib/ui", { b: STRING }, {}) });
    expect(next.ok).toBe(true);
    const document = next.document!;
    expect(Object.keys(mountsOf(document))).toEqual(["product", "ux", "ui"]);
    for (const key of ["product", "ux"]) expect(mountsOf(document)[key]).toEqual(mountsOf(first)[key]);
    expect(rulesOf(document).slice(0, 2)).toEqual(rulesOf(first));
    // Nearest first: `ux`'s string, not `product`'s.
    expect(mountsOf(document)["ui"]).toEqual({ state: "lib/ui", inputs: { b: ".children.ux.output.d" } });
    expect(next.additions).toEqual({ children: { ui: mountsOf(document)["ui"] }, transitions: [rulesOf(document)[2]] });
    expect(document["operation"]).toEqual(first["operation"]);
  });

  it("writes nothing for a target the document already mounts and offers", () => {
    const again = generateDynamicWorkflow({ base: { kind: "dynamic", document: first }, producers: [product], target: surface("lib/ux", { b: FEATURE }, {}) });
    expect(again).toMatchObject({ ok: true, existing: true, targetKey: "ux", additions: { children: {}, transitions: [] } });
    expect(again.document).toBe(first);
  });

  it("mounts the same state a second time under a key of its own when asked for one, and never reuses a key", () => {
    const again = generateDynamicWorkflow({ base: { kind: "dynamic", document: first }, producers: [product], target: surface("lib/ux", { b: FEATURE }, {}), targetKey: "ux" });
    expect(again.targetKey).toBe("ux_2");
    expect(Object.keys(mountsOf(again.document!))).toEqual(["product", "ux", "ux_2"]);
  });
});

describe("a clone", () => {
  it("yields the additions alone — the frozen root is not an authored document", () => {
    const result = generateDynamicWorkflow({ base: { kind: "clone", children: ["product", "review"], offered: [] }, producers: [product], target: surface("other/ship", { b: STRING }, {}) });
    expect(result.ok).toBe(true);
    expect(result.document).toBeUndefined();
    expect(result.additions).toEqual({
      children: { ship: { state: "other/ship", inputs: { b: ".children.product.output.p" } } },
      transitions: [{ when: "on_user_event('task_move', { to_state: 'ship' })", to: "ship", standing: true }],
    });
  });

  it("keeps a key the workflow already uses", () => {
    const result = generateDynamicWorkflow({ base: { kind: "clone", children: ["review"], offered: [] }, producers: [], target: surface("other/review", {}, {}) });
    expect(result.targetKey).toBe("review_2");
  });
});

describe("spelling", () => {
  it("quotes a key the identifier grammar cannot spell", () => {
    expect(wireExpression("plan", "new_items")).toBe(".children.plan.output.new_items");
    expect(wireExpression("claude-review", "the report")).toBe('.children."claude-review".output."the report"');
  });
});
