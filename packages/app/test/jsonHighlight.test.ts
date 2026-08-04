/**
 * The coloured layer, and the hints that ride along with it.
 *
 * The first test is the one that matters most and looks the least interesting: every token, joined
 * back together, must reproduce the input exactly. That layer sits BEHIND a transparent textarea, so
 * a single dropped or added character shifts the colour out from under the text — and the failure is
 * invisible in a unit test that only checks the interesting tokens.
 */
import { describe, expect, it } from "vitest";
import { highlightJson, splitTokensAt, type HighlightLine } from "../src/renderer/jsonHighlight";

/** The rendered text, exactly as the overlay would lay it out. */
const rendered = (lines: HighlightLine[]): string =>
  lines.map((line) => line.tokens.map((token) => token.text).join("")).join("\n");

const kindsOf = (lines: HighlightLine[], kind: string): string[] =>
  lines.flatMap((line) => line.tokens.filter((token) => token.kind === kind).map((token) => token.text));

describe("round-tripping", () => {
  const inputs = [
    '{"label": "Planning"}',
    '{\n  "label": "Planning",\n  "limits": { "timeout": 600 }\n}',
    '{ "a": [1, 2.5, -3, 1e4], "b": true, "c": null }',
    '{ "unterminated": "still typ',
    '{ "trailing": 1, }',
    "",
    "   ",
    "{{{[[[",
    '{ "escaped": "a \\" b", "after": 1 }',
    '{ "emoji": "★ ✦", "tab":\t"x" }',
  ];

  for (const input of inputs) {
    it(`reproduces ${JSON.stringify(input.slice(0, 32))} exactly`, () => {
      expect(rendered(highlightJson(input))).toBe(input);
    });
  }
});

describe("what gets coloured", () => {
  it("tells a key from a string value", () => {
    const lines = highlightJson('{ "label": "Planning" }');
    expect(kindsOf(lines, "key")).toEqual(['"label"']);
    expect(kindsOf(lines, "string")).toEqual(['"Planning"']);
  });

  it("does not call an unterminated string a key, because nothing has proved it one", () => {
    expect(kindsOf(highlightJson('{ "lab'), "key")).toEqual([]);
  });

  it("finds numbers and literals", () => {
    const lines = highlightJson('{ "a": -1.5e3, "b": true, "c": null }');
    expect(kindsOf(lines, "number")).toEqual(["-1.5e3"]);
    expect(kindsOf(lines, "literal")).toEqual(["true", "null"]);
  });

  it("splits tokens at newlines so a line never borrows another's text", () => {
    const lines = highlightJson('{\n  "a": 1\n}');
    expect(lines).toHaveLength(3);
    expect(lines[1]!.tokens.some((t) => t.text.includes("\n"))).toBe(false);
  });
});

describe("the hints", () => {
  /** A stand-in schema: `model` means one thing at the root and another inside `operation`. */
  const describe_ = (path: string[], key: string): string | undefined => {
    if (path.length === 0 && key === "label") return "display name on the board";
    if (path.join(".") === "operation" && key === "model") return "route-prefixed";
    if (path.join(".") === "transitions" && key === "when") return "a guard";
    return undefined;
  };

  it("attaches a key's description to the line it is on", () => {
    const lines = highlightJson('{\n  "label": "Planning"\n}', describe_);
    expect(lines[1]!.hint).toBe("display name on the board");
    expect(lines[0]!.hint).toBeUndefined();
  });

  it("resolves a key by its PATH, not just its name", () => {
    const lines = highlightJson('{\n  "operation": {\n    "model": "x"\n  }\n}', describe_);
    expect(lines[2]!.hint).toBe("route-prefixed");
  });

  it("gives a same-named key at another path no hint", () => {
    // `model` at the top level is not `operation.model`, and describing it as one would be a lie.
    const lines = highlightJson('{\n  "model": "x"\n}', describe_);
    expect(lines[1]!.hint).toBeUndefined();
  });

  it("resolves inside an object in an array", () => {
    const lines = highlightJson('{\n  "transitions": [\n    { "when": "x" }\n  ]\n}', describe_);
    expect(lines[2]!.hint).toBe("a guard");
  });

  it("keeps the first key's hint when a line holds several", () => {
    const lines = highlightJson('{ "label": "a", "other": "b" }', describe_);
    expect(lines[0]!.hint).toBe("display name on the board");
  });

  it("asks for nothing when no describer is supplied", () => {
    expect(highlightJson('{ "label": "a" }')[0]!.hint).toBeUndefined();
  });
});

describe("splitting a line at the caret", () => {
  const lineOf = (text: string) => highlightJson(text)[0]!.tokens;
  const joined = (tokens: { text: string }[]) => tokens.map((t) => t.text).join("");

  it("cuts a token in half when the caret is inside one", () => {
    // The case that motivates all of this: typing `"mod` leaves the caret inside a string token, and
    // a marker appended after the token would sit past the quote instead of at the caret.
    const tokens = lineOf('{ "mod');
    const { before, after } = splitTokensAt(tokens, 5);
    expect(joined(before)).toBe('{ "mo');
    expect(joined(after)).toBe("d");
  });

  it("keeps the halves reconstituting the line, at every column", () => {
    const text = '{ "label": "Planning", "n": 12 }';
    const tokens = lineOf(text);
    for (let column = 0; column <= text.length; column++) {
      const { before, after } = splitTokensAt(tokens, column);
      expect(joined(before) + joined(after), `column ${column}`).toBe(text);
      expect(joined(before).length, `column ${column}`).toBe(column);
    }
  });

  it("puts everything before the caret when the column is past the end of the line", () => {
    const tokens = lineOf("{}");
    const { before, after } = splitTokensAt(tokens, 99);
    expect(joined(before)).toBe("{}");
    expect(after).toEqual([]);
  });

  it("puts everything after it at column zero", () => {
    const tokens = lineOf("{}");
    const { before, after } = splitTokensAt(tokens, 0);
    expect(before).toEqual([]);
    expect(joined(after)).toBe("{}");
  });

  it("preserves each half's token kind, so the colour survives the cut", () => {
    const { before, after } = splitTokensAt(lineOf('"ab"'), 2);
    expect(before[0]!.kind).toBe("string");
    expect(after[0]!.kind).toBe("string");
  });

  it("handles an empty line", () => {
    const { before, after } = splitTokensAt([], 0);
    expect(before).toEqual([]);
    expect(after).toEqual([]);
  });
});
