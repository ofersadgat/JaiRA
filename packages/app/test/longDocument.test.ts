/**
 * The fact that made every long document render as raw markdown halfway down.
 *
 * `syntaxTree(state)` is the tree PARSED SO FAR, not the tree of the document: CodeMirror parses a
 * few thousand characters up front and extends lazily as the viewport moves. A fold that walks it
 * therefore sees a document that stops, and produces no decorations beyond that point.
 *
 * The live-preview field's answer is to recompute when the tree grows — see `livePreview`'s `update`
 * in `markdownEditor.tsx`. This pins the premise that fix rests on, because if `syntaxTree` ever
 * started returning a complete tree the recompute would look like dead weight and get removed again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { fenceLanguage, marks } from "../src/renderer/markdownEditor";

function stateOf(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: fenceLanguage })],
  });
}

function count(state: EditorState): number {
  let found = 0;
  const cursor = marks(state, false).iter();
  while (cursor.value !== null) {
    found++;
    cursor.next();
  }
  return found;
}

describe("a document longer than one parse", () => {
  it("is NOT parsed to the end on the first pass", () => {
    const text = readFileSync("LOOPS.md", "utf8");
    expect(text.length).toBeGreaterThan(10_000);
    expect(syntaxTree(stateOf(text)).length).toBeLessThan(text.length);
  });

  it("decorates only as far as the tree reaches, which is why the recompute exists", () => {
    const text = readFileSync("LOOPS.md", "utf8");
    const state = stateOf(text);
    const reach = syntaxTree(state).length;
    let last = 0;
    const cursor = marks(state, false).iter();
    while (cursor.value !== null) {
      last = Math.max(last, cursor.to);
      cursor.next();
    }
    // Nothing past the parse, and something before it: the fold is right about what it can see.
    expect(last).toBeLessThanOrEqual(reach);
    expect(count(state)).toBeGreaterThan(0);
  });

  it("decorates the whole of a document short enough to be parsed in one go", () => {
    const text = "# Title\n\nSome **bold** text.\n\n> a quote\n";
    const state = stateOf(text);
    expect(syntaxTree(state).length).toBe(text.length);
    expect(count(state)).toBeGreaterThan(3);
  });
});
