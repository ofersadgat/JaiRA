import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyMove, editStyle, editText, formatStyle, insertElement, parse, readStyle, removeElement, renderArtboard, setPropDefault, wrapElement } from "../src/index.js";
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

describe("removeElement", () => {
  it("takes an element and its line out, and leaves the rest byte for byte", () => {
    const source = artboard(`<div style="padding: 8px">\n  <h1>Title</h1>\n  <p>Body</p>\n</div>`);
    const h1 = parse(source).elements.find((el) => el.tag === "h1")!;
    expect(removeElement(source, h1.n)).toBe(source.replace("  <h1>Title</h1>\n", ""));
  });

  it("takes only the element when it shares its line", () => {
    const source = artboard(`<p>a <b>bold</b> c</p>`);
    const b = parse(source).elements.find((el) => el.tag === "b")!;
    expect(removeElement(source, b.n)).toBe(source.replace("<b>bold</b>", ""));
  });
});

describe("insertElement", () => {
  const source = artboard(`<div style="display: flex">\n  <span>one</span>\n  <span>two</span>\n</div>`);
  const div = parse(source).elements.find((el) => el.tag === "div")!;

  it("puts markup before a child, on its own line, indented as that child", () => {
    const after = insertElement(source, div.n, `<em>new</em>`, 1);
    expect(after).toBe(source.replace("  <span>two</span>", "  <em>new</em>\n  <span>two</span>"));
  });

  it("puts markup after the last child, a step in from the closing tag", () => {
    expect(insertElement(source, div.n, `<em>new</em>`)).toBe(source.replace("  <span>two</span>\n</div>", "  <span>two</span>\n  <em>new</em>\n</div>"));
  });

  it("puts markup at the end of the template itself", () => {
    const after = insertElement(source, null, `<footer>end</footer>`);
    expect(parse(after).elements.at(-1)!.tag).toBe("footer");
    expect(parse(after).elements.find((el) => el.tag === "footer")!.parent).toBeNull();
  });
});

describe("readStyle and formatStyle", () => {
  it("round-trip CSS names and values verbatim, holes and !important included", () => {
    const text = "background: {{tab.bg}}; color: red !important; font-family: 'A; B', serif; background-image: url(data:x;base64,AA)";
    const read = readStyle(text);
    expect(read).toEqual({ background: "{{tab.bg}}", color: "red !important", "font-family": "'A; B', serif", "background-image": "url(data:x;base64,AA)" });
    expect(readStyle(formatStyle(read))).toEqual(read);
  });

  it("drops an emptied declaration", () => {
    expect(formatStyle({ width: "10px", height: "" })).toBe("width: 10px");
  });
});

describe("applyMove", () => {
  const source = artboard(`<div style="display: flex; gap: 8px">\n  <span style="color: red">one</span>\n  <span>two</span>\n</div>`);
  const [div, one, two] = parse(source).elements;
  const parent = { id: div!.n, rect: { x: 10, y: 20, width: 300, height: 40 }, style: "display: flex; gap: 8px" };

  it("drags an item out of a stack: the parent keeps its size, the sibling stays where it stood, the item goes where it was dropped", () => {
    const after = applyMove(source, { id: one!.n, dx: 30, dy: 50, rect: { x: 10, y: 20, width: 40, height: 20 }, style: "color: red", parent, siblings: [{ id: two!.n, rect: { x: 58, y: 20, width: 40, height: 20 }, style: "" }] });
    const [d, a, b] = parse(after).elements;
    const styleOf = (el: typeof d) => readStyle(after.slice(el!.style!.start, el!.style!.end));
    expect(styleOf(d)).toEqual({ display: "flex", gap: "8px", position: "relative", width: "300px", height: "40px" });
    expect(styleOf(b)).toEqual({ position: "absolute", left: "48px", top: "0px", width: "40px", height: "20px", margin: "0" });
    expect(styleOf(a)).toEqual({ color: "red", position: "absolute", left: "30px", top: "50px", width: "40px", height: "20px", margin: "0" });
    // Nothing but the three styles changed.
    expect(after.replace(/ style="[^"]*"/g, "")).toBe(source.replace(/ style="[^"]*"/g, ""));
  });

  it("only moves an element that is placed already", () => {
    const placed = editStyle(source, one!.n, "position: absolute; left: 30px; top: 50px");
    const after = applyMove(placed, { id: one!.n, dx: 5, dy: -10, rect: { x: 40, y: 70, width: 40, height: 20 }, style: "position: absolute; left: 30px; top: 50px", parent, siblings: [] });
    const a = parse(after).elements[one!.n]!;
    expect(readStyle(after.slice(a.style!.start, a.style!.end))).toEqual({ position: "absolute", left: "35px", top: "40px" });
  });

  it("offsets a top element, which has nothing to be placed in", () => {
    const after = applyMove(source, { id: div!.n, dx: 12, dy: 4, rect: parent.rect, style: parent.style, parent: null, siblings: [] });
    expect(readStyle(after.slice(parse(after).elements[0]!.style!.start, parse(after).elements[0]!.style!.end))).toMatchObject({ position: "relative", left: "12px", top: "4px" });
  });
});

describe("wrapElement", () => {
  it("puts an element in a new stack or grid and changes nothing else", () => {
    const source = artboard(`<p>a <b>bold</b> c</p>`);
    const b = parse(source).elements.find((el) => el.tag === "b")!;
    expect(wrapElement(source, b.n, "stack")).toBe(source.replace("<b>bold</b>", `<div style="display: flex; flex-direction: column; gap: 8px"><b>bold</b></div>`));
    const grid = wrapElement(source, b.n, "grid");
    expect(parse(grid).elements.find((el) => el.tag === "b")!.parent).toBe(parse(grid).elements.find((el) => el.tag === "div")!.n);
    expect(grid).toContain("repeat(2, minmax(0, 1fr))");
  });
});

describe("setPropDefault", () => {
  it("keeps a tweak as the prop's default, escaped as the attribute needs, and the rest of the file as it was", () => {
    const poster = fixture("poster.dc.html");
    const after = setPropDefault(poster, "accent", "#a9441f");
    expect(parse(after).props["accent"]).toMatchObject({ editor: "color", default: "#a9441f" });
    const quoted = setPropDefault(poster, "accent", "it's & done");
    expect(parse(quoted).props["accent"]!.default).toBe("it's & done");
    expect(quoted).toContain("it&#39;s &amp; done");
    // Outside the attribute, nothing moved.
    expect(after.slice(0, after.indexOf("data-props"))).toBe(poster.slice(0, poster.indexOf("data-props")));
  });
});
