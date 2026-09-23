/**
 * Settings pages as rows (the person's pick of t3code's pattern, 2026-09-23).
 *
 * Two rules a row lives by and a DOM-less test can hold: a hint on a settings page is ONE sentence,
 * with whatever followed behind an ⓘ; and a section's id — what the sidebar's accordion scrolls to —
 * is its title, made safe for an attribute.
 */
import { describe, expect, it } from "vitest";
import { partIdOf, splitHint } from "../src/renderer/controls";

describe("a row's one sentence", () => {
  it("keeps the first sentence and hands the rest to the ⓘ", () => {
    expect(splitHint("Glob patterns, matched per root. A folder takes its contents with it.")).toEqual({
      first: "Glob patterns, matched per root.",
      rest: "A folder takes its contents with it.",
    });
  });

  it("leaves a single sentence whole, with nothing behind the ⓘ", () => {
    expect(splitHint("Naming a distro runs everything inside it.")).toEqual({ first: "Naming a distro runs everything inside it.", rest: "" });
    expect(splitHint("no full stop at all")).toEqual({ first: "no full stop at all", rest: "" });
  });

  it("does not split inside a word — a dot has to end the sentence", () => {
    // `$ARTIFACT_DIR` and `settings.json` carry dots that are not the end of anything.
    expect(splitHint("Written in settings.json, so everyone sees it. Yours is not.").first).toBe("Written in settings.json, so everyone sees it.");
  });
});

describe("a section's id", () => {
  it("is its title, lower-cased and hyphenated", () => {
    expect(partIdOf("Model providers")).toBe("model-providers");
    expect(partIdOf("JaiRA's own directory")).toBe("jaira-s-own-directory");
    expect(partIdOf("Rules (3)")).toBe("rules-3");
  });
});
