/**
 * One `operation`/`environment` block, in and out.
 *
 * Both blocks are written in the same shape, so this covers both. The property under test throughout
 * is the merge: a field the form does not model has to come out the far side untouched. hw passes an
 * unrecognized field straight to the call config ("the operation IS the call"), so dropping one
 * silently changes what the model is asked to do — and a knob invented after this file was written
 * still has to reach the provider.
 */
import { describe, expect, it } from "vitest";
import {
  applyOperationFields,
  EMPTY_OPERATION_FIELDS,
  operationFieldsOf,
  type OperationFieldsForm,
} from "../src/renderer/operationForm";

const round = (block: unknown, patch: Partial<OperationFieldsForm> = {}): Record<string, unknown> =>
  applyOperationFields(block, { ...operationFieldsOf(block), ...patch });

/** Patch one or more of the JSON-valued fields. */
const withJson = (block: unknown, json: Record<string, string>): Record<string, unknown> => {
  const form = operationFieldsOf(block);
  return applyOperationFields(block, { ...form, json: { ...form.json, ...json } });
};

/** Patch one or more of the simple text fields. */
const withFields = (block: unknown, fields: Record<string, string>): Record<string, unknown> => {
  const form = operationFieldsOf(block);
  return applyOperationFields(block, { ...form, fields: { ...form.fields, ...fields } });
};

/** A block using most of the surface at once, including keys this model does not render. */
const FULL = {
  kind: "prompt",
  prompt: "Review {{.inputs.plan}}",
  system: "Be terse.",
  model: "anthropic/claude-sonnet-5",
  temperature: 0.2,
  maxOutputTokens: 16000,
  stopSequences: ["</done>"],
  reasoning: { effort: "high", budgetTokens: 4000 },
  tools: ["read_file", "run_command"],
  session: "review",
  fork: true,
  conversation: { mode: "selected_artifacts", artifacts: ["plan_doc"] },
  permissions: { profile: "read-only", default: "ask", tools: { run_command: "deny" } },
  input: { plan: { schema: { type: "string" }, binding: ".inputs.plan" } },
  output: { report: { schema: { type: "string", contentMediaType: "text/markdown" } } },
  path: ["./ops", "$INHERITED"],
  providerOptions: { anthropic: { cacheControl: true } },
  // Genuinely not modelled — a knob hw itself does not know, which still has to reach the provider.
  responseFormat: { type: "json_object" },
};

describe("the merge", () => {
  it("round-trips a full block unchanged", () => {
    expect(round(FULL)).toEqual(FULL);
  });

  it("keeps the keys it does not model", () => {
    const out = withFields(FULL, { model: "openai/gpt-5" });

    expect(out["responseFormat"]).toEqual({ type: "json_object" });
    expect(out["path"]).toEqual(["./ops", "$INHERITED"]);
    expect(out["providerOptions"]).toEqual({ anthropic: { cacheControl: true } });
    expect(out["model"]).toBe("openai/gpt-5");
  });

  it("reads an absent block as saying nothing", () => {
    expect(applyOperationFields(undefined, EMPTY_OPERATION_FIELDS)).toEqual({});
  });
});

describe("simple fields", () => {
  it("writes numbers as numbers, not as the text that was typed", () => {
    const out = withFields({}, { temperature: "0.7", maxOutputTokens: "8000" });
    expect(out).toEqual({ temperature: 0.7, maxOutputTokens: 8000 });
  });

  it("leaves a half-typed number alone rather than writing NaN", () => {
    // The moment mid-way through typing `-1` where the box holds only `-`. NaN serializes as `null`,
    // which would reach the provider as an explicit null rather than as "not set".
    expect(withFields({ temperature: 0.2 }, { temperature: "-" })["temperature"]).toBe(0.2);
    expect(withFields({ seed: 7 }, { seed: "1e" })["seed"]).toBe(7);
  });

  it("clears a field the author emptied", () => {
    expect(withFields({ model: "planner", system: "hi" }, { model: "", system: "" })).toEqual({});
  });

  it("normalizes the loader's 'functionRef' onto the authored 'function'", () => {
    expect(operationFieldsOf({ functionRef: "codex-cli" }).fields["functionRef"]).toBe("codex-cli");
    expect(withFields({ functionRef: "codex-cli" }, { functionRef: "claude-code" })).toEqual({
      function: "claude-code",
    });
  });

  it("shows a referenced field read-only and never writes over it", () => {
    // `system` is linkable but `model` is not, and a reference on an unlinkable field is exactly the
    // shape that still has to be shown read-only.
    const ref = { model: { $ref: "$/lib/models.default" } };
    const form = operationFieldsOf(ref);

    expect(form.structured["model"]).toBe(true);
    expect(form.fields["model"]).toBe("");
    expect(withFields(ref, { model: "typed over" })).toEqual(ref);
  });
});

