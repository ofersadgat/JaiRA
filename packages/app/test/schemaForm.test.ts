/**
 * The generic form, against the schemas this app actually has.
 *
 * It was ported from a project whose schemas were written FOR a form: flat objects of scalars, every
 * shape spelled out where it is used. `shared/schemas.ts` is not that. Those documents are written
 * for an editor's completion and for validation, so a shape used twice is declared once under
 * `definitions` and referred to, every leaf is a choice of shapes (the value itself, or a binding
 * that produces it), and the maps a state is mostly made of (`inputs`, `outputs`) carry no
 * `properties` at all, because the keys are the author's.
 *
 * The form itself is the universal tree's (`components/form/SchemaForm.tsx`) and is not drawn here.
 * What is held is what it ASKS `schemaForm/model.ts` on the way down a real document, and on the
 * form somebody fills in: where a reference leads, what a map's rows answer to, which members may be
 * left out, what a row with a complaint in it is. `schemaFormModel.test.ts` holds the model's rules
 * one function at a time; these are the same questions asked of the documents that broke the form.
 *
 * Not held here, because the form decides them itself: that a reference already expanded on the way
 * down is not expanded again (what stops a render of a self-referring schema), that a READING draws
 * only what its document states and no switches or chips, and what the switch, the ↺, the
 * provenance mark and the source chip look like.
 */
import { describe, expect, it } from "vitest";
import { schemaById } from "@jaira/shared/browser";
import {
  branchesOf,
  branchIndexFor,
  deref,
  flatten,
  isComposite,
  isWithin,
  itemPath,
  leafControlOf,
  mapSchema,
  seedFor,
  shortText,
  singleShapeOf,
  typeHintOf,
} from "../src/renderer/schemaForm/model";
import { presentationFor } from "../src/renderer/schemaForm/presentation";
import type { Schema } from "../src/renderer/schemaForm/types";

const STATE = schemaById("state")!.document as unknown as Schema;
const JSON_SCHEMA = "#/definitions/jsonSchema";

/** The document a form is a reading OF — a small state, with both kinds of map filled in. */
const DOC = {
  label: "Review the changeset",
  inputs: { changeset: { schema: { type: "object" } } },
  outputs: { verdict: { schema: { type: "string" } } },
  operation: { kind: "prompt", prompt: "Read the diff." },
};

/** A node as the form resolves it: its reference followed, and a one-shape union unwrapped. */
const resolved = (schema: Schema): Schema => singleShapeOf(deref(schema, STATE), STATE);

/** The shape the form draws a value in — of a choice of shapes, the one the value is already in. */
const shapeFor = (schema: Schema, value: unknown): Schema => {
  const node = resolved(schema);
  const branches = branchesOf(node, STATE);
  return branches === undefined ? node : branches[branchIndexFor(branches, value, STATE)]!;
};

const membersOf = (schema: Schema): Record<string, Schema> => flatten(schema, undefined, STATE).properties;

/** One slot of the state schema, reached the way the form reaches it: the map, then what every key of it answers to. */
const slotOf = (map: "inputs" | "outputs", key: string): Schema => {
  const held = DOC[map] as Record<string, unknown>;
  return shapeFor(mapSchema(shapeFor(membersOf(STATE)[map]!, held), STATE)!, held[key]);
};

describe("a form built from one of this app's own schemas", () => {
  it("terminates on a schema that refers to itself", () => {
    // A slot's `schema` member is a JSON Schema describing JSON Schema, whose `items` refers back to
    // it. Following a reference is ONE step — the node it names, with its own references still
    // references — so asking about a member of it never walks the document for ever.
    const items = membersOf(deref({ $ref: JSON_SCHEMA }, STATE))["items"]!;
    expect(items["$ref"]).toBe(JSON_SCHEMA);
    const followed = deref(items, STATE);
    expect(followed["$ref"]).toBeUndefined();
    expect(membersOf(followed)["items"]!["$ref"]).toBe(JSON_SCHEMA);
    // What the form asks of the member before it draws it, each of which answers.
    expect(isComposite(items, STATE)).toBe(true);
    expect(seedFor(items, STATE)).toEqual({});
    expect(typeHintOf(items, STATE)).toBe("");
    // A reference that names ITSELF has no node to arrive at. It comes back as it was, not as a hang.
    const loop: Schema = { definitions: { a: { $ref: "#/definitions/a" } } };
    expect(deref({ $ref: "#/definitions/a" }, loop)).toEqual({ $ref: "#/definitions/a" });
  });

  it("follows a reference, so a member declared once still draws", () => {
    // `inputs.changeset` is a slot, and what a slot's `schema` may be is declared once, under
    // `definitions`. Before references were followed this was an object with no properties: a heading
    // with nothing beneath it.
    const said = membersOf(slotOf("inputs", "changeset"))["schema"]!;
    expect(presentationFor(undefined, "schema", resolved(said)).tooltip).toContain("JSON Schema for the value");
    const shape = shapeFor(said, DOC.inputs.changeset.schema);
    expect(Object.keys(membersOf(shape))).toEqual(expect.arrayContaining(["type", "properties", "items", "enum"]));
  });

  it("draws the members of a MAP, whose keys are the author's", () => {
    // `inputs` and `outputs` have no `properties` — every key is the author's, described by
    // `additionalProperties`. So nothing declared claims `changeset` or `verdict`, the rows are the
    // value's own keys, and each is drawn as the one schema every key answers to: a slot.
    for (const map of ["inputs", "outputs"] as const) {
      const node = shapeFor(membersOf(STATE)[map]!, DOC[map]);
      expect(membersOf(node)).toEqual({});
      expect(mapSchema(node, STATE)).toBeDefined();
    }
    expect(Object.keys(membersOf(slotOf("inputs", "changeset")))).toContain("schema");
    expect(Object.keys(membersOf(slotOf("outputs", "verdict")))).toContain("binding");
  });
});

