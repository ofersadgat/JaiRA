/**
 * The state form's read/merge contract.
 *
 * This is the code most able to lose someone's work without saying so: the form renders a handful of
 * a state's fields, and every field it does NOT render has to survive a save untouched. A single
 * missing carry-over here silently deletes a workflow's wiring, and the only symptom is a run that
 * stops working later.
 *
 * The round-trip property is the one that matters — read a document into the form, write it back
 * unchanged, and get the same document.
 */
import { describe, expect, it } from "vitest";
import {
  applyForm,
  emptyBindingRow,
  emptyChildRow,
  emptySlotRow,
  formOf,
  type FormModel,
  type SlotRow,
} from "../src/renderer/stateForm";
import { ANY_TYPE, type SlotType } from "@jaira/shared/browser";

/** A state using most of the format at once, including fields the form has never heard of. */
const PLAN = {
  label: "Planning",
  environment: { kind: "prompt", model: "planner" },
  inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } },
  outputs: {
    outcome: { schema: { type: "string" }, binding: { expr: ".children.critique.output.outcome === 'clean'" } },
    plan_doc: { kind: "blob", binding: ".children.context.output.plan_doc" },
  },
  children: {
    goals: { inputs: { issue: ".inputs.issue" } },
    context: { inputs: { goals: ".children.goals.output.goals" } },
    critique: { inputs: { plan_doc: ".children.context.output.plan_doc" }, async: true },
  },
  sequence: ["goals", "context", "critique"],
  transitions: [
    { to: "terminate.success", when: ".children.critique.output.outcome === 'clean'" },
    { to: "goals" },
  ],
  limits: { max_iterations: 3 },
};

const round = (doc: unknown, patch: Partial<FormModel> = {}): Record<string, unknown> =>
  applyForm(doc, { ...formOf(doc), ...patch }) as Record<string, unknown>;

/** Round-trip with a patch to the OPERATION's simple fields — the common case in these tests. */
const roundOp = (
  doc: unknown,
  fields: Record<string, string>,
  patch: Partial<FormModel> = {},
): Record<string, unknown> => {
  const form = formOf(doc);
  return round(doc, {
    ...patch,
    operation: { ...form.operation, fields: { ...form.operation.fields, ...fields } },
  });
};

/** One of the operation's simple fields, as the form reads it. */
const opField = (doc: unknown, name: string): string => formOf(doc).operation.fields[name] ?? "";

describe("formOf", () => {
  it("reads children in RUN order, not declaration order", () => {
    const reordered = { ...PLAN, sequence: ["critique", "goals", "context"] };
    expect(formOf(reordered).children.map((c) => c.key)).toEqual(["critique", "goals", "context"]);
  });

  it("appends a child the sequence forgot rather than dropping it", () => {
    // Such a child still RUNS, so hiding it would misrepresent the workflow.
    const partial = { ...PLAN, sequence: ["critique"] };
    expect(formOf(partial).children.map((c) => c.key)).toEqual(["critique", "goals", "context"]);
  });

  it("marks a structured binding and guard as read-only rather than showing an empty box", () => {
    const form = formOf(PLAN);
    // An empty box invites typing, and typing would replace a computed expression with a literal.
    expect(form.outputs.find((o) => o.name === "outcome")?.structured).toBe(true);
    expect(form.outputs.find((o) => o.name === "plan_doc")?.structured).toBeUndefined();
    expect(form.transitions[1]).toMatchObject({ to: "goals", when: "" });
  });

  it("reads the authored 'function' spelling as well as the loader's 'functionRef'", () => {
    expect(opField({ operation: { kind: "function", function: "claude-cli" } }, "functionRef")).toBe("claude-cli");
    expect(opField({ operation: { kind: "function", functionRef: "codex-cli" } }, "functionRef")).toBe("codex-cli");
  });
});

