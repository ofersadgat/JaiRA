/**
 * What the live-preview fold draws for the constructs that are BLOCKS.
 *
 * Testable in a node environment because `marks` is a pure function of `EditorState` — the whole
 * reason it is shaped that way. There is no DOM here (see `vitest.config.ts`), so this asserts on
 * the decoration set rather than on rendered lines, and the table widget is covered through the pure
 * helpers that decide what it will draw rather than through `toDOM`.
 */
import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { CodeFence, columnAlign, fenceLanguage, marks, rowCells, TableBlock } from "../src/renderer/markdownEditor";

const LANGUAGE = markdown({ base: markdownLanguage, codeLanguages: fenceLanguage });

function stateOf(text: string, caret?: number): EditorState {
  return EditorState.create({
    doc: text,
    ...(caret === undefined ? {} : { selection: { anchor: caret } }),
    extensions: [LANGUAGE],
  });
}

/** The decorations the editor would apply, as `[from, to, decoration]` triples. */
function bands(text: string, caret?: number): Array<{ from: number; to: number; deco: Decoration }> {
  const found: Array<{ from: number; to: number; deco: Decoration }> = [];
  const cursor = marks(stateOf(text, caret), caret !== undefined).iter();
  while (cursor.value !== null) {
    found.push({ from: cursor.from, to: cursor.to, deco: cursor.value });
    cursor.next();
  }
  return found;
}

/** Every line-decoration class applied, in document order. */
function lineClasses(text: string, caret?: number): string[] {
  return bands(text, caret)
    .filter((row) => row.from === row.to && (row.deco.spec as { class?: string }).class !== undefined)
    .map((row) => (row.deco.spec as { class: string }).class);
}

/** The source of every range the fold hides. */
function hidden(text: string, caret?: number): string[] {
  return bands(text, caret)
    .filter((row) => row.from < row.to && (row.deco.spec as { block?: boolean }).block !== true)
    .map((row) => text.slice(row.from, row.to));
}

describe("blockquotes", () => {
  it("bands every line of the quote", () => {
    expect(lineClasses("> one\n> two\n")).toEqual(["cm-quote-line", "cm-quote-line"]);
  });

  it("hides the `>` AND the space after it, now that the border replaces both", () => {
    expect(hidden("> quoted")).toContain("> ");
  });

  it("replaces the list bullet with a drawn one rather than hiding it", () => {
    // The mark IS replaced now — by a widget that draws a dot. What must not happen is the list
    // losing its bullet, and drawing one is a better answer to that than showing the hyphen.
    const mark = bands("- item").find((row) => row.from === 0 && row.to === 1);
    expect((mark?.deco.spec as { widget?: unknown }).widget).toBeDefined();
  });
});

describe("fenced code", () => {
  it("replaces the whole fence, delimiters included — which is where the blank lines went", () => {
    const text = "```\nplain\n```";
    const block = bands(text).filter((row) => (row.deco.spec as { block?: boolean }).block === true);
    expect(block).toHaveLength(1);
    expect(block[0]!.from).toBe(0);
    expect(block[0]!.to).toBe(text.length);
    expect(block[0]!.deco.spec.widget).toBeInstanceOf(CodeFence);
    // Nothing is left banding or hiding inside a range that is no longer drawn.
    expect(lineClasses(text)).toEqual([]);
  });

  it("gives the widget the CONTENTS, not the delimiters — the range it writes back to", () => {
    const text = "```typescript\nconst a = 1;\n```";
    const block = bands(text).find((row) => (row.deco.spec as { block?: boolean }).block === true);
    // The trailing newline belongs to the closing delimiter rather than to the block, so a
    // write-back replacing this range leaves the ``` on a line of its own.
    expect((block!.deco.spec.widget as CodeFence).source).toBe("const a = 1;");
    expect((block!.deco.spec.widget as CodeFence).lang).toBe("typescript");
  });

  it("sends an untyped fence down the same route rather than treating it specially", () => {
    const block = bands("```\nplain\n```").find((row) => (row.deco.spec as { block?: boolean }).block === true);
    expect((block!.deco.spec.widget as CodeFence).lang).toBe("");
  });

  it("steps aside for the source when the caret is inside it", () => {
    const text = "```typescript\nconst a = 1;\n```";
    expect(bands(text, 3).filter((row) => (row.deco.spec as { block?: boolean }).block === true)).toEqual([]);
    expect(lineClasses(text, 3)).toEqual([
      "cm-code-line cm-code-open",
      "cm-code-line",
      "cm-code-line cm-code-close",
    ]);
  });

  it("shows the whole fence as source once you are in it, not just the caret's line", () => {
    // The delimiter line is two lines above the caret. Revealing only the caret's line would leave
    // the ``` hidden, and the language of a block could never be changed.
    expect(hidden("```typescript\nconst a = 1;\n```", 20)).toEqual([]);
  });
});