/**
 * Links (WORKFLOWS.md §2.2).
 *
 * A `{"$ref": …}` on a LINKABLE field is the form's to edit — it used to fall into `structured` and
 * send the author to the JSON tab to write the very thing the field's own hint recommended. The
 * property under test is that linking and unlinking are non-destructive in both directions: the two
 * spellings are held side by side, so pressing the toggle to see what it does cannot lose a prompt.
 */
describe("links", () => {
  const withRefs = (block: unknown, refs: Record<string, string>): Record<string, unknown> => {
    const form = operationFieldsOf(block);
    return applyOperationFields(block, { ...form, refs: { ...form.refs, ...refs } });
  };
  /** Unlink: the KEY goes, which is what distinguishes "not linked" from "linked, not yet typed". */
  const unlinked = (block: unknown): Record<string, unknown> => {
    const form = operationFieldsOf(block);
    const refs = { ...form.refs };
    delete refs["prompt"];
    return applyOperationFields(block, { ...form, refs });
  };

  const LINKED = { prompt: { $ref: "$/prompts/review.md" } };

  it("reads a plain $ref on a linkable field as a link, not as read-only", () => {
    const form = operationFieldsOf(LINKED);
    expect(form.refs["prompt"]).toBe("$/prompts/review.md");
    expect(form.structured["prompt"]).toBeUndefined();
  });

  it("round-trips a link untouched", () => {
    expect(round(LINKED)).toEqual(LINKED);
  });

  it("retargets a link", () => {
    expect(withRefs(LINKED, { prompt: "$/prompts/critique.md" })).toEqual({
      prompt: { $ref: "$/prompts/critique.md" },
    });
  });

  it("links a literal, and gives the literal back on unlinking", () => {
    const literal = { prompt: "Review it." };
    expect(withRefs(literal, { prompt: "$/prompts/review.md" })).toEqual(LINKED);
    // The literal is still in `fields` while the link is on — which is what makes unlinking restore
    // it rather than leave an empty prompt behind.
    expect(operationFieldsOf(literal).fields["prompt"]).toBe("Review it.");
  });

  it("removes the reference on unlinking", () => {
    expect(unlinked(LINKED)["prompt"]).toBeUndefined();
  });

  it("writes nothing for a link whose target has not been typed yet", () => {
    // Distinct from unlinked: the key is present, so the control is showing a link box — but an
    // empty box is "not authored", exactly as an empty text box is.
    expect(withRefs({ prompt: "Review it." }, { prompt: "   " })["prompt"]).toBeUndefined();
  });

  it("writes a reference that names nothing, so the linter can say so", () => {
    expect(withRefs({}, { prompt: "$/prompts/not_here_yet.md" })).toEqual({
      prompt: { $ref: "$/prompts/not_here_yet.md" },
    });
  });

  it("keeps a reference with sibling overrides read-only", () => {
    // Siblings override what the reference brought in. The link control shows one target and would
    // delete them, so this stays the JSON tab's problem.
    const merged = { prompt: { $ref: "$/prompts/review.md", extra: true } };
    const form = operationFieldsOf(merged);
    expect(form.structured["prompt"]).toBe(true);
    expect(form.refs["prompt"]).toBeUndefined();
    expect(withFields(merged, { prompt: "typed over" })).toEqual(merged);
  });
});

