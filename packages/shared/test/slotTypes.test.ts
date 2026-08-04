/**
 * The slot type vocabulary.
 *
 * Two properties carry the whole design, and both are about what the picker REFUSES to do:
 *
 *  1. Every type it offers round-trips — write the schema, read it back, get the same type. A
 *     vocabulary that cannot read its own output would relabel a slot on every save.
 *  2. Anything richer than the vocabulary reads as `null`, not as the nearest match. `null` is what
 *     makes the row read-only, and the row being read-only is what stops a dropdown from deleting a
 *     `properties` block it was never able to show.
 */
import { describe, expect, it } from "vitest";
import {
  ANY_TYPE,
  DEFAULT_MEDIA_TYPE,
  SLOT_TYPES,
  sameSchema,
  schemaForSlotType,
  slotTypeOf,
  TYPE_NAMES,
  type SlotType,
} from "../src/slotTypes";

describe("the vocabulary round-trips", () => {
  for (const { name } of SLOT_TYPES) {
    it(`${name}, alone and as a list`, () => {
      const type: SlotType = { name, list: false, ...(name === "artifact" ? { mediaType: DEFAULT_MEDIA_TYPE } : {}) };

      expect(slotTypeOf(schemaForSlotType(type))).toEqual(type);
      expect(slotTypeOf(schemaForSlotType({ ...type, list: true }))).toEqual({ ...type, list: true });
    });
  }

  it("reads an absent schema as the unconstrained type, and writes none back", () => {
    expect(slotTypeOf(undefined)).toEqual(ANY_TYPE);
    expect(schemaForSlotType(ANY_TYPE)).toBeUndefined();
  });

  it("tells 'a list of anything' apart from 'no schema'", () => {
    // Both are unconstrained in their element type; only one says the value is a list.
    expect(schemaForSlotType({ name: "any", list: true })).toEqual({ type: "array" });
    expect(slotTypeOf({ type: "array" })).toEqual({ name: "any", list: true });
  });
});

describe("synonyms", () => {
  it("carries a synonym as x-type, which the subtype checker enforces", () => {
    // `format` would be inert here — the checker ignores it and ajv is built without ajv-formats.
    expect(schemaForSlotType({ name: "url", list: false })).toEqual({ type: "string", "x-type": TYPE_NAMES.url });
    expect(schemaForSlotType({ name: "datetime", list: false })).toEqual({
      type: "number",
      "x-type": TYPE_NAMES.datetime,
    });
  });

  it("refuses a type name it does not know rather than reading it as the bare type", () => {
    // Reading `{type:"string","x-type":"Sha256"}` as plain text would drop the tag on the next save,
    // and the tag is the only thing stopping a bare string from being wired in.
    expect(slotTypeOf({ type: "string", "x-type": "Sha256" })).toBeNull();
  });
});

describe("artifacts", () => {
  it("keeps whatever media type the author wrote", () => {
    // `contentMediaType` IS the blob derivation (`kindFor`), so it is never normalized away.
    expect(slotTypeOf({ type: "string", contentMediaType: "image/png" })).toEqual({
      name: "artifact",
      list: false,
      mediaType: "image/png",
    });
  });

  it("carries contentEncoding through", () => {
    const schema = { type: "string", contentMediaType: "image/png", contentEncoding: "base64" };
    const type = slotTypeOf(schema);

    expect(type).toEqual({ name: "artifact", list: false, mediaType: "image/png", encoding: "base64" });
    expect(schemaForSlotType(type!)).toEqual(schema);
  });
});

describe("schemas outside the vocabulary", () => {
  // Each of these is a legal, useful schema the picker cannot represent. Reading any of them as the
  // nearest vocabulary type would mean deleting the part that made it worth writing.
  const rich: Array<[string, unknown]> = [
    ["an object with properties", { type: "object", properties: { a: { type: "string" } } }],
    ["an enum", { type: "string", enum: ["a", "b"] }],
    ["a bound", { type: "number", minimum: 0 }],
    ["a described slot", { type: "string", description: "the issue" }],
    ["a union", { anyOf: [{ type: "string" }, { type: "number" }] }],
    ["a tuple", { type: "array", prefixItems: [{ type: "string" }] }],
    ["a list of lists", { type: "array", items: { type: "array", items: { type: "string" } } }],
    ["a list of objects with properties", { type: "array", items: { type: "object", properties: {} } }],
    ["a $ref", { $ref: "$/types/plan.json" }],
    ["a schema that is not an object", "$/types/plan.json"],
  ];

  for (const [what, schema] of rich) {
    it(`reports ${what} as outside the vocabulary`, () => {
      expect(slotTypeOf(schema)).toBeNull();
    });
  }

  it("reads a bare {} as unconstrained", () => {
    expect(slotTypeOf({})).toEqual(ANY_TYPE);
  });
});

describe("sameSchema", () => {
  it("ignores key order, so a reformat does not read as a change", () => {
    expect(sameSchema({ type: "string", "x-type": "Url" }, { "x-type": "Url", type: "string" })).toBe(true);
  });

  it("separates absent from empty", () => {
    expect(sameSchema(undefined, {})).toBe(false);
    expect(sameSchema(undefined, undefined)).toBe(true);
  });

  it("sees a real difference", () => {
    expect(sameSchema({ type: "string" }, { type: "number" })).toBe(false);
  });
});
