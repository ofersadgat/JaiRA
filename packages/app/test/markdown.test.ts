/**
 * The markdown fold, and the seam a caller uses to take over a fenced block.
 *
 * This renderer stopped producing an HTML string and started producing elements, which is a change
 * with two things worth defending. The seam is the point of the exercise: a model that cannot reach
 * `show_artifact` pastes a page into its answer, and a page in a grey box is not something anybody
 * can look at. The fold is the part that has to not regress while gaining it — a document is a
 * document, tables and nested lists included.
 *
 * The third group is the one that used to belong to DOMPurify. Dropping a sanitizer is only safe if
 * what it was doing is done somewhere, so these assert the two jobs it had: markup in the source
 * stays text, and a `javascript:` URL never reaches an attribute. Both are now structural rather
 * than a library's business, and structural claims are the kind you write down.
 *
 * Rendered through `react-dom/server` rather than a DOM: the questions here are all about what the
 * tree contains, and static markup answers every one of them without an environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, type FenceRenderer } from "../src/renderer/markdown";

/** One document, as the markup it renders to. */
const render = (text: string, fence?: FenceRenderer): string =>
  renderToStaticMarkup(createElement(Markdown, fence === undefined ? { text } : { text, fence }));

describe("the fold", () => {
  it("renders the ordinary shapes of a document", () => {
    const html = render("# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("nests, which is the whole reason this is a stack", () => {
    const html = render("- outer\n  - inner\n\n> quoted\n");
    expect(html).toContain("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("carries a table's column alignment across as a style React understands", () => {
    // The one inline style markdown-it emits. Passed through as a raw `style` string it would be a
    // prop React refuses to set, and the column would silently lose its alignment.
    const html = render("| a | b |\n| :- | --: |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toMatch(/text-align:\s*right/);
  });

  it("renders a truncated document rather than dropping it", () => {
    // The ordinary case on this surface, not an error: an answer arrives a token at a time, so the
    // stream is half a document more often than it is a whole one. An unclosed frame is closed.
    const html = render("# Title\n\n- one\n- two");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>two</li>");
  });
});

describe("the fence seam", () => {
  it("draws a grey box when nobody takes the block", () => {
    const html = render("```js\nconst x = 1;\n```\n");
    expect(html).toContain('<pre class="language-js"><code>const x = 1;');
  });

  it("hands the block over, tagged with its language", () => {
    const seen: { lang: string; code: string }[] = [];
    render("```html\n<b>hi</b>\n```\n", (block) => {
      seen.push({ lang: block.lang, code: block.code });
      return createElement("span", null, "drawn");
    });
    expect(seen).toEqual([{ lang: "html", code: "<b>hi</b>\n" }]);
  });

  it("puts what the renderer returned into the document", () => {
    const html = render("intro\n\n```html\n<b>hi</b>\n```\n", () => createElement("span", null, "drawn"));
    expect(html).toContain("<span>drawn</span>");
    // And the source is NOT also emitted — one block, one rendering.
    expect(html).not.toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("falls back when the renderer declines, which is what `undefined` means", () => {
    // The distinction that makes the contract work: "I have nothing for `python`" must show the
    // source, where a renderer returning nothing at all would swallow the block entirely.
    const html = render("```python\nprint(1)\n```\n", ({ lang }) =>
      lang === "html" ? createElement("span", null, "drawn") : undefined,
    );
    expect(html).toContain("<code>print(1)");
  });

  it("reaches a fence nested inside a list", () => {
    // The case that killed the placeholder-splicing alternative: the block is not at the top level,
    // so there is nothing to split the document on — and a fold does not care.
    const html = render("- step one\n\n  ```html\n  <b>hi</b>\n  ```\n", () => createElement("span", null, "drawn"));
    expect(html).toContain("<span>drawn</span>");
    expect(html).toContain("<li>");
  });
});

describe("what the sanitizer used to do", () => {
  it("keeps markup in the source as TEXT", () => {
    // `html: false` at the parser, and React escaping at the renderer. Two layers, and the point is
    // that neither one is a filter over a string that has already become markup.
    const html = render("<script>alert(1)</script>\n\nand <b>this</b> too\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;this&lt;/b&gt;");
  });

  it("never puts a `javascript:` URL in an attribute", () => {
    // Refused by the FIRST layer here: markdown-it's own `validateLink` declines to parse it as a
    // link at all, so it stays literal text. Which is the assertion worth making — not that the
    // characters are absent, but that they never reach an `href`.
    const html = render("[click me](javascript:alert(1))\n");
    expect(html).not.toMatch(/href=/);
    // The words survive either way — dropping them would delete what the model wrote, silently.
    expect(html).toContain("click me");
  });

  it("refuses a scheme the parser allows and this renderer does not", () => {
    // The SECOND layer, on its own. `ftp:` passes `validateLink` — it is not one of the three it
    // blocks — and is still not something to hand a privileged window, so the allowlist stops it and
    // the link renders inert with its text intact.
    const html = render("[grab it](ftp://host/file)\n");
    expect(html).not.toMatch(/href=/);
    expect(html).toContain("grab it");
  });

  it("keeps an ordinary link, and opens it away from the privileged window", () => {
    const html = render("[docs](https://example.com/a)\n");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("keeps a relative link, which has no scheme to abuse", () => {
    expect(render("[a](./notes.md)\n")).toContain('href="./notes.md"');
  });
});

describe("front matter", () => {
  it("does not let a document's header become its loudest heading", () => {
    // The failure this rule exists for: `---` is a thematic break, and `---` UNDER a paragraph is a
    // setext underline, so an unhandled header renders as a rule plus a three-line `<h2>` that says
    // `id: … type: … status: proposed`. Nothing in the document claims that, and it sits above the
    // real title.
    const html = render("---\nid: product/x\nstatus: proposed\n---\n\n# Real title\n\nBody.\n");
    expect(html).not.toContain("<h2>");
    expect(html).toContain("<h1>Real title</h1>");
  });

  it("keeps the header rather than deleting it", () => {
    // Collapsed, not dropped. A renderer that silently loses lines is one you cannot trust about
    // the lines it kept.
    const html = render("---\nid: product/x\n---\n\n# Title\n");
    expect(html).toContain("front matter");
    expect(html).toContain("id: product/x");
  });

  it("leaves two thematic breaks alone, because an empty header is not one", () => {
    const html = render("---\n---\n\ntext\n");
    expect(html).not.toContain("md-front");
    expect(html).toContain("<hr/>");
  });

  it("only reads a header at the top, never mid-document", () => {
    const html = render("# Title\n\n---\nnot: a header\n---\n");
    expect(html).not.toContain("md-front");
  });
});