describe("lists", () => {
  it("round-trips tools", () => {
    expect(operationFieldsOf({ tools: ["a", "b"] }).fields["tools"]).toBe("a, b");
    expect(withFields({}, { tools: "read_file, run_command" })["tools"]).toEqual(["read_file", "run_command"]);
  });

  it("drops the key when the box is emptied", () => {
    expect(withFields({ tools: ["a"] }, { tools: "" })).toEqual({});
  });
});

/**
 * Absent and `null` are different declarations (DESIGN §1.6). Absent means the operation gets its own
 * stream; `null` is an explicit "start fresh" that OVERRIDES whatever the environment chain supplied.
 */
describe("session", () => {
  it("tells absent, named and fresh apart", () => {
    expect(operationFieldsOf({}).session.mode).toBe("absent");
    expect(operationFieldsOf({ session: "review" }).session).toMatchObject({ mode: "named", name: "review" });
    expect(operationFieldsOf({ session: null }).session.mode).toBe("fresh");
  });

  it("writes null for fresh rather than dropping the declaration", () => {
    const out = round({}, { session: { mode: "fresh", name: "", text: "" } });
    expect(out).toEqual({ session: null });
    expect("session" in out).toBe(true);
  });

  it("treats an emptied name as 'not declared', never as fresh", () => {
    // `""` is an error in the engine — a template that interpolated a bad reference must not quietly
    // produce an isolated conversation that looks like it worked.
    expect(round({ session: "review" }, { session: { mode: "named", name: "", text: "" } })).toEqual({});
  });

  it("shows a computed position read-only", () => {
    const computed = { session: { $expr: ".children.plan.operation.output.session" } };
    expect(operationFieldsOf(computed).session.mode).toBe("structured");
    expect(round(computed)).toEqual(computed);
  });
});

describe("conversation", () => {
  it("round-trips a mode and its artifacts", () => {
    const decl = { conversation: { mode: "selected_artifacts", artifacts: ["plan_doc"] } };
    expect(round(decl)).toEqual(decl);
  });

  it("drops the artifact list under a mode that does not read it", () => {
    // Dead config that reads as intent is worse than no config.
    const out = round(
      { conversation: { mode: "selected_artifacts", artifacts: ["plan_doc"] } },
      { conversation: { mode: "full_history", artifacts: "plan_doc" } },
    );
    expect(out["conversation"]).toEqual({ mode: "full_history" });
  });

  it("removes the block when the mode is cleared", () => {
    expect(round({ conversation: { mode: "fresh" } }, { conversation: { mode: "", artifacts: "" } })).toEqual({});
  });
});

describe("permissions", () => {
  it("round-trips the profile, the default and the per-tool map", () => {
    const decl = { permissions: { profile: "plan", default: "ask", tools: { run_command: "deny" } } };
    expect(round(decl)).toEqual(decl);
  });

  it("builds a tool map from rows and drops the half-typed ones", () => {
    const out = round(
      {},
      {
        permissions: {
          profile: "",
          default: "allow",
          tools: [
            { tool: "run_command", mode: "ask" },
            { tool: "", mode: "deny" },
          ],
        },
      },
    );
    expect(out["permissions"]).toEqual({ default: "allow", tools: { run_command: "ask" } });
  });

  it("removes the block once nothing is left in it", () => {
    const emptied = { permissions: { profile: "", default: "", tools: [] } };
    expect(round({ permissions: { profile: "full" } }, emptied)).toEqual({});
  });
});

describe("args", () => {
  it("round-trips a function's arguments", () => {
    const decl = { args: { options: ["approve", "block"], comments: true } };
    expect(round(decl)).toEqual(decl);
  });

  it("keeps a reference written the way that position requires", () => {
    // `args` is untyped, so a reference there must be spelled `{"$ref": …}` rather than as a bare
    // string — and the JSON box is exactly what lets an author write that.
    const decl = { args: { rubric: { $ref: "$/lib/rubric.json" } } };
    expect(round(decl)).toEqual(decl);
  });

  it("drops the key when the box is emptied", () => {
    expect(withJson({ args: { a: 1 } }, { args: "" })).toEqual({});
  });
});

