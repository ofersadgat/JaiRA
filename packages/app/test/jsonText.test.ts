/**
 * Editing a JSON value in a text box.
 *
 * The property that matters is the round trip. A box that shows the string `3` as bare `3` would
 * read it back as the NUMBER 3 and silently retype the slot it belongs to — so the interesting cases
 * here are all strings that look like something else.
 */
import { describe, expect, it } from "vitest";
import { jsonTextOf, jsonValueOf, listOf, listTextOf } from "../src/renderer/jsonText";

describe("jsonText round trip", () => {
  const values: Array<[string, unknown]> = [
    ["a bare word", "significant"],
    ["a sentence", "the issue to plan against"],
    ["a number", 3],
    ["a negative number", -2.5],
    ["a boolean", true],
    ["null", null],
    ["an array", ["a", "b"]],
    ["an object", { depth: 3 }],
    ["an empty object", {}],
    ["an empty array", []],
    // Every one of these is a STRING that JSON would parse as something else.
    ["the string '3'", "3"],
    ["the string 'true'", "true"],
    ["the string 'null'", "null"],
    ["the string '[]'", "[]"],
    ["a quoted string", '"quoted"'],
    ["the empty string", ""],
  ];

  for (const [what, value] of values) {
    it(`survives ${what}`, () => {
      expect(jsonValueOf(jsonTextOf(value))).toEqual(value);
    });
  }

  it("shows an ordinary string without quoting ceremony", () => {
    // WORKFLOWS.md writes `"default": "significant"`; typing `"significant"` for it is the tax this
    // avoids, and the tax is what pushes people onto the JSON tab for everything.
    expect(jsonTextOf("significant")).toBe("significant");
    expect(jsonValueOf("significant")).toBe("significant");
  });

  it("quotes exactly the strings that would come back as something else", () => {
    expect(jsonTextOf("3")).toBe('"3"');
    expect(jsonTextOf("hello")).toBe("hello");
  });

  it("separates an empty box from an empty string", () => {
    // The empty box means "not declared". An empty string is a value, so it cannot be shown as one.
    expect(jsonValueOf("")).toBeUndefined();
    expect(jsonTextOf(undefined)).toBe("");
    expect(jsonTextOf("")).toBe('""');
  });

  it("reads unparseable text as the string it is", () => {
    expect(jsonValueOf("{ not json")).toBe("{ not json");
    expect(jsonValueOf("  padded  ")).toBe("padded");
  });
});

describe("lists", () => {
  it("round-trips a list of names", () => {
    expect(listOf(listTextOf(["read_file", "run_command"]))).toEqual(["read_file", "run_command"]);
  });

  it("tolerates whatever spacing someone types", () => {
    expect(listOf("a ,b,  c ")).toEqual(["a", "b", "c"]);
  });

  it("reads an empty box as absent", () => {
    expect(listOf("")).toBeUndefined();
    expect(listOf("  ,  ")).toBeUndefined();
    expect(listTextOf(undefined)).toBe("");
  });
});
