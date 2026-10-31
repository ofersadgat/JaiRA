# @jaira/dc-runtime

JaiRA's own runtime for Claude Design's `.dc.html` artboards (decision 0020, §5). The format is the one
`packages/shared/builtin/artifact-types/design/` gives the model — `SKILL.md` ("One artboard: the
skeleton", "Rules that bite") and `reference/format.md` — and this package draws the files written from
those instructions as Claude Design draws them. It is written from that text alone.

Two outputs:

- **`dist/support.js`** (`npm --workspace @jaira/dc-runtime run build`): the one browser file every
  artboard's head loads (`<script src="./support.js"></script>`). An IIFE with React 19 and ReactDOM
  inside; about 220 KB minified. Beside it, `dist/support-modules.json` lists every file the bundle read,
  for the Licenses page (below).
- **The module** (`src/index.ts`), for Node and for the canvas editor: parsing, the editor's source
  edits, canvas paths, and rendering with React.

## The page

Loaded in an artboard's `<head>`, `support.js`:

1. hides `<x-dc>` at once (`x-dc{display:none!important}`), so the raw template never shows;
2. after `DOMContentLoaded`, reads the page's source — fetched again from `location.href`, because the
   DOM has lowercased `onClick`, moved what it did not expect out of tables and kept no offsets; the
   serialized DOM only when that fetch fails — and draws the component where `<x-dc>` was, in a
   `<div data-dc-root style="display:contents">`;
3. puts `<helmet>`'s children in `<head>` through a portal: holes in them are filled, an imported
   child's helmet is added too, and leaves when the child does;
4. talks to `window.parent`.

### Messages

From the page to `window.parent` (`postMessage(…, "*")`):

| Message | When |
| --- | --- |
| `{ type: "dc:ready", size: { width, height } }` | once, a frame after the first render; the size is from the page's corner to the far edges of the template's top elements |
| `{ type: "dc:navigate", href, url }` | a link to another artboard was followed in play: `href` is the target's canvas path (`sub/Cart.dc.html`), `url` the address it would be fetched from |
| `{ type: "dc:error", message }` | a file failed to parse, compile, load or render (an error box is drawn in its place), or an uncaught error in the page |

To the page, from `window.parent` only:

| Message | Effect |
| --- | --- |
| `{ type: "dc:props", props }` | the tweak values: `this.props` becomes the declared defaults overridden by `props`. Each message replaces the last one's set; it is not merged. |

### Links

`<a href="Cart.dc.html">` never navigates the frame. In play it posts `dc:navigate` with the canvas path
resolved against the artboard's own (a leading `/` is the canvas root); `href="#id"` scrolls to the
element; an `https:`, `mailto:` or `tel:` link opens with `window.open` (the frame needs `allow-popups`).
A click on a `<button>`, `<input>`, `<select>` or `<textarea>` inside a link runs that control's handler
and does not follow the link (format.md: it "swallows the click"). A relative link that is not a
`.dc.html` file does nothing.

Canvas paths come from the page's URL: everything after the last `/project/` in its path, or the file
name when there is no `/project/`. The host should serve a canvas so that its files sit under a
`…/project/` path.

## `window.DC`

```ts
DC.version: "0.2.47"                      // the Claude Design contract this follows
DC.parse(source: string): DCDocument
DC.editStyle(source: string, n: number, styleText: string): string
DC.editText(source: string, n: number, text: string): string
DC.mount(container: Element, source: string, options?: MountOptions): DCMount
DC.resolveCanvasPath(from: string, href: string): string
DC.decodeEntities(text: string): string
```

The same functions are exported by the module (`import { parse, editStyle, … } from "@jaira/dc-runtime"`).

### `parse(source)`

```ts
interface DCDocument {
  title: string | null;                   // <title>'s text
  lang: string | null;                    // <html lang>
  helmet: string;                         // <helmet>'s inner source, verbatim ("" if none)
  template: string;                       // <x-dc>'s inner source, verbatim
  script: string | null;                  // the logic script's body, or null (not written yet)
  props: Record<string, DCPropSpec>;      // data-props, `$`-keys ($preview) left out
  preview: { width: number; height: number } | undefined;   // $preview
  elements: DCElement[];                  // every element inside <x-dc>, in document order
  error: string | null;                   // no <x-dc>, or data-props that is not a JSON object
  nodes: Node[];                          // the template tree the renderer walks
}
interface DCElement {
  n: number;                              // index in `elements`; the rendered `data-dc-id`
  tag: string;                            // lowercased; SVG's own case (`linearGradient`)
  parent: number | null;
  startTag: { start, end };               // `<` through `>`
  outer: { start, end };                  // start tag through end tag
  style: { start, end } | null;           // the style value, inside its quotes
  styleInsert: number;                    // where ` style="…"` goes when there is none
  text: { start, end } | null;            // one literal text node, trimmed; empty range for no content
}
```

Every offset is into `source`. `parse` never throws.

### `editStyle` and `editText`

Pure string splices at the offsets `parse` reports; everything else in the file is left byte for byte.
`editStyle` writes `styleText` verbatim (holes included) with the attribute's own quote escaped; an empty
`styleText` removes the attribute; an element with no `style` gains `style="…"` after its last
attribute. `editText` escapes `&`, `<` and `{{` (as `&#123;{`) so the text reads back as typed, keeps
the whitespace around it, and throws for an element whose content is not one literal text node.

### Click → source

Each rendered DOM element has `data-dc-id="<n>"` (copies made by `<sc-for>` share their template's
`n`). Each template's top elements also carry `data-dc-src="<canvas path>"`; the file an element came
from is its nearest `[data-dc-src]`, itself included — an imported child's elements are numbered in the
child's file.

### `mount(container, source, options)`

```ts
interface MountOptions {
  props?: Record<string, unknown>;        // over the declared defaults
  mode?: "play" | "edit";                 // edit: events run, links never followed. Default play
  path?: string;                          // the artboard's canvas path. Default "Main.dc.html"
  resolve?: (path: string) => Promise<string>;   // a sibling's source, for <dc-import>
  onNavigate?: (path: string) => void;    // default: post { type: "dc:navigate", href } to the parent
  onError?: (message: string) => void;    // default: console.error
  onReady?: () => void;                   // a frame after the first render
  helmetTarget?: Element;                 // default document.head
}
interface DCMount {
  update(source: string): void;           // same script → same class, `state` kept
  setProps(props: Record<string, unknown>): void;   // replaces the given set
  reload(): void;                         // forgets imported files; draws all again (state lost)
  unmount(): void;
}
```

### `renderArtboard(source, options)` (module only)

The artboard as one React element, for `react-dom/server` and tests: `{ props?, path?, files?, helmet?:
"inline" | "omit" }`. Imports come only from `files`, by canvas path.

## The format, as implemented

- **Holes** `{{ path }}`: dotted lookups into `renderVals()`'s object and the loop variables around
  them (`{{ item.x }}`, `{{ $index }}`, `{{ list.0 }}`), and the literals `true`, `false`, `null`,
  `undefined`, numbers and quoted strings. Anything else — `{{ a + b }}`, `{{ !x }}`, `{{ fn() }}` — is
  undefined and draws nothing. In text, a string or number is drawn; null, undefined, booleans and
  objects draw nothing. Holes are found in the text as written, before entities are decoded.
- **Attributes**: a literal is a string; one whole hole is the raw value; a mix is an interpolated
  string. `class`/`for` → `className`/`htmlFor`, and HTML's other lowercase names (`tabindex`,
  `readonly`, `colspan`, …) in React's spelling; `aria-*`/`data-*` as written; hyphenated and
  `ns:`-prefixed SVG attributes camel-cased (`stroke-width` → `strokeWidth`, `xlink:href` →
  `xlinkHref`); `viewBox` and SVG's other mixed-case names kept, or restored from lowercase. Events:
  `onClick="{{ fn }}"` as written, a lowercased `onclick` looked up; a handler that is not a function
  (inline JavaScript) is dropped. Boolean attributes (`disabled`, `checked`, `hidden`, …) are true by
  presence whatever their literal value; only a bound one can be false. A literal `value`/`checked` on a
  field is its starting value (`defaultValue`/`defaultChecked`); a bound one is controlled. `style` is
  interpolated and parsed into a React style object (a bound object is used as it is); `ref` takes a
  ref.