/**
 * A form somebody fills in — a state's inputs, as the Run panel draws them.
 *
 * The real `feature` inputs, because they are the ones that broke: an `enum` slot drawn as a JSON box
 * refused `significant`, and a bounded number was never checked against its bounds. (What an enum's
 * box offers and what a bounded number says beside its name are in `schemaFormModel.test.ts`, on
 * these same two members.)
 */
describe("a form somebody fills in", () => {
  const FEATURE: Schema = {
    type: "object",
    properties: {
      issue: { type: "string", contentMediaType: "text/markdown", minLength: 1 },
      severity_threshold: { type: "string", enum: ["blocker", "significant", "minor", "note"], default: "significant" },
      threshold_rank: { type: "integer", default: 2 },
      ask_below: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
    },
    required: ["issue"],
  };

  it("knows which members may be left out — a switch goes before each — and which one is required and gets none", () => {
    const { properties, required } = flatten(FEATURE);
    expect([...required]).toEqual(["issue"]);
    expect(Object.keys(properties).filter((key) => !required.has(key))).toEqual(["severity_threshold", "threshold_rank", "ask_below"]);
  });

  it("reads the default a switched-off member gets as one short line", () => {
    // The form's note is "not set — the default applies: …"; what follows the colon is this.
    const { properties } = flatten(FEATURE);
    expect(shortText(properties["severity_threshold"]!["default"])).toBe("significant");
    expect(shortText(properties["ask_below"]!["default"])).toBe("0.8");
  });

  it("finds the chosen shape's fields to draw under a choice of shapes, and nothing to type where the shape is none", () => {
    const anchor: Schema = {
      anyOf: [
        { title: "path", type: "string" },
        { title: "path + line", type: "object", required: ["path", "line"], properties: { path: { type: "string" }, line: { type: "integer" } } },
        { type: "null" },
      ],
    };
    const branches = branchesOf(anchor)!;
    const held = branches[branchIndexFor(branches, { path: "runForm.ts", line: 221 })]!;
    expect(Object.keys(flatten(held).properties)).toEqual(["path", "line"]);
    // `null` is a shape like the others, and its control is a line saying what is sent, not a box.
    expect(leafControlOf(branches[branchIndexFor(branches, null)]!)).toBe("none");
  });

  it("opens a list at closed rows — unless a row has a problem in it", () => {
    const items: Schema = { type: "object", properties: { id: { type: "string" }, statement: { type: "string" } } };
    // Rows of this list open and close at all because an item is more than one line.
    expect(isComposite(items)).toBe(true);
    // The complaint is about a box INSIDE row 1, so row 1 is the troubled one and row 0 stays shut.
    const complaint = "criteria[1].id";
    expect(isWithin(complaint, itemPath("criteria", 1))).toBe(true);
    expect(isWithin(complaint, itemPath("criteria", 0))).toBe(false);
    // …and a row is not under another whose index its own begins with.
    expect(isWithin("criteria[10].id", itemPath("criteria", 1))).toBe(false);
  });

  it("reads a free-key object as rows that all answer to one schema, and starts an added key empty", () => {
    const env: Schema = { type: "object", additionalProperties: { type: "string" } };
    const every = mapSchema(env, undefined)!;
    expect(every).toEqual({ type: "string" });
    expect(seedFor(every)).toBe("");
    // `true` says a key may be there and not what its value looks like, so it makes no rows.
    expect(mapSchema({ type: "object", additionalProperties: true }, undefined)).toBeUndefined();
  });
});
