/**
 * The parse behind the second reading of every data format.
 *
 * Two properties are worth more than everything else here. The first is that a broken document
 * produces a LOCATED complaint rather than a throw — a viewer with no answer draws a blank panel,
 * and the document most likely to be broken is the one somebody most wants read. The second is that
 * the things YAML can express and JSON cannot — anchors, merge keys, multi-document streams, cyclic
 * aliases — each get the treatment that is honest for them, because those are exactly the cases
 * where "translate it to JSON and use the JSON viewer" quietly produces the wrong document.
 */
import { describe, expect, it } from "vitest";
import {
  delimiterOf,
  parseDelimited,
  parseStructured,
  spotOf,
  structuredFormatOf,
} from "../src/structured";

describe("which grammar a type names", () => {
  it("resolves the registered types, the bare subtypes, and every vendor type built on them", () => {
    expect(structuredFormatOf("application/json")).toBe("json");
    expect(structuredFormatOf("application/yaml")).toBe("yaml");
    expect(structuredFormatOf("text/csv")).toBe("delimited");
    expect(structuredFormatOf("text/tab-separated-values")).toBe("delimited");
    // A slot declares `{contentMediaType: "yaml"}` and means it — see `structuredFormatOf`.
    expect(structuredFormatOf("yaml")).toBe("yaml");
    // The whole point of walking the fallback chain: a workflow file is YAML whatever else it is,
    // and nothing had to be added here for it to be.
    expect(structuredFormatOf("application/vnd.jaira.workflow+yaml")).toBe("yaml");
    expect(structuredFormatOf("application/vnd.jaira.workflow+json")).toBe("json");
    expect(structuredFormatOf("application/vnd.jaira.config+json")).toBe("json");
  });

  it("names no grammar for text that has none, which is what stops the reading being offered", () => {
    expect(structuredFormatOf("text/markdown")).toBeUndefined();
    expect(structuredFormatOf("text/plain")).toBeUndefined();
    expect(structuredFormatOf("text/x-typescript")).toBeUndefined();
    // The two deliberate absentees — see `StructuredFormat` on why a wrong parser is worse than none.
    expect(structuredFormatOf("application/toml")).toBeUndefined();
    expect(structuredFormatOf("text/x-ini")).toBeUndefined();
    expect(structuredFormatOf(undefined)).toBeUndefined();
  });

  it("takes the separator from the type, since only the type knows it", () => {
    expect(delimiterOf("text/csv")).toBe(",");
    expect(delimiterOf("text/tab-separated-values")).toBe("\t");
  });
});

