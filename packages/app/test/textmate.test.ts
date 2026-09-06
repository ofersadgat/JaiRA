/**
 * Colouring a reading of source — and the property the whole per-type theme feature rests on.
 *
 * The claim is narrow and worth testing directly, because it is the thing that was NOT true before:
 * two readings on screen at once can be in two different palettes. Monaco cannot do it — its token
 * classes are indices into one global colour map, so scoping the CSS would not help and a second
 * palette is not expressible — and that limit is what made "a theme per type" look impossible. Shiki
 * writes the colours inline, so the same text in two themes is two independent strings.
 *
 * This runs the real highlighter, with the real grammars and the real theme files, because a stub
 * would prove nothing about the only question here: what actually comes out.
 */
import { describe, expect, it } from "vitest";
import { colorize, textmateThemeFor, textmateThemeName } from "../src/renderer/textmate";

/** Every colour the markup states, as written — what tells two palettes apart. */
function coloursIn(html: string): string[] {
  return [...html.matchAll(/color:\s*(#[0-9a-fA-F]{3,8})/g)].map((hit) => hit[1]!.toLowerCase());
}

describe("colouring a reading", () => {
  it("returns the colours INLINE, which is what makes one reading independent of the next", async () => {
    const html = await colorize("const answer: number = 42;\n", "typescript", "monokai-light");
    expect(html).not.toBeNull();
    // The mechanism, stated as a test: no class whose meaning lives in a stylesheet somewhere else.
    expect(html).toContain("style=");
    expect(html).not.toContain("mtk");
    expect(coloursIn(html ?? "").length).toBeGreaterThan(2);
  });

  it("draws the same text in two palettes at once", async () => {
    // THE property. Both of these can be on screen together, and neither can disturb the other,
    // because neither is a claim about the window.
    const source = "export function themeOf(): string {\n  return 'monokai-light';\n}\n";
    const light = await colorize(source, "typescript", "monokai-light");
    const dark = await colorize(source, "typescript", "one-dark");
    expect(light).not.toBeNull();
    expect(dark).not.toBeNull();
    expect(light).not.toEqual(dark);
    // Monokai Light's keywords are its pink; One Dark's are its purple. Different files, same words.
    expect(coloursIn(light ?? "")).toContain("#f92672");
    expect(coloursIn(dark ?? "")).toContain("#c678dd");
  });

  it("colours a language whose grammar is named differently from Monaco's id", async () => {
    // `shell` here, `shellscript` everywhere else — the mapping that was wrong once already.
    const html = await colorize("echo \"hello\" | wc -l\n", "shell", "monokai");
    expect(html).not.toBeNull();
    expect(coloursIn(html ?? "").length).toBeGreaterThan(1);
  });

  it("answers null for a language it has no grammar for, rather than throwing", async () => {
    // The caller draws the same characters uncoloured, which is a rendering. Refusing to show a file
    // because its colouring is unavailable would be a much worse trade.
    expect(await colorize("x = 1\n", "brainfuck", "monokai")).toBeNull();
    expect(await colorize("x = 1\n", "typescript", "a-theme-nobody-shipped")).toBeNull();
  });
});

describe("“follows the app” as a palette", () => {
  it("resolves to the two VSCode defaults Monaco's own vs / vs-dark are renditions of", () => {
    expect(textmateThemeFor("app", false)).toBe("app-light");
    expect(textmateThemeFor("app", true)).toBe("app-dark");
    expect(textmateThemeName("app-dark")).toBe("dark-plus");
    expect(textmateThemeName("app-light")).toBe("light-plus");
  });

  it("leaves a real palette alone, and treats nothing said as following the app", () => {
    // A chosen palette does NOT move with the window: choosing Monokai Light and then turning the
    // app dark leaves the code in Monokai Light, which is the whole of what choosing it meant.
    expect(textmateThemeFor("monokai-light", true)).toBe("monokai-light");
    expect(textmateThemeFor(undefined, false)).toBe("app-light");
    expect(textmateThemeFor("", true)).toBe("app-dark");
  });

  it("actually colours in it, so choosing it is not choosing grey", async () => {
    // The reason this exists: `app` had no TextMate theme, so a reading under it would have fallen
    // back to plain text — a preference that silently turned colour off.
    const html = await colorize("const x = 1;\n", "typescript", "app-light");
    expect(html).not.toBeNull();
    expect(coloursIn(html ?? "").length).toBeGreaterThan(1);
  });
});
