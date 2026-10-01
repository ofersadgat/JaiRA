import { describe, expect, it } from "vitest";
import { filterSuggestions, nextLine, placeSuggestions, previousLine, suggestionsFrom } from "../src/components/form/suggestModel";

/**
 * The rules of the type-ahead (`form/Suggest.tsx`), each as Chromium and Electron apply them to an
 * `<input list>` on the desktop — the popup photographed there is what these were read from.
 */
describe("a datalist's type-ahead", () => {
  const options = suggestionsFrom(["option-5-five", "option-15", "claude-opus-5-5", "codex-mini", ""], { "claude-opus-5-5": "Opus, the big one", "codex-mini": "codex-mini" });

  it("lists what CONTAINS the text, in the value or the label, case folded", () => {
    expect(filterSuggestions(options, "5").map((o) => o.value)).toEqual(["option-5-five", "option-15", "claude-opus-5-5"]);
    expect(filterSuggestions(options, "BIG").map((o) => o.value)).toEqual(["claude-opus-5-5"]);
    expect(filterSuggestions(options, "").map((o) => o.value)).toEqual(["option-5-five", "option-15", "claude-opus-5-5", "codex-mini"]);
  });

  it("draws no label that says the value again", () => {
    expect(filterSuggestions(options, "codex")).toEqual([{ value: "codex-mini" }]);
    expect(filterSuggestions(options, "opus")[0]?.label).toBe("Opus, the big one");
  });

  it("goes round the ends with the arrows, from none to the first or the last", () => {
    expect(nextLine(null, 3)).toBe(0);
    expect(nextLine(2, 3)).toBe(0);
    expect(previousLine(null, 3)).toBe(2);
    expect(previousLine(0, 3)).toBe(2);
    expect(previousLine(2, 3)).toBe(1);
  });

  it("hangs under the box, over it when below is shorter than above and too short, clipped to the room", () => {
    const win = { width: 800, height: 600 };
    expect(placeSuggestions({ left: 100, top: 100, width: 260, height: 30 }, { width: 340, height: 170 }, win)).toEqual({ left: 100, top: 130, width: 340, height: 170 });
    expect(placeSuggestions({ left: 100, top: 500, width: 260, height: 30 }, { width: 340, height: 170 }, win)).toEqual({ left: 100, top: 330, width: 340, height: 170 });
    // Too tall for either side: the side with more room, clipped to it — it never scrolls.
    expect(placeSuggestions({ left: 100, top: 200, width: 260, height: 30 }, { width: 260, height: 900 }, win)).toEqual({ left: 100, top: 230, width: 260, height: 370 });
    // Too wide for the right, with more room on the left: grows left from the box's end.
    expect(placeSuggestions({ left: 600, top: 100, width: 150, height: 30 }, { width: 400, height: 50 }, win)).toEqual({ left: 350, top: 130, width: 400, height: 50 });
  });
});
