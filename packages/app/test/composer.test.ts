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
    // And ONLY stop: there is nowhere for a message to go, so offering to send one would be an
    // invitation to an error.
    expect(html).not.toContain('aria-label="Send"');
  });

  it("offers both while a turn is in flight in a conversation", () => {
    // The message joins the turn — that is what the line above the button has been saying, and what
    // `chat:send` has always done. One button meant the box refused what the channel underneath it
    // was willing to do: you could stop the agent, or wait, and nothing else.
    const html = draw({ busy: true, joinable: true, onStop: () => undefined });
    expect(html).toContain('aria-label="Stop"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain("joins the turn in flight");
  });

  it("still refuses a second send where the first is what STARTS the conversation", () => {
    // The box on the empty Chat view. Its `busy` is a task being created, and a second send there is
    // a second conversation rather than a second message — so `joinable` is what this turns on, not
    // `busy` alone.
    expect(draw({ busy: true })).toContain("disabled");
  });
});