describe("JSON", () => {
  it("reads the dialect the files in this repo are actually written in", () => {
    // Comments and a trailing comma: `settings.json` has the first and a model's ```json block
    // routinely has the second. `JSON.parse` refuses both, which would make the reading unavailable
    // exactly where it helps.
    const parsed = parseStructured('{\n  // the model to use\n  "model": "opus",\n}', "json");
    expect(parsed).toEqual({ ok: true, value: { model: "opus" } });
  });

  it("points at the first thing it could not read", () => {
    const parsed = parseStructured('{\n  "a": 1\n  "b": 2\n}', "json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.spot).toEqual({ line: 3, column: 3 });
  });

  it("calls an empty document empty rather than reading it as nothing", () => {
    // `jsonc-parser` answers `undefined` for empty input without complaining, and a viewer showing
    // "undefined" for a file somebody has not started typing is a worse answer than saying so.
    expect(parseStructured("   \n", "json").ok).toBe(false);
  });
});

describe("YAML", () => {
  it("resolves the things JSON has no syntax for, which is the whole reason the reading exists", () => {
    const source = [
      "defaults: &base",
      "  retries: 2",
      "  model: opus",
      "plan:",
      "  <<: *base",
      "  model: sonnet",
    ].join("\n");
    const parsed = parseStructured(source, "yaml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The merge key applied and the override won — neither is visible in the source without doing
    // this in your head, and that is the question this view answers.
    expect(parsed.value).toEqual({
      defaults: { retries: 2, model: "opus" },
      plan: { retries: 2, model: "sonnet" },
    });
  });

  it("reads a multi-document stream as a list, and says how many there were", () => {
    const parsed = parseStructured("kind: a\n---\nkind: b\n", "yaml");
    expect(parsed).toEqual({ ok: true, value: [{ kind: "a" }, { kind: "b" }], documents: 2 });
    // One document is itself, not a list of one.
    expect(parseStructured("kind: a\n", "yaml")).toEqual({ ok: true, value: { kind: "a" } });
  });

  it("keeps a block scalar as the text it is", () => {
    const parsed = parseStructured("prompt: |\n  first\n  second\n", "yaml");
    expect(parsed).toEqual({ ok: true, value: { prompt: "first\nsecond\n" } });
  });

  it("reports a syntax error with the line, rather than throwing", () => {
    // A tab where an indent should be is the mistake a model makes, and YAML's least helpful error.
    const parsed = parseStructured("a:\n\t- 1\n", "yaml");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toBeTruthy();
    expect(parsed.spot?.line).toBe(2);
  });

  it("refuses an alias bomb instead of hanging on it", () => {
    // A YAML graph expanded into a tree can be exponentially larger than its source — the classic
    // billion-laughs shape. `yaml`'s own maxAliasCount throws; the point of the test is that the
    // throw is caught and comes back as an answer a panel can draw.
    const source = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
    ].join("\n");
    const parsed = parseStructured(source, "yaml");
    expect(parsed.ok).toBe(false);
  });
});

describe("CSV and TSV", () => {
  it("handles the quoting, which is the only part that is hard", () => {
    const rows = parseDelimited('name,note\n"Ada","said ""hi"", then left"\n"multi\nline",plain\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Ada", 'said "hi", then left'],
      ["multi\nline", "plain"],
    ]);
  });

  it("counts rows the way a person would", () => {
    // A trailing newline ends the last row rather than starting a blank one…
    expect(parseDelimited("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // …and a file that just stops still ends in a row.
    expect(parseDelimited("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // An empty trailing field is a field.
    expect(parseDelimited("a,b,\n")).toEqual([["a", "b", ""]]);
    expect(parseDelimited("")).toEqual([]);
  });

  it("leaves a ragged row ragged, because that is usually the thing being looked for", () => {
    expect(parseDelimited("a,b\n1,2,3\n")).toEqual([
      ["a", "b"],
      ["1", "2", "3"],
    ]);
  });

  it("reads CRLF as the same table as LF", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("separates on tabs when asked to", () => {
    expect(parseStructured("a\tb\n1\t2\n", "delimited", "\t")).toEqual({
      ok: true,
      value: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
  });
});

describe("where a complaint points", () => {
  it("counts lines and columns from one, because a person reads them", () => {
    expect(spotOf("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(spotOf("abc", 2)).toEqual({ line: 1, column: 3 });
    expect(spotOf("ab\ncd", 3)).toEqual({ line: 2, column: 1 });
    // Past the end is clamped rather than answered with a negative column.
    expect(spotOf("ab", 99)).toEqual({ line: 1, column: 3 });
  });
});

describe("JSON Lines", () => {
  it("reads the file as the list of records it is", () => {
    const parsed = parseStructured('{"n":1}\n{"n":2}\n\n{"n":3}\n', "jsonl");
    expect(parsed).toEqual({ ok: true, value: [{ n: 1 }, { n: 2 }, { n: 3 }], documents: 3 });
  });

  it("fails the whole file on a bad line, and names it", () => {
    // Dropping the line and showing the rest would be lying about what the file contains.
    const parsed = parseStructured('{"n":1}\nnot json\n', "jsonl");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.spot?.line).toBe(2);
  });

  it("is a different reading from whole-file JSON, which is why it has its own type", () => {
    expect(structuredFormatOf("application/jsonl")).toBe("jsonl");
    // The same bytes as one JSON document are not a document at all.
    expect(parseStructured('{"n":1}\n{"n":2}\n', "json").ok).toBe(false);
  });
});