/**
 * WORKFLOWS.md §4.3 calls this "the single most common silent failure": `operation.input` values are
 * PARAMETERS, so the wiring goes under `binding`. `{"prompt": ".inputs.x"}` loads as a slot with no
 * binding — the call runs with nothing in it and the state reports success.
 */
describe("operation.input", () => {
  it("reads and writes the parameter spelling, never the bare one", () => {
    const form = operationFieldsOf({});
    const out = applyOperationFields(
      {},
      {
        ...form,
        input: [{ ...form.input[0], name: "prompt", type: { name: "text", list: false }, schemaText: "",
                  optional: false, binding: ".inputs.instruction", default: "", description: "" }],
      },
    );
    // The binding is a FIELD of the parameter — the shape the row can produce is the correct one.
    expect(out["input"]).toEqual({ prompt: { schema: { type: "string" }, binding: ".inputs.instruction" } });
  });

  it("round-trips an authored input map", () => {
    const decl = { input: { prompt: { kind: "text", binding: ".inputs.instruction" } } };
    expect(round(decl)).toEqual(decl);
  });

  it("removes the block when its last row goes", () => {
    expect(round({ input: { a: {} } }, { input: [] })).toEqual({});
  });
});

/**
 * §4.4, the blob rule: a delegated agent returns ONE STRING. A LONE entry carrying `kind: "blob"`
 * says the whole return IS that value; declare it `json` and the string is read as a record of
 * named outputs, finds nothing, and the state fails.
 */
describe("operation.output", () => {
  it("tells 'declared' apart from 'built by the loader'", () => {
    expect(operationFieldsOf({}).output).toEqual([]);
    expect(operationFieldsOf({ output: { report: { kind: "blob" } } }).output).toMatchObject([{ name: "report" }]);
  });

  it("round-trips a named artifact output", () => {
    const decl = { output: { report: { schema: { type: "string", contentMediaType: "text/markdown" } } } };
    expect(round(decl)).toEqual(decl);
    expect(operationFieldsOf(decl).output).toMatchObject([
      { name: "report", type: { name: "artifact", list: false, mediaType: "text/markdown" } },
    ]);
  });

  it("round-trips SEVERAL named returns — the map is the common case", () => {
    const decl = {
      output: {
        outcome: { schema: { type: "string" } },
        weaknesses: { schema: { type: "array", items: { type: "string" } } },
      },
    };
    expect(round(decl)).toEqual(decl);
    expect(operationFieldsOf(decl).output).toHaveLength(2);
  });

  it("removes the declaration and lets the loader build one", () => {
    expect(round({ output: { report: { kind: "blob" } } }, { output: [] })).toEqual({});
  });
});

describe("path and the pass-through knobs", () => {
  it("round-trips a search path, splice sentinel and all", () => {
    // Arrays REPLACE in the environment merge, so `$INHERITED` is how an author prepends rather than
    // shadowing everything including the built-ins.
    expect(operationFieldsOf({ path: ["./ops", "$INHERITED"] }).fields["path"]).toBe("./ops, $INHERITED");
    expect(withFields({}, { path: "./ops, $INHERITED" })["path"]).toEqual(["./ops", "$INHERITED"]);
  });

  it("round-trips providerOptions and toolChoice as JSON", () => {
    const decl = { providerOptions: { anthropic: { cacheControl: true } }, toolChoice: "auto" };
    expect(round(decl)).toEqual(decl);
  });

  it("drops a knob the author emptied", () => {
    expect(withJson({ toolChoice: "auto" }, { toolChoice: "" })).toEqual({});
  });
});

describe("fork and reasoning", () => {
  it("writes fork only when it is on", () => {
    // Absent and `false` mean the same thing, so writing `false` would be noise in every diff.
    expect(round({}, { fork: true })).toEqual({ fork: true });
    expect(round({ fork: true }, { fork: false })).toEqual({});
  });

  it("round-trips reasoning, and removes it once emptied", () => {
    const decl = { reasoning: { effort: "high", budgetTokens: 4000 } };
    expect(round(decl)).toEqual(decl);
    expect(round(decl, { reasoning: { effort: "", budgetTokens: "" } })).toEqual({});
  });
});
