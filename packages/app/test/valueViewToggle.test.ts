/**
 * Every view the toggle OFFERS has a renderer behind it.
 *
 * The rule the toggle is built on is that a button which can only be pressed to no effect must not
 * be there — `valueView.tsx` says so in its header and `valueViews.ts` prunes the list to enforce
 * it. What neither of them checks is the other direction: `viewsFor` can name a view the component
 * has no branch for, and then the button is there and does nothing.
 *
 * That is not hypothetical. `data`, `table` and `patch` were added to `viewsFor` with their parses
 * wired up and their bodies never written, so all three fell past every branch to the raw source —
 * three buttons on a YAML document, two of which drew what the third drew. A test that renders each
 * view of a value and demands they DIFFER is what makes "the toggle offers no dead buttons" a fact
 * about the code rather than a claim in a comment.
 *
 * Rendered through `react-dom/server`, like every other view test here: the questions are all about
 * what the tree contains, and static markup answers them with no environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { viewsFor, type ViewHint, type ViewId } from "@jaira/shared/browser";
import { ValueView } from "../src/renderer/valueView";

const draw = (value: unknown, hint: ViewHint, view: ViewId): string =>
  renderToStaticMarkup(createElement(ValueView, { value, hint, view, chrome: false }));

const YAML = ["name: feature", "steps:", "  - draft", "  - critique"].join("\n");
const CSV = "name,count\nAda,3\nGrace,4";
const PATCH = ["--- a/one.ts", "+++ b/one.ts", "@@ -1,2 +1,2 @@", "-was", "+is"].join("\n");

describe("no view in the toggle draws what another one draws", () => {
  const cases: Array<{ what: string; value: unknown; hint: ViewHint }> = [
    { what: "a YAML document", value: YAML, hint: { mime: "application/yaml" } },
    { what: "a CSV", value: CSV, hint: { mime: "text/csv" } },
    { what: "a patch", value: PATCH, hint: { mime: "text/x-diff" } },
  ];

  for (const { what, value, hint } of cases) {
    it(`gives ${what} a distinct rendering for every view it offers`, () => {
      const views = viewsFor(value, hint);
      expect(views.length).toBeGreaterThan(1);
      const drawn = new Map<string, ViewId>();
      for (const view of views) {
        // `code` mounts Monaco behind a `Suspense`, so on the server it is its fallback — which is
        // the source. Excluded rather than asserted about: what it draws in a browser is Monaco's
        // business and nothing this test can see.
        if (view === "code") continue;
        const html = draw(value, hint, view);
        const clash = drawn.get(html);
        expect(clash, `${view} draws exactly what ${clash} draws`).toBeUndefined();
        drawn.set(html, view);
      }
    });
  }
});

describe("what each restored view actually draws", () => {
  it("reads a YAML document as the value it denotes, not as its own source", () => {
    const html = draw(YAML, { mime: "application/yaml" }, "data");
    // The keys, as a tree — and not the `- draft` of the source it was showing instead.
    expect(html).toContain("doc-tree");
    expect(html).toContain("steps");
    expect(html).not.toContain("- draft");
  });

  it("says WHERE a document broke rather than falling back to its source", () => {
    // The moment a reader most wants the parse is when the document is wrong, so the view that
    // cannot parse reports the position instead of quietly showing something else.
    const html = draw("a:\n b: [1,\n", { mime: "application/yaml" }, "data");
    expect(html).toContain("vv-parse-error");
  });

  it("lays a CSV out as rows and columns", () => {
    const html = draw(CSV, { mime: "text/csv" }, "table");
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("<td>Ada</td>");
  });

  it("reads a patch as the change it describes", () => {
    const html = draw(PATCH, { mime: "text/x-diff" }, "patch");
    expect(html).toContain("vv-patch-file");
    expect(html).toContain("one.ts");
  });
});
