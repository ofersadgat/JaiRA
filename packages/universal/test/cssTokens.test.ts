import { describe, expect, it } from "vitest";
import { evaluate, resolveAt } from "../src/cssTokens";

/**
 * The native side of decision 0015's tokens: `styles.css`'s cascade, replayed. Each expectation is worked
 * by hand from the CSS, the way the browser's cascade and CSS Color 5's `color-mix` define it.
 */
describe("styles.css tokens, replayed for native", () => {
  it("takes a palette's own value over the root's", () => {
    expect(resolveAt({ palette: "classic", scheme: "light" }).accent).toBe("#2563c7");
    expect(resolveAt({ palette: "ink", scheme: "light" }).accent).toBe("#4a4fd1");
  });

  it("takes the palette's dark block in the dark scheme, over both light blocks", () => {
    expect(resolveAt({ palette: "ink", scheme: "dark" }).accent).toBe("#9ea2ff");
  });

  it("mixes in premultiplied sRGB, so a tint over transparent keeps its hue and thins", () => {
    expect(resolveAt({ palette: "ink", scheme: "light" })["tint-accent"]).toBe("rgba(74, 79, 209, 0.1)");
  });

  it("lets a subtree's variables win inside it, resolving their references against the root", () => {
    const sidebar = resolveAt({ palette: "ink", scheme: "light", scopes: ["sidebar"] });
    expect(sidebar.accent).toBe("#b3b6ff");
    // color-mix(in srgb, #ffffff 7%, var(--chrome)), with --chrome #171a2e from the ink block
    expect(sidebar.panel).toBe("rgb(39, 42, 61)");
  });

  it("resolves a reference where it is DECLARED: a subtree's --accent does not recolour the root's --focus-ring", () => {
    // Found by shots/tokens-check.mts against Chromium: custom properties inherit computed values.
    const root = resolveAt({ palette: "blueprint", scheme: "light" });
    const sidebar = resolveAt({ palette: "blueprint", scheme: "light", scopes: ["sidebar"] });
    expect(sidebar.accent).not.toBe(root.accent);
    expect(sidebar["focus-ring"]).toBe(root["focus-ring"]);
  });

  it("reads px lengths as numbers, and evaluates calc() over them", () => {
    const ink = resolveAt({ palette: "ink", scheme: "light" });
    expect(ink["size-data"]).toBe(12);
    expect(evaluate("calc(var(--size-data) * 0.8)", (n) => ink[n])).toBeCloseTo(9.6);
  });

  it("leaves what native cannot use as the CSS said it", () => {
    const ink = resolveAt({ palette: "ink", scheme: "light" });
    expect(String(ink["font-data"])).toMatch(/^"JetBrains Mono"/);
    expect(evaluate("calc(100vw - 10px)", () => undefined)).toBe("calc(100vw - 10px)");
  });
});