describe("tables", () => {
  it("replaces the whole table with a widget when the caret is elsewhere", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const block = bands(text).filter((row) => (row.deco.spec as { block?: boolean }).block === true);
    expect(block).toHaveLength(1);
    expect(block[0]!.from).toBe(0);
    expect(block[0]!.to).toBe(text.length);
    expect(block[0]!.deco.spec.widget).toBeInstanceOf(TableBlock);
  });

  it("steps aside for the source when the caret is inside it", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(bands(text, 3).filter((row) => (row.deco.spec as { block?: boolean }).block === true)).toEqual([]);
    expect(lineClasses(text, 3)).toEqual([
      "cm-table-line cm-table-head",
      "cm-table-line cm-table-rule",
      "cm-table-line",
    ]);
  });

  it("does not swallow a paragraph that merely follows the table", () => {
    const text = "| a |\n| --- |\n| 1 |\n\nafter";
    const block = bands(text).find((row) => (row.deco.spec as { block?: boolean }).block === true);
    expect(text.slice(block!.from, block!.to)).toBe("| a |\n| --- |\n| 1 |");
  });
});

describe("table cells", () => {
  it("drops the optional outer pipes, which GFM makes optional on both spellings", () => {
    expect(rowCells("| a | b |")).toEqual(["a", "b"]);
    expect(rowCells("a | b")).toEqual(["a", "b"]);
  });

  it("keeps an escaped pipe inside a cell rather than splitting on it", () => {
    expect(rowCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  it("keeps an interior empty cell, so the columns still line up", () => {
    expect(rowCells("| a |  | c |")).toEqual(["a", "", "c"]);
  });

  it("reads the alignment row", () => {
    expect(["---", ":---", ":---:", "---:"].map(columnAlign)).toEqual([null, "left", "center", "right"]);
  });
});

describe("a list's hanging indent", () => {
  /** The per-item `padding-left`, in `ch`, from the line decoration's inline style. */
  function indentOf(text: string): number[] {
    return bands(text)
      .filter((row) => (row.deco.spec as { class?: string }).class === "cm-item-line")
      .map((row) => {
        const style = (row.deco.spec as { attributes?: Record<string, string> }).attributes?.["style"] ?? "";
        // The declaration is a `calc` that adds the line's own inset — see the `ListItem` branch.
        return Number(/\+ (\d+)ch/u.exec(style)?.[1] ?? -1);
      });
  }

  it("hangs by the marker's width", () => {
    // `- ` is two characters drawn before the text.
    expect(indentOf("- one")).toEqual([2]);
  });

  it("counts a nested item's leading spaces, which are drawn", () => {
    expect(indentOf("- one\n  - two")).toEqual([2, 4]);
  });

  it("does NOT count a quote marker, which is hidden", () => {
    // `> - one`: the `> ` is replaced, so the rendering starts at the bullet. Counting it pushed
    // every bullet inside a blockquote off the left edge of the pane.
    expect(indentOf("> - one")).toEqual([2]);
  });

  it("does not count nested quote markers either", () => {
    expect(indentOf("> > - deep")).toEqual([2]);
  });

  it("hangs an ordered item by its number's width", () => {
    expect(indentOf("10. ten")).toEqual([4]);
  });
});
