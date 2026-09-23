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
  parseSettings,
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
    expect(parseSettings({ appearance: { sizeApp: 13 } }).appearance).toMatchObject({
      palette: "ink",
      laneColors: null,
      buckets: null,
      statusWash: null,
    });
  });

  it("reads each field on its own, and drops what it cannot use", () => {
    // Unlike the editor theme, the palettes are known here, so an id this release does not have
    // falls back rather than being kept for a release that might.
    const parsed = appearanceOf({ palette: "neon", laneColors: true, buckets: "dotted", statusWash: "yes" });
    expect(parsed.palette).toBe("ink");
    expect(appearanceOf({ palette: "classic" }).palette).toBe("classic");
    expect(appearanceOf({ palette: "blueprint" }).palette).toBe("blueprint");
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
    expect(parseSettings({ theme: "system" }).theme).toBe("system");
    expect(parseSettings({ theme: "dark" }).theme).toBe("dark");
    // Anything else is the default, light — as it always was.
    expect(parseSettings({ theme: "dim" }).theme).toBe("light");
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

