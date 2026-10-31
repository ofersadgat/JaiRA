/**
 * A template element's attributes → the props React wants for it.
 *
 * format.md's rules: `x="literal"` is a string, `x="{{ path }}"` the raw value (a number, a function, a
 * ref, an object), `x="a {{p}} b"` an interpolated string; `class` and `for` become `className` and
 * `htmlFor`; events are whole-value attributes in JSX camelCase. The rest is what React needs to put
 * the same attribute on the DOM that the HTML would have: HTML's lowercase names in React's spelling,
 * SVG's hyphenated ones camel-cased, boolean attributes true by presence, a `style` string as an object.
 */

import type { Attr, ElementNode } from "./html.js";
import { evaluate, interpolate, segments, wholeHole, type Scope } from "./holes.js";

/** HTML attributes whose React name is not their HTML name, by lowercase name. */
const HTML_NAMES: Record<string, string> = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength",
  minlength: "minLength", colspan: "colSpan", rowspan: "rowSpan", contenteditable: "contentEditable",
  crossorigin: "crossOrigin", autocomplete: "autoComplete", autofocus: "autoFocus", autoplay: "autoPlay",
  enctype: "encType", srcset: "srcSet", srcdoc: "srcDoc", usemap: "useMap", frameborder: "frameBorder",
  allowfullscreen: "allowFullScreen", cellpadding: "cellPadding", cellspacing: "cellSpacing", accesskey: "accessKey",
  novalidate: "noValidate", formnovalidate: "formNoValidate", spellcheck: "spellCheck", datetime: "dateTime",
  inputmode: "inputMode", enterkeyhint: "enterKeyHint", charset: "charSet", hreflang: "hrefLang",
  referrerpolicy: "referrerPolicy", playsinline: "playsInline", nomodule: "noModule", itemprop: "itemProp",
  itemscope: "itemScope", itemtype: "itemType", itemid: "itemID", itemref: "itemRef", formaction: "formAction",
  formenctype: "formEncType", formmethod: "formMethod", formtarget: "formTarget", popovertarget: "popoverTarget",
  popovertargetaction: "popoverTargetAction", fetchpriority: "fetchPriority", controlslist: "controlsList",
  disablepictureinpicture: "disablePictureInPicture", disableremoteplayback: "disableRemotePlayback",
  marginwidth: "marginWidth", marginheight: "marginHeight", radiogroup: "radioGroup", dirname: "dirName",
};

/** Attributes whose presence means true, whatever their value says. */
const BOOLEAN = new Set([
  "allowfullscreen", "async", "autofocus", "autoplay", "checked", "controls", "default", "defer", "disabled",
  "formnovalidate", "hidden", "inert", "ismap", "itemscope", "loop", "multiple", "muted", "nomodule", "novalidate",
  "open", "playsinline", "readonly", "required", "reversed", "selected", "disablepictureinpicture",
  "disableremoteplayback",
]);

/**
 * React's event props by lowercase name, so `onclick="{{ pick }}"` — which is what `onClick` becomes
 * once anything lowercases it — still binds.
 */
const EVENTS: Record<string, string> = Object.fromEntries(
  [
    "onAbort", "onAnimationEnd", "onAnimationIteration", "onAnimationStart", "onAuxClick", "onBeforeInput", "onBlur",
    "onCanPlay", "onCanPlayThrough", "onChange", "onClick", "onClose", "onCompositionEnd", "onCompositionStart",
    "onCompositionUpdate", "onContextMenu", "onCopy", "onCut", "onDoubleClick", "onDrag", "onDragEnd", "onDragEnter",
    "onDragExit", "onDragLeave", "onDragOver", "onDragStart", "onDrop", "onDurationChange", "onEnded", "onError",
    "onFocus", "onGotPointerCapture", "onInput", "onInvalid", "onKeyDown", "onKeyPress", "onKeyUp", "onLoad",
    "onLoadedData", "onLoadedMetadata", "onLoadStart", "onLostPointerCapture", "onMouseDown", "onMouseEnter",
    "onMouseLeave", "onMouseMove", "onMouseOut", "onMouseOver", "onMouseUp", "onPaste", "onPause", "onPlay",
    "onPlaying", "onPointerCancel", "onPointerDown", "onPointerEnter", "onPointerLeave", "onPointerMove",
    "onPointerOut", "onPointerOver", "onPointerUp", "onProgress", "onRateChange", "onReset", "onResize", "onScroll",
    "onScrollEnd", "onSeeked", "onSeeking", "onSelect", "onStalled", "onSubmit", "onSuspend", "onTimeUpdate",
    "onToggle", "onTouchCancel", "onTouchEnd", "onTouchMove", "onTouchStart", "onTransitionEnd", "onVolumeChange",
    "onWaiting", "onWheel",
  ].flatMap((name) => [
    [name.toLowerCase(), name],
    [`${name.toLowerCase()}capture`, `${name}Capture`],
  ]),
);
// HTML's own name for the double click.
EVENTS["ondblclick"] = "onDoubleClick";

