/**
 * The word-level refinement behind the markdown editor's diff reading.
 *
 * The stored hunks are LINE ranges — the right unit for applying a change, the wrong unit for
 * reading prose, where a one-word fix showed the whole paragraph struck through and then again
 * intact. This turns them into positions in the NEW text, which is what lets the editor stay
 * editable while showing what changed.
 *
 * `diffSpans` is pure and lives where it can be tested without a DOM; everything around it in
 * `markdownEditor.tsx` is CodeMirror wiring.
 */
import { describe, expect, it } from "vitest";
import { diffSpans } from "../src/renderer/markdownEditor";

/** What the editor would paint: the added ranges resolved against the new text, and the cut text. */
function reading(before: string, after: string, hunks: { start: number; end: number; text: string }[]) {
  const spans = diffSpans({ before, after, hunks });
  return {
    added: spans.added.map(([from, to]) => after.slice(from, to)),
    removed: spans.removed.map((cut) => cut.text),
    at: spans.removed.map((cut) => cut.at),
  };
}

describe("diffSpans", () => {
  it("marks only the WORDS that changed, not the whole line", () => {
    const before = "The probe runs on open.\n";
    const after = "The probe runs on close.\n";
    // One line-granular hunk, as the text strategy would produce it.
    const spans = reading(before, after, [{ start: 0, end: before.length, text: after }]);
    expect(spans.added).toEqual(["close"]);
    expect(spans.removed).toEqual(["open"]);
  });

  it("puts the added range at an offset that resolves in the NEW text", () => {
    const before = "one two three\n";
    const after = "one TWO three\n";
    const spans = diffSpans({ before, after, hunks: [{ start: 0, end: before.length, text: after }] });
    for (const [from, to] of spans.added) {
      expect(after.slice(from, to)).toBe("TWO");
    }
  });

  it("drifts later hunks by how much earlier ones grew", () => {
    const before = "aaa\nbbb\nccc\n";
    const after = "aaaaaaaa\nbbb\nZZZ\n";
    const spans = diffSpans({
      before,
      after,
      hunks: [
        { start: 0, end: 4, text: "aaaaaaaa\n" },
        { start: 8, end: 12, text: "ZZZ\n" },
      ],
    });
    // The point is that every mark still resolves to text that is actually THERE. Without the drift
    // the second hunk's marks land four characters early, inside `bbb` — a mark pointing at a line
    // nobody touched, which is the failure this arithmetic exists to prevent.
    const marked = spans.added.map(([from, to]) => after.slice(from, to));
    expect(marked).toEqual(["aaaaaaaa", "ZZZ"]);
    expect(spans.removed.map((cut) => cut.text)).toEqual(["aaa", "ccc"]);
    // And the cut text is offered where the cut happened, not at a stale offset.
    for (const cut of spans.removed) {
      expect(cut.at).toBeLessThanOrEqual(after.length);
    }
  });

  it("reports a pure insertion as added with nothing removed", () => {
    const before = "one\n";
    const after = "one\ntwo\n";
    const spans = reading(before, after, [{ start: 4, end: 4, text: "two\n" }]);
    expect(spans.removed).toEqual([]);
    expect(spans.added.join("")).toContain("two");
  });

  it("reports a pure deletion as removed with nothing added", () => {
    const before = "one\ntwo\n";
    const after = "one\n";
    const spans = reading(before, after, [{ start: 4, end: 8, text: "" }]);
    expect(spans.added).toEqual([]);
    expect(spans.removed.join("")).toContain("two");
  });

  it("says nothing at all when nothing changed", () => {
    expect(diffSpans({ before: "same\n", after: "same\n", hunks: [] })).toEqual({ added: [], removed: [] });
  });

  it("keeps whitespace out of the marks, so a mark points at a word", () => {
    const before = "cache the probe\n";
    const after = "cache the probes\n";
    const spans = reading(before, after, [{ start: 0, end: before.length, text: after }]);
    // `probe` → `probes` is one word replaced, not a phrase with its spaces.
    expect(spans.added).toEqual(["probes"]);
    expect(spans.removed).toEqual(["probe"]);
  });

  it("falls back to whole-region replacement on a pathological pair rather than hanging", () => {
    const before = `${"x ".repeat(900)}\n`;
    const after = `${"y ".repeat(900)}\n`;
    const spans = diffSpans({ before, after, hunks: [{ start: 0, end: before.length, text: after }] });
    expect(spans.added.length).toBe(1);
    expect(spans.removed.length).toBe(1);
  });
});
