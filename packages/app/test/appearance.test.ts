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
import {
  PALETTES,
  PALETTE_FRAME,
  SIZE_LIMITS,
  clampSize,
  defaultAppearance,
  defaultAppearanceConfig,
  parseAppearanceConfig,
  resolveTheme,
  surfaceOf,
  type Appearance,
} from "@jaira/shared";
import {
  DEFAULT_APP_STACK,
  DEFAULT_DATA_STACK,
  SHIPPED_APP_FAMILY,
  SHIPPED_DATA_FAMILY,
  applyAppearance,
  shownFamilies,
  stackOf,
} from "../src/renderer/appearance";

const appearanceOf = (patch: Record<string, unknown>): Appearance => parseAppearanceConfig(patch);

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

describe("parsing the appearance block of a settings layer", () => {
  it("defaults to the shipped sizes and no chosen families", () => {
    expect(parseAppearanceConfig(undefined)).toEqual(defaultAppearanceConfig());
    expect(parseAppearanceConfig({})).toMatchObject(defaultAppearance());
    expect(defaultAppearance().sizeApp).toBe(SIZE_LIMITS.sizeApp.default);
  });

  it("refuses a size outside what its control offers, naming the key", () => {
    // Strict, like every block of settings.json: an 80px chrome is a window with no visible
    // controls, and a document asking for one is refused rather than quietly clamped. The old
    // preferences file's clamping lives on only in its migration.
    expect(() => appearanceOf({ sizeApp: 900 })).toThrow(/config\.appearance\.sizeApp must be a size from 11 to 17/);
    expect(() => appearanceOf({ sizeData: 1 })).toThrow(/sizeData/);
    expect(() => appearanceOf({ sizeApp: "big" })).toThrow(/sizeApp/);
    expect(clampSize("sizeEditor", 13)).toBe(13);
    expect(appearanceOf({ sizeData: 14, advanced: true }).sizeData).toBe(14);
  });

  it("refuses a family named twice, because a repeat can never be reached", () => {
    // A stack is an ordered list of ALTERNATIVES: the second copy of a family is behind the first,
    // which always resolves, so it is dead weight in a control whose whole point is the order.
    expect(() => appearanceOf({ dataFamily: ["Menlo", " Menlo ", "Consolas"] })).toThrow(/names 'Menlo' twice/);
    expect(appearanceOf({ dataFamily: [" Menlo ", "Consolas"] }).dataFamily).toEqual(["Menlo", "Consolas"]);
  });

  it("refuses a value of the wrong kind, and a key the block does not have", () => {
    // Not the string's truthiness — only a real `true` turns a switch on, and anything else is refused.
    expect(() => appearanceOf({ smoothing: "yes" })).toThrow(/smoothing must be true or false/);
    expect(() => appearanceOf({ appFamily: "Inter" })).toThrow(/appFamily must be a list/);
    expect(() => appearanceOf({ theme: "dark" })).toThrow(/config\.appearance\.theme is not a setting/);
    expect(() => appearanceOf({ editors: { json: { minimap: true } } })).toThrow(/editors\.json\.minimap is not a setting/);
    expect(() => appearanceOf({ renderers: { markdown: { read: "x" } } })).toThrow(/not a renderer key/);
  });

  it("reads the nested blocks a layer states partly, with every default filled in", () => {
    const parsed = parseAppearanceConfig({
      conversation: { sequentialBatches: "band" },
      editors: { json: { wrap: true } },
      renderers: { "text/markdown:view": { read: "source" } },
    });
    expect(parsed.conversation.sequentialBatches).toBe("band");
    // Unstated: the number alone.
    expect(parsed.conversation.usageFigures).toBe("number");
    expect(parseAppearanceConfig({ conversation: { usageFigures: "ring" } }).conversation.usageFigures).toBe("ring");
    expect(() => parseAppearanceConfig({ conversation: { usageFigures: "dial" } })).toThrow(/usageFigures/);
    expect(parsed.editors.json.wrap).toBe(true);
    expect(parsed.editors.code).toEqual(defaultAppearanceConfig().editors.code);
    expect(parsed.renderers["text/markdown:view"]).toEqual({ read: "source", write: null, off: [], theme: { read: null, write: null } });
  });
});

