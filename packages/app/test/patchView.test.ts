/**
 * A patch, drawn.
 *
 * The parse is tested in `shared/test/unifiedDiff.test.ts`; what is left here is the rendering's two
 * promises, both of which exist because this is NOT the changeset viewer. The line numbers on screen
 * are the patch's own — a Monaco re-diff of synthesized text would number from 1 and quietly send a
 * reader to the wrong place — and the gap between two hunks is drawn as a boundary rather than closed
 * up, because lines 130 and 400 are not neighbours.
 *
 * Rendered through `react-dom/server`, like the other component tests here: every question is about
 * what the tree contains.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@jaira/shared/browser";
import { PatchView } from "../src/renderer/valueView";

const render = (patch: string): string =>
  renderToStaticMarkup(createElement(PatchView, { files: parseUnifiedDiff(patch) }));

const TWO_HUNKS = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,2 +10,3 @@ function boot() {",
  " const a = 1;",
  "+const b = 2;",
  " return a;",
  "@@ -400,2 +401,1 @@ function stop() {",
  " const c = 3;",
  "-const d = 4;",
  "",
].join("\n");

describe("PatchView", () => {
  it("shows the patch's own line numbers, not a count from one", () => {
    const html = render(TWO_HUNKS);
    expect(html).toContain(">10<");
    expect(html).toContain(">400<");
    expect(html).toContain(">401<");
  });

  it("draws each hunk as its own region, so the gap between them is visible", () => {
    const html = render(TWO_HUNKS);
    expect(html.match(/vv-patch-hunk/g)).toHaveLength(2);
    expect(html).toContain("@@ -10,2 +10,3 @@");
    expect(html).toContain("@@ -400,2 +401,1 @@");
    // The section git names after the second `@@` rides along — it is the cheapest possible answer
    // to "where in the file am I".
    expect(html).toContain("function stop() {");
  });

  it("marks added and removed lines apart from context", () => {
    const html = render(TWO_HUNKS);
    expect(html.match(/ln-add/g)).toHaveLength(1);
    expect(html.match(/ln-del/g)).toHaveLength(1);
    // Two context lines around the addition, one before the deletion.
    expect(html.match(/ln-context/g)).toHaveLength(3);
  });

  it("heads the whole patch with what it touches and what moved", () => {
    const html = render(TWO_HUNKS);
    expect(html).toContain("1 file");
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).toContain("src/app.ts");
  });

  it("names a rename on both sides", () => {
    const html = render("diff --git a/x.ts b/y.ts\nrename from x.ts\nrename to y.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(html).toContain("x.ts");
    expect(html).toContain("y.ts");
    expect(html).toContain("rename");
  });

  it("says a binary file cannot be shown rather than drawing an empty block", () => {
    const html = render("diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n");
    expect(html).toContain("binary");
    expect(html).not.toContain("vv-patch-hunk");
  });

  it("has an honest answer for a header with no hunks — a mode change is not nothing", () => {
    const html = render("diff --git a/x.sh b/x.sh\nold mode 100644\nnew mode 100755\n");
    expect(html).toContain("No lines change");
  });

  it("draws nothing rather than an empty frame when the parse declined", () => {
    expect(renderToStaticMarkup(createElement(PatchView, { files: [] }))).toContain("could be read");
  });
});