describe("applyForm", () => {
  it("round-trips a document unchanged", () => {
    // `sequence` is the one deliberate addition, and this document already has it.
    expect(round(PLAN)).toEqual(PLAN);
  });

  it("keeps every field the form does not render", () => {
    const out = round(PLAN, { label: "Renamed" });

    expect(out["label"]).toBe("Renamed");
    expect(out["limits"]).toEqual({ max_iterations: 3 });
    expect(out["environment"]).toEqual({ kind: "prompt", model: "planner" });
    // Child wiring and slot schemas are the substance; the rows show neither.
    expect((out["children"] as Record<string, unknown>)["critique"]).toEqual({
      inputs: { plan_doc: ".children.context.output.plan_doc" },
      async: true,
    });
    expect((out["outputs"] as Record<string, Record<string, unknown>>)["outcome"]!["schema"]).toEqual({ type: "string" });
  });

  it("never writes a structured binding back as a string", () => {
    const out = round(PLAN);
    expect((out["outputs"] as Record<string, Record<string, unknown>>)["outcome"]!["binding"]).toEqual({
      expr: ".children.critique.output.outcome === 'clean'",
    });
  });

  it("reordering children rewrites the sequence and the key order together", () => {
    const form = formOf(PLAN);
    const rotated = [form.children[2]!, form.children[0]!, form.children[1]!];

    const out = round(PLAN, { children: rotated });

    expect(out["sequence"]).toEqual(["critique", "goals", "context"]);
    expect(Object.keys(out["children"] as object)).toEqual(["critique", "goals", "context"]);
    // The move must not cost the child its wiring.
    expect((out["children"] as Record<string, unknown>)["critique"]).toMatchObject({ async: true });
  });

  it("writes an explicit sequence even into a document that had none", () => {
    // Run order is semantics. Left implicit it rests on JSON key order, and every JS engine hoists
    // integer-like keys — `{"2":…,"1":…}` would silently run backwards.
    const noSequence = { children: { b: {}, a: {} } };
    expect(round(noSequence)["sequence"]).toEqual(["b", "a"]);
    // One child needs no ordering statement.
    expect(round({ children: { only: {} } })["sequence"]).toBeUndefined();
  });

  it("drops a half-typed row without disturbing the rows around it", () => {
    const form = formOf(PLAN);
    // What the "+ Add" button produces, before anything is typed into it.
    const withBlank = [...form.inputs, emptySlotRow()];

    const out = round(PLAN, { inputs: withBlank });

    expect(Object.keys(out["inputs"] as object)).toEqual(["issue"]);
    // And the surviving row keeps the schema the row never showed — the blank must not shift the
    // positional carry-over onto the wrong declaration.
    expect((out["inputs"] as Record<string, Record<string, unknown>>)["issue"]!["schema"]).toEqual({
      type: "string",
      contentMediaType: "markdown",
    });
  });

  it("carries a slot's other fields across a rename", () => {
    const form = formOf(PLAN);
    const renamed = form.inputs.map((row) => ({ ...row, name: "ticket" }));

    const out = round(PLAN, { inputs: renamed });

    expect(Object.keys(out["inputs"] as object)).toEqual(["ticket"]);
    expect((out["inputs"] as Record<string, Record<string, unknown>>)["ticket"]!["schema"]).toEqual({
      type: "string",
      contentMediaType: "markdown",
    });
  });

  it("removes a block entirely when its last row goes", () => {
    const out = round(PLAN, { inputs: [], outputs: [], children: [], transitions: [] });

    expect(out["inputs"]).toBeUndefined();
    expect(out["outputs"]).toBeUndefined();
    expect(out["children"]).toBeUndefined();
    expect(out["sequence"]).toBeUndefined();
    expect(out["transitions"]).toBeUndefined();
    // Still not a licence to discard the rest of the document.
    expect(out["limits"]).toEqual({ max_iterations: 3 });
  });

  it("drops the operation block when the kind is cleared", () => {
    const withOp = { operation: { kind: "prompt", prompt: "hi" }, label: "x" };
    expect(round(withOp, { operationKind: "" })["operation"]).toBeUndefined();
  });
});

/**
 * An operation may declare no `kind`, hold its prompt as a reference, or be a reference itself. All
 * three are ordinary documents the form used to read as "no operation" or "no value" — and then act
 * on that reading by deleting the block or writing over the reference.
 */
