/**
 * The pure half of the runtime, for the canvas editor (decision 0020 §5): reading an artboard's source
 * and editing it in place. No React, no DOM — the editor's chunk carries only this.
 */
export { parse, type DCDocument, type DCElement, type DCPropSpec, type SourceRange } from "./parse.js";
export { editStyle, editText, formatStyle, insertElement, readStyle, removeElement } from "./edit.js";
export { decodeEntities } from "./html.js";
