import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { fenceLanguage, marks } from "../src/renderer/markdownEditor";

/**
 * The text an unfocused editor actually shows, reconstructed from the decorations.
 *
 * Every replaced range is dropped; a replacement carrying a widget contributes a space, which is
 * what {@link SoftBreak} draws. Block replacements contribute a placeholder, since what they show is
 * a mounted component rather than text.
 */
function shown(text: string, caret?: number): string {
  const state = EditorState.create({
    doc: text,
    ...(caret === undefined ? {} : { selection: { anchor: caret } }),
    extensions: [markdown({ base: markdownLanguage, codeLanguages: fenceLanguage })],
  });
  const cuts: Array<{ from: number; to: number; with: string }> = [];
  const cursor = marks(state, caret !== undefined).iter();
  while (cursor.value !== null) {
    const spec = cursor.value.spec as { block?: boolean; widget?: unknown; class?: string };
    // A MARK decoration also spans a range, and cutting one would delete the text it is merely
    // colouring — which is how the image test came back with the alt text gone. Only replacements
    // remove text, and nothing in this module gives a replacement a class.
    if (cursor.from < cursor.to && spec.class === undefined) {
      cuts.push({
        from: cursor.from,
        to: cursor.to,
        with:
          spec.block === true
            ? "␟"
            : spec.widget === undefined
              ? ""
              : // A widget contributes what it draws: a bullet its dot, a soft break its space.
                // A widget contributes what it draws, which it says for itself — see `SoftBreak.text`.
                ((spec.widget as { text?: string }).text ?? " "),
      });
    }
    cursor.next();
  }
  cuts.sort((a, b) => b.from - a.from);
  let out = text;
  for (const cut of cuts) out = out.slice(0, cut.from) + cut.with + out.slice(cut.to);
  return out;
}

describe("the README, as the editor draws it", () => {
  it("draws a link once, not twice", () => {
    expect(shown("- [SPEC.md](SPEC.md) — product spec")).toBe("• SPEC.md — product spec");
  });

  it("leaves a bare autolink alone, because its URL is its text", () => {
    expect(shown("see <https://example.com/x> now")).toBe("see https://example.com/x now");
  });

  it("keeps an inline link's label when the target differs from it", () => {
    expect(shown("[declarative-ai](https://github.com/ofersadgat/declarative-ai)")).toBe("declarative-ai");
  });

  it("joins a hard-wrapped list item into the one paragraph it is", () => {
    const text = "- [SPEC.md](SPEC.md) — product spec (the formalism is\n  normative in `d/SPEC.md`).";
    expect(shown(text)).toBe("• SPEC.md — product spec (the formalism is normative in d/SPEC.md).");
  });

  it("joins a hard-wrapped paragraph", () => {
    const text = "hierarchical workflows over agents\nwith durable tasks, and humans in\nthe loop.";
    expect(shown(text)).toBe("hierarchical workflows over agents with durable tasks, and humans in the loop.");
  });

  it("keeps a HARD break, which is the one break markdown means", () => {
    expect(shown("one  \ntwo")).toBe("one  \ntwo");
  });

  it("does not join across a blank line, which is a real paragraph boundary", () => {
    expect(shown("one\n\ntwo")).toBe("one\n\ntwo");
  });

  it("shows the source again on the lines being edited", () => {
    const text = "- [SPEC.md](SPEC.md) — spec";
    const state = EditorState.create({
      doc: text,
      selection: { anchor: 4 },
      extensions: [markdown({ base: markdownLanguage, codeLanguages: fenceLanguage })],
    });
    let cuts = 0;
    const cursor = marks(state, true).iter();
    while (cursor.value !== null) {
      if (cursor.from < cursor.to) cuts++;
      cursor.next();
    }
    expect(cuts).toBe(0);
  });
});

describe("decoration hygiene", () => {
  it("never produces a range that overlaps another, which CodeMirror rejects", () => {
    const text = [
      "# Title",
      "",
      "Text with [a link](target.md) that wraps",
      "  onto a second line.",
      "",
      "> a quote",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```text",
      "plain",
      "```",
      "",
      "- item one that is\n  wrapped",
    ].join("\n");
    const state = EditorState.create({
      doc: text,
      extensions: [markdown({ base: markdownLanguage, codeLanguages: fenceLanguage })],
    });
    // Building a set is itself the check: CodeMirror throws on ranges that partially overlap.
    expect(() => Decoration.set([], true)).not.toThrow();
    const found = marks(state, false);
    let last = -1;
    const cursor = found.iter();
    while (cursor.value !== null) {
      expect(cursor.from).toBeGreaterThanOrEqual(last);
      last = cursor.from;
      cursor.next();
    }
  });
});