describe("operations the form does not fully own", () => {
  it("keeps an operation whose kind comes from the environment chain", () => {
    // WORKFLOWS.md §6.1: leaving `function` to the chain is how one state is mounted under two
    // runtimes. Reading this as "no operation" deleted it on the next unrelated edit.
    const inherited = { label: "Review", operation: { function: "claude-code", system: "be brief" } };

    expect(formOf(inherited).operationKind).toBe("inherit");
    expect(round(inherited, { label: "Renamed" })).toEqual({
      label: "Renamed",
      operation: { function: "claude-code", system: "be brief" },
    });
  });

  it("keeps '{}' — the opt-in to a fully inherited operation", () => {
    // The difference between "inherit the whole operation" and "there isn't one" is the whole point
    // of the empty block, so a save must not turn the first into the second.
    expect(round({ label: "x", operation: {} }, { label: "y" })).toEqual({ label: "y", operation: {} });
  });

  it("writes no 'kind' when the operation is inherited", () => {
    const out = roundOp({ operation: {} }, { functionRef: "codex-cli" }, { operationKind: "inherit" });
    expect(out["operation"]).toEqual({ function: "codex-cli" });
  });

  it("still drops an inherited operation when the author picks none", () => {
    // Deleting it is correct here and only here: the author said so.
    expect(round({ operation: { function: "claude-code" } }, { operationKind: "" })["operation"]).toBeUndefined();
  });

  it("reads a referenced prompt as a link, and does not flatten it to a literal", () => {
    const ref = { operation: { kind: "prompt", prompt: { $ref: "$/prompts/critique.md" } } };
    const form = formOf(ref);

    // A plain `{"$ref": …}` on a linkable field is the form's to edit now — but the LITERAL box is
    // still not what holds it, so text arriving through `fields` is not evidence of anything.
    expect(form.operation.refs["prompt"]).toBe("$/prompts/critique.md");
    expect(form.operation.fields["prompt"]).toBe("");
    expect(roundOp(ref, { prompt: "typed over" })).toEqual(ref);
  });

  it("leaves a referenced function alone, including when the kind changes", () => {
    const ref = { operation: { kind: "function", function: { $ref: "$/lib/agent.function" } } };
    expect(formOf(ref).operation.structured["functionRef"]).toBe(true);
    expect(roundOp(ref, { prompt: "hi" }, { operationKind: "prompt" })["operation"]).toMatchObject({
      function: { $ref: "$/lib/agent.function" },
    });
  });

  it("leaves a transcluded operation exactly as written", () => {
    // `"operation": "$/lib/review.operation"` is a reference, not a block to take apart.
    const transcluded = { label: "Review", operation: "$/lib/review.operation" };
    const form = formOf(transcluded);

    expect(form.operationKind).toBe("ref");
    expect(form.operationRef).toBe("$/lib/review.operation");
    expect(roundOp(transcluded, { prompt: "hi" }, { label: "Renamed", operationKind: "ref" })).toEqual({
      label: "Renamed",
      operation: "$/lib/review.operation",
    });
  });

  it("retargets a transcluded operation", () => {
    // An `operation` sits in an OBJECT position, so the reference is the bare string — no
    // `{"$ref": …}` wrapper, which is what makes this a different control from the prompt's.
    const transcluded = { operation: "$/lib/review.operation" };
    expect(round(transcluded, { operationRef: "$/lib/critique.operation" })).toEqual({
      operation: "$/lib/critique.operation",
    });
  });

  it("replaces a block with a link once a target is named", () => {
    const block = { operation: { kind: "prompt", prompt: "Review it." } };
    expect(round(block, { operationKind: "ref", operationRef: "$/lib/review.operation" })).toEqual({
      operation: "$/lib/review.operation",
    });
  });

  it("leaves the block alone while the link box is still empty", () => {
    // Moving the control to Link and not yet saying what to is not a decision to delete an
    // operation. A dropdown change must not cost a block.
    const block = { operation: { kind: "prompt", prompt: "Review it." } };
    expect(round(block, { operationKind: "ref", operationRef: "" })).toEqual(block);
  });

  it("drops the operation when a link is emptied", () => {
    // Emptying a box that HELD a reference is a decision, unlike the case above.
    expect(round({ operation: "$/lib/review.operation" }, { operationRef: "" })["operation"]).toBeUndefined();
  });

  it("clears a field the author emptied, but only a string one", () => {
    const withOp = { operation: { kind: "function", function: "claude-code", model: "sonnet" } };
    expect(roundOp(withOp, { functionRef: "", model: "" })["operation"]).toEqual({ kind: "function" });
  });
});

