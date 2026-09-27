/**
 * Nothing floats in place.
 *
 * A popover drawn inside its button's wrapper — `position: absolute` and a z-index — is clipped by
 * every `overflow` around it and painted under every stacking context above it, and no number in its
 * own rule can fix either. The app kept shipping that shape and kept finding it covered: the
 * composer's card under the top bar, the context menu under an editor's splitter, the Tools card's
 * mode picker cut off by the category it was opened in. Every float now goes through popover.tsx,
 * which renders it into `<body>`, and these tests are what keep the next one from being written the
 * old way:
 *
 *  - no stylesheet rule has the in-place float's shape: `position: absolute`, a shadow, a z-index;
 *  - a z-index is either a small literal — layering INSIDE one component — or a layer token;
 *  - `position: fixed` is only on the window's own layers;
 *  - `createPortal`, and inline `zIndex` or `position: "fixed"`, are popover.tsx's alone.
 *
 * Each exception below is named with its reason. A new one should have to argue its way in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeFloat } from "../src/renderer/popover";

const RENDERER = join(__dirname, "..", "src", "renderer");
const CSS = readFileSync(join(RENDERER, "styles.css"), "utf8");

interface Rule {
  selector: string;
  body: string;
  line: number;
}

/** Every innermost `selector { body }` in the sheet, comments blanked so their braces don't count. */
function rules(css: string): Rule[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(plain); m !== null; m = re.exec(plain)) {
    const brace = m.index + m[0].indexOf("{");
    out.push({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!, line: plain.slice(0, brace).split("\n").length });
  }
  return out;
}

const decl = (body: string, property: string): string | undefined => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

/** Positioned boxes with a shadow and a z-index that are NOT floats. */
const IN_PLACE_OK: Record<string, string> = {
  // The Settings/side panel column slides OVER the sidebar it belongs to; it is layout, not a float,
  // and it must stay inside the sidebar's own box.
  ".side-panel": "a layout column over its own sidebar",
  // The tick on a palette card, over the card's own picture.
  ".theme-check": "a badge inside its own card",
};

/** The window's own layers: the only `position: fixed` rules. */
const FIXED_OK: Record<string, string> = {
  ".float": "the float layer — popover.tsx renders every float into <body> with this class",
  ".modal-backdrop": "a modal is a render function's caller's choice (see componentGallery), and covers the window",
  ".diff-pane": "the full-window diff view",
  ".toast": "the error toast",
  ".crash": "the crash screen, which replaces the app",
  ".crash-banner": "the crash banner, over the app",
};

const TOKENS = ["--z-modal", "--z-toast", "--z-float", "--z-crash"];

