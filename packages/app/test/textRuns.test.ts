/**
 * Long text cut into runs a phone can draw (`textRuns.ts`): bounded by characters AND lines, the text
 * kept whole across the cuts, and an empty line at a cut never lost.
 */
import { describe, expect, it } from "vitest";
import { runsOf, textRuns } from "../src/renderer/textRuns";

describe("textRuns", () => {
  it("leaves a short text whole", () => {
    expect(textRuns("one\ntwo")).toEqual(["one\ntwo"]);
    expect(textRuns("")).toEqual([""]);
  });

  it("cuts between lines, by characters and by lines, and joins back to the text", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const runs = textRuns(text, 1500, 40);
    expect(runs.map((r) => r.split("\n").length)).toEqual([40, 40, 20]);
    expect(runs.join("\n")).toBe(text);
    const wide = Array.from({ length: 10 }, () => "x".repeat(400)).join("\n");
    expect(textRuns(wide, 1500, 40).map((r) => r.length)).toEqual([400 * 3 + 2, 400 * 3 + 2, 400 * 3 + 2, 400]);
  });

  it("cuts a line longer than a run at its last space, else at the run's length", () => {
    const words = Array.from({ length: 50 }, () => "word").join(" ");
    const runs = textRuns(words, 100, 40);
    expect(runs.every((r) => r.length <= 100)).toBe(true);
    expect(runs.join("")).toBe(words);
    expect(runs[0]!.endsWith(" ")).toBe(true);
    expect(textRuns("y".repeat(250), 100, 40)).toEqual(["y".repeat(100), "y".repeat(100), "y".repeat(50)]);
  });

  it("starts the next run with the empty lines at a cut, where a trailing newline draws none", () => {
    const text = ["a", "b", "", "", "c", "d"].join("\n");
    const runs = textRuns(text, 1500, 3);
    // The next run takes them on, however many: a blank line is a run's cheapest.
    expect(runs).toEqual(["a\nb", "\n\nc\nd"]);
    expect(runs.join("\n")).toBe(text);
  });
});

describe("runsOf", () => {
  it("groups by size and count, an oversized item alone", () => {
    expect(runsOf([1, 2, 3, 10, 1], (n) => n, 5, 10)).toEqual([[1, 2], [3], [10], [1]]);
    expect(runsOf([1, 1, 1, 1], (n) => n, 100, 3)).toEqual([[1, 1, 1], [1]]);
  });
});
