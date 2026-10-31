import { describe, expect, it } from "vitest";
import { decodeEntities, evaluate, parse, parseHtml, type ElementNode } from "../src/index.js";
import { scope as scopeOf } from "../src/holes.js";
import { artboard, fixture } from "./fixtures.js";

const slice = (source: string, range: { start: number; end: number } | null): string | null => (range ? source.slice(range.start, range.end) : null);

describe("parse", () => {
  it("reads format.md's sample: title, lang, helmet, template, script, props", () => {
    const source = fixture("format-sample.dc.html");
    const doc = parse(source);
    expect(doc.error).toBeNull();
    expect(doc.title).toBe("Hello");
    expect(doc.lang).toBe("en");
    expect(doc.helmet).toContain("body { margin: 0; font-family: system-ui, sans-serif; }");
    expect(doc.template.startsWith("\n<helmet>")).toBe(true);
    expect(doc.template.trimEnd().endsWith("</div>")).toBe(true);
    expect(doc.script).toContain("class Component extends DCLogic");
    expect(doc.props).toEqual({ title: { editor: "text", default: "Hello" } });
    expect(doc.preview).toBeUndefined();
    expect(doc.elements.map((el) => el.tag)).toEqual(["helmet", "style", "div", "h1", "sc-for", "div"]);
    expect(doc.elements.map((el) => el.parent)).toEqual([null, 0, null, 2, 2, 4]);
  });

  it("reports each element's start tag, style value and literal text as source offsets", () => {
    const source = fixture("poster.dc.html");
    const doc = parse(source);
    expect(doc.preview).toEqual({ width: 880, height: 560 });
    expect(Object.keys(doc.props)).toEqual(["accent"]);
    const [root, h1, img] = doc.elements.filter((el) => ["div", "h1", "img"].includes(el.tag));
    expect(slice(source, root!.startTag)).toMatch(/^<div style="width: 880px;.*gap: 24px">$/);
    expect(slice(source, h1!.style)).toBe("margin: 0; font-size: 56px; color: {{accent}}");
    expect(slice(source, h1!.text)).toBe("Spring Menu");
    expect(slice(source, h1!.outer)).toBe('<h1 style="margin: 0; font-size: 56px; color: {{accent}}">Spring Menu</h1>');
    expect(img!.text).toBeNull();
    expect(slice(source, img!.style)).toBe("width: 240px; height: 160px; object-fit: cover");
    // The format sample's <h1> holds a hole, so it has no literal text to retype.
    const sample = parse(fixture("format-sample.dc.html"));
    expect(sample.elements[3]!.text).toBeNull();
    expect(sample.elements[2]!.style).not.toBeNull();
  });

  it("gives an element with no style the place one would be inserted, and an empty one its text range", () => {
    const source = artboard(`<p class="x"   ></p><br><svg viewBox="0 0 2 2"><path d="M0 0"/></svg>`);
    const doc = parse(source);
    const [p, br, , path] = doc.elements;
    expect(source.slice(p!.startTag.start, p!.styleInsert)).toBe('<p class="x"');
    expect(slice(source, p!.text)).toBe("");
    expect(p!.text!.start).toBe(p!.startTag.end);
    expect(br!.text).toBeNull();
    expect(source.slice(path!.startTag.start, path!.styleInsert)).toBe('<path d="M0 0"');
  });

  it("decodes data-props with getAttribute's semantics before JSON", () => {
    const doc = parse(artboard("<p></p>", "class Component extends DCLogic {}", `{"label":{"editor":"text","default":"Tom &amp; Jerry&#39;s \\"best\\" — ok"}}`));
    expect(doc.error).toBeNull();
    expect(doc.props["label"]!.default).toBe(`Tom & Jerry's "best" — ok`);
  });

  it("names what makes a file undrawable", () => {
    expect(parse("<html><body><div></div></body></html>").error).toMatch(/no <x-dc>/);
    expect(parse(artboard("<p></p>", "class Component extends DCLogic {}", "{nope")).error).toMatch(/data-props is not valid JSON/);
  });

  it("finds a script with no data-props, and a file with no script", () => {
    expect(parse(artboard("<p></p>", "class Component extends DCLogic {}")).script).toContain("class Component");
    const bare = parse(artboard("<p>{{x}}</p>"));
    expect(bare.script).toBeNull();
    expect(bare.error).toBeNull();
  });
});

