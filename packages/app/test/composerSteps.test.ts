/**
 * The composer on one line (the composer mockups, 2026-10-25: design 1, "words drop in steps"): every
 * word, then shorter words, then the model's name and icons, then icons alone — the first that fits.
 */
import { describe, expect, it } from "vitest";
import { chipStepOf, chipWordsAt, shortChipWords } from "../src/renderer/composerModel";

const WORDS = { model: "claude-cli/claude-opus-5-5", thinking: "the model's default", permissions: "full access", tools: "45 tools" };

describe("a chip's shorter words", () => {
  it("drop the model's route, the model's own level and the word tools", () => {
    expect(shortChipWords(WORDS)).toEqual({ model: "claude-opus-5-5", thinking: "default", permissions: "full access", tools: "45" });
    expect(shortChipWords({ ...WORDS, model: "no model configured", thinking: "high", tools: "default tools" })).toEqual({ model: "no model configured", thinking: "high", permissions: "full access", tools: "default" });
    expect(shortChipWords({ ...WORDS, tools: "no tools" }).tools).toBe("none");
    expect(shortChipWords({ ...WORDS, tools: "read_file" }).tools).toBe("read_file");
  });
});

describe("each chip's words at a step", () => {
  it("are every word, the shorter, the model's name alone, then none", () => {
    expect(chipWordsAt(WORDS, 0)).toEqual(WORDS);
    expect(chipWordsAt(WORDS, 1).model).toBe("claude-opus-5-5");
    expect(chipWordsAt(WORDS, 2)).toEqual({ model: "claude-opus-5-5", thinking: null, permissions: null, tools: null });
    expect(chipWordsAt(WORDS, 3)).toEqual({ model: null, thinking: null, permissions: null, tools: null });
  });
});

describe("the step that fits", () => {
  const chips = [
    { full: 190, short: 130, icon: 33 },
    { full: 140, short: 80, icon: 33 },
    { full: 100, short: 100, icon: 33 },
    { full: 90, short: 50, icon: 33 },
  ];
  // Every word: 520 + 15 of gaps; shorter: 360 + 15; the model's name and icons: 229 + 15; icons: 132 + 15.
  it("is the first whose chips fit the room", () => {
    expect(chipStepOf(600, chips, 5)).toBe(0);
    expect(chipStepOf(535, chips, 5)).toBe(0);
    expect(chipStepOf(534, chips, 5)).toBe(1);
    expect(chipStepOf(300, chips, 5)).toBe(2);
    expect(chipStepOf(200, chips, 5)).toBe(3);
    expect(chipStepOf(40, chips, 5)).toBe(3);
  });
  it("counts the live note's words only while the chips have words", () => {
    expect(chipStepOf(600, chips, 5, 100)).toBe(1);
    expect(chipStepOf(300, chips, 5, 100)).toBe(2);
  });
});