/**
 * A slot's type is its `schema`. `kind` is the engine's transport tag and is DERIVED from the schema
 * by `kindFor`, so the form writes schemas and lets the loader work the tag out — except where doing
 * so would rewrite a file nobody asked it to touch.
 */
describe("slot types", () => {
  const typeOf = (doc: unknown, slot: string): SlotType | null =>
    formOf(doc).inputs.find((row) => row.name === slot)?.type ?? null;

  const withType = (doc: unknown, type: SlotType): Record<string, unknown> =>
    round(doc, { inputs: formOf(doc).inputs.map((row) => ({ ...row, type })) });

  it("reads a schema as its type", () => {
    expect(typeOf({ inputs: { issue: { schema: { type: "string" } } } }, "issue")).toEqual({
      name: "text",
      list: false,
    });
    expect(typeOf({ inputs: { tags: { schema: { type: "array", items: { type: "string" } } } } }, "tags")).toEqual({
      name: "text",
      list: true,
    });
  });

  it("writes a schema and lets the loader derive the kind", () => {
    const out = withType({ inputs: { issue: {} } }, { name: "url", list: false });
    // No `kind`: `kindFor` reads this as `text`, and saying so again is a second place to be wrong.
    expect((out["inputs"] as Record<string, unknown>)["issue"]).toEqual({
      schema: { type: "string", "x-type": "Url" },
    });
  });

  it("drops a now-wrong kind when the type changes", () => {
    // `kind: "blob"` beside a fresh `{"type":"string"}` is not a leftover, it is a contradiction —
    // and the engine gates artifact registration on the kind, so leaving it would misroute the value.
    const artifact = { inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } } };
    const out = withType(artifact, { name: "text", list: false });

    expect((out["inputs"] as Record<string, unknown>)["issue"]).toEqual({ schema: { type: "string" } });
  });

  it("leaves an authored kind alone when the type is untouched", () => {
    // The form is not a formatter. A file that spells out a derivable `kind` is not wrong, and
    // "correcting" it on an unrelated edit would put noise in every diff.
    const artifact = { inputs: { issue: { kind: "blob", schema: { type: "string", contentMediaType: "markdown" } } } };
    expect(round(artifact)).toEqual(artifact);
  });

  it("declares an artifact by its media type, which is what makes it a blob", () => {
    const out = withType({ inputs: { doc: {} } }, { name: "artifact", list: false, mediaType: "image/png" });
    expect((out["inputs"] as Record<string, unknown>)["doc"]).toEqual({
      schema: { type: "string", contentMediaType: "image/png" },
    });
  });

  it("removes the schema when a slot goes back to unconstrained", () => {
    const out = withType({ inputs: { issue: { schema: { type: "string" }, optional: true } } }, ANY_TYPE);
    expect((out["inputs"] as Record<string, unknown>)["issue"]).toEqual({ optional: true });
  });

  it("shows a schema richer than the vocabulary read-only, and never writes over it", () => {
    const rich = { inputs: { plan: { schema: { type: "object", properties: { a: { type: "string" } } } } } };
    const row = formOf(rich).inputs[0]!;

    expect(row.type).toBeNull();
    expect(row.schemaText).toBe(JSON.stringify({ type: "object", properties: { a: { type: "string" } } }));
    // Editing anything else on the row must leave the schema exactly where it was.
    expect(round(rich, { inputs: [{ ...row, optional: true }] })).toEqual({
      inputs: { plan: { schema: { type: "object", properties: { a: { type: "string" } } }, optional: true } },
    });
  });

  /**
   * A LINKED type: `"schema": "$/types/markdown"`.
   *
   * A schema sits in an object position, so its reference is the bare string — which read as
   * "richer than the vocabulary" and left a shared type library unauthorable from the form, in a
   * format whose own examples use one.
   */
  describe("linked", () => {
    const LINKED = { inputs: { plan: { schema: "$/types/markdown" } } };
    const rowOf = (doc: unknown) => formOf(doc).inputs[0]!;
    const withRow = (doc: unknown, row: SlotRow): Record<string, unknown> => round(doc, { inputs: [row] });

    it("reads the bare string as a link rather than as an unshowable schema", () => {
      const row = rowOf(LINKED);
      expect(row.typeRef).toBe("$/types/markdown");
      // Not `null`: the picker is replaced by the link box, so there is no read-only summary to show.
      expect(row.type).toEqual(ANY_TYPE);
    });

    it("round-trips a link untouched", () => {
      expect(round(LINKED)).toEqual(LINKED);
    });

    it("retargets a link", () => {
      expect(withRow(LINKED, { ...rowOf(LINKED), typeRef: "$/types/plan" })).toEqual({
        inputs: { plan: { schema: "$/types/plan" } },
      });
    });

    it("links a slot that had a vocabulary type, and drops the derivable kind with it", () => {
      const artifact = { inputs: { plan: { kind: "blob", schema: { type: "string", contentMediaType: "text/markdown" } } } };
      const out = withRow(artifact, { ...rowOf(artifact), typeRef: "$/types/markdown" });
      // The referenced document decides the schema, so a `kind` derived from the old one is a lie.
      expect((out["inputs"] as Record<string, unknown>)["plan"]).toEqual({ schema: "$/types/markdown" });
    });

    it("removes the schema on unlinking", () => {
      const { typeRef: _dropped, ...unlinked } = rowOf(LINKED);
      expect(withRow(LINKED, unlinked)["inputs"]).toEqual({ plan: {} });
    });

    it("leaves the previous schema alone while the link box is still empty", () => {
      const typed = { inputs: { plan: { schema: { type: "string" } } } };
      expect(withRow(typed, { ...rowOf(typed), typeRef: "  " })).toEqual(typed);
    });

    /**
     * A LIST of a named type — `{"type": "array", "items": "$/types/plan"}`.
     *
     * `items` is one of the keywords the loader's expander recurses into, so a bare-string
     * reference there is ours exactly as it is at the top of a `schema`. The picker could say "a
     * list of text" and could not say "a list of `$/types/plan`", which made the shared type
     * library the one vocabulary the list toggle did not apply to.
     */
    const LINKED_LIST = { inputs: { plan: { schema: { type: "array", items: "$/types/markdown" } } } };

    it("reads an array of a reference as a linked type that is a list", () => {
      const row = formOf(LINKED_LIST).inputs[0]!;
      expect(row.typeRef).toBe("$/types/markdown");
      expect(row.type).toEqual({ name: "any", list: true });
    });

    it("round-trips a list of a named type untouched", () => {
      expect(round(LINKED_LIST)).toEqual(LINKED_LIST);
    });

    it("wraps and unwraps a link as the list toggle moves", () => {
      const row = rowOf(LINKED);
      expect(withRow(LINKED, { ...row, type: { name: "any", list: true } })).toEqual(LINKED_LIST);

      const listed = formOf(LINKED_LIST).inputs[0]!;
      expect(withRow(LINKED_LIST, { ...listed, type: { name: "any", list: false } })).toEqual(LINKED);
    });

    it("does not read an array of an INLINE schema as a link", () => {
      // `items` is a schema, not a reference — the vocabulary picker owns this one.
      const inline = { inputs: { tags: { schema: { type: "array", items: { type: "string" } } } } };
      const row = formOf(inline).inputs[0]!;

      expect(row.typeRef).toBeUndefined();
      expect(row.type).toEqual({ name: "text", list: true });
    });

    it("does not mistake JSON Schema's own $ref for a link", () => {
      // Inside a schema the key is JSON Schema's, never ours (WORKFLOWS.md §2.2). Reading it as a
      // link would rewrite a `#/$defs/plan` pointer as a bare string and retype the slot.
      const jsonSchemaRef = { inputs: { plan: { schema: { $ref: "#/$defs/plan" } } } };
      const row = rowOf(jsonSchemaRef);

      expect(row.typeRef).toBeUndefined();
      expect(row.type).toBeNull();
      expect(round(jsonSchemaRef)).toEqual(jsonSchemaRef);
    });
  });

  it("keeps a slot's default and description across a type change", () => {
    const slot = { inputs: { depth: { schema: { type: "string" }, default: "3", description: "how deep" } } };
    const out = withType(slot, { name: "integer", list: false });

    expect((out["inputs"] as Record<string, unknown>)["depth"]).toEqual({
      schema: { type: "integer" },
      default: "3",
      description: "how deep",
    });
  });

  it("gives a new row no schema until someone picks one", () => {
    const out = round({}, { inputs: [{ ...emptySlotRow(), name: "issue" }] });
    expect((out["inputs"] as Record<string, unknown>)["issue"]).toEqual({});
  });
});

