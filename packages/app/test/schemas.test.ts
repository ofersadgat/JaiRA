/**
 * The schemas the JSON editor holds a document to.
 *
 * The risk with this feature is not missing an error — it is REPORTING one against a file that is
 * correct. A schema that flagged `{"$ref": …}`, or demanded a `prompt` the environment chain
 * supplies, would train people to ignore the panel within a day, and an ignored validator is worse
 * than none. So most of what follows is "this valid thing must produce no violations", and the
 * catching tests are the two errors people actually make by hand: a misspelled key and a wrong type.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles } from "@jaira/runtime";
import { listSchemas, matchesFile, mergeSkeleton, propertiesOf, schemaById, schemaForFile, skeletonOf, withMissingFields } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-schema-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
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
  it("offers the entries the picker lists", () => {
    expect(listSchemas().map((s) => s.id)).toEqual([
      "state",
      "state-prompt",
      "prompt-operation",
      "package-json",
      "tsconfig",
      "compose",
      "gitlab-ci",
      "github-workflow",
    ]);
  });

  it("offers each syntax the schemas its documents can be written in", () => {
    // A state is a state in either syntax; npm and tsc read JSON, the three CI and Compose files YAML.
    expect(listSchemas("json").map((s) => s.id)).toEqual(["state", "state-prompt", "prompt-operation", "package-json", "tsconfig"]);
    expect(listSchemas("yaml").map((s) => s.id)).toEqual([
      "state",
      "state-prompt",
      "prompt-operation",
      "compose",
      "gitlab-ci",
      "github-workflow",
    ]);
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
    expect(check("prompt-operation", { prompt: { $expr: "inputs.issue" } })).toEqual([]);
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
          outcome: { binding: { $expr: ".children.critique.output.outcome" } },
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
          { to: "terminate.success", when: ".children.critique.output.outcome === 'clean'" },
          { to: "goals" },
        ],
        operation: {
          kind: "prompt",
          prompt: "…",
          conversation: { mode: "selected_artifacts", artifacts: ["plan"] },
          permissions: { scopes: [{ path: "docs/**", default: "allow" }] },
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
      // `label` is a partial of THIS app's documents; a Compose file rightly refuses it.
      if (entry.files !== undefined) continue;
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
    expect(propertiesOf(entry, ["operation", "permissions"]).map((p) => p.key)).toEqual(["scopes"]);
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

/**
 * The files their own ecosystems define — held to the published schema, found by NAME.
 *
 * The same two risks as this app's own schemas, the first one sharper: these are somebody else's
 * format, and a verdict against a `package.json` npm itself accepts would be this editor being wrong
 * about a file it does not own. So the repo's own manifests must pass, and a typo must not.
 */
