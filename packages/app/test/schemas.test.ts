/**
 * The schemas the JSON editor holds a document to.
 *
 * The risk with this feature is not missing an error — it is REPORTING one against a file that is
 * correct. A schema that flagged `{"$ref": …}`, or demanded a `prompt` the environment chain
 * supplies, would train people to ignore the panel within a day, and an ignored validator is worse
 * than none. So most of what follows is "this valid thing must produce no violations", and the
 * catching tests are the two errors people actually make by hand: a misspelled key and a wrong type.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles } from "@jaira/runtime";
import { listSchemas, mergeSkeleton, propertiesOf, schemaById, skeletonOf } from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-schema-"));
  initProject(dir);
  service = new AppService({ watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Violations for a document, as the editor would list them. */
const check = (schemaId: string, doc: unknown): string[] =>
  service
    .validateSchema({ schemaId, text: JSON.stringify(doc) })
    .violations.map((v) => `${v.path}: ${v.message}`);

describe("the registry", () => {
  it("offers the three entries the picker lists", () => {
    expect(listSchemas().map((s) => s.id)).toEqual(["state", "state-prompt", "prompt-operation"]);
  });

  it("refuses an unknown id rather than silently passing the document", () => {
    expect(() => service.validateSchema({ schemaId: "nope", text: "{}" })).toThrow(/no schema named/);
  });
});

describe("what must NOT be reported", () => {
  it("accepts an empty document — nothing is required in the file", () => {
    // WORKFLOWS.md §4: what the file leaves out, the environment chain may supply.
    expect(check("state", {})).toEqual([]);
    expect(check("state-prompt", {})).toEqual([]);
    expect(check("prompt-operation", {})).toEqual([]);
  });

  it("accepts a reference anywhere a literal would go", () => {
    expect(check("prompt-operation", { kind: "prompt", prompt: { $ref: "$/prompts/goals.md" } })).toEqual([]);
    expect(check("state", { operation: { $ref: "$/ops/plan.json" } })).toEqual([]);
    expect(check("state", { inputs: { $ref: "$/slots/common.json" } })).toEqual([]);
  });

  it("accepts an expression and an explicit json literal", () => {
    expect(check("prompt-operation", { prompt: { expr: "inputs.issue" } })).toEqual([]);
    expect(check("state", { sequence: { json: ["a", "b"] } })).toEqual([]);
  });

  it("accepts a field the vocabulary has never heard of on an operation", () => {
    // hw passes anything it does not own straight into the call config, so a knob invented after
    // this table was written still reaches the model. Flagging it would be wrong.
    expect(check("prompt-operation", { kind: "prompt", someNewProviderKnob: 7 })).toEqual([]);
  });

  it("accepts the worked example from WORKFLOWS.md §4.1", () => {
    expect(
      check("prompt-operation", {
        kind: "prompt",
        prompt: "Extract goals from {{.inputs.issue}}.",
        system: "You are a careful planner.",
        model: "anthropic/claude-sonnet-5",
      }),
    ).toEqual([]);
  });

  it("accepts a fully populated state, now that every block is modelled", () => {
    // Depth is where a schema starts inventing rules. Each of these blocks is written the way
    // WORKFLOWS.md writes it, so any violation here is the schema being wrong, not the document.
    expect(
      check("state", {
        inputs: {
          issue: {
            kind: "blob",
            schema: { type: "string", contentMediaType: "text/markdown" },
            binding: ".inputs.issue",
            default: "significant",
            optional: true,
            description: "The issue to plan against",
          },
        },
        outputs: {
          weaknesses: { schema: { type: "array", items: { type: "string" } } },
          outcome: { binding: { expr: ".children.critique.outputs.outcome" } },
        },
        children: {
          goals: { inputs: { issue: ".inputs.issue" } },
          lint: { async: true },
          shared: { state: "$/lib/review" },
          claude_review: {
            state: "review/agent_review",
            async: true,
            environment: { kind: "function", function: "claude-cli" },
            inputs: { change: ".inputs.change" },
          },
        },
        transitions: [
          { to: "terminate.success", when: ".children.critique.outputs.outcome === 'clean'" },
          { to: "goals" },
        ],
        operation: {
          kind: "prompt",
          prompt: "…",
          conversation: { mode: "selected_artifacts", artifacts: ["plan"] },
          permissions: { profile: "read-only", default: "ask", tools: { run_command: "deny" } },
          reasoning: { effort: "high", budgetTokens: 4096 },
          session: "planning",
        },
      }),
    ).toEqual([]);
  });

  it("accepts a full state with children, sequence, transitions and limits", () => {
    expect(
      check("state", {
        id: "feature/plan",
        label: "Planning",
        description: "…",
        inputs: { issue: { kind: "text" } },
        outputs: { plan: { kind: "text" } },
        operation: { kind: "prompt", prompt: "…" },
        environment: { model: "anthropic/claude-sonnet-5" },
        children: { goals: {} },
        sequence: ["goals"],
        transitions: [{ when: "true", to: "terminate.success" }],
        limits: { max_iterations: 3, timeout: 600 },
      }),
    ).toEqual([]);
  });
});

