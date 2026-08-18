/**
 * The two voices, as a person set them (SHELL.md §6).
 *
 * Every register in the stylesheet is a multiple of its voice's base and takes its family from one
 * of two tokens, which is what makes this four values rather than eleven: one control moves a whole
 * voice with every ratio intact. That is the entire reason §3.3 forbids a literal font-size in a
 * component — a px anywhere is a component this cannot reach.
 */
import { SIZE_LIMITS, clampSize, type Appearance } from "@jaira/shared/browser";

/**
 * The stacks a chosen family is prepended TO — never replaced by.
 *
 * A face with no `⛔`, no box-drawing glyphs, or no coverage of a script the person reads falls
 * through to these instead of showing tofu. That failure is invisible to whoever picked the font,
 * because their sample text rendered, and it is why the picker states this stack as an un-removable
 * last line rather than leaving it as a rule you have to know.
 *
 * Deliberately NOT the stylesheet's own defaults, which lead with DM Sans and JetBrains Mono: those
 * are a preference JaiRA expresses when the person has expressed none, and once they have, theirs
 * goes in front and ours stops being relevant. With no choice made at all, `applyAppearance` removes
 * the property entirely and the stylesheet's value stands.
 */
export const DEFAULT_APP_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const DEFAULT_DATA_STACK = '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace';

/** A family as it goes into a CSS stack: quoted when it has a space, bare when it does not. */
function cssFamily(name: string): string {
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) ? name : `"${name.replace(/"/g, "")}"`;
}

/** One voice's stack: the chosen families, then the default. Empty ⇒ null, meaning "leave ours". */
export function stackOf(families: readonly string[], fallback: string): string | null {
  const chosen = families.filter((f) => f.trim().length > 0).map(cssFamily);
  return chosen.length === 0 ? null : [...chosen, fallback].join(", ");
}

/**
 * Write the preferences onto the document root as the tokens the stylesheet reads.
 *
 * Inline custom properties on `:root`, which is the one place that beats the stylesheet's own `:root`
 * without a specificity fight and without a second copy of the palette. A value the person has not
 * set is REMOVED rather than written back at its default — so the stylesheet stays the single source
 * of what "unset" looks like, and a future change to a default reaches everybody who never touched
 * the control.
 */
export function applyAppearance(root: HTMLElement, a: Appearance): void {
  const set = (name: string, value: string | null): void => {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  set("--font-app", stackOf(a.appFamily, DEFAULT_APP_STACK));
  set("--font-data", stackOf(a.dataFamily, DEFAULT_DATA_STACK));
  set("--size-app", `${clampSize("sizeApp", a.sizeApp)}px`);
  set("--size-data", `${clampSize("sizeData", a.sizeData)}px`);
  // Simple/advanced: the editor follows the data voice until it is separated. `null` restores the
  // stylesheet's own `var(--size-data)`, so turning Advanced back off re-couples them rather than
  // freezing the editor at whatever it happened to be.
  set("--size-editor", a.advanced ? `${clampSize("sizeEditor", a.sizeEditor)}px` : null);
  // Grayscale antialiasing, off by default — see `Appearance.smoothing`.
  set("-webkit-font-smoothing", a.smoothing ? "antialiased" : null);
  set("-moz-osx-font-smoothing", a.smoothing ? "grayscale" : null);
}

/**
 * Is this family monospaced? — OURS, and a note rather than a block (SHELL.md §6).
 *
 * Two voices can be configured into one: nothing stops somebody putting Georgia in the data slot,
 * and the app will render it, and every column of counts and every diff will stop lining up. Saying
 * so at the moment of the choice is worth far more than refusing it — it is their app, and a
 * proportional "code" font is a legitimate if unusual taste.
 *
 * Measured rather than looked up: there is no font metadata in the browser, so the test is the
 * definition — `i` and `W` advance the same distance exactly when the face is monospaced. Falls back
 * to `true` (say nothing) when there is no canvas to measure with, because a warning that appears
 * because measurement failed is worse than no warning.
 */
export function isMonospace(family: string, measure?: CanvasRenderingContext2D | null): boolean {
  const ctx = measure ?? document.createElement("canvas").getContext("2d");
  if (ctx === null) return true;
  ctx.font = `40px ${cssFamily(family)}, monospace`;
  const narrow = ctx.measureText("i".repeat(20)).width;
  const wide = ctx.measureText("W".repeat(20)).width;
  // A whole pixel over twenty characters is well inside rounding, and well under any real difference
  // — `i` and `W` differ by a factor of three in a proportional face.
  return Math.abs(narrow - wide) < 1;
}

/** The sizes a control offers, for the one place that renders a slider per voice. */
export { SIZE_LIMITS };
