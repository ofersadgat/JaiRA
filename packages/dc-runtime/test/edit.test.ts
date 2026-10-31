import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { editStyle, editText, parse, renderArtboard } from "../src/index.js";
import { artboard, fixture } from "./fixtures.js";

/** Asserts `after` is `before` with `[start, end)` replaced, and nothing else changed. */
function onlyChanged(before: string, after: string, start: number, end: number, insert: string): void {
  expect(after).toBe(before.slice(0, start) + insert + before.slice(end));
}

const poster = fixture("poster.dc.html");
const h1 = parse(poster).elements.find((el) => el.tag === "h1")!;

describe("editStyle", () => {
  it("rewrites the style value's bytes and nothing else", () => {
    const after = editStyle(poster, h1.n, "margin: 0; font-size: 64px; color: {{accent}}");
    onlyChanged(poster, after, h1.style!.start, h1.style!.end, "margin: 0; font-size: 64px; color: {{accent}}");
    expect(parse(after).elements.map((el) => el.tag)).toEqual(parse(poster).elements.map((el) => el.tag));
  });

  it("round-trips: writing the same style back is the same file", () => {
    for (const el of parse(poster).elements) {
      if (el.style) expect(editStyle(poster, el.n, poster.slice(el.style.start, el.style.end))).toBe(poster);
    }
  });

  it("adds a style after the last attribute of an element with none", () => {
    const source = artboard(`<p class="lead">Hi</p><img src="a.png"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><section></section>`);
    const [p, img, , path, section] = parse(source).elements;
    expect(editStyle(source, p!.n, "color: red")).toContain(`<p class="lead" style="color: red">Hi</p>`);
    expect(editStyle(source, img!.n, "width: 10px")).toContain(`<img src="a.png" style="width: 10px">`);
    expect(editStyle(source, path!.n, "fill: red")).toContain(`<path d="M0 0" style="fill: red"/>`);
    expect(editStyle(source, section!.n, "gap: 4px")).toContain(`<section style="gap: 4px"></section>`);
    onlyChanged(source, editStyle(source, p!.n, "color: red"), p!.styleInsert, p!.styleInsert, ` style="color: red"`);
  });

  it("removes the attribute for an empty style, and escapes for the quote in use", () => {
    const source = artboard(`<p class="a" style="color: red" id="b">x</p><q style='a: b'>y</q><b style=color:red>z</b>`);
    const [p, q, b] = parse(source).elements;
    expect(editStyle(source, p!.n, "  ")).toContain(`<p class="a" id="b">x</p>`);
    expect(editStyle(source, q!.n, `font-family: 'Inter'`)).toContain(`<q style='font-family: &#39;Inter&#39;'>y</q>`);
    expect(editStyle(source, p!.n, `font-family: "Inter"`)).toContain(`style="font-family: &quot;Inter&quot;"`);
    expect(editStyle(source, b!.n, "color: blue; margin: 0")).toContain(`<b style="color: blue; margin: 0">z</b>`);
    // What was written reads back as the style that was asked for.
    const quoted = editStyle(source, q!.n, `font-family: 'Inter'`);
    const style = parse(quoted).elements[q!.n]!.style!;
    expect(renderToStaticMarkup(renderArtboard(quoted))).toContain(`font-family:&#x27;Inter&#x27;`);
    expect(quoted.slice(style.start, style.end)).toBe("font-family: &#39;Inter&#39;");
  });
});

describe("editText", () => {
  it("retypes an element's literal text in place", () => {
    const after = editText(poster, h1.n, "Summer Menu");
    onlyChanged(poster, after, h1.text!.start, h1.text!.end, "Summer Menu");
  });

  it("escapes what would otherwise be markup or a hole, so it reads back as typed", () => {
    const after = editText(poster, h1.n, "Fish & <Chips> {{ not a hole }}");
    const markup = renderToStaticMarkup(renderArtboard(after));
    expect(markup).toContain(">Fish &amp; &lt;Chips&gt; {{ not a hole }}</h1>");
    expect(parse(after).elements[h1.n]!.text).not.toBeNull();
  });

  it("keeps the whitespace around the text", () => {
    const source = artboard(`<p>\n    Hello there\n  </p>`);
    const after = editText(source, 0, "Bye");
    expect(after).toContain(`<p>\n    Bye\n  </p>`);
  });

  it("refuses an element whose content is not one literal text", () => {
    const sample = fixture("format-sample.dc.html");
    expect(() => editText(sample, 3, "x")).toThrow(/one literal text/);
    expect(() => editText(sample, 99, "x")).toThrow(/no element 99/);
  });
});
