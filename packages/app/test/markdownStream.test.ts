import { describe, expect, it } from "vitest";
import { parseMarkdown, type Token } from "../src/renderer/markdownParse";
import { closeInline, StreamParse, streamingText } from "../src/renderer/markdownStream";

/** A token as drawing sees it — not where in the source it came from, which a tail counts from its own start. */
const shape = (tokens: readonly Token[]): string[] =>
  tokens.map((t) => `${t.type}|${t.tag}|${t.level}|${t.nesting}|${t.markup}|${t.info}|${t.content}|${(t.children ?? []).map((c) => `${c.type}:${c.content}`).join(",")}`);

const DOCS: Record<string, string> = {
  answer: [
    "Here's what I found:",
    "- the parser runs on **every** frame",
    "- the blocks are keyed by `index`",
    "",
    "## Why it is slow",
    "",
    "Each delta re-parses the *whole* text. See [the docs](https://example.com/a_b).",
    "",
    "1. Parse once",
    "2. Keep the blocks",
    "",
    "   with a paragraph in the item",
    "",
    "3. Draw the end",
    "",
    "```ts",
    "const a = 1;",
    "",
    "function f() { return a; }",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> quoted",
    "lazy line",
    "",
    "Setext heading",
    "---",
    "",
    "    indented code",
    "",
    "Done.",
    "",
  ].join("\n"),
  lists: ["- a", "", "- b", "", "  continued", "- c", "", "* other list", "", "text", ""].join("\n"),
  fences: ["Text", "```", "unlabelled", "```", "", "~~~~yaml", "a: 1", "~~~", "~~~~", "", "after", ""].join("\n"),
};

describe("StreamParse", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(`parses ${name} as a whole parse would, at every length`, () => {
      const parse = new StreamParse();
      let settledAtSome = false;
      for (let n = 0; n <= doc.length; n += 1) {
        const text = doc.slice(0, n);
        const got = parse.parse(text);
        if (got.settled.length > 0) settledAtSome = true;
        expect(shape([...got.settled.flat(), ...got.tail]), `at ${n}: ${JSON.stringify(text.slice(-30))}`).toEqual(shape(parseMarkdown(text)));
      }
      expect(settledAtSome).toBe(true);
    });

    it(`parses ${name}, tidied as it streams, as a whole parse would — and still settles`, () => {
      const parse = new StreamParse();
      let settled = 0;
      for (let n = 0; n <= doc.length; n += 1) {
        const text = streamingText(doc.slice(0, n));
        const got = parse.parse(text);
        settled = Math.max(settled, got.settled.length);
        expect(shape([...got.settled.flat(), ...got.tail]), `at ${n}: ${JSON.stringify(text.slice(-30))}`).toEqual(shape(parseMarkdown(text)));
      }
      expect(settled).toBeGreaterThan(1);
    });
  }

  it("keeps a settled segment as the same array", () => {
    const parse = new StreamParse();
    // Settled only once the last block's first line is complete.
    expect(parse.parse("one\n\ntwo\n\nthr").settled).toEqual([]);
    const first = parse.parse("one\n\ntwo\n\nthree\nmo");
    const second = parse.parse("one\n\ntwo\n\nthree\nmore\n\nfour\nfi");
    expect(first.settled.length).toBeGreaterThan(0);
    expect(second.settled[0]).toBe(first.settled[0]);
  });

  it("starts over for a text that is not the last one grown", () => {
    const parse = new StreamParse();
    parse.parse("one\n\ntwo\n\nthree");
    const other = parse.parse("different\n\ntext");
    expect(shape([...other.settled.flat(), ...other.tail])).toEqual(shape(parseMarkdown("different\n\ntext")));
  });

  it("parses whole a text with a reference definition, which reaches back", () => {
    const parse = new StreamParse();
    const text = "see [x]\n\nmore\n\n[x]: https://example.com\n";
    parse.parse("see [x]\n\nmore\n\n");
    const got = parse.parse(text);
    expect(got.settled).toEqual([]);
    expect(shape(got.tail)).toEqual(shape(parseMarkdown(text)));
  });

  it("names the fence still waiting to be closed", () => {
    const parse = new StreamParse();
    expect(parse.parse("a\n\n```ts\nconst a").open?.type).toBe("fence");
    expect(new StreamParse().parse("a\n\n```ts\nconst a\n```").open).toBeUndefined();
    expect(new StreamParse().parse("a\n\n```ts\nconst a\n```\n").open).toBeUndefined();
    expect(new StreamParse().parse("```\n").open?.type).toBe("fence");
    // A shorter run of backticks does not close a longer fence.
    expect(new StreamParse().parse("````\na\n```\n").open?.type).toBe("fence");
  });
});

describe("closeInline", () => {
  it.each([
    ["**bold", "**bold**"],
    ["some **bold text ", "some **bold text**"],
    ["*it", "*it*"],
    ["_it", "_it_"],
    ["~~gone", "~~gone~~"],
    ["**bold *both", "**bold *both***"],
    ["***both", "***both***"],
    ["a `code", "a `code`"],
    ["**a `code", "**a `code`**"],
    ["see [the docs](https://exa", "see the docs"],
    ["a ![pic](https://x", "a"],
    ["a ![pi", "a"],
    // Dropped: an opener with nothing after it yet.
    ["text **", "text"],
    ["text `", "text"],
    // Left alone.
    ["**done** and *done*", "**done** and *done*"],
    ["2 * 3 * 4", "2 * 3 * 4"],
    ["snake_case_name", "snake_case_name"],
    ["`a*b` and `c`", "`a*b` and `c`"],
    ["[a link](https://x.y) after", "[a link](https://x.y) after"],
  ])("%j → %j", (input, want) => {
    expect(closeInline(input)).toBe(want);
  });
});

describe("streamingText", () => {
  it("holds back a last line that is only a marker", () => {
    expect(streamingText("Options:\n-")).toBe("Options:\n");
    expect(streamingText("Options:\n1.")).toBe("Options:\n");
    expect(streamingText("a\n\n#")).toBe("a\n\n");
    expect(streamingText("a\n\n```")).toBe("a\n\n");
    expect(streamingText("Options:\n- a")).toBe("Options:\n- a");
  });

  it("tidies only the last line", () => {
    expect(streamingText("**one\n\n**two")).toBe("**one\n\n**two**");
    expect(streamingText("**two\n")).toBe("**two**\n");
  });

  it("does not touch code in an open fence", () => {
    expect(streamingText("```py\nx = a ** b\ny = `")).toBe("```py\nx = a ** b\ny = `");
    expect(streamingText("```\ncode\n```\n**bold")).toBe("```\ncode\n```\n**bold**");
  });

  it("holds back a table header until its delimiter row", () => {
    expect(streamingText("a\n\n| x | y |")).toBe("a\n\n");
    expect(streamingText("a\n\n| x | y |\n|---|---|")).toBe("a\n\n| x | y |\n|---|---|");
  });
});