const FORM_FIELDS = new Set(["input", "select", "textarea"]);

/** The attributes of `el` as React props, holes filled from `at`. */
export function propsOf(el: ElementNode, at: Scope): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const a of el.attrs) {
    const name = reactName(a, el);
    if (name === null) continue;
    const value = valueOf(a, at, name);
    if (name === "style") {
      const style = styleValue(value);
      if (style) props["style"] = style;
      continue;
    }
    if (/^on[A-Z]/.test(name)) {
      // A handler is a function from `renderVals()`; inline JavaScript in a string never runs here.
      if (typeof value === "function") props[name] = value;
      continue;
    }
    // `disabled`, `disabled=""` and even `disabled="false"` are all true in HTML; only a bound value
    // (`disabled="{{ busy }}"`) can make one false.
    props[name] = BOOLEAN.has(a.key) && (a.raw === null || wholeHole(a.raw) === null) ? true : value;
  }
  // A literal `value` or `checked` on a field is where it STARTS, as in HTML; React would read either
  // as controlled and freeze the field. A bound one (`value="{{ q }}"`) is controlled, as written.
  if (FORM_FIELDS.has(el.tag)) {
    for (const [html, initial] of [["value", "defaultValue"], ["checked", "defaultChecked"]] as const) {
      const a = el.attrs.find((x) => x.key === html);
      if (a && (a.raw === null || wholeHole(a.raw) === null) && html in props) {
        props[initial] = props[html];
        delete props[html];
      }
    }
  }
  if ("contentEditable" in props) props["suppressContentEditableWarning"] = true;
  return props;
}

function valueOf(a: Attr, at: Scope, name: string): unknown {
  if (a.raw === null) return name.startsWith("aria-") || name.startsWith("data-") ? "" : true;
  const hole = wholeHole(a.raw);
  if (hole !== null) return evaluate(hole, at);
  return interpolate(segments(a.raw, true), at);
}

/** React's name for an attribute, or null for one React cannot carry. */
function reactName(a: Attr, el: ElementNode): string | null {
  const key = a.key;
  if (key.startsWith("data-") || key.startsWith("aria-")) return key;
  if (key.startsWith("on")) {
    // `onClick` as written is React's name already; a lowercased one is looked up.
    if (/^on[A-Z]/.test(a.name)) return a.name;
    return EVENTS[key] ?? null;
  }
  if (key === "class") return "className";
  if (key === "style" || key === "ref") return key;
  if (key === "xmlns") return key;
  if (key.includes(":")) {
    // `xlink:href` → `xlinkHref`, `xml:space` → `xmlSpace`, `xmlns:xlink` → `xmlnsXlink`.
    const [ns, local] = key.split(":") as [string, string];
    return ns + local.charAt(0).toUpperCase() + camel(local.slice(1));
  }
  if (!el.svg && HTML_NAMES[key]) return HTML_NAMES[key]!;
  if (key.includes("-")) return camel(key);
  return key;
}

const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function styleValue(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "object") return value as Record<string, string>;
  const style = parseStyle(String(value));
  return Object.keys(style).length > 0 ? style : null;
}

/**
 * A CSS declaration list → a React style object. Splits on `;` and `:` outside parentheses and quotes,
 * so `url(data:…;base64,…)` and `content: "a;b"` survive. A custom property (`--x`) keeps its name;
 * `-webkit-x` becomes `WebkitX` and `-ms-x` `msX`, as React spells them. `!important` is dropped:
 * React cannot set it, and a value carrying it would be refused by the browser altogether.
 */
export function parseStyle(text: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const declaration of split(text, ";")) {
    const colon = indexOutside(declaration, ":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    let value = declaration.slice(colon + 1).trim();
    if (!property || !value) continue;
    value = value.replace(/\s*!\s*important\s*$/i, "");
    style[styleName(property)] = value;
  }
  return style;
}

function styleName(property: string): string {
  if (property.startsWith("--")) return property;
  const lower = property.toLowerCase();
  if (lower.startsWith("-ms-")) return `ms${camel(lower.slice(3))}`;
  if (lower.startsWith("-")) return camel(lower.slice(1)).replace(/^./, (c) => c.toUpperCase());
  return camel(lower);
}

function split(text: string, separator: string): string[] {
  const parts: string[] = [];
  let last = 0;
  for (let at = indexOutside(text, separator); at >= 0; at = indexOutside(text, separator, last)) {
    parts.push(text.slice(last, at));
    last = at + 1;
  }
  parts.push(text.slice(last));
  return parts;
}

function indexOutside(text: string, char: string, from = 0): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

/** The props a `<dc-import>` passes its child: every attribute but `name` and the `hint-*`s, kebab → camel. */
export function importProps(el: ElementNode, at: Scope): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const a of el.attrs) {
    if (a.key === "name" || a.key.startsWith("hint-")) continue;
    // Written case kept: a prop written `cardTitle` arrives as `cardTitle`, and `card-title` as well.
    props[camel(a.name)] = a.raw === null ? true : valueOf(a, at, a.name);
  }
  return props;
}