/**
 * What the picker draws, which is not the same question as what is stored.
 *
 * "Unset means unset" is a rule about the DOCUMENT — the property is removed and the stylesheet's
 * own value stands. On screen it produced an empty box under a heading, which states that nothing
 * is chosen and cannot state what the window is set in. Both are true at once, and this is the seam
 * that keeps them from contradicting each other.
 */
describe("what the picker shows for a voice", () => {
  it("shows the shipped face when nothing has been chosen", () => {
    expect(shownFamilies([], "app")).toEqual([SHIPPED_APP_FAMILY]);
    expect(shownFamilies([], "data")).toEqual([SHIPPED_DATA_FAMILY]);
  });

  it("shows the choice, and only the choice, once there is one", () => {
    // Never ours plus theirs: a chosen stack REPLACES the shipped face outright — `stackOf` prepends
    // it to the platform fallback, and DM Sans is not in that fallback.
    expect(shownFamilies(["Inter"], "app")).toEqual(["Inter"]);
    expect(stackOf(["Inter"], DEFAULT_APP_STACK)).not.toContain(SHIPPED_APP_FAMILY);
  });

  it("leaves the stored value alone, which is what keeps `unset` meaning unset", () => {
    expect(stackOf(shownFamilies([], "app"), DEFAULT_APP_STACK)).toContain(SHIPPED_APP_FAMILY);
    // The document still says nothing: this is a display, not a write.
    expect(stackOf([], DEFAULT_APP_STACK)).toBeNull();
  });
});

/**
 * The window's palette and the board's three options (the person's pick, 2026-09-23).
 *
 * Three rules: ink rail is the default; classic is the app as it first shipped, so choosing it writes
 * NOTHING onto the root; and an option nobody has set is whatever the palette was designed with,
 * resolved before it reaches the stylesheet, so the CSS only ever describes a departure from the
 * classic board.
 */
