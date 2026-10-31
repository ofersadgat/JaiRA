/**
 * JaiRA's runtime for Claude Design's `.dc.html` files (decision 0020, §5), as a module: the pure parts
 * — parsing, the editor's source edits, canvas paths — for Node and the editor, and rendering for a
 * host with React. The browser file every artboard loads, `support.js`, is `support.ts` bundled.
 */

export { parse, type DCDocument, type DCElement, type DCPropSpec, type SourceRange } from "./parse.js";
export { editStyle, editText, formatStyle, insertElement, readStyle, removeElement } from "./edit.js";
export { decodeEntities, parseHtml, type Attr, type ElementNode, type Node, type TextNode } from "./html.js";
export { evaluate, interpolate, segments, type Scope, type Segment } from "./holes.js";
export { parseStyle } from "./attrs.js";
export { encodeCanvasPath, isArtboardLink, isExternal, pagePlace, resolveCanvasPath } from "./paths.js";
export { defaultsOf, renderArtboard, type RenderOptions } from "./render.js";
export { mount, type DCMount, type MountOptions } from "./mount.js";