/** The state-level fields the form reached last: the note, the guards, and the defaults layer. */
describe("state-level fields", () => {
  it("round-trips a description", () => {
    const doc = { label: "Plan", description: "what this state is for" };
    expect(round(doc)).toEqual(doc);
    expect(formOf(doc).description).toBe("what this state is for");
  });

  it("round-trips both limits and removes the block once neither is set", () => {
    const doc = { limits: { max_iterations: 3, timeout: 600 } };
    expect(round(doc)).toEqual(doc);
    expect(round(doc, { limits: { maxIterations: "", timeout: "" } })["limits"]).toBeUndefined();
  });

  it("writes limits as numbers", () => {
    expect(round({}, { limits: { maxIterations: "5", timeout: "30" } })["limits"]).toEqual({
      max_iterations: 5,
      timeout: 30,
    });
  });

  it("tells 'no environment' apart from 'an empty one'", () => {
    // Only a state that declares an operation gets one, so an absent block is a real statement.
    expect(formOf({}).environment).toBeNull();
    expect(formOf({ environment: {} })).toMatchObject({ environment: {} });
    expect(round({ environment: { kind: "prompt" } }, { environment: null })["environment"]).toBeUndefined();
  });

  it("edits the environment through the same controls as the operation", () => {
    const doc = { environment: { kind: "prompt", model: "planner" } };
    const form = formOf(doc);
    const out = round(doc, {
      environment: { ...form.environment!, fields: { ...form.environment!.fields, model: "critic" } },
    });
    expect(out["environment"]).toEqual({ kind: "prompt", model: "critic" });
  });

  it("reads the environment's own kind, which nothing used to carry", () => {
    // The whole of the bug: a block spelling `{"kind": "prompt", "model": …}` rendered the model and
    // no sign of the kind. It survived a save, because the fields merge over what was there — so it
    // was a kind you could see the effects of and never the value.
    expect(formOf({ environment: { kind: "prompt", model: "claude-sonnet-5" } }).environmentKind).toBe("prompt");
    expect(formOf({ environment: { session: "review" } }).environmentKind).toBe("");
    expect(formOf({}).environmentKind).toBe("");
  });

  it("writes the environment's kind, and writes none for 'inherited'", () => {
    const doc = { environment: { kind: "prompt", model: "claude-sonnet-5" } };
    expect(round(doc, { environmentKind: "function" })["environment"]).toEqual({
      kind: "function",
      model: "claude-sonnet-5",
    });
    // Blank states none — an environment that settles no kind is what a pure composite supplying
    // only a session wants, and it must stay expressible.
    expect(round(doc, { environmentKind: "" })["environment"]).toEqual({ model: "claude-sonnet-5" });
  });

  it("drops an environment whose last field AND kind are gone", () => {
    const doc = { environment: { kind: "prompt" } };
    const form = formOf(doc);
    expect(round(doc, { environment: form.environment!, environmentKind: "" })["environment"]).toBeUndefined();
  });

  it("keeps an environment on a state with no operation of its own", () => {
    // Declaring a session on a pure composite is the ordinary way to give a whole subtree one
    // conversation, and the engine reads it there specifically.
    const composite = { environment: { session: "review" }, children: { a: {} } };
    expect(round(composite)["environment"]).toEqual({ session: "review" });
  });
});