describe("a blockquote that wraps", () => {
  it("joins with ONE space, not two", () => {
    // The continuation line is `> and no visible`. Swallowing only the whitespace left the space
    // after the marker behind, so every wrap inside a quote came out double-spaced.
    const text = "> A quote with a rule down its left margin\n> and no visible angle brackets.";
    expect(shown(text)).toBe("A quote with a rule down its left margin and no visible angle brackets.");
  });

  it("still hides the marker on a quote line that is NOT a continuation", () => {
    expect(shown("> one\n>\n> two")).toBe("one\n\ntwo");
  });

  it("handles a nested quote's continuation prefix", () => {
    expect(shown("> > deep quote that\n> > wraps here")).toBe("deep quote that wraps here");
  });
});

describe("list marks", () => {
  it("draws a bullet where the source has a hyphen", () => {
    expect(shown("- one\n- two")).toBe("\u2022 one\n\u2022 two");
  });

  it("draws one for every spelling of an unordered mark", () => {
    expect(shown("* star")).toBe("\u2022 star");
    expect(shown("+ plus")).toBe("\u2022 plus");
  });

  it("leaves an ordered list's number alone, because the number IS the content", () => {
    expect(shown("1. first\n2. second")).toBe("1. first\n2. second");
  });

  it("does not mistake emphasis for a bullet", () => {
    expect(shown("a *starred* word")).toBe("a starred word");
  });

  it("shows the source again on the line being edited", () => {
    expect(shown("- one\n- two", 2)).toContain("- one");
  });
});

describe("block markers take their trailing space", () => {
  it("leaves no margin in front of a heading", () => {
    expect(shown("### 3.1 Indexing")).toBe("3.1 Indexing");
  });

  it("leaves none in front of a quote", () => {
    expect(shown("> quoted")).toBe("quoted");
  });

  it("takes a Setext underline's whole row, not just its characters", () => {
    expect(shown("Title\n=====")).toBe("Title");
  });
});

describe("task lists", () => {
  it("draws a box, empty or ticked", () => {
    expect(shown("- [ ] todo\n- [x] done")).toBe("\u2022 \u2610 todo\n\u2022 \u2611 done");
  });

  it("accepts an upper-case X, which GFM does", () => {
    expect(shown("- [X] done")).toBe("\u2022 \u2611 done");
  });

  it("shows the brackets again on the line being edited", () => {
    expect(shown("- [ ] todo", 3)).toContain("[ ]");
  });
});

describe("links of every kind", () => {
  it("hides a reference link's label, which is its target", () => {
    expect(shown("a [reference link][ref] here")).toBe("a reference link here");
  });

  it("hides an inline link's target", () => {
    expect(shown("a [text](target.md) here")).toBe("a text here");
  });

  it("hides a link's title as well as its target", () => {
    expect(shown('a [text](target.md "the title") here')).toBe("a text here");
  });

  it("keeps an autolink whole, because its URL is its text", () => {
    expect(shown("see <https://example.com/x>")).toBe("see https://example.com/x");
  });

  it("leaves an image's alt text and drops its path", () => {
    expect(shown("An image: ![alt text](picture.png)")).toBe("An image: alt text");
  });

  it("leaves a link DEFINITION exactly as written", () => {
    expect(shown("[ref]: https://example.com/ref")).toBe("[ref]: https://example.com/ref");
  });
});

describe("setext headings", () => {
  it("takes the underline's row with it, rather than leaving a blank line", () => {
    expect(shown("Setext one\n==========\n\nafter")).toBe("Setext one\n\nafter");
  });

  it("does the same for the second level", () => {
    expect(shown("Setext two\n----------\n\nafter")).toBe("Setext two\n\nafter");
  });

  it("shows the underline again when the caret is on the title", () => {
    expect(shown("Setext one\n==========", 2)).toContain("==========");
  });
});
