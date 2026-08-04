/**
 * Locating the cursor in a document that does not parse.
 *
 * Every case here is mid-edit text, because that is the only kind this function ever sees — asking
 * where the cursor is in a *valid* document is a question nobody has. The two behaviours worth
 * guarding are the path (so suggestions come from the right part of the schema) and the refusal to
 * suggest in a value position (so accepting one never produces `"model": temperature`).
 */
import { describe, expect, it } from "vitest";
import { cursorContext, siblingKeys } from "../src/renderer/jsonCursor";

/** Marks the cursor with `|`, which reads far better than counting characters. */
const at = (marked: string) => {
  const cursor = marked.indexOf("|");
  return cursorContext(marked.replace("|", ""), cursor);
};

describe("the path to the cursor", () => {
  it("is empty at the top level", () => {
    expect(at('{ "la|" }').path).toEqual([]);
  });

  it("names the object the cursor is inside", () => {
    expect(at('{ "operation": { "mod|" } }').path).toEqual(["operation"]);
  });

  it("nests", () => {
    expect(at('{ "operation": { "session": { "x|" } } }').path).toEqual(["operation", "session"]);
  });

  it("borrows the array's key for an object inside it", () => {
    // `transitions` describes its items, so an object at transitions[0] answers to `transitions`.
    expect(at('{ "transitions": [ { "wh|" } ] }').path).toEqual(["transitions"]);
  });

  it("survives an unclosed document, which is the normal case while typing", () => {
    expect(at('{ "operation": { "mod|').path).toEqual(["operation"]);
    expect(at('{ "operation": {\n  "prompt": "hi",\n  "mo|').path).toEqual(["operation"]);
  });

  it("leaves a closed block behind", () => {
    expect(at('{ "operation": { "model": "x" }, "la|" }').path).toEqual([]);
  });
});

describe("whether a name belongs at the cursor", () => {
  it("is a key position right after an opening brace or a comma", () => {
    expect(at('{ |').inKeyPosition).toBe(true);
    expect(at('{ "label": "x", |').inKeyPosition).toBe(true);
  });

  it("is NOT a key position after a colon", () => {
    // The case that makes this worth computing: suggesting here would write a bare word as a value.
    expect(at('{ "model": |').inKeyPosition).toBe(false);
    expect(at('{ "model": "an|').inKeyPosition).toBe(false);
  });

  it("is not a key position inside an array of values", () => {
    expect(at('{ "sequence": [ "a", |').inKeyPosition).toBe(false);
  });

  it("reports a key position again inside an object in an array", () => {
    expect(at('{ "transitions": [ { |').inKeyPosition).toBe(true);
  });
});

describe("whether the name is being typed inside its quotes", () => {
  // The editor only offers completions once this is set. A bare key position — after `{` or a comma,
  // with nothing typed — is also somewhere a name belongs, but opening the menu there means it is
  // open whenever the caret rests on a blank line inside an object, and the arrow keys belong to the
  // menu while it is. Waiting for the quote gives the arrows back everywhere except mid-word.
  it("is false at a key position with nothing typed", () => {
    expect(at("{ |").inKeyPosition).toBe(true);
    expect(at("{ |").quoted).toBe(false);
    expect(at('{ "label": "x",\n  |').quoted).toBe(false);
  });

  it("is true once the opening quote is typed", () => {
    expect(at('{ "|').quoted).toBe(true);
    expect(at('{ "mod|').quoted).toBe(true);
    expect(at('{ "operation": { "mo|').quoted).toBe(true);
  });

  it("stays true when the closing quote has been typed too", () => {
    expect(at('{ "mod"|').quoted).toBe(true);
  });

  it("is false for a bare word, which has not passed a quote", () => {
    expect(at("{ lab|").quoted).toBe(false);
  });

  it("is false in a value position however much is typed", () => {
    expect(at('{ "model": "an|').quoted).toBe(false);
  });
});

describe("the partial name", () => {
  it("reads what has been typed inside an unterminated quote", () => {
    const context = at('{ "operation": { "mod|');
    expect(context.partial).toBe("mod");
    expect(context.inKeyPosition).toBe(true);
  });

  it("reads a name typed without quotes, so completion works before you type one", () => {
    expect(at("{ lab|").partial).toBe("lab");
  });

  it("is empty when nothing has been typed yet", () => {
    expect(at('{ "label": "x",\n  |').partial).toBe("");
  });

  it("points at where the name began, so accepting one replaces it", () => {
    const marked = '{ "mod|';
    const context = cursorContext(marked.replace("|", ""), marked.indexOf("|"));
    expect(context.partialStart).toBe(2);
  });

  it("treats a name whose closing quote was typed as still being the name", () => {
    // Otherwise the list would show every key and then insert one AFTER the quotes: `"mod""model": `.
    const context = at('{ "mod|');
    expect(context.partial).toBe("mod");
    const closed = at('{ "mod"|');
    expect(closed.partial).toBe("mod");
    expect(closed.inKeyPosition).toBe(true);
    expect(closed.partialStart).toBe(2);
  });

  it("is not confused by a brace inside a string", () => {
    expect(at('{ "prompt": "a { b", "la|').path).toEqual([]);
    expect(at('{ "prompt": "a { b", "la|').partial).toBe("la");
  });
});

describe("siblingKeys", () => {
  it("lists what the enclosing object already has", () => {
    const marked = '{ "label": "x", "description": "y", "|" }';
    expect(siblingKeys(marked.replace("|", ""), marked.indexOf("|"))).toEqual(["label", "description"]);
  });

  it("ignores keys of nested objects", () => {
    const marked = '{ "operation": { "model": "x" }, "|" }';
    expect(siblingKeys(marked.replace("|", ""), marked.indexOf("|"))).toEqual(["operation"]);
  });

  it("lists the inner object's keys when the cursor is inside it", () => {
    const marked = '{ "operation": { "model": "x", "|" } }';
    expect(siblingKeys(marked.replace("|", ""), marked.indexOf("|"))).toEqual(["model"]);
  });

  it("handles an object that is not closed yet", () => {
    const marked = '{ "label": "x", "|';
    expect(siblingKeys(marked.replace("|", ""), marked.indexOf("|"))).toEqual(["label"]);
  });
});