/** Slot fields beyond a name and a type — including the one that silences a reachability error. */
describe("slot defaults, descriptions and spreads", () => {
  const inputRow = (doc: unknown, name: string) => formOf(doc).inputs.find((row) => row.name === name)!;

  it("round-trips a default and a description", () => {
    const doc = { inputs: { depth: { schema: { type: "integer" }, default: 3, description: "how deep" } } };
    expect(round(doc)).toEqual(doc);

    const row = inputRow(doc, "depth");
    expect(row.default).toBe("3");
    expect(row.description).toBe("how deep");
  });

  it("keeps a string default a string", () => {
    // The trap: a default of "3" shown bare would read back as the number 3 and retype the slot.
    const doc = { inputs: { depth: { default: "3" } } };
    expect(inputRow(doc, "depth").default).toBe('"3"');
    expect(round(doc)).toEqual(doc);
  });

  it("takes a plain word as a default without quoting ceremony", () => {
    const out = round(
      { inputs: { mode: {} } },
      { inputs: [{ ...emptySlotRow(), name: "mode", default: "significant" }] },
    );
    expect((out["inputs"] as Record<string, unknown>)["mode"]).toEqual({ default: "significant" });
  });

  it("removes a default the author cleared", () => {
    const doc = { inputs: { depth: { default: 3, optional: true } } };
    const out = round(doc, { inputs: formOf(doc).inputs.map((row) => ({ ...row, default: "" })) });
    expect((out["inputs"] as Record<string, unknown>)["depth"]).toEqual({ optional: true });
  });

  it("marks a spread and offers it no type of its own", () => {
    // §3.5: `ctx_*` declares N slots, each keeping the CHILD's schema. There is no one schema here.
    const doc = { outputs: { "ctx_*": { binding: ".children.context.output" } } };
    const row = formOf(doc).outputs[0]!;

    expect(row.spread).toBe(true);
    expect(round(doc)).toEqual(doc);
  });

  it("does not write a schema onto a spread", () => {
    const doc = { outputs: { "ctx_*": { binding: ".children.context.output" } } };
    const out = round(doc, {
      outputs: formOf(doc).outputs.map((row) => ({ ...row, type: { name: "text" as const, list: false } })),
    });
    expect((out["outputs"] as Record<string, unknown>)["ctx_*"]).toEqual({
      binding: ".children.context.output",
    });
  });
});

