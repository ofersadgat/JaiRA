/**
 * The one control on the composer that is not about what to say: the button.
 *
 * It wears three verbs across two props, and the combination that mattered was the one nobody had:
 * a composer that cannot SEND (no conversation in this state) sitting under a workflow that is still
 * running. That is the ordinary shape of watching a composite — its children hold the conversations,
 * it holds none — and it left the panel with no way to stop the run it was showing.
 *
 * Rendered to static markup rather than through a DOM harness: the claim is what is on the page, and
 * a server render answers exactly that.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatPlanView } from "@jaira/shared/browser";
import { Composer } from "../src/renderer/composer";

const plan = (): ChatPlanView =>
  ({
    settings: {},
    origin: { model: "unset", reasoning: "unset", tools: "unset", permissions: "unset" },
    unresolved: [],
    live: "idle",
    effective: { reasoning: "medium", permissions: "ask" },
    available: { routes: [], tools: [], models: [] },
  }) as unknown as ChatPlanView;

const draw = (props: Partial<Parameters<typeof Composer>[0]>): string =>
  renderToStaticMarkup(
    createElement(Composer, {
      plan: plan(),
      overrides: {},
      onOverrides: () => undefined,
      onSend: () => undefined,
      ...props,
    }),
  );

describe("the composer's button", () => {
  it("sends when nothing is in flight", () => {
    const html = draw({});
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain("cx-stop");
  });

  it("becomes a stop button while something is in flight", () => {
    expect(draw({ busy: true, onStop: () => undefined })).toContain('aria-label="Stop"');
  });

  it("stays a greyed send button when the host has nothing to stop", () => {
    // No `onStop` is an honest shape, not an oversight: a transcript beside a board has no handle on
    // the run it is reading, and a stop button that could not stop anything is worse than none.
    const html = draw({ busy: true });
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("disabled");
  });

  it("offers stop over a composer that cannot send — the composite case", () => {
    // The regression. A state that holds no conversation disables the box, and disabling the box
    // used to take the only handle on a running workflow with it.
    const html = draw({
      busy: true,
      onStop: () => undefined,
      disabled: "This state holds no conversation of its own — reply in one of the runs below.",
    });
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain("holds no conversation of its own");
  });
});
