/**
 * What a fork DRAWS — the one mark, at both of the places it lands.
 *
 * `chatConversation.test.ts` and `sessionBands.test.ts` cover the models: where a thread divided,
 * and which operations are the sides of one division. This covers the half that only exists on
 * screen, and the claim is the one the whole shape is for: a fork is legible AS a fork, and legible
 * the same way wherever it happens.
 *
 * The mark replaced a seam that said one fact five times — a wash, a rule above, a rule below,
 * teeth, and a sentence — with two carriers and no wash or rules at all. So the assertions here are
 * mostly about what is NOT drawn: teeth and a chip, and in the gutter placement not even teeth.
 *
 * Rendered to static markup, for the reason `sessionPanels.test.ts` gives: the claims are structural.
 * The menu is a click away and is the app's own `ContextMenu`, tested where that lives.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForkMark, type ForkSide } from "../src/renderer/sessionPanels";

const SIDES: ForkSide[] = [
  { key: "default@6", label: "failed", note: "default" },
  { key: "b7c1e4@6", label: "finished", note: "b7c1e4" },
];

const draw = (patch: Partial<Parameters<typeof ForkMark>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ForkMark, { sides: SIDES, shown: "b7c1e4@6", onShow: () => undefined, ...patch }),
  );

describe("the mark a fork draws", () => {
  it("is teeth and a chip, and nothing else", () => {
    const html = draw();
    // Both edges, because a torn line with one end is a rule with a decoration on it.
    expect(html.match(/sb-zig/g)).toHaveLength(2);
    expect(html).toContain("fork-chip");
    // The carriers the old seam spent and this one does not. A wash and a pair of rules said the
    // same thing the teeth already say, and three ways of saying it is what made it loud.
    expect(html).not.toContain("sb-tear");
  });

  it("leads with the word that is the same on every mark", () => {
    // `fork:` is the only part identical at every scale, so it is the part the eye can learn. Its
    // own element because it carries weight the rest of the label does not.
    expect(draw()).toContain('class="fork-kind">fork:');
  });

  it("counts before it names", () => {
    // "is there something I am not seeing" is the question the mark exists to answer, and it is
    // answered by the count — before the reader has read the name of anything.
    expect(draw()).toContain("2 of 2");
    expect(draw()).toContain("finished");
  });

  it("counts the side being READ, not the newest one", () => {
    const html = draw({ shown: "default@6" });
    expect(html).toContain("1 of 2");
    expect(html).toContain("failed");
    expect(html).not.toContain("2 of 2");
  });

  it("falls back to the first side when the one shown is not among them", () => {
    // A stale selection is not a reason to render a mark that names nothing, and it is not a reason
    // to render nothing at all: the fork happened either way.
    expect(draw({ shown: "gone@9" })).toContain("1 of 2");
  });

  it("draws nothing at all for a single side", () => {
    // A fork with one side is not a fork. `forksOf` already declines to report one; this is the
    // same rule at the other end, so a caller that hands one over draws no furniture over nothing.
    expect(draw({ sides: [SIDES[0]!] })).toBe("");
  });

  it("has no teeth where nothing was torn", () => {
    // The gutter placement: a branch that is its own panel. Three attempts are three conversations,
    // not one conversation cut twice, so there is no cut to draw — the chip alone says which of the
    // three this panel is.
    const html = draw({ torn: false });
    expect(html).not.toContain("sb-zig");
    expect(html).toContain("fork-chip");
    expect(html).toContain("2 of 2");
  });
});