/** A child's wiring is the substance of its declaration — and was the last thing only JSON could say. */
describe("child wiring", () => {
  const WIRED = {
    children: {
      critique: {
        state: "./critique",
        inputs: { plan_doc: ".children.context.output.plan_doc", depth: { json: 3 } },
        environment: { kind: "function", function: "claude-code", tools: ["read_file"] },
      },
    },
  };

  it("reads a child's inputs as rows, marking the structured ones", () => {
    const child = formOf(WIRED).children[0]!;

    expect(child.inputs.map((row) => row.name)).toEqual(["plan_doc", "depth"]);
    expect(child.inputs[0]).toMatchObject({ value: ".children.context.output.plan_doc" });
    expect(child.inputs[1]!.structured).toBe(true);
  });

  it("round-trips a wired child unchanged", () => {
    expect(round(WIRED)).toEqual(WIRED);
  });

  it("adds a wire", () => {
    const form = formOf(WIRED);
    const child = form.children[0]!;
    const out = round(WIRED, {
      children: [{ ...child, inputs: [...child.inputs, { name: "issue", value: ".inputs.issue" }] }],
    });

    expect((out["children"] as Record<string, Record<string, unknown>>)["critique"]!["inputs"]).toEqual({
      plan_doc: ".children.context.output.plan_doc",
      depth: { json: 3 },
      issue: ".inputs.issue",
    });
  });

  it("keeps a structured binding across a rename of the slot it fills", () => {
    const form = formOf(WIRED);
    const child = form.children[0]!;
    const renamed = child.inputs.map((row) => (row.name === "depth" ? { ...row, name: "levels" } : row));
    const out = round(WIRED, { children: [{ ...child, inputs: renamed }] });

    expect((out["children"] as Record<string, Record<string, unknown>>)["critique"]!["inputs"]).toEqual({
      plan_doc: ".children.context.output.plan_doc",
      levels: { json: 3 },
    });
  });

  it("drops a half-typed wire without disturbing the others", () => {
    const form = formOf(WIRED);
    const child = form.children[0]!;
    const out = round(WIRED, { children: [{ ...child, inputs: [...child.inputs, emptyBindingRow()] }] });

    expect(Object.keys((out["children"] as Record<string, Record<string, unknown>>)["critique"]!["inputs"] as object))
      .toEqual(["plan_doc", "depth"]);
  });

  it("edits a per-mount environment while keeping what it does not render", () => {
    // §6.1: this layer exists so one state can be mounted under two runtimes. `tools` is not on the
    // three controls, and putting policy somewhere the form only partly shows must still be safe.
    const form = formOf(WIRED);
    const child = form.children[0]!;
    const out = round(WIRED, {
      children: [{ ...child, environment: { ...child.environment, functionRef: "codex-cli" } }],
    });

    expect((out["children"] as Record<string, Record<string, unknown>>)["critique"]!["environment"]).toEqual({
      kind: "function",
      function: "codex-cli",
      tools: ["read_file"],
    });
  });

  it("removes an environment emptied of everything the form can see", () => {
    const bare = { children: { critique: { environment: { kind: "function", function: "claude-code" } } } };
    const child = formOf(bare).children[0]!;
    const out = round(bare, {
      children: [{ ...child, environment: { kind: "", functionRef: "", model: "" } }],
    });

    expect((out["children"] as Record<string, unknown>)["critique"]).toEqual({});
  });

  it("keeps a child out of the spine that the document left out of it", () => {
    // The engine advances the cursor through `sequence` and nothing else, so a child omitted from it
    // is a jump target rather than a step. Writing every child back into `sequence` — which is what
    // this used to do — silently promoted it to a step.
    const jumpTarget = { children: { plan: {}, retry: {} }, sequence: ["plan"] };
    const form = formOf(jumpTarget);

    expect(form.children.map((c) => [c.key, c.inSpine])).toEqual([
      ["plan", true],
      ["retry", false],
    ]);
    expect(round(jumpTarget)).toEqual(jumpTarget);
  });

  it("writes an empty sequence rather than omitting it when nothing is a step", () => {
    // Absent means "all of them, in declaration order" — the opposite claim, so `[]` has to be said.
    const doc = { children: { a: {}, b: {} }, sequence: [] };
    expect(formOf(doc).children.every((c) => !c.inSpine)).toBe(true);
    expect(round(doc)["sequence"]).toEqual([]);
  });

  it("treats every child as a step when the document names no sequence", () => {
    const form = formOf({ children: { a: {}, b: {} } });
    expect(form.children.every((c) => c.inSpine)).toBe(true);
  });

  it("gives a new child no wiring until someone adds some", () => {
    const out = round({}, { children: [{ ...emptyChildRow(), key: "goals" }] });
    expect((out["children"] as Record<string, unknown>)["goals"]).toEqual({});
  });
});