describe("the stylesheet has no in-place floats", () => {
  const all = rules(CSS);

  it("no rule is shaped like a float drawn inside its opener", () => {
    const offenders = all
      .filter((r) => decl(r.body, "position") === "absolute")
      .filter((r) => decl(r.body, "box-shadow") !== undefined || /var\(--lift\)/.test(r.body))
      .filter((r) => {
        const z = decl(r.body, "z-index");
        return z !== undefined && z !== "0" && z !== "auto";
      })
      .filter((r) => IN_PLACE_OK[r.selector] === undefined)
      .map((r) => `styles.css:${r.line} ${r.selector} — render it through <Popover> (popover.tsx) instead`);
    expect(offenders).toEqual([]);
  });

  it("a z-index is layering inside one component (0–9) or one of the window's layers", () => {
    const offenders = all.flatMap((r) => {
      const z = decl(r.body, "z-index");
      if (z === undefined || z === "auto") return [];
      if (/^-?\d$/.test(z)) return [];
      if (TOKENS.some((token) => z === `var(${token})`)) return [];
      return [`styles.css:${r.line} ${r.selector} z-index: ${z}`];
    });
    expect(offenders).toEqual([]);
  });

  it("the layer tokens are declared, in order, and only the layers use them", () => {
    const root = all.find((r) => r.selector === ":root" && decl(r.body, "--z-float") !== undefined);
    expect(root).toBeDefined();
    const values = TOKENS.map((token) => Number(decl(root!.body, token)));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    const users = all.filter((r) => /z-index\s*:\s*var\(--z-/.test(r.body)).map((r) => r.selector);
    expect(users.filter((selector) => FIXED_OK[selector] === undefined)).toEqual([]);
  });

  it("a float takes itself out of the window's drag strips, so a press on it reaches the page", () => {
    // The OS hit-tests `-webkit-app-region: drag`, not the page: a float lying over the title strip
    // without this moved the window instead (the Needs attention card's Dismiss all, 2026-09-26).
    const float = all.find((r) => r.selector === ".float");
    expect(float === undefined ? undefined : decl(float.body, "-webkit-app-region")).toBe("no-drag");
  });

  it("`position: fixed` is only on the window's own layers", () => {
    const offenders = all
      .filter((r) => decl(r.body, "position") === "fixed" && FIXED_OK[r.selector] === undefined)
      .map((r) => `styles.css:${r.line} ${r.selector} — a float is <Popover>/<Overlay>; a fixed box inside a transformed ancestor is not fixed`);
    expect(offenders).toEqual([]);
  });
});

describe("the renderer has one way to float", () => {
  const sources = readdirSync(RENDERER, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => ({ file: file.replace(/\\/g, "/"), text: readFileSync(join(RENDERER, file), "utf8") }))
    .filter(({ file }) => file !== "popover.tsx");

  it("only popover.tsx calls createPortal", () => {
    expect(sources.filter(({ text }) => /\bcreatePortal\b/.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it("no component sets a z-index or `position: fixed` inline", () => {
    const offenders = sources.flatMap(({ file, text }) =>
      text.split("\n").flatMap((line, at) => (/\bzIndex\s*:|position\s*:\s*["']fixed["']/.test(line) ? [`${file}:${at + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
  });
});

describe("placing a float", () => {
  const view = { width: 1000, height: 800 };
  const button = { left: 400, top: 380, right: 480, bottom: 404 };

  it("goes on the side asked for, lined up on the edges asked for", () => {
    expect(placeFloat(button, { width: 200, height: 100 }, view, "below", "start", 6)).toEqual({ left: 400, top: 410, maxHeight: undefined });
    expect(placeFloat(button, { width: 200, height: 100 }, view, "below", "end", 6)).toEqual({ left: 280, top: 410, maxHeight: undefined });
    expect(placeFloat(button, { width: 200, height: 100 }, view, "above", "start", 6)).toEqual({ left: 400, top: 274, maxHeight: undefined });
  });

  it("flips to the other side when that is where the room is", () => {
    const low = { left: 400, top: 760, right: 480, bottom: 784 };
    expect(placeFloat(low, { width: 200, height: 300 }, view, "below", "start", 6).top).toBe(760 - 6 - 300);
    const high = { left: 400, top: 10, right: 480, bottom: 34 };
    expect(placeFloat(high, { width: 200, height: 300 }, view, "above", "start", 6).top).toBe(34 + 6);
  });

  it("stays inside the window, and scrolls inside itself when it cannot fit", () => {
    const right = { left: 960, top: 380, right: 990, bottom: 404 };
    expect(placeFloat(right, { width: 200, height: 100 }, view, "below", "start", 6).left).toBe(1000 - 200 - 4);
    const tall = placeFloat(button, { width: 200, height: 2000 }, view, "below", "start", 6);
    expect(tall.maxHeight).toBe(800 - 404 - 6 - 4);
    expect(tall.top + tall.maxHeight!).toBeLessThanOrEqual(800);
  });

  it("opens beside, for a flyout", () => {
    expect(placeFloat(button, { width: 100, height: 50 }, view, "left", "end", 10)).toEqual({ left: 290, top: 354, maxHeight: undefined });
    expect(placeFloat({ left: 30, top: 380, right: 60, bottom: 404 }, { width: 100, height: 50 }, view, "left", "start", 10).left).toBe(70);
  });
});
