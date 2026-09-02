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
import { MarkdownDocument } from "../src/renderer/documents";
import "../src/renderer/fenceRender";

const YAML = ["id: plan", ""].join("\n");
const DOC = ["# Plan", "", "```yaml", "id: plan", "```", "", "Approve?"].join("\n");

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(MarkdownDocument, { text: DOC, ...props } as never));

describe("a document nothing may change", () => {
  it("is read, fenced blocks and all", () => {
    // No `onChange` is the whole statement — the caller names no renderer and passes no fence.
    const html = render({});
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain("<p>Approve?</p>");
    // The reading a fence earns anywhere else in the app, which is the point of routing through one
    // component: a ```yaml block is the same thing in a gate, a transcript and a file.
    expect(html).toContain("vv-toggle");
    expect(html).toContain(">Data<");
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

describe("code, read and edited", () => {
  it("reads with the tokenizer — no editor instance for something nobody can type into", async () => {
    const { CodeDocument } = await import("../src/renderer/documents");
    const html = renderToStaticMarkup(
      createElement(CodeDocument, { text: YAML, mime: "application/yaml" }),
    );
    // Its fallback is the source, so the text is on screen while Monaco loads.
    expect(html).toContain("id: plan");
  });

  it("keeps an editable value on the coloured view instead of demoting it to a box", async () => {
    // This replaced a worse answer. The code view had no renderer that could accept a keystroke, so
    // an editable YAML value either sat on a pane that dropped every one or fell through to a plain
    // textarea — colour or editing, never both. `MonacoCodePane` takes an `onChange` now, so the
    // value that said it could be changed is coloured AND changeable in the same place.
    const { ValueView } = await import("../src/renderer/valueView");
    const html = renderToStaticMarkup(
      createElement(ValueView, {
        value: YAML,
        hint: { mime: "application/yaml" },
        edit: () => undefined,
      } as never),
    );
    expect(html).not.toContain("<textarea");
    expect(html).toContain("id: plan");
  });

  it("still offers the source underneath, which is what the toggle is for", async () => {
    const { ValueView } = await import("../src/renderer/valueView");
    const html = renderToStaticMarkup(
      createElement(ValueView, { value: YAML, hint: { mime: "application/yaml" } } as never),
    );
    expect(html).toContain(">Code<");
    expect(html).toContain(">Source<");
  });
});
