/**
 * What the schema form decides, without drawing it.
 *
 * Each of these was a way the form could quietly say the wrong thing: a union drawn in a shape nobody
 * picked, a switched-on field that starts from nothing instead of its default, a complaint about a
 * missing member filed under its parent, a branch the form did not choose explaining why it failed,
 * a `minLength: 1` read out as a limit of forty.
 */
import { describe, expect, it } from "vitest";
import { fillFormSchema, validateComponentResult, type FillFormConfig } from "@jaira/shared/browser";
import {
  branchesOf,
  branchIndexFor,
  branchLabels,
  checkBlocker,
  fieldErrorsOf,
  isComposite,
  leafControlOf,
  messageOf,
  numberFromText,
  pathOfPointer,
  seedFor,
  suggestionsOf,
  summaryOf,
  typeHintOf,
  type CheckError,
} from "../src/renderer/schemaForm/model";

const ANCHOR = {
  anyOf: [
    { title: "path", type: "string" },
    { title: "path + line", type: "object", required: ["path", "line"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } } },
    { type: "null" },
  ],
};

describe("a value that may take more than one shape", () => {
  it("is a choice of shapes for anyOf, oneOf and a type array alike", () => {
    expect(branchLabels(branchesOf(ANCHOR)!)).toEqual(["path", "path + line", "none"]);
    expect(branchLabels(branchesOf({ type: ["string", "null"] })!)).toEqual(["text", "none"]);
    expect(branchesOf({ oneOf: [{ type: "number" }, { type: "boolean" }] })).toHaveLength(2);
    // One branch is not a choice.
    expect(branchesOf({ anyOf: [{ type: "string" }] })).toBeUndefined();
  });

  it("gives every branch the keywords written beside the union — except the null one", () => {
    const [text, none] = branchesOf({ type: ["string", "null"], minLength: 1 })!;
    expect(text).toEqual({ type: "string", minLength: 1 });
    expect(none).toEqual({ type: "null" });
  });

  it("numbers two branches that would otherwise read the same", () => {
    expect(branchLabels([{ type: "object" }, { type: "object" }])).toEqual(["object 1", "object 2"]);
  });

  it("finds the branch a value is already in — by kind, then by required members", () => {
    const branches = branchesOf(ANCHOR)!;
    expect(branchIndexFor(branches, "a.ts")).toBe(0);
    expect(branchIndexFor(branches, { path: "a.ts", line: 3 })).toBe(1);
    expect(branchIndexFor(branches, null)).toBe(2);
    // Nothing yet: the first shape that is not "none".
    expect(branchIndexFor(branches, undefined)).toBe(0);
    const two = [
      { type: "object", required: ["url"], properties: { url: { type: "string" } } },
      { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    ];
    expect(branchIndexFor(two, { path: "x" })).toBe(1);
  });

  it("keeps raw text in a number box with the number shape rather than the text one", () => {
    expect(branchIndexFor([{ type: "boolean" }, { type: "number" }], "1.5x")).toBe(1);
  });
});

describe("what a value starts as", () => {
  it("starts from the declared default, so switching a field on starts from what would have been sent", () => {
    expect(seedFor({ type: "string", enum: ["a", "b"], default: "b" })).toBe("b");
    expect(seedFor({ type: "number", default: 0.8 })).toBe(0.8);
  });

  it("is empty of content and right in shape otherwise — an object with only its required members", () => {
    expect(seedFor({ type: "string" })).toBe("");
    expect(seedFor({ type: "boolean" })).toBe(false);
    expect(seedFor({ type: "array" })).toEqual([]);
    expect(seedFor({ type: "object", required: ["id"], properties: { id: { type: "string" }, note: { type: "string" } } })).toEqual({ id: "" });
    expect(seedFor(ANCHOR)).toBe("");
  });

  it("holds the text of a number box that is not a number yet, rather than dropping it", () => {
    expect(numberFromText("0.5")).toBe(0.5);
    expect(numberFromText("")).toBe("");
    expect(numberFromText("1.5x")).toBe("1.5x");
  });
});

describe("the control a value is typed into", () => {
  it("is a choice box for an enum, one that insists, and for examples, one that only suggests", () => {
    expect(leafControlOf({ type: "string", enum: ["a"] })).toBe("choice");
    expect(suggestionsOf({ type: "string", enum: ["a", "b"] })).toEqual({ values: ["a", "b"], strict: true });
    expect(suggestionsOf({ type: "string", examples: ["memory"] })).toEqual({ values: ["memory"], strict: false });
  });

  it("is a box with room for content with a media type, and a lenient box for no type at all", () => {
    expect(leafControlOf({ type: "string", contentMediaType: "text/markdown" })).toBe("multiline");
    expect(leafControlOf({})).toBe("json");
  });

  it("opens and closes a list row only when the item is more than one line", () => {
    expect(isComposite({ type: "object" })).toBe(true);
    expect(isComposite(ANCHOR)).toBe(true);
    expect(isComposite({ type: "string" })).toBe(false);
  });
});

describe("what a field says about itself", () => {
  it("says what the schema allows before anything is typed", () => {
    expect(typeHintOf({ type: "string", enum: ["blocker", "significant", "minor", "note"] })).toBe("one of 4");
    expect(typeHintOf({ type: "number", minimum: 0, maximum: 1 })).toBe("number · 0 to 1");
    expect(typeHintOf({ type: "integer", minimum: 1 })).toBe("integer · at least 1");
    expect(typeHintOf({ type: "string", contentMediaType: "text/markdown", minLength: 1 })).toBe("text/markdown · at least 1 character");
    expect(typeHintOf({ type: "array", minItems: 1 })).toBe("list · at least 1");
    expect(typeHintOf({ type: "object", additionalProperties: { type: "string" } })).toBe("keys → text");
    // Plain text says nothing; its box already does.
    expect(typeHintOf({ type: "string" })).toBe("");
  });

  it("reads a closed list row as its first couple of values", () => {
    const item = { type: "object", properties: { id: { type: "string" }, statement: { type: "string" }, manual: { type: "boolean" } } };
    expect(summaryOf(item, { statement: "Pause survives an app restart", id: "AC-1" })).toBe("AC-1 · Pause survives an app restart");
    expect(summaryOf(item, {})).toBe("0 fields");
  });
});

describe("a complaint, placed and worded", () => {
  const err = (patch: Partial<CheckError>): CheckError => ({ instancePath: "", schemaPath: "#", keyword: "type", params: {}, ...patch });

  it("reads a pointer against the value, so a list index and a numeric key are told apart", () => {
    expect(pathOfPointer("/criteria/1/id", { criteria: [{}, {}] })).toBe("criteria[1].id");
    expect(pathOfPointer("/env/1", { env: { "1": "x" } })).toBe("env.1");
    expect(pathOfPointer("/0", ["x"], "tags")).toBe("tags[0]");
  });

  it("files a missing member under the member, not its parent", () => {
    const errors = fieldErrorsOf([err({ instancePath: "/1", keyword: "required", params: { missingProperty: "statement" } })], [{}, {}], "criteria");
    expect(errors).toEqual([{ path: "criteria[1].statement", message: "required" }]);
  });

  it("drops what the branches nobody picked said, and the union's summary when something specific survives", () => {
    const value = { path: "a.ts", line: 0 };
    const errors = fieldErrorsOf(
      [
        err({ instancePath: "", schemaPath: "#/anyOf/0/type", keyword: "type", params: { type: "string" } }),
        err({ instancePath: "/line", schemaPath: "#/anyOf/1/properties/line/minimum", keyword: "minimum", params: { comparison: ">=", limit: 1 } }),
        err({ instancePath: "", schemaPath: "#/anyOf/2/type", keyword: "type", params: { type: "null" } }),
        err({ instancePath: "", schemaPath: "#/anyOf", keyword: "anyOf", params: {} }),
      ],
      value,
      "anchor",
    );
    expect(errors).toEqual([{ path: "anchor.line", message: "must be at least 1" }]);
  });

  it("says the common rules the way a person would, and a limit of one as 'can't be empty'", () => {
    expect(messageOf(err({ keyword: "minLength", params: { limit: 1 } }), "")).toBe("can't be empty");
    expect(messageOf(err({ keyword: "minLength", params: { limit: 40 } }), "")).toBe("must be at least 40 characters");
    expect(messageOf(err({ keyword: "maximum", params: { comparison: "<=", limit: 1 } }), 1.5)).toBe("must be at most 1");
    expect(messageOf(err({ keyword: "enum", params: { allowedValues: ["blocker", "note"] } }), "x")).toBe("must be one of: blocker, note");
    expect(messageOf(err({ keyword: "type", params: { type: "number" } }), "1.5x")).toBe("'1.5x' is not a number");
    expect(messageOf(err({ keyword: "type", params: { type: "number" } }), "")).toBe("enter a number");
    expect(messageOf(err({ keyword: "type", params: { type: "integer" } }), 2.5)).toBe("must be a whole number");
    expect(messageOf(err({ keyword: "minItems", params: { limit: 1 } }), [])).toBe("needs at least one item");
    // A keyword with no wording of its own keeps the validator's, which is still true.
    expect(messageOf(err({ keyword: "dependentRequired", params: {}, message: "must have property b when a is present" }), {})).toBe(
      "must have property b when a is present",
    );
  });

  it("puts the first complaint and the count beside the button", () => {
    expect(checkBlocker({ pending: false, answered: true, errors: [] })).toBeNull();
    expect(checkBlocker({ pending: false, answered: true, errors: [{ path: "issue", message: "can't be empty" }] })).toBe("issue: can't be empty");
  });
});

describe("a fill_form as a schema", () => {
  const config: FillFormConfig = {
    component: "fill_form",
    prompt: "Describe the follow-up.",
    fields: [
      { name: "title", type: "string", label: "Title" },
      { name: "severity", type: "enum", enum: ["minor", "significant"] },
      { name: "store", type: "enum", enum: ["memory", "sqlite"], custom: true },
      { name: "estimate", type: "number" },
      { name: "blocking", type: "boolean", optional: true, default: true },
      { name: "notes", type: "string", multiline: true, optional: true },
    ],
  };
  const schema = fillFormSchema(config.fields) as Record<string, Record<string, Record<string, unknown>>>;

  it("restates the gate's contract in schema keywords", () => {
    expect(schema["required"]).toEqual(["title", "severity", "store", "estimate"]);
    expect(schema["properties"]!["title"]).toEqual({ type: "string", minLength: 1, title: "Title" });
    expect(schema["properties"]!["severity"]).toMatchObject({ enum: ["minor", "significant"] });
    // `custom` suggests rather than insists.
    expect(schema["properties"]!["store"]).toEqual({ type: "string", examples: ["memory", "sqlite"], minLength: 1 });
    expect(leafControlOf(schema["properties"]!["notes"]!)).toBe("multiline");
  });

  it("refuses an empty required answer exactly as the contract does", () => {
    // The contract reads `""` as not answered; `minLength: 1` is the schema's spelling of the same rule.
    expect(validateComponentResult(config, { title: "", severity: "minor", store: "redis", estimate: 2 }).ok).toBe(false);
    expect(validateComponentResult(config, { title: "t", severity: "minor", store: "redis", estimate: 2 }).ok).toBe(true);
  });
});