- **`<sc-for list as>`** repeats with the item under `as` (default `item`) and `$index`; nested loops
  shadow. **`<sc-if value>`** draws its children when the value is truthy. While a file has no script
  yet (it is still being written), `hint-placeholder-count` items and `hint-placeholder-val` stand in.
- **`<dc-import name>`** mounts `<name>.dc.html` from the importing file's folder; every other attribute
  but `hint-*` is a prop (kebab → camel, written case kept); the `hint-size="W,H"` box is drawn until it
  loads; it works inside `<sc-for>`; a file importing itself is refused with an error box.
- **`<helmet>`**: see "The page". A `<script>` in the template never runs.
- **The logic class**: the script runs with `new Function("DCLogic", "React", …)` and must define
  `class Component extends DCLogic`. `DCLogic` is a React class component whose `render()` walks the
  template with `renderVals()`'s result; `this.props`, `state`/`setState`/`forceUpdate` and the
  lifecycle are React's. `this.state` starts as `{}`. `React` is in scope (`React.createRef()`).
- **`data-props`** is read as `getAttribute` would (entities decoded) and then JSON-parsed. Each
  declared `default` becomes the prop's value unless one is given; `$preview` is metadata.
- **HTML**: void elements, raw-text elements (`<style>`, `<script>`, `<textarea>`, `<title>`),
  comments, the common implied end tags (`<p>`, `<li>`, `<dt>`/`<dd>`, `<option>`, table rows and
  cells), SVG's case and self-closing tags. A self-closing slash on an HTML element is ignored, as a
  browser ignores it — `<dc-import … />` swallows what follows (format.md: never self-close).
  Whitespace is kept as written, except where React refuses it (inside `<table>`, `<tbody>`, `<tr>`,
  `<select>`, …) and the newline after `<pre>` and `<textarea>`, which HTML drops too.

