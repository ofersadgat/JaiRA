/**
 * What each view of a value is called on its button, and what the button's tooltip says it does —
 * `valueView.tsx`'s `VIEW_META`, here so the universal value view (decision 0015,
 * `packages/universal/src/components/panel/ValueView.tsx`) names its views with the same words.
 */
import { extensionForMime, type RendererId, type ViewId } from "@jaira/shared/browser";

export const VIEW_META: Record<ViewId, { label: string; hint: string }> = {
  changes: { label: "Files", hint: "The files this changes, as a diff" },
  media: { label: "Preview", hint: "Play or show it" },
  markdown: { label: "Rendered", hint: "As markdown, rendered" },
  html: { label: "Rendered", hint: "As HTML, rendered" },
  code: { label: "Code", hint: "Highlighted, in an editor" },
  text: { label: "Source", hint: "The text exactly as it was produced" },
  json: { label: "JSON", hint: "The value as JSON" },
  data: { label: "Data", hint: "Parsed — the value this document denotes" },
  patch: { label: "Diff", hint: "The change this patch describes" },
  table: { label: "Table", hint: "As rows and columns" },
  form: { label: "Form", hint: "As the fields its schema declares" },
};

/**
 * What each renderer is called on its menu, and what the item says it does.
 *
 * The hint names the CONSEQUENCE rather than the implementation, because that is what somebody
 * opening this menu is choosing between. Nobody wants Monaco or a `<pre>`; they want to type, or
 * they want to drag a selection through the block and copy it.
 *
 * EXPORTED, so the Appearance pane offers these two under the same names with the same explanations.
 * A settings screen that invented its own words for a choice a person also meets on a menu would be
 * two vocabularies for one decision, and the second one is always the one nobody recognises.
 */
export const RENDERER_META: Record<RendererId, { label: string; hint: string }> = {
  monaco: { label: "Monaco", hint: "A real editor — typing, a caret, its own selection" },
  // NOT "CodeMirror": both of these are Monaco. The editor is Monaco's editor and this is
  // `monaco.editor.colorize`, its tokenizer with no editor behind it — same grammars, same colours,
  // ordinary DOM. CodeMirror is the markdown editor this block is sitting inside.
  codeview: { label: "Code view", hint: "Coloured, but not an editor — so a selection can be dragged through it" },
};

/**
 * What a value should be called once it is a file on somebody's disk.
 *
 * An artifact already has a name and it is the one the producer chose, so that wins outright. For
 * everything else the name is invented, and the only part of it that carries information is the
 * EXTENSION — `value.md` and `value.json` open in different things, and a download with no extension
 * opens in nothing. The rest is a placeholder, which is honest: this value never had a name.
 */
export function fileNameOf(artifactPath: string | undefined, mime: string | undefined, isText: boolean): string {
  if (artifactPath !== undefined && artifactPath !== "") return artifactPath.slice(artifactPath.lastIndexOf("/") + 1);
  const ext = mime === undefined ? undefined : extensionForMime(mime);
  return `value.${ext ?? (isText ? "txt" : "json")}`;
}

/** UTF-8 text as base64, which is what `shell:saveFile` takes. */
export function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * What each key of a value means, by the path of the object it sits in — `JsonView`'s reader of the
 * schema the value was declared against, here so the universal value view ghosts the same words.
 *
 * Walks the schema itself rather than going through the registry the editor uses: this is handed a
 * schema, not a document type, so there is nothing to look up. Absent members simply answer
 * `undefined`, which the highlighter reads as "no hint on this line".
 */
export function schemaDescriber(schema: unknown): ((path: readonly string[], key: string) => string | undefined) | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  return (path: readonly string[], key: string): string | undefined => {
    let node: unknown = schema;
    for (const step of path) {
      const props = propertiesOf(node);
      // An array index is a step in the VALUE's path and not in the schema's — the members of an
      // array all share one declaration, so walking into `items` is how the two stay in step.
      node = /^\d+$/.test(step) ? itemsOf(node) : props?.[step];
      if (node === undefined) return undefined;
    }
    const target = propertiesOf(node)?.[key];
    if (target === null || typeof target !== "object") return undefined;
    const described = (target as Record<string, unknown>)["description"];
    return typeof described === "string" ? described : undefined;
  };
}

/** A schema node's declared members, or `undefined` for anything that has none. */
function propertiesOf(schema: unknown): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const props = (schema as Record<string, unknown>)["properties"];
  return props !== null && typeof props === "object" && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : undefined;
}

/** What an array's members are declared as. */
function itemsOf(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  return (schema as Record<string, unknown>)["items"];
}

/** A line's hint as drawn: the first 80 characters, and `…` past them (`JsonView`). */
export function hintText(hint: string): string {
  return hint.length > 80 ? `${hint.slice(0, 80)}…` : hint;
}
