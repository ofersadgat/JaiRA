/**
 * A delimited file drawn as the grid it is.
 *
 * The parsing is `structured.ts`'s and tested there; what is left here is the layout's two
 * judgements — the first row is a header, and a long file is cut rather than drawn — plus the
 * property that makes the cut safe to make: the reader is told, and told where the rest is.
 *
 * Rendered through `react-dom/server` for the reason `markdown.test.ts` gives: every question here
 * is about what the tree contains, and static markup answers all of them without an environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableView } from "../src/renderer/valueView";

const render = (rows: string[][]): string => renderToStaticMarkup(createElement(TableView, { rows }));

describe("TableView", () => {
  it("draws the first row as the header and the rest as cells", () => {
    const html = render([
      ["name", "count"],
      ["Ada", "3"],
    ]);
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("<th>count</th>");
    expect(html).toContain("<td>Ada</td>");
    expect(html).not.toContain("<th>Ada</th>");
  });

  it("draws a ragged row as it is, rather than padding it into agreement", () => {
    // A row with a field too many is usually the thing somebody opened the file to find — see
    // `parseDelimited`. Hiding it inside a tidy grid would be the renderer taking that away.
    const html = render([
      ["a", "b"],
      ["1", "2", "3"],
    ]);
    expect(html).toContain("<td>3</td>");
  });

  it("says so when it stops, and says where the rest is", () => {
    const rows = [["n"], ...Array.from({ length: 620 }, (_, i) => [String(i)])];
    const html = render(rows);
    expect(html).toContain("<td>499</td>");
    expect(html).not.toContain("<td>500</td>");
    expect(html).toContain("120 more rows");
    expect(html).toContain("under Source");
  });

  it("counts one leftover row in the singular", () => {
    const rows = [["n"], ...Array.from({ length: 501 }, (_, i) => [String(i)])];
    expect(render(rows)).toContain("1 more row");
  });

  it("says nothing about a cut it did not make", () => {
    const html = render([["a"], ["1"]]);
    expect(html).not.toContain("more row");
  });

  it("has an honest answer for a file with nothing in it", () => {
    expect(render([])).toContain("No rows.");
  });

  it("draws a header-only file as a header, not as an error", () => {
    // One row is a legitimate CSV: the columns are declared and nothing has been recorded yet.
    const html = render([["name", "count"]]);
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("<tbody></tbody>");
  });
});
