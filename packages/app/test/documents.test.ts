/**
 * The one place that decides how a markdown document is drawn.
 *
 * What matters here is the CONTRACT rather than the components: a caller says what it has and what
 * may be done with it, and the right renderer follows. Before this component existed that decision
 * was spread across four call sites, and the one that got it wrong — a gate's read-only approval
 * document, sent to the editor — showed coloured YAML with no reading behind it while the same block
 * in a model's answer had the full toggle. Nobody chose that; it fell out of a condition two files
 * away.
 *
 * ## What a server render can and cannot see
 *
 * The reading path is asserted directly. The editing path is NOT, and pretending otherwise would be
 * the mistake: it is lazily loaded behind a `Suspense` whose fallback is the reading, so under
 * `react-dom/server` both branches emit the same markup and an assertion that appeared to tell them
 * apart would be testing the fallback. CodeMirror needs a DOM, and this package has no DOM test
 * environment — so what is checked here is that every branch renders the document's words rather
 * than a blank pane, and the branch itself is one line in `markdownDocument.tsx` kept honest by
 * being the only one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownDocument } from "../src/renderer/markdownDocument";

const DOC = ["# Plan", "", "```yaml", "id: plan", "```", "", "Approve?"].join("\n");

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(MarkdownDocument, { text: DOC, ...props } as never));

describe("a document nothing may change", () => {
  it("is read, fenced blocks and all", () => {
    // No `onChange` is the whole statement — the caller names no renderer and passes no fence.
    const html = render({});
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<p>Approve?</p>");
    // The fence is drawn by whatever renderer the page registered (`registerFenceRenderer`); an
    // island page registers none, and the block is its source in a box.
    expect(html).toContain(`<pre class="language-yaml"><code>id: plan`);
  });
});

describe("a document that may be changed", () => {
  it("shows the words while its editor loads, rather than a blank pane", () => {
    // The `Suspense` fallback IS the reading — see the header. That is deliberate rather than
    // incidental: half a megabyte of CodeMirror arriving should not blank the document first.
    const html = render({ onChange: () => undefined });
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<p>Approve?</p>");
  });

  it("does not report a change merely for being drawn", () => {
    let reported: string | null = null;
    render({ onChange: (next: string) => (reported = next) });
    expect(reported).toBeNull();
  });

  it("does the same when it is only showing a change", () => {
    // A `diff` takes the editing renderer with nothing editable — drawing a change in place is the
    // one thing the live preview does that the reading renderer cannot.
    const html = render({ diff: { before: "# Plan\n", after: DOC, hunks: [] } });
    expect(html).toContain("<h1>Plan</h1>");
  });
});