### Not implemented, or uncertain

- Not seen against Claude Design's own runtime: every rule above is read from the instructions. Where
  they are silent this runtime chose: declared `default`s are applied as props (format.md says
  "`default` seeds the editor only"; the host's Tweaks would pass the seeded values anyway); booleans
  and objects in a text hole draw nothing; `sc-if` has no else; an `sc-for` list that is not an array
  draws nothing.
- `!important` in an inline style is dropped (React cannot set it).
- The DOM fallback (when the page cannot fetch itself, see "Host requirements") loses what the browser
  moved: an `<sc-for>` inside a `<table>` draws no rows, and `data-dc-id`s may not match `parse` of the
  real source.
- Named character references outside the parser's table of about 230 are decoded through the browser
  in the page, and left as written in Node.
- `dc:ready` is posted once; nothing reports a later change of size (an import loading, fonts).
- `editStyle`/`editText` re-parse the file on every call; fine for one edit, slow for thousands.
- Design-system components (`x-import`, `window.<Ns>`), comments, `db`, `room` and the other
  capabilities are not part of this runtime.

## Host requirements

- Serve `support.js` at `./support.js` beside every artboard, in every folder of the canvas.
- The frame is sandboxed without `allow-same-origin`, so its origin is opaque: the page's fetch of
  itself and of its imports are cross-origin. Answer `.dc.html` requests with
  `Access-Control-Allow-Origin: *` (or the page falls back to the DOM, and imports fail).
- CSP: `script-src` must allow `support.js` (`'self'`) and **`'unsafe-eval'`** — the logic script is
  compiled with `new Function`. `connect-src 'self'` for those fetches. React needs nothing else.
- `allow-popups` for external links.

## Licenses

`support.js` bundles React, ReactDOM and scheduler (all MIT); their `@license` headers are kept at the
end of the file. `dist/support-modules.json` is the bundle's module list in the form
`packages/app/build.mjs` writes `main-modules.json`; the client build's license plugin
(`packages/client/vite.config.ts`, `moduleLists`) reads such lists, so adding
`{ bundle: "artboard", file: new URL("../dc-runtime/dist/support-modules.json", import.meta.url) }`
there — once the app's build runs this one first and ships `support.js` — tags those packages
`artboard` on the Licenses page.
