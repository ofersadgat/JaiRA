/**
 * What each view of a value is called on its button, and what the button's tooltip says it does —
 * `valueView.tsx`'s `VIEW_META`, here so the universal value view (decision 0015,
 * `packages/universal/src/components/panel/ValueView.tsx`) names its views with the same words.
 */
import { extensionForMime, type ViewId } from "@jaira/shared/browser";

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
