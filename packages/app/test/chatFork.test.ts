/**
 * What a split conversation DRAWS.
 *
 * `chatConversation.test.ts` covers the model — where the seam is and what is down each side. This
 * covers the half that only exists on screen, and the claim is the one the shape is for: a fork is
 * legible AS a fork. Two torn edges with the choice between them, one tab per side, and the side
 * being read marked as such.
 *
 * It is the same vocabulary the Tasks view uses for a session cut in two (`sessionPanels.tsx`) — a
 * torn edge along the bottom of what stops, a torn edge along the top of what starts — because it is
 * the same fact about a conversation, arrived at from the other direction. A second drawing of "this
 * thread divides here" would be a second thing to learn to read.
 *
 * Rendered to static markup, for the reason `sessionPanels.test.ts` gives: the claims are structural.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForkSeam } from "../src/renderer/chatPane";

const draw = (shown: string): string =>
  renderToStaticMarkup(
    createElement(ForkSeam, {
      branches: [
        { key: "", label: "two, but better" },
        { key: "#i1", label: "two" },
      ],
      shown,
      onShow: () => undefined,
    }),
  );

describe("the seam a fork draws", () => {
  it("tears both ways — what stops above it, what starts below", () => {
    const html = draw("");
    // The pair is the whole statement. One edge alone says "this ends"; two say "this divides", and
    // the divide is the thing that happened.
    expect(html).toContain("sb-tear-paused");
    expect(html).toContain("sb-tear-resumed");
    expect(html).toContain("the conversation splits here");
  });

  it("offers one side per branch, and says which is being read", () => {
    const html = draw("");
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    // Named by what was SAID rather than by a branch id: which of two conversations you want is a
    // question about the message that opens each, and an opaque session id answers it for nobody.
    expect(html).toContain("two, but better");
    expect(html).toContain(">two<");
  });

  it("names the side that is showing on the edge that opens it", () => {
    // The bottom tear closes the shared half; the top one opens what you chose. Reading the label
    // there is how you know which conversation the turns underneath belong to after scrolling.
    expect(draw("#i1")).toMatch(/sb-tear-resumed[\s\S]*two/);
  });

  it("counts the sides when there are more than two", () => {
    const html = renderToStaticMarkup(
      createElement(ForkSeam, {
        branches: [
          { key: "", label: "a" },
          { key: "b", label: "b" },
          { key: "c", label: "c" },
        ],
        shown: "",
        onShow: () => undefined,
      }),
    );
    // Editing one message twice is two branches off one position, and "splits here" would then be
    // saying something narrower than what happened.
    expect(html).toContain("splits 3 ways here");
  });
});
