/**
 * The YAML colourer that front matter is drawn with.
 *
 * The first block is the one that matters and looks the least interesting, exactly as in
 * `jsonHighlight.test.ts`: every token, joined back together, must reproduce the input character for
 * character. A renderer that silently drops a space is a renderer quietly editing the document it
 * claims to be showing, and no test of the interesting tokens would ever catch it.
 *
 * After that the tests are about the three things a line scanner can plausibly get wrong and that
 * matter most in this repo's files: a `#` that is a comment versus one that is not, a block scalar
 * whose body must not be re-read as keys, and the anchors and tags that are the reason YAML is not
 * JSON in the first place.
 */
import { describe, expect, it } from "vitest";
import { highlightYaml } from "../src/renderer/yamlHighlight";
import type { HighlightLine } from "../src/renderer/jsonHighlight";

const rendered = (lines: HighlightLine[]): string =>
  lines.map((line) => line.tokens.map((token) => token.text).join("")).join("\n");

const kindsOf = (lines: HighlightLine[], kind: string): string[] =>
  lines.flatMap((line) => line.tokens.filter((token) => token.kind === kind).map((token) => token.text));

describe("round-tripping", () => {
  const inputs = [
    "name: feature\ndescription: Build a thing\n",
    "# a header comment\nkey: value # a trailing one\n",
    "list:\n  - one\n  - two\n",
    "prompt: |\n  Line one.\n\n  Line three.\n",
    "quoted: 'it''s here'\ndouble: \"a \\\" b\"\n",
    "anchors: &base\n  a: 1\nmerged:\n  <<: *base\n",
    "url: http://example.com/x#y\n",
    "---\na: 1\n...\n",
    "  indented: true\n\ttabbed: nope\n",
    "",
    "\n\n",
    "no colon at all",
    "empty:\n",
    "tagged: !!timestamp 2001-12-14\n",
  ];

  for (const input of inputs) {
    it(`reproduces ${JSON.stringify(input.slice(0, 34))} exactly`, () => {
      expect(rendered(highlightYaml(input))).toBe(input);
    });
  }
});

describe("what gets which colour", () => {
  it("marks keys, and only where a colon actually ends one", () => {
    const lines = highlightYaml("name: feature\nurl: http://example.com/a\n");
    // `http` is not a key: the colon after it is followed by `/`, not by a space or a line end.
    expect(kindsOf(lines, "key")).toEqual(["name", "url"]);
  });

  it("tells a comment from a hash that is just a character", () => {
    const lines = highlightYaml("# whole line\nkey: value # trailing\nurl: http://x/#frag\ntext: 'a # b'\n");
    expect(kindsOf(lines, "comment")).toEqual(["# whole line", "# trailing"]);
  });

  it("keeps a block scalar's body as one scalar rather than re-reading it as keys", () => {
    // The shape every workflow file in this repo is full of. Colouring `Then: do this` inside a
    // prompt as a key would make the body look like structure it is not.
    const lines = highlightYaml("prompt: |\n  First: do this\n  Then: do that\nnext: 1\n");
    expect(kindsOf(lines, "key")).toEqual(["prompt", "next"]);
    expect(kindsOf(lines, "string")).toEqual(["  First: do this", "  Then: do that"]);
  });

  it("ends a block scalar when the indent comes back out", () => {
    const lines = highlightYaml("a:\n  body: |\n    text\n  after: 2\n");
    expect(kindsOf(lines, "key")).toEqual(["a", "body", "after"]);
  });

  it("gives anchors, aliases and tags their own colour", () => {
    // These are the parts of the language JSON has no word for — see `structured.ts`. A reader
    // scanning for them should not have to find them among the ordinary scalars.
    const lines = highlightYaml("base: &defaults\n  a: 1\nuse: *defaults\nwhen: !!timestamp 2001-12-14\n");
    expect(kindsOf(lines, "literal")).toEqual(["&defaults", "*defaults", "!!timestamp"]);
  });

  it("separates numbers, booleans and the words that only look like them", () => {
    const lines = highlightYaml("count: 3\nratio: -1.5e3\nflag: true\nnothing: ~\nname: true story\n");
    expect(kindsOf(lines, "number")).toEqual(["3", "-1.5e3"]);
    expect(kindsOf(lines, "literal")).toEqual(["true", "~"]);
    // `true story` is a sentence, not a boolean.
    expect(kindsOf(lines, "string")).toEqual(["true story"]);
  });

  it("marks the dashes of a sequence as structure, and the item beside them as a value", () => {
    const lines = highlightYaml("tools:\n  - Read\n  - Write\n");
    // The colon that ends `tools` is structure too, and comes first.
    expect(kindsOf(lines, "punct")).toEqual([":", "- ", "- "]);
    expect(kindsOf(lines, "string")).toEqual(["Read", "Write"]);
  });
});

describe("what a key means", () => {
  it("asks by PATH, so the same name under two parents is two different fields", () => {
    const seen: string[] = [];
    highlightYaml("operation:\n  model: opus\nmodel: sonnet\n", (path, key) => {
      seen.push([...path, key].join("."));
      return undefined;
    });
    expect(seen).toEqual(["operation", "operation.model", "model"]);
  });

  it("hangs the description off the line its key is on", () => {
    const lines = highlightYaml("model: opus\n", (_path, key) => (key === "model" ? "Which model to use" : undefined));
    expect(lines[0]?.hint).toBe("Which model to use");
    expect(lines[1]?.hint).toBeUndefined();
  });
});
