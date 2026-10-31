import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parse, renderArtboard, type RenderOptions } from "../src/index.js";
import { propsOf } from "../src/attrs.js";
import { scope } from "../src/holes.js";
import { artboard, fixture, returning } from "./fixtures.js";

const html = (source: string, options?: RenderOptions): string => renderToStaticMarkup(renderArtboard(source, options));

describe("rendering", () => {
  it("draws format.md's sample", () => {
    const markup = html(fixture("format-sample.dc.html"));
    expect(markup).toContain(`<div style="padding:32px" data-dc-id="2" data-dc-src="Main.dc.html">`);
    expect(markup).toContain(`<h1 data-dc-id="3">Hello</h1>`);
    expect(markup).toContain(`<div data-dc-id="5">One</div>`);
    expect(markup).toContain("a { color: #b45309; } a:hover { color: #92400e; }");
    expect(markup).not.toContain("{{");
    expect(markup).not.toContain("sc-for");
  });

  it("draws SKILL.md's poster, its accent tweak at the default and overridden", () => {
    const source = fixture("poster.dc.html");
    const markup = html(source);
    expect(markup).toContain(
      `<div style="width:880px;height:560px;box-sizing:border-box;padding:64px;display:flex;flex-direction:column;gap:24px" data-dc-id="2" data-dc-src="Main.dc.html">`,
    );
    expect(markup).toContain(`<h1 style="margin:0;font-size:56px;color:#666666" data-dc-id="3">Spring Menu</h1>`);
    expect(markup).toContain(`<img src="/_blob/&lt;id&gt;" style="width:240px;height:160px;object-fit:cover" data-dc-id="4"/>`);
    expect(html(source, { props: { accent: "#b45309" } })).toContain(`color:#b45309`);
    expect(html(source, { helmet: "omit" })).not.toContain("<style");
  });

  it("repeats with sc-for: per-item values, $index, interpolated class and style, shared data-dc-id", () => {
    const markup = html(fixture("swatches.dc.html"));
    expect(markup.match(/<button /g)).toHaveLength(3);
    expect(markup).toContain(`<button class="swatch is-off" aria-pressed="false" style="background:#e8d9b5;width:44px;height:44px" data-dc-id="2">0: Sand</button>`);
    expect(markup).toContain(`<button class="swatch is-on" aria-pressed="true" style="background:#6b7f4a;width:44px;height:44px" data-dc-id="2">1: Moss</button>`);
    expect(markup).toContain(`>2: Clay</button>`);
    // `state` seeded from a prop: the enum tweak's default, then a value given over it.
    expect(markup).toContain(`<p data-dc-id="4" data-dc-src="Main.dc.html">Picked moss</p>`);
    expect(html(fixture("swatches.dc.html"), { props: { initial: "clay" } })).toContain("Picked clay");
  });

  it("binds a per-item handler as the function renderVals() made for that item", () => {
    const doc = parse(fixture("swatches.dc.html"));
    const button = doc.nodes.flatMap((n) => (n.type === "element" ? n.children : [])).find((n) => n.type === "element" && n.tag === "sc-for");
    const el = button!.type === "element" ? button!.children.find((n) => n.type === "element") : undefined;
    const pick = (): void => {};
    const props = propsOf(el as never, scope({ swatch: { pick, state: "is-on", hex: "#000", selected: "true" } }));
    expect(props["onClick"]).toBe(pick);
    expect(props["className"]).toBe("swatch is-on");
    expect(props["style"]).toEqual({ background: "#000", width: "44px", height: "44px" });
  });

  it("branches with sc-if both ways", () => {
    const source = artboard(`<sc-if value="{{ on }}"><b>yes</b></sc-if><sc-if value="{{ off }}"><i>no</i></sc-if><sc-if value="{{ missing }}"><u>never</u></sc-if>`, returning(`{ on: 1, off: 0 }`));
    const markup = html(source);
    expect(markup).toContain(`<b data-dc-id="1" data-dc-src="Main.dc.html">yes</b>`);
    expect(markup).not.toContain("<i");
    expect(markup).not.toContain("<u");
  });

  it("draws an expression hole as nothing, silently", () => {
    const source = artboard(`<p>[{{ a + b }}]</p><p>[{{ !flag }}]</p><p>[{{ fn() }}]</p><p title="x{{ a * 2 }}y">[{{ a }}]</p>`, returning(`{ a: 1, b: 2, flag: true, fn: () => 'called' }`));
    const markup = html(source);
    expect(markup).toContain(`<p data-dc-id="0" data-dc-src="Main.dc.html">[]</p>`);
    expect(markup).toContain(`<p data-dc-id="1" data-dc-src="Main.dc.html">[]</p>`);
    expect(markup).toContain(`<p data-dc-id="2" data-dc-src="Main.dc.html">[]</p>`);
    expect(markup).toContain(`<p title="xy" data-dc-id="3" data-dc-src="Main.dc.html">[1]</p>`);
    expect(markup).not.toContain("called");
  });

  it("gives a tweak its declared default, and a given prop wins over it", () => {
    const source = artboard(`<p>{{ label }}</p>`, returning(`{ label: this.props.label ?? 'fallback' }`), `{"label":{"editor":"text","default":"from default"}}`);
    expect(html(source)).toContain(">from default</p>");
    expect(html(source, { props: { label: "given" } })).toContain(">given</p>");
    const undeclared = artboard(`<p>{{ label }}</p>`, returning(`{ label: this.props.label ?? 'fallback' }`), `{"label":{"editor":"text"}}`);
    expect(html(undeclared)).toContain(">fallback</p>");
  });

  it("maps attributes the way React needs them: class, for, booleans, form values, SVG, entities", () => {
    const source = artboard(
      `<label for="q" class="l">Q&amp;A &mdash; ok</label><input id="q" value="start" disabled readonly tabindex="2"><input type="checkbox" checked>` +
        `<input value="{{ v }}" onInput="{{ set }}"><button disabled="{{ busy }}">b</button><textarea>\nfirst</textarea><pre>\nline</pre>` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-width="2" stroke-linecap="round" fill-rule="evenodd" d="M1 1"/><use xlink:href="#a"/></svg>`,
      returning(`{ v: 'bound', set: () => {}, busy: false }`),
    );
    const markup = html(source);
    expect(markup).toContain(`<label for="q" class="l" data-dc-id="0" data-dc-src="Main.dc.html">Q&amp;A — ok</label>`);
    expect(markup).toContain(`<input id="q" disabled="" readOnly="" tabindex="2" data-dc-id="1" data-dc-src="Main.dc.html" value="start"/>`);
    expect(markup).toContain(`<input type="checkbox" data-dc-id="2" data-dc-src="Main.dc.html" checked=""/>`);
    expect(markup).toContain(`<input data-dc-id="3" data-dc-src="Main.dc.html" value="bound"/>`);
    expect(markup).toContain(`<button data-dc-id="4" data-dc-src="Main.dc.html">b</button>`);
    expect(markup).toContain(`<textarea data-dc-id="5" data-dc-src="Main.dc.html">first</textarea>`);
    expect(markup).toContain(`<pre data-dc-id="6" data-dc-src="Main.dc.html">line</pre>`);
    expect(markup).toContain(`<svg viewBox="0 0 24 24" aria-hidden="true" data-dc-id="7" data-dc-src="Main.dc.html">`);
    expect(markup).toContain(`<path stroke-width="2" stroke-linecap="round" fill-rule="evenodd" d="M1 1" data-dc-id="8"></path>`);
    expect(markup).toContain(`<use xlink:href="#a" data-dc-id="9"></use>`);
  });

  it("drops whitespace React refuses in tables, and keeps it elsewhere", () => {
    const source = artboard(`<table>\n<tbody>\n<sc-for list="{{ rows }}" as="r">\n<tr>\n<td>{{ r }}</td>\n</tr>\n</sc-for>\n</tbody>\n</table><p>a <b>b</b> c</p>`, returning(`{ rows: ['x', 'y'] }`));
    const markup = html(source);
    expect(markup).toContain(`<table data-dc-id="0" data-dc-src="Main.dc.html"><tbody data-dc-id="1"><tr data-dc-id="3"><td data-dc-id="4">x</td></tr><tr data-dc-id="3"><td data-dc-id="4">y</td></tr></tbody></table>`);
    expect(markup).toContain(`>a <b data-dc-id="6">b</b> c</p>`);
  });

  it("nests loops, the inner $index shadowing the outer, the outer item still in scope", () => {
    const source = artboard(
      `<sc-for list="{{ groups }}" as="g"><sc-for list="{{ g.items }}" as="it"><i>{{ g.name }}{{ $index }}{{ it }}</i></sc-for></sc-for>`,
      returning(`{ groups: [{ name: 'a', items: ['x', 'y'] }, { name: 'b', items: ['z'] }] }`),
    );
    expect(html(source).match(/>[^<]+<\/i>/g)).toEqual([">a0x</i>", ">a1y</i>", ">b0z</i>"]);
  });

  it("stands in the hint-* values while the file has no script yet", () => {
    const source = artboard(`<sc-for list="{{ items }}" as="item" hint-placeholder-count="3"><li>{{ item.label }}</li></sc-for><sc-if value="{{ open }}" hint-placeholder-val="{{ true }}"><p>open</p></sc-if>`);
    const markup = html(source);
    expect(markup.match(/<li /g)).toHaveLength(3);
    expect(markup).toContain(">open</p>");
    // Once there is a script, an absent list is empty and an absent condition false.
    const withScript = html(artboard(`<sc-for list="{{ items }}" as="item" hint-placeholder-count="3"><li>x</li></sc-for><sc-if value="{{ open }}" hint-placeholder-val="{{ true }}"><p>open</p></sc-if>`, returning("{}")));
    expect(withScript).not.toContain("<li");
    expect(withScript).not.toContain("<p");
  });

  it("mounts a dc-import with its props, kebab to camel, inside a loop", () => {
    const main = artboard(
      `<section><sc-for list="{{ cards }}" as="c"><dc-import name="Card" item="{{ c }}" card-tone="{{ tone }}" hint-size="200px,120px"></dc-import></sc-for></section>`,
      returning(`{ cards: [{ title: 'First' }, { title: 'Second' }], tone: 'warm' }`),
    );
    const markup = html(main, { files: { "Card.dc.html": fixture("Card.dc.html") } });
    expect(markup).toContain(`<article style="width:200px;height:120px" data-dc-id="0" data-dc-src="Card.dc.html">`);
    expect(markup).toContain(`<h2 data-dc-id="1">First</h2>`);
    expect(markup).toContain(`<h2 data-dc-id="1">Second</h2>`);
    expect(markup.match(/<p data-dc-id="2">warm<\/p>/g)).toHaveLength(2);
  });

  it("resolves a dc-import against the importing file's folder, and draws the hint box until it loads", () => {
    const main = artboard(`<dc-import name="Card" hint-size="100%,120px"></dc-import>`, returning("{}"));
    expect(html(main, { path: "sub/Main.dc.html", files: { "sub/Card.dc.html": fixture("Card.dc.html") } })).toContain(`data-dc-src="sub/Card.dc.html"`);
    expect(html(main)).toContain(`<div data-dc-id="0" aria-hidden="true" style="width:100%;height:120px;box-sizing:border-box"></div>`);
    // The child's own default applies when its importer gives nothing.
    const alone = html(main, { files: { "Card.dc.html": fixture("Card.dc.html") } });
    expect(alone).toContain(`<h2 data-dc-id="1">Untitled</h2>`);
    expect(alone).toContain(`<p data-dc-id="2">plain</p>`);
  });

  it("refuses a file that imports itself rather than looping", () => {
    const self = artboard(`<dc-import name="Main"></dc-import>`, returning("{}"));
    expect(html(self, { files: { "Main.dc.html": self } })).toContain("Main.dc.html imports itself.");
  });

  it("draws an error box, never nothing, for a script that fails or is not the class", () => {
    expect(html(artboard(`<p>x</p>`, "class Component extends DCLogic { renderVals() { return {}; }"))).toMatch(/could not be drawn.*The script failed/s);
    expect(html(artboard(`<p>x</p>`, "class Other extends DCLogic {}"))).toContain("must define `class Component extends DCLogic`");
    expect(html(artboard(`<p>x</p>`, "class Component extends DCLogic {}", "{bad"))).toContain("data-props is not valid JSON");
  });

  it("lets the script use React (a ref from createRef) and lifecycle methods exist", () => {
    const source = artboard(
      `<input ref="{{ box }}"><p>{{ kind }}</p>`,
      `class Component extends DCLogic {\n  box = React.createRef();\n  componentDidMount() { this.box.current.focus(); }\n  renderVals() { return { box: this.box, kind: typeof this.setState }; }\n}`,
    );
    expect(html(source)).toContain(">function</p>");
  });

  it("renders a hole's value as text, numbers included, nothing for objects and booleans", () => {
    const source = artboard(`<p>{{ n }}|{{ s }}|{{ t }}|{{ o }}|{{ u }}|{{ z }}</p>`, returning(`{ n: 3, s: '<b>', t: true, o: { a: 1 }, z: 0 }`));
    expect(html(source)).toContain(`>3|&lt;b&gt;||||0</p>`);
  });

  it("passes a style object bound whole, and keeps url() and custom properties intact in a string", () => {
    const source = artboard(
      `<div style="{{ ring }}"></div><div style="--accent: #f00; background: url(data:image/png;base64,AAA=) no-repeat; -webkit-line-clamp: 2; color: red !important"></div>`,
      returning(`{ ring: { outline: '2px solid red', outlineOffset: '2px' } }`),
    );
    const markup = html(source);
    expect(markup).toContain(`<div style="outline:2px solid red;outline-offset:2px" data-dc-id="0"`);
    expect(markup).toContain(`style="--accent:#f00;background:url(data:image/png;base64,AAA=) no-repeat;-webkit-line-clamp:2;color:red"`);
  });
});
