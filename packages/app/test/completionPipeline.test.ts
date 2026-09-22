/**
 * What the editor actually offers, end to end.
 *
 * The pieces were each tested alone and each passed while the feature stayed broken, which is the
 * usual shape of an integration gap: `cursorContext` produced a path, `propertiesOf` answered for a
 * path, and nobody checked they were talking about the same one. So this drives the exact chain the
 * component runs — text and a caret offset in, the list of offered keys out — over documents written
 * the way WORKFLOWS.md writes them.
 */
import { describe, expect, it } from "vitest";
import { propertiesOf, schemaById, type SchemaEntry } from "@jaira/shared";
import { cursorContext, siblingKeys } from "../src/renderer/jsonCursor";

/**
 * The component's suggestion logic, verbatim.
 *
 * Kept in step with `SchemaJsonEditor` by being the same four steps in the same order: locate the
 * cursor, refuse unless a quoted key is being typed, look the path up, drop what the object already
 * has and what the partial rules out.
 */
function offered(entry: SchemaEntry, marked: string): string[] {
  const cursor = marked.indexOf("|");
  const text = marked.replace("|", "");
  const context = cursorContext(text, cursor);
  if (!context.inKeyPosition || !context.quoted) return [];
  const present = new Set(siblingKeys(text, cursor));
  const partial = context.partial.toLowerCase();
  return propertiesOf(entry, context.path)
    .filter((property) => !present.has(property.key))
    .filter((property) => property.key.toLowerCase().startsWith(partial))
    .sort((a, b) => Number(b.expected) - Number(a.expected))
    .map((property) => property.key);
}

const state = (): SchemaEntry => schemaById("state")!;
const promptOp = (): SchemaEntry => schemaById("prompt-operation")!;

describe("inside a slot", () => {
  it("offers the slot's fields, which is the thing that was missing", () => {
    expect(offered(state(), '{ "inputs": { "issue": { "|')).toEqual([
      "schema",
      "kind",
      "binding",
      "default",
      "optional",
      "description",
      "name",
    ]);
  });

  it("offers them for an output too", () => {
    expect(offered(state(), '{ "outputs": { "plan_doc": { "|')).toContain("binding");
  });

  it("filters by what has been typed", () => {
    expect(offered(state(), '{ "inputs": { "issue": { "k|')).toEqual(["kind"]);
    expect(offered(state(), '{ "inputs": { "issue": { "de|')).toEqual(["default", "description"]);
  });

  it("drops fields the slot already has", () => {
    expect(offered(state(), '{ "inputs": { "issue": { "kind": "text", "|')).not.toContain("kind");
  });

  it("works with the document formatted as anyone would actually write it", () => {
    const text = [
      "{",
      '  "label": "Planning",',
      '  "inputs": {',
      '    "issue": {',
      '      "|',
      "",
    ].join("\n");
    expect(offered(state(), text)).toContain("optional");
  });

  it("offers nothing for the slot NAME, which is the author's to choose", () => {
    expect(offered(state(), '{ "inputs": { "|')).toEqual([]);
  });
});

describe("inside the other nested blocks", () => {
  it("offers a child's fields", () => {
    // `transitions` among them since a child mount can carry its own — the schema gained it, and the
    // completions read the schema.
    expect(offered(state(), '{ "children": { "goals": { "|')).toEqual([
      "state",
      "inputs",
      "async",
      "environment",
      "transitions",
    ]);
  });

  it("offers a transition's fields inside the array", () => {
    expect(offered(state(), '{ "transitions": [ { "|')).toEqual(["to", "when"]);
  });

  it("offers the operation's fields", () => {
    expect(offered(state(), '{ "operation": { "prom|')).toEqual(["prompt"]);
  });

  it("offers the operation's nested blocks", () => {
    expect(offered(state(), '{ "operation": { "permissions": { "|')).toEqual(["scopes"]);
    expect(offered(state(), '{ "operation": { "conversation": { "|')).toEqual(["mode", "artifacts"]);
  });

  it("offers a child environment's fields, three levels down", () => {
    expect(offered(state(), '{ "children": { "r": { "environment": { "mod|')).toEqual(["model"]);
  });
});

describe("the operation schema on its own", () => {
  it("offers the output slot's fields", () => {
    expect(offered(promptOp(), '{ "output": { "|')).toContain("kind");
  });

  it("offers a parameter's fields inside `input`", () => {
    // §4.3: each value in `operation.input` is a PARAMETER whose wiring goes under `binding`.
    expect(offered(promptOp(), '{ "input": { "prompt": { "|')).toContain("binding");
    expect(offered(promptOp(), '{ "input": { "prompt": { "bi|')).toEqual(["binding"]);
  });
});

describe("at the top level", () => {
  it("offers the document's own fields", () => {
    expect(offered(state(), '{ "|')).toContain("operation");
    expect(offered(state(), '{ "la|')).toEqual(["label"]);
  });

  it("stays quiet until the opening quote", () => {
    expect(offered(state(), "{ |")).toEqual([]);
    expect(offered(state(), '{ "label": "x",\n  |')).toEqual([]);
  });

  it("stays quiet in a value position", () => {
    expect(offered(state(), '{ "label": "|')).toEqual([]);
  });
});

describe("inside a slot's schema — a JSON Schema document of its own", () => {
  it("offers the schema keywords", () => {
    const keys = offered(state(), '{ "inputs": { "issue": { "schema": { "|');
    expect(keys).toContain("type");
    expect(keys).toContain("items");
    expect(keys).toContain("properties");
    expect(keys).toContain("enum");
  });

  it("offers x-type and NOT format", () => {
    // slotTypes.ts is emphatic: synonyms are `x-type`, never `format`. The subtype checker enforces
    // `x-type` and ignores `format`, and this app's ajv has no ajv-formats — so offering `format`
    // would invite writing a constraint that is checked by precisely nothing.
    const keys = offered(state(), '{ "inputs": { "issue": { "schema": { "|');
    expect(keys).toContain("x-type");
    expect(keys).not.toContain("format");
  });

  it("offers contentMediaType, the keyword that makes a slot a blob", () => {
    expect(offered(state(), '{ "outputs": { "report": { "schema": { "content|')).toEqual([
      "contentMediaType",
      "contentEncoding",
    ]);
  });

  it("recurses into items, so a list's element schema completes too", () => {
    expect(offered(state(), '{ "outputs": { "w": { "schema": { "items": { "|')).toContain("type");
  });

  it("recurses into a declared property's own schema", () => {
    expect(offered(state(), '{ "inputs": { "x": { "schema": { "properties": { "field": { "|')).toContain("type");
  });

  it("reaches the schema inside an operation parameter", () => {
    expect(offered(promptOp(), '{ "input": { "prompt": { "schema": { "|')).toContain("contentMediaType");
  });

  it("goes deep without losing the thread", () => {
    const deep = '{ "inputs": { "x": { "schema": { "items": { "properties": { "y": { "|';
    expect(offered(state(), deep)).toContain("x-type");
  });
});