describe("the HTML underneath", () => {
  const els = (html: string): ElementNode[] => {
    const out: ElementNode[] = [];
    const walk = (el: ElementNode): void => {
      for (const child of el.children) if (child.type === "element") (out.push(child), walk(child));
    };
    walk(parseHtml(html));
    return out;
  };

  it("reads every attribute form, keeps the written name, and the first of a repeated one", () => {
    const [el] = els(`<input type=checkbox disabled data-x='a "b"' onClick="{{ go }}" title="&lt;hi&gt;" type="text">`);
    expect(el!.attrs.map((a) => [a.name, a.key, a.value, a.quote])).toEqual([
      ["type", "type", "checkbox", ""],
      ["disabled", "disabled", null, ""],
      ["data-x", "data-x", 'a "b"', "'"],
      ["onClick", "onclick", "{{ go }}", '"'],
      ["title", "title", "<hi>", '"'],
    ]);
  });

  it("knows void elements, raw text, comments and implied end tags", () => {
    const tags = els(`<p>a<img src=x>b</p><!-- <div> --><style>a > b { content: "<p>" }</style><ul><li>one<li>two</ul><p>x<div>y</div>`);
    expect(tags.map((el) => el.tag)).toEqual(["p", "img", "style", "ul", "li", "li", "p", "div"]);
    const style = tags[2]!;
    expect(style.children).toHaveLength(1);
    expect(style.children[0]).toMatchObject({ type: "text", raw: 'a > b { content: "<p>" }', decode: false });
    const [ul] = tags.filter((el) => el.tag === "ul");
    expect(ul!.children.map((c) => (c.type === "element" ? c.tag : "#text"))).toEqual(["li", "li"]);
    // `<p>` is closed by the `<div>`, so the div is the p's sibling.
    const root = parseHtml(`<p>x<div>y</div>`);
    expect(root.children.map((c) => (c.type === "element" ? c.tag : "#text"))).toEqual(["p", "div"]);
  });

  it("keeps SVG's case and its self-closing tags; HTML ignores a self-closing slash", () => {
    const tags = els(`<svg viewbox="0 0 24 24"><lineargradient id="g"></lineargradient><path stroke-width="2" d="M1 1"/><circle r="1"/></svg><dc-import name="Card"/><p>inside</p>`);
    expect(tags.map((el) => el.tag)).toEqual(["svg", "linearGradient", "path", "circle", "dc-import", "p"]);
    expect(tags[0]!.attrs[0]!.key).toBe("viewBox");
    expect(tags[2]!.children).toEqual([]);
    // As in a browser, `<dc-import/>` is an open tag: what follows ends up inside it (format.md: never self-close).
    expect(tags[4]!.children.some((c) => c.type === "element" && c.tag === "p")).toBe(true);
  });

  it("decodes named, decimal and hex references, and leaves unknown ones", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#39;&#x27; &mdash; &copy &nosuch; &#0;")).toBe("a & b <c> '' — © &nosuch; �");
  });
});

describe("holes", () => {
  const at = scopeOf({ user: { name: "Ada", tags: ["x"] }, n: 0, fn: () => 1 });

  it("are dotted lookups or literals", () => {
    expect(evaluate(" user.name ", at)).toBe("Ada");
    expect(evaluate("user.tags.0", at)).toBe("x");
    expect(evaluate("user.missing.deeper", at)).toBeUndefined();
    expect(evaluate("true", at)).toBe(true);
    expect(evaluate("3", at)).toBe(3);
    expect(evaluate("-1.5", at)).toBe(-1.5);
    expect(evaluate("'x y'", at)).toBe("x y");
    expect(evaluate("n", at)).toBe(0);
  });

  it("are never expressions: those are undefined", () => {
    for (const expr of ["n + 1", "!n", "fn()", "user['name']", "a ? b : c", "`x`", "user.name.toUpperCase()"]) {
      expect(evaluate(expr, at)).toBeUndefined();
    }
  });
});