describe("what must be reported", () => {
  it("catches a misspelled top-level key, which is the error people actually make", () => {
    // §2: "Nothing else is recognized." This is the one place additionalProperties earns its keep.
    const errors = check("state", { lable: "Planning" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unknown field 'lable'");
  });

  it("catches a scalar of the wrong type, and says where", () => {
    const errors = check("prompt-operation", { kind: "prompt", temperature: "warm" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^temperature: /);
  });

  it("points into a nested path with a dotted name", () => {
    const errors = check("state", { operation: { kind: "prompt", maxOutputTokens: "lots" } });
    expect(errors.some((e) => e.startsWith("operation.maxOutputTokens: "))).toBe(true);
  });

  it("holds a prompt-kinded state to the prompt shape", () => {
    expect(check("state-prompt", { operation: { kind: "function" } }).length).toBeGreaterThan(0);
    expect(check("state-prompt", { operation: { kind: "prompt" } })).toEqual([]);
  });

  it("reports a parse error instead of schema noise about a half-typed document", () => {
    const result = service.validateSchema({ schemaId: "state", text: '{"label": ' });
    expect(result.parseError).toBeTruthy();
    expect(result.violations).toEqual([]);
  });
});

describe("what the schema offers the editor", () => {
  it("writes a skeleton that is itself valid", () => {
    for (const entry of listSchemas()) {
      const skeleton = skeletonOf(entry);
      expect(check(entry.id, skeleton), `${entry.id} skeleton`).toEqual([]);
    }
  });

  it("puts the after-merge requirements in the prompt operation's skeleton", () => {
    // `kind` and `prompt` are required AFTER merging, never in the file — so the skeleton writes
    // them and the validator does not ask for them. Both halves of that split matter.
    const skeleton = skeletonOf(schemaById("prompt-operation")!) as Record<string, unknown>;
    expect(skeleton["kind"]).toBe("prompt");
    expect(skeleton).toHaveProperty("prompt");
    expect(check("prompt-operation", {})).toEqual([]);
  });

  it("adds what a document is missing without touching what it has", () => {
    const entry = schemaById("prompt-operation")!;
    const merged = mergeSkeleton(entry, { prompt: "written already", model: "anthropic/x" }) as Record<string, unknown>;
    // The absent one arrives; the present ones are untouched, including where the skeleton has an
    // opinion about them. Merging is what makes the button safe on a document with content in it.
    expect(merged["kind"]).toBe("prompt");
    expect(merged["prompt"]).toBe("written already");
    expect(merged["model"]).toBe("anthropic/x");
  });

  it("merges into a nested block rather than replacing it", () => {
    const entry = schemaById("state-prompt")!;
    const merged = mergeSkeleton(entry, { operation: { prompt: "keep me" } }) as Record<string, unknown>;
    expect(merged["operation"]).toEqual({ prompt: "keep me" });
  });

  it("leaves an empty string or an empty object alone — present is present", () => {
    const merged = mergeSkeleton(schemaById("prompt-operation")!, { prompt: "" }) as Record<string, unknown>;
    expect(merged["prompt"]).toBe("");
  });

  it("produces something valid whatever it merged into", () => {
    for (const entry of listSchemas()) {
      expect(check(entry.id, mergeSkeleton(entry, {})), `${entry.id} into {}`).toEqual([]);
      expect(check(entry.id, mergeSkeleton(entry, { label: "x" })), `${entry.id} into a partial`).toEqual([]);
    }
  });

  it("marks what is required after merging at any depth, not just at the root", () => {
    // The reason this is on the property and not only on the entry: a state's `operation.prompt` is
    // a level down, and the suggestion list sorts by exactly this flag.
    const inOperation = propertiesOf(schemaById("state-prompt")!, ["operation"]);
    expect(inOperation.find((p) => p.key === "prompt")?.expected).toBe(true);
    expect(inOperation.find((p) => p.key === "kind")?.expected).toBe(true);
    expect(inOperation.find((p) => p.key === "temperature")?.expected).toBe(false);
  });

  it("still does not REQUIRE what it marks as expected", () => {
    // The whole split: marked for the author, invisible to the validator.
    expect(check("state-prompt", { operation: {} })).toEqual([]);
  });

  it("lists the top-level properties for the reference panel", () => {
    const keys = propertiesOf(schemaById("state")!).map((p) => p.key);
    expect(keys).toEqual([
      "id",
      "label",
      "description",
      "inputs",
      "outputs",
      "operation",
      "environment",
      "children",
      "sequence",
      "transitions",
      "limits",
    ]);
  });

  it("walks into a nested block, which is what completion at the cursor needs", () => {
    const inOperation = propertiesOf(schemaById("state-prompt")!, ["operation"]).map((p) => p.key);
    expect(inOperation).toContain("prompt");
    expect(inOperation).toContain("model");
    // A prompt operation has no `function`/`args` — §4: they are meaningless on it.
    expect(inOperation).not.toContain("function");
    expect(inOperation).not.toContain("args");
  });

  it("walks into a map whose keys the AUTHOR chose", () => {
    // The gap that made this feature feel shallow: `inputs` names are `issue`, `plan_doc` — the map
    // itself has nothing to suggest, but everything INSIDE one of its entries does.
    const inSlot = propertiesOf(schemaById("state")!, ["inputs", "issue"]).map((p) => p.key);
    expect(inSlot).toEqual(["schema", "kind", "binding", "default", "optional", "description", "name"]);
    // Whatever the author called it.
    expect(propertiesOf(schemaById("state")!, ["outputs", "anything_at_all"]).map((p) => p.key)).toContain("binding");
  });

  it("walks into a declared child", () => {
    const inChild = propertiesOf(schemaById("state")!, ["children", "goals"]).map((p) => p.key);
    expect(inChild).toEqual(["state", "inputs", "async", "environment", "transitions"]);
  });

  it("walks through an array to the shape of its items", () => {
    // The path carries no index — `transitions` is what the cursor reports inside one of its objects.
    const inTransition = propertiesOf(schemaById("state")!, ["transitions"]).map((p) => p.key);
    expect(inTransition).toEqual(["to", "when"]);
    expect(propertiesOf(schemaById("state")!, ["transitions"]).find((p) => p.key === "to")?.expected).toBe(true);
  });

  it("walks into the operation's own nested blocks", () => {
    const entry = schemaById("state-prompt")!;
    expect(propertiesOf(entry, ["operation", "permissions"]).map((p) => p.key)).toEqual([
      "profile",
      "default",
      "tools",
    ]);
    expect(propertiesOf(entry, ["operation", "conversation"]).map((p) => p.key)).toEqual(["mode", "artifacts"]);
    expect(propertiesOf(entry, ["operation", "reasoning"]).map((p) => p.key)).toEqual(["effort", "budgetTokens"]);
    expect(propertiesOf(entry, ["operation", "output"]).map((p) => p.key)).toContain("kind");
  });

  it("goes several levels deep, through a child's own environment", () => {
    const deep = propertiesOf(schemaById("state")!, ["children", "review", "environment"]).map((p) => p.key);
    expect(deep).toContain("model");
    expect(deep).toContain("kind");
  });

  it("returns nothing for a path the schema does not describe", () => {
    expect(propertiesOf(schemaById("state")!, ["nonsense"])).toEqual([]);
    expect(propertiesOf(schemaById("state")!, ["label", "deeper"])).toEqual([]);
  });

  it("carries the vocabulary's own hints through to the panel", () => {
    const model = propertiesOf(schemaById("prompt-operation")!).find((p) => p.key === "model");
    expect(model?.type).toBe("string");
    expect(model?.description).toContain("Model");
    const kind = propertiesOf(schemaById("prompt-operation")!).find((p) => p.key === "kind");
    expect(kind?.values).toEqual(["prompt"]);
  });
});

describe("the workflows this repo actually ships", () => {
  // The strongest check available, and the one that would catch this schema inventing a rule: every
  // state in the built-in workflow must validate clean. These documents are written by the people who
  // wrote the format, exercise slots, children, transitions, environments and both operation kinds,
  // and any violation here means the schema is wrong rather than the workflow.
  it("validates every state of the built-in workflow with no violations", () => {
    const files = specPlanningFiles();
    const ids = Object.keys(files);
    expect(ids.length).toBeGreaterThan(3);
    for (const [id, document] of Object.entries(files)) {
      expect(check("state", document), `${id} against the state schema`).toEqual([]);
    }
  });

  it("validates each state's operation block against the operation schema", () => {
    for (const [id, document] of Object.entries(specPlanningFiles())) {
      const operation = (document as Record<string, unknown>)["operation"];
      if (operation === undefined || (operation as Record<string, unknown>)["kind"] !== "prompt") continue;
      expect(check("prompt-operation", operation), `${id}'s operation`).toEqual([]);
    }
  });
});

describe("what a violation says", () => {
  it("names the allowed values instead of just saying there are some", () => {
    // "must be equal to one of the allowed values" sends you to the documentation for something the
    // schema is already holding. ajv puts them in `params`; there is no reason not to print them.
    const errors = check("state", { inputs: { feature_description: { schema: { type: "wrong" } } } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      'inputs.feature_description.schema.type: must be one of: "string", "number", "integer", "boolean", "object", "array", "null"',
    );
  });

  it("names the value a const field demands", () => {
    const errors = check("state-prompt", { operation: { kind: "function" } });
    expect(errors.some((e) => e.includes('must be "prompt"'))).toBe(true);
  });

  it("still names the offending field for an unknown key", () => {
    expect(check("state", { lable: 1 })[0]).toContain("unknown field 'lable'");
  });

  it("quotes strings and leaves other literals bare", () => {
    const errors = check("state", { operation: { conversation: { mode: "nope" } } });
    expect(errors.some((e) => e.includes('"full_history"'))).toBe(true);
  });
});

describe("how many rows one mistake produces", () => {
  it("reports a deep mistake once, not once per enclosing block", () => {
    // Every leaf is `anyOf: [own type, {$ref}, {expr}, {json}]`, so ajv reports the real error and
    // then, at each level above it, that the value was not a reference either. Four rows for one
    // typo — three of them advising that `inputs` could have been a `$ref` — is how a validation
    // panel becomes something people stop reading.
    const errors = check("state", { inputs: { feature_description: { schema: { type: "wrong" } } } });
    expect(errors).toEqual([
      'inputs.feature_description.schema.type: must be one of: "string", "number", "integer", "boolean", "object", "array", "null"',
    ]);
  });

  it("still reports two independent mistakes separately", () => {
    // The collapse drops ANCESTORS of an explained failure, not every summary — a second problem
    // elsewhere in the document must keep its row even if all it can say is that it did not match.
    const errors = check("state", { lable: 1, sequence: 5 });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.includes("unknown field 'lable'"))).toBe(true);
    expect(errors.some((e) => e.startsWith("sequence:"))).toBe(true);
  });

  it("never reports a document as invalid with nothing to show for it", () => {
    for (const document of [{ lable: 1 }, { inputs: 5 }, { transitions: [{ to: 5 }] }, { operation: 7 }]) {
      const result = service.validateSchema({ schemaId: "state", text: JSON.stringify(document) });
      expect(result.violations.length, JSON.stringify(document)).toBeGreaterThan(0);
    }
  });
});

/**
 * Picking the schema from the document.
 *
 * The picker used to be a menu you had to know the answer to: open a `.json` file and it sat on
 * "none — plain JSON" whether or not the file was obviously a state.
 *
 * A match means something only because every registered schema is `additionalProperties: false` —
 * satisfying one says the document carries no key that schema does not know. Two properties matter
 * and both are easy to lose: an arbitrary JSON file must match NOTHING, and a document that matches
 * two schemas must be offered the more specific one.
 */
describe("detecting a document's schema", () => {
  const detect = (doc: unknown): string | null => service.detectSchema(JSON.stringify(doc)).schemaId;

  it("recognises a state file", () => {
    expect(detect({ label: "Plan", children: { goals: {} }, sequence: ["goals"] })).toBe("state");
  });

  it("prefers the more specific schema when both fit", () => {
    // A prompt state satisfies `state` too. `state-prompt` says more about the same file, so it is
    // the better answer — and it is the one whose `expected` keys the document actually carries.
    expect(detect({ operation: { kind: "prompt", prompt: "go" } })).toBe("state-prompt");
  });

  it("recognises a bare operation block", () => {
    expect(detect({ kind: "prompt", prompt: "review it", model: "anthropic/claude-sonnet-5" })).toBe(
      "prompt-operation",
    );
  });

  it("matches nothing for an unrelated JSON document", () => {
    // The whole signal: an unknown key is a refusal, not a shrug.
    expect(detect({ name: "my-package", version: "1.0.0", dependencies: {} })).toBeNull();
  });

  it("declines to guess for an empty object", () => {
    // `{}` satisfies every one of them vacuously. Choosing there would be picking for the author
    // rather than reading what they wrote.
    expect(detect({})).toBeNull();
  });

  it("declines for anything that is not an object", () => {
    expect(detect([1, 2, 3])).toBeNull();
    expect(detect("a string")).toBeNull();
    expect(detect(null)).toBeNull();
  });

  it("declines for text that is not JSON at all", () => {
    // Asked while a file is opening, so a half-written document is ordinary and not an error.
    expect(service.detectSchema("{ broken").schemaId).toBeNull();
    expect(service.detectSchema("").schemaId).toBeNull();
  });

  it("reports every candidate, best first", () => {
    const found = service.detectSchema(JSON.stringify({ operation: { kind: "prompt", prompt: "go" } }));
    expect(found.candidates[0]).toBe("state-prompt");
    expect(found.candidates).toContain("state");
  });

  it("agrees with the validator — a detected schema reports no violations", () => {
    const doc = { label: "Plan", children: { goals: {} }, sequence: ["goals"] };
    const id = detect(doc)!;
    expect(check(id, doc)).toEqual([]);
  });
});