describe("files the wider world defines", () => {
  const yaml = (schemaId: string, text: string): string[] =>
    service.validateSchema({ schemaId, text, format: "yaml" }).violations.map((v) => `${v.path}: ${v.message}`);

  it("claims a file by its name, whatever it holds — even empty", () => {
    expect(service.detectSchema("", "packages/app/package.json").schemaId).toBe("package-json");
    expect(service.detectSchema("", "C:\\work\\compose.yaml", "yaml").schemaId).toBe("compose");
    expect(service.detectSchema("", "docker-compose.yml", "yaml").schemaId).toBe("compose");
    expect(service.detectSchema("", ".gitlab-ci.yml", "yaml").schemaId).toBe("gitlab-ci");
    expect(schemaForFile("my-package.json")).toBeUndefined();
  });

  it("does not claim a name in a syntax the schema is not written in", () => {
    // A `package.json` read as YAML is not npm's file; the name alone should not hand it npm's schema.
    expect(service.detectSchema("{}", "package.json", "yaml").schemaId).toBeNull();
  });

  it("never guesses these from content — a manifest under another name is plain JSON", () => {
    expect(service.detectSchema(JSON.stringify({ name: "x", version: "1.0.0" }), "fixture.json").schemaId).toBeNull();
  });

  it("passes this repository's own package.json files", () => {
    for (const file of ["package.json", "packages/app/package.json", "packages/shared/package.json"]) {
      const text = readFileSync(join(__dirname, "..", "..", "..", file), "utf8");
      expect(service.validateSchema({ schemaId: "package-json", text }).violations, file).toEqual([]);
    }
  });

  it("reports a package.json field of the wrong type", () => {
    const found = check("package-json", { name: 5, version: "1.0.0" });
    expect(found.some((e) => e.startsWith("name:"))).toBe(true);
  });

  it("passes a Compose file and reports a misspelled service key", () => {
    expect(yaml("compose", "services:\n  web:\n    image: nginx\n    ports: ['80:80']\n")).toEqual([]);
    // `unevaluatedProperties` is 2020-12's, and a draft-07 compile would skip it — this is the test
    // that the Compose Specification is compiled in its own dialect.
    expect(yaml("compose", "services:\n  web:\n    imagee: nginx\n")).toEqual([
      "services.web: unknown field 'imagee' — nothing else is recognized here",
    ]);
  });

  it("passes a GitLab pipeline and reports a job it cannot run", () => {
    expect(yaml("gitlab-ci", "stages: [build]\nbuild:\n  stage: build\n  script: [make]\n")).toEqual([]);
    expect(yaml("gitlab-ci", "build:\n  scrpt: make\n").length).toBeGreaterThan(0);
  });

  it("states a YAML parse error instead of schema noise", () => {
    const result = service.validateSchema({ schemaId: "compose", text: "services: [\n", format: "yaml" });
    expect(result.parseError).toBeDefined();
    expect(result.violations).toEqual([]);
  });

  it("detects a state written as YAML by its content, as it does one written as JSON", () => {
    const text = "label: Plan\nsequence: [goals]\nchildren:\n  goals: {}\n";
    expect(service.detectSchema(text, "plan.yaml", "yaml").schemaId).toBe("state");
  });

  it("walks the published shapes for the field reference", () => {
    const keys = (id: string, at: string[]): string[] => propertiesOf(schemaById(id)!, at).map((p) => p.key);
    expect(keys("package-json", [])).toEqual(expect.arrayContaining(["name", "version", "scripts", "dependencies"]));
    // A service is `patternProperties` → `$ref` → `allOf` of two specs: all three have to be read.
    expect(keys("compose", ["services", "web"])).toEqual(expect.arrayContaining(["image", "ports", "deploy"]));
    // A job is any key the pipeline does not reserve (`additionalProperties`), then `allOf` again.
    expect(keys("gitlab-ci", ["build"])).toEqual(expect.arrayContaining(["script", "stage", "rules"]));
    // A tsconfig's root is nothing BUT an `allOf` of definitions.
    expect(keys("tsconfig", [])).toEqual(expect.arrayContaining(["compilerOptions", "extends", "include"]));
    expect(keys("tsconfig", ["compilerOptions"])).toEqual(expect.arrayContaining(["strict", "target", "paths"]));
    expect(keys("github-workflow", ["jobs", "build"])).toEqual(expect.arrayContaining(["runs-on", "steps", "needs"]));
  });
});

describe("names that are patterns", () => {
  it("matches from the end of the path, one segment per segment", () => {
    expect(matchesFile("package.json", "packages/app/package.json")).toBe(true);
    expect(matchesFile("package.json", "my-package.json")).toBe(false);
    expect(matchesFile("tsconfig.*.json", "tsconfig.base.json")).toBe(true);
    expect(matchesFile("tsconfig.*.json", "tsconfig.json")).toBe(false);
    expect(matchesFile(".github/workflows/*.yml", "C:\\repo\\.github\\workflows\\ci.yml")).toBe(true);
    // The directory is what makes a workflow a workflow.
    expect(matchesFile(".github/workflows/*.yml", "repo/workflows/ci.yml")).toBe(false);
    expect(matchesFile(".github/workflows/*.yml", "ci.yml")).toBe(false);
    // `*` stays inside its segment.
    expect(matchesFile(".github/workflows/*.yml", ".github/workflows/nested/ci.yml")).toBe(false);
  });

  it("claims a tsconfig and its variants, and a workflow by its directory", () => {
    expect(service.detectSchema("", "packages/app/tsconfig.json").schemaId).toBe("tsconfig");
    expect(service.detectSchema("", "tsconfig.base.json").schemaId).toBe("tsconfig");
    expect(service.detectSchema("", ".github/workflows/ci.yml", "yaml").schemaId).toBe("github-workflow");
    expect(service.detectSchema("", ".github/workflows/release.yaml", "yaml").schemaId).toBe("github-workflow");
    expect(schemaForFile("config/ci.yml")).toBeUndefined();
  });
});