/**
 * `model` sits FLAT on the operation — "the operation IS the call" (REFERENCES.md §7.2). hw hoists
 * every field it does not own into the call config, so the nested spelling this form used to write
 * reached the provider as `config.model` and the state silently ran on the default model.
 */
describe("model", () => {
  it("writes model as a flat operation field", () => {
    const out = roundOp({ operation: { kind: "prompt", prompt: "hi" } }, { model: "anthropic/claude-sonnet-5" });
    expect(out["operation"]).toEqual({ kind: "prompt", prompt: "hi", model: "anthropic/claude-sonnet-5" });
  });

  it("round-trips a correctly authored model without moving it", () => {
    const flat = { operation: { kind: "prompt", prompt: "hi", model: "planner" } };
    expect(opField(flat, "model")).toBe("planner");
    expect(round(flat)).toEqual(flat);
  });

  it("migrates the nested spelling an earlier form wrote", () => {
    const nested = { operation: { kind: "prompt", prompt: "hi", config: { model: "planner" } } };

    expect(opField(nested, "model")).toBe("planner");
    // Left in place the stale copy would also shadow the flat field on the next read.
    expect(round(nested)["operation"]).toEqual({ kind: "prompt", prompt: "hi", model: "planner" });
  });

  it("keeps the rest of a config block while migrating", () => {
    const nested = { operation: { kind: "prompt", config: { model: "planner", seed: 7 } } };
    expect(round(nested)["operation"]).toEqual({ kind: "prompt", model: "planner", config: { seed: 7 } });
  });
});
