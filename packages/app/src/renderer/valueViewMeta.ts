/**
 * What each view of a value is called on its button, and what the button's tooltip says it does —
 * `valueView.tsx`'s `VIEW_META`, here so the universal value view (decision 0015,
 * `packages/universal/src/components/panel/ValueView.tsx`) names its views with the same words.
 */
import type { ViewId } from "@jaira/shared/browser";

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