describe("the palette and the board's options", () => {
  const root = (): HTMLElement => {
    const style = new Map<string, string>();
    const data: Record<string, string> = {};
    return {
      style: {
        setProperty: (n: string, v: string) => style.set(n, v),
        removeProperty: (n: string) => style.delete(n),
        getPropertyValue: (n: string) => style.get(n) ?? "",
      },
      dataset: data,
    } as unknown as HTMLElement;
  };
  const apply = (patch: Partial<Appearance>): DOMStringMap => {
    const el = root();
    applyAppearance(el, { ...defaultAppearance(), ...patch });
    return el.dataset;
  };

  it("is ink rail with every option left to it, for a file written before any of this", () => {
    expect(parseAppearanceConfig({ sizeApp: 13 })).toMatchObject({
      palette: "ink",
      laneColors: null,
      buckets: null,
      statusWash: null,
    });
  });

  it("reads each field on its own, and refuses what it cannot use", () => {
    // Unlike the editor theme, the palettes are known here, so an id this release does not have is
    // refused by name rather than kept for a release that might.
    expect(() => appearanceOf({ palette: "neon" })).toThrow(/palette must be one of ink, classic/);
    expect(() => appearanceOf({ buckets: "dotted" })).toThrow(/buckets must be one of box, line/);
    expect(() => appearanceOf({ statusWash: "yes" })).toThrow(/statusWash must be true, false or null/);
    expect(appearanceOf({ palette: "classic" }).palette).toBe("classic");
    expect(appearanceOf({ palette: "blueprint" }).palette).toBe("blueprint");
    // Null is a statement: "the palette's own", which is how a layer takes a weaker layer's choice back.
    const parsed = appearanceOf({ laneColors: true, buckets: null, statusWash: null });
    expect(parsed.laneColors).toBe(true);
    expect(parsed.buckets).toBeNull();
    expect(parsed.statusWash).toBeNull();
    expect(appearanceOf({ palette: "pastel", buckets: "line", statusWash: false })).toMatchObject({
      palette: "pastel",
      buckets: "line",
      statusWash: false,
    });
  });

  it("resolves an unset option from the palette, and a set one from the person", () => {
    const base = defaultAppearance();
    expect(surfaceOf({ ...base, palette: "ink" }).buckets).toBe("line");
    expect(surfaceOf({ ...base, palette: "pastel" }).laneColors).toBe(true);
    expect(surfaceOf({ ...base, palette: "pastel", laneColors: false }).laneColors).toBe(false);
    expect(surfaceOf({ ...base, palette: "ink", buckets: "box" }).buckets).toBe("box");
    for (const palette of PALETTES) expect(surfaceOf({ ...base, palette }).statusWash).toBe(false);
  });

  it("paints an untouched app in ink rail, with its columns as rules", () => {
    expect(apply({})).toMatchObject({ palette: "ink", buckets: "line" });
  });

  it("writes nothing onto the root for classic with its own options", () => {
    const data = apply({ palette: "classic" });
    for (const name of ["palette", "buckets", "lanes", "wash"]) expect(data[name]).toBeUndefined();
  });

  it("names the palette and each departure, and nothing that is today's board", () => {
    expect(apply({ palette: "ink" })).toMatchObject({ palette: "ink", buckets: "line" });
    expect(apply({ palette: "ink" })["lanes"]).toBeUndefined();
    expect(apply({ palette: "pastel" })).toMatchObject({ palette: "pastel", lanes: "on" });
    expect(apply({ palette: "hairline", statusWash: true, buckets: "box" })).toMatchObject({ palette: "hairline", wash: "on" });
    expect(apply({ palette: "hairline", buckets: "box" })["buckets"]).toBeUndefined();
    // The options work over classic too — they are about the board, not about a palette.
    expect(apply({ palette: "classic", laneColors: true, buckets: "line" })).toMatchObject({ lanes: "on", buckets: "line" });
    expect(apply({ palette: "classic", laneColors: true })["palette"]).toBeUndefined();
    expect(apply({ palette: "blueprint" })).toMatchObject({ palette: "blueprint" });
    // Pastel rail is pastel with ink's dark sidebar, so it keeps pastel's lanes.
    expect(apply({ palette: "pastel-rail" })).toMatchObject({ palette: "pastel-rail", lanes: "on" });
    expect(apply({ palette: "zinc" })).toMatchObject({ palette: "zinc" });
    expect(apply({ palette: "zinc" })["buckets"]).toBeUndefined();
  });

  it("takes the attributes back when classic is put back", () => {
    const el = root();
    applyAppearance(el, { ...defaultAppearance(), palette: "pastel", statusWash: true });
    applyAppearance(el, { ...defaultAppearance(), palette: "classic" });
    for (const name of ["palette", "buckets", "lanes", "wash"]) expect(el.dataset[name]).toBeUndefined();
  });

  it("takes light, dark or system as the mode, and paints system as the OS says", () => {
    expect(parseAppearanceConfig({ mode: "system" }).mode).toBe("system");
    expect(parseAppearanceConfig({ mode: "dark" }).mode).toBe("dark");
    // Unstated is the default, light — as it always was; a mode that does not exist is refused.
    expect(parseAppearanceConfig({}).mode).toBe("light");
    expect(() => parseAppearanceConfig({ mode: "dim" })).toThrow(/mode must be one of light, dark, system/);
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    // An explicit choice ignores the OS.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("has a frame colour for every palette in both themes, and classic's is the one it always had", () => {
    for (const palette of PALETTES) {
      expect(PALETTE_FRAME[palette].light.ground).toMatch(/^#[0-9a-f]{6}$/);
      expect(PALETTE_FRAME[palette].dark.ground).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(PALETTE_FRAME.classic.light).toEqual({ ground: "#f5f6f8", panel: "#ffffff", dim: "#5c6779" });
    expect(PALETTE_FRAME.classic.dark).toEqual({ ground: "#0f1115", panel: "#161922", dim: "#8b93a7" });
  });
});

