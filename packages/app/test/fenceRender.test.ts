/**
 * The fenced blocks of a markdown DOCUMENT, drawn the way a model's answer already drew them.
 *
 * This is a wiring test, and the wiring is the whole bug it exists for. The renderer had lived in
 * `transcriptView.tsx`, so only the transcript could reach it: a ```yaml block was a full reading in
 * a model's answer and a grey `<pre>` in the `.md` file in the next pane. A workflow description is
 * prose wrapped around fenced YAML, which made the grey box most of the document.
 *
 * Nothing below passes a `fence` prop, and that is deliberate. The prop was the defect — optional
 * injection is injection three of four callers skipped — so what these assert is that a plain
 * `<Markdown>` draws its blocks properly on its own.
 *
 * Rendered through `react-dom/server`, so what these assert is the tree — the lazily-loaded
 * highlighter never resolves here, and its `Suspense` fallback standing in is expected.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/markdown";
import { ValueView } from "../src/renderer/valueView";
// Imported for the SIDE EFFECT as much as for the component: this module installs the fence
// renderer (see `registerFenceRenderer`), which is what makes the bare `<Markdown>` below draw its
// fenced blocks. That is the whole point of the registration — nothing has a prop to forget.
import { MarkdownView } from "../src/renderer/fenceRender";

/** No `fence` prop anywhere. The registration is what is under test. */
const render = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

const asFile = (text: string): string =>
  renderToStaticMarkup(
    createElement(MarkdownView, {
      doc: { layer: "project", path: "workflows/feature.md", text, exists: true },
      busy: false,
      onSave: () => undefined,
      context: {},
    } as never),
  );

describe("a fence inside a document", () => {
  it("gives YAML the same reading it gets in a transcript, not a grey box", () => {
    const html = render("# Title\n\n```yaml\nid: plan\n```\n");
    expect(html).toContain("vv-toggle");
    // The readings YAML earns — see `viewsFor`. `language-yaml` is the bare `<pre>` this replaced.
    expect(html).toContain(">Data<");
    expect(html).not.toContain("language-yaml");
  });

  it("does the same for the other formats that have a reading", () => {
    expect(render("```json\n{}\n```\n")).toContain(">Data<");
    expect(render("```csv\na,b\n1,2\n```\n")).toContain(">Table<");
    expect(render("```diff\n@@ -1 +1 @@\n-a\n+b\n```\n")).toContain(">Diff<");
  });

  it("leaves a language with no better reading as its source", () => {
    // The seam's contract: declining is `undefined`, and the fold shows the block. Python has a
    // grammar and so earns `Code`, but nothing beyond it — no second button to press to no effect.
    const html = render("```python\nx = 1\n```\n");
    expect(html).toContain(">Code<");
    expect(html).not.toContain(">Data<");
    // …and a fence naming nothing at all stays exactly what it was.
    expect(render("```\nplain\n```\n")).not.toContain("vv-toggle");
  });

  it("reaches the file surface too, which is where the grey box actually was", () => {
    const html = asFile("---\nname: feature\n---\n\n```yaml\nid: plan\n```\n");
    expect(html).toContain("vv-toggle");
    expect(html).not.toContain("language-yaml");
  });

  it("gives the FRONT MATTER the same reading, because it is a YAML document too", () => {
    // It was coloured and nothing more: a `<pre>` inside a `<details>`, with no way to ask what the
    // header actually denotes. A header and a fence are the same content in the same file, so they
    // go through the same renderer under the same name rather than this module learning a second
    // way to draw YAML.
    const html = render("---\nname: feature\ntools: [Read, Write]\n---\n\n# Title\n");
    const header = html.slice(html.indexOf("md-front"), html.indexOf("<h1>"));
    expect(header).toContain("vv-toggle");
    expect(header).toContain(">Data<");
    // Still folded away behind its summary — a header must not compete with the first heading.
    expect(header).toContain("<summary>front matter</summary>");
  });

  it("says so for an empty file rather than drawing an empty document", () => {
    expect(asFile("   \n")).toContain("This file is empty.");
  });
});

describe("a markdown value that is only being read", () => {
  /** The shape `components.tsx` renders a gate's document with: read-only, a mime, no fence prop. */
  const document = (text: string): string =>
    renderToStaticMarkup(createElement(ValueView, { value: text, hint: { mime: "text/markdown" } }));

  it("draws the fences inside an approval document as readings", () => {
    // Where this surfaced. A gate's document is read-only unless its config says otherwise and it
    // passes no fence renderer, so `ValueView` sent it to the live-preview EDITOR — coloured YAML
    // with no reading behind it, while the same block in a model's answer had the full toggle. An
    // editor cannot host one: its document is text with decorations, not a place for a component.
    const html = document(["# Plan", "", "```yaml", "id: plan", "model: opus", "```", "", "Approve?", ""].join("\n"));
    // The document's own toggle…
    expect(html).toContain(">Rendered<");
    // …and the fence's, nested inside it, with the parse behind it.
    expect(html).toContain(">Data<");
    expect(html.match(/vv-toggle/g)?.length).toBeGreaterThan(1);
  });

  it("reads a CSV and a patch in one too, since it is the same renderer", () => {
    expect(document(["```csv", "a,b", "1,2", "```", ""].join("\n"))).toContain(">Table<");
    expect(document(["```diff", "@@ -1 +1 @@", "-a", "+b", "```", ""].join("\n"))).toContain(">Diff<");
  });
});