describe("tsconfig.json and GitHub Actions", () => {
  const repo = (file: string): string => readFileSync(join(__dirname, "..", "..", "..", file), "utf8");
  const yaml = (schemaId: string, text: string): string[] =>
    service.validateSchema({ schemaId, text, format: "yaml" }).violations.map((v) => `${v.path}: ${v.message}`);

  it("passes this repository's own tsconfigs — comments, trailing commas and all", () => {
    // `tsconfig.base.json` is written with `//` comments, which `tsc` accepts and `JSON.parse` does not.
    expect(repo("tsconfig.base.json")).toContain("//");
    for (const file of ["tsconfig.base.json", "packages/app/tsconfig.json", "packages/shared/tsconfig.json"]) {
      const result = service.validateSchema({ schemaId: "tsconfig", text: repo(file) });
      expect(result.parseError, file).toBeUndefined();
      expect(result.violations, file).toEqual([]);
    }
  });

  it("reports a compiler option of the wrong type — and not why the other branch failed", () => {
    // `compilerOptions` is "an object, or null". The object branch got further; that null was not
    // written is not news to anyone.
    expect(check("tsconfig", { compilerOptions: { strict: "yes" } })).toEqual(["compilerOptions.strict: must be boolean"]);
  });

  it("passes this repository's own workflow", () => {
    expect(yaml("github-workflow", repo(".github/workflows/ci.yml"))).toEqual([]);
  });

  it("reports a job GitHub cannot run", () => {
    const valid = "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
    expect(yaml("github-workflow", valid)).toEqual([]);
    // A job is one that runs steps OR one that calls a reusable workflow. This is the first kind with
    // no `runs-on`; that the second kind takes no `steps` is about a job nobody is writing.
    expect(yaml("github-workflow", "on: push\njobs:\n  build:\n    steps:\n      - run: make\n")).toEqual([
      "jobs.build: must have required property 'runs-on'",
    ]);
  });
});

/**
 * "Add missing fields", on the text — the one place this editor writes a document it did not type.
 *
 * What must hold is that it ADDS: a tsconfig's comments, a pipeline's comments, the order and the
 * indentation the author chose all come back as they were, with the missing keys beside them.
 */
describe("adding missing fields to a document's text", () => {
  it("adds to JSONC without touching its comments, order or tabs", () => {
    const text = '{\n\t// the base every package extends\n\t"extends": "./tsconfig.base.json",\n}\n';
    const out = withMissingFields(schemaById("tsconfig")!, text);
    expect(out).toContain("\t// the base every package extends\n\t\"extends\": \"./tsconfig.base.json\"");
    expect(out).toMatch(/\n\t"compilerOptions": \{\}/);
    expect(service.validateSchema({ schemaId: "tsconfig", text: out }).violations).toEqual([]);
  });

  it("keeps a YAML document's comments, and writes values the schema accepts", () => {
    const text = "# deploys on every push\nname: ci\n";
    const out = withMissingFields(schemaById("github-workflow")!, text, "yaml");
    expect(out.startsWith("# deploys on every push\nname: ci\n")).toBe(true);
    expect(out).toContain("on: push");
  });

  it("writes the skeleton into an empty document, and leaves an unreadable one alone", () => {
    expect(JSON.parse(withMissingFields(schemaById("package-json")!, ""))).toEqual({ name: "my-package", version: "0.1.0" });
    expect(withMissingFields(schemaById("package-json")!, '{"name": ')).toBe('{"name": ');
    expect(withMissingFields(schemaById("package-json")!, "[1, 2]")).toBe("[1, 2]");
  });

  it("adds nothing a document already has", () => {
    const text = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    expect(withMissingFields(schemaById("package-json")!, text)).toBe(text);
  });
});

