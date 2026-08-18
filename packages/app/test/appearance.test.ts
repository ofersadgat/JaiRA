/**
 * The typography preferences (SHELL.md §6).
 *
 * Two rules carry the design and neither is visible from reading the type:
 *
 *  - **Prepend, never replace.** A chosen family goes IN FRONT of the default stack, so a face with
 *    no `⛔` and no box-drawing glyphs falls through instead of showing tofu — a failure invisible to
 *    whoever picked the font, because their sample text rendered.
 *  - **Unset means unset.** A value nobody has chosen is REMOVED from the root rather than written
 *    back at today's default, so the stylesheet stays the single source of what unset looks like.
 */
import { describe, expect, it } from "vitest";
import { SIZE_LIMITS, clampSize, defaultAppearance, parseSettings, type Appearance } from "@jaira/shared";
import { DEFAULT_APP_STACK, DEFAULT_DATA_STACK, stackOf } from "../src/renderer/appearance";

const appearanceOf = (patch: Record<string, unknown>): Appearance =>
  parseSettings({ appearance: patch }).appearance;

describe("the stack a chosen family produces", () => {
  it("puts the choice in FRONT of the default rather than instead of it", () => {
    // The whole rule, in one assertion. A face missing a glyph falls through to the platform stack;
    // replacing would leave a person with tofu and no way to see why.
    expect(stackOf(["Inter"], DEFAULT_APP_STACK)).toBe(`Inter, ${DEFAULT_APP_STACK}`);
    expect(stackOf(["Fira Code", "Menlo"], DEFAULT_DATA_STACK)).toBe(`"Fira Code", Menlo, ${DEFAULT_DATA_STACK}`);
  });

  it("quotes a family only when it needs quoting", () => {
    expect(stackOf(["JetBrains Mono"], DEFAULT_DATA_STACK)).toContain('"JetBrains Mono"');
    expect(stackOf(["Consolas"], DEFAULT_DATA_STACK)).toBe(`Consolas, ${DEFAULT_DATA_STACK}`);
  });

  it("says NOTHING when no family has been chosen", () => {
    // Null, not the default stack: `applyAppearance` removes the property, and the stylesheet's own
    // value stands — which is where DM Sans and JetBrains Mono are named, and where a change to the
    // shipped default should reach everybody who never touched the control.
    expect(stackOf([], DEFAULT_APP_STACK)).toBeNull();
    expect(stackOf(["   "], DEFAULT_APP_STACK)).toBeNull();
  });
});

describe("parsing a preferences file", () => {
  it("defaults to the shipped sizes and no chosen families", () => {
    expect(parseSettings({}).appearance).toEqual(defaultAppearance());
    expect(defaultAppearance().sizeApp).toBe(SIZE_LIMITS.sizeApp.default);
  });

  it("clamps a size rather than dropping it", () => {
    // An 80px chrome is a window with no visible controls, and a 2px one is the same window from
    // the other direction — so the value is held inside the bounds the control offers.
    expect(appearanceOf({ sizeApp: 900 }).sizeApp).toBe(SIZE_LIMITS.sizeApp.max);
    expect(appearanceOf({ sizeData: 1 }).sizeData).toBe(SIZE_LIMITS.sizeData.min);
    expect(clampSize("sizeEditor", 13)).toBe(13);
  });

  it("ignores a size that is not a number at all, keeping the default", () => {
    expect(appearanceOf({ sizeApp: "big" }).sizeApp).toBe(SIZE_LIMITS.sizeApp.default);
    expect(appearanceOf({ sizeData: Number.NaN }).sizeData).toBe(SIZE_LIMITS.sizeData.default);
  });

  it("de-duplicates a family list, because a repeat can never be reached", () => {
    // A stack is an ordered list of ALTERNATIVES: the second copy of a family is behind the first,
    // which always resolves, so it is dead weight in a control whose whole point is the order.
    expect(appearanceOf({ dataFamily: ["Menlo", " Menlo ", "", "Consolas"] }).dataFamily).toEqual(["Menlo", "Consolas"]);
  });

  it("keeps the readable fields of a half-broken document", () => {
    // Per FIELD, like the layout parser: this is a preference file rather than something anyone
    // authored, and one bad value is no reason to reset a person's whole typography.
    const parsed = appearanceOf({ appFamily: "Inter", sizeData: 14, advanced: true, smoothing: "yes" });
    expect(parsed.appFamily).toEqual([]);
    expect(parsed.sizeData).toBe(14);
    expect(parsed.advanced).toBe(true);
    // Not the string's truthiness — only a real `true` turns a switch on.
    expect(parsed.smoothing).toBe(false);
  });

  it("reads a settings file written before any of this existed", () => {
    expect(parseSettings({ theme: "dark" }).appearance).toEqual(defaultAppearance());
  });
});
