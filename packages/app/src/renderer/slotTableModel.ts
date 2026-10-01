/**
 * What the slot table's rows compute — which box answers for which lint path, what an empty binding
 * means, what a type says in words. `SlotTable`
 * (`packages/universal/src/components/workflow/SlotTable.tsx`) draws the table from these answers.
 */
import { ANY_TYPE, OWNED_KEYWORDS, SLOT_TYPES, type SlotType } from "@jaira/shared/browser";
import { fieldClass, type FormIssues } from "./issues";
import type { SlotRow } from "./slotForm";

/** A one-glance label for a schema the picker does not model. The full document is the tooltip. */
export function summarizeSchema(text: string): string {
  try {
    const schema = JSON.parse(text) as Record<string, unknown>;
    const type = typeof schema["type"] === "string" ? (schema["type"] as string) : "schema";
    const named = typeof schema["x-type"] === "string" ? ` ${schema["x-type"] as string}` : "";
    const extra = Object.keys(schema).filter((k) => !OWNED_KEYWORDS.includes(k));
    return `${type}${named}${extra.length > 0 ? ` +${extra.join(" +")}` : ""}`;
  } catch {
    return "schema";
  }
}

/** A slot type's hint, for the picker's tooltip. */
export const slotTypeHint = (type: SlotType): string | undefined => SLOT_TYPES.find((t) => t.name === type.name)?.hint;

/**
 * A type in words, as a reading says it: `list of artifact · text/markdown`. A reading says the type
 * in words — the picker is three controls answering one question, and at the width of a side panel a
 * sentence fits where a control row does not.
 */
export function slotTypeWords(type: SlotType): string {
  return `${type.list ? "list of " : ""}${SLOT_TYPES.find((t) => t.name === type.name)?.label ?? type.name}${type.name === "artifact" && (type.mediaType ?? "").length > 0 ? ` · ${type.mediaType}` : ""}`;
}

/** The wrapper a linked type keeps — the row's, not the referenced document's (`SlotRow.typeRef`). */
export const linkedWrapper = (row: SlotRow): SlotType => row.type ?? ANY_TYPE;

/** What a linked type says where there is no link control to edit it with. */
export const linkedTypeWords = (row: SlotRow): string => `🔗 ${linkedWrapper(row).list ? "list of " : ""}${row.typeRef ?? ""}`;

/** Which of the three the type control is for a row. */
export type SlotTypeShape = "spread" | "linked" | "custom" | "vocabulary";
export function slotTypeShapeOf(row: SlotRow): SlotTypeShape {
  if (row.spread === true) return "spread";
  if (row.typeRef !== undefined) return "linked";
  if (row.type === null) return "custom";
  return "vocabulary";
}

/** The spread's own words and tooltip. */
export const SPREAD_WORDS = "per child";
export const SPREAD_TITLE = "a spread — each slot keeps the child's own schema (§3.5)";

/** A row's lint path, or `undefined` when its table is not part of a linted document. */
export function slotPathOf(path: string | undefined, row: { name: string }): string | undefined {
  return path === undefined || row.name.trim().length === 0 ? undefined : `${path}.${row.name.trim()}`;
}

/** True when this row's empty binding is a MEANING rather than a blank — see `emptyBindingMeans`. */
export function isProduced(row: SlotRow, emptyBindingMeans: string | undefined): boolean {
  return emptyBindingMeans !== undefined && row.structured !== true && row.binding.trim().length === 0;
}

/** Which BOX of a slot row is wrong: the type picker takes `<slot>.kind`, the binding box the rest. */
export function slotMarksOf(issues: FormIssues, rowPath: string | undefined): { typeMark: string; bindingMark: string } {
  return {
    typeMark: rowPath === undefined ? "" : fieldClass(issues, `${rowPath}.kind`),
    bindingMark: rowPath === undefined ? "" : fieldClass(issues, rowPath, [`${rowPath}.kind`]),
  };
}

/** Linking is presence of `typeRef`, so unlinking has to DELETE the key, not blank it. */
export function linkedRows(rows: readonly SlotRow[], index: number, ref: string | null): SlotRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    if (ref === null) {
      const { typeRef: _dropped, ...rest } = row;
      return rest;
    }
    return { ...row, typeRef: ref };
  });
}

/** The column header over the binding boxes. */
export function bindingHeadOf(emptyBindingMeans: string | undefined): string {
  return emptyBindingMeans === undefined ? "Binding — where the value comes from" : `Binding — empty means ${emptyBindingMeans}`;
}

/** The name box's placeholder. */
export const namePlaceholderOf = (optional: boolean): string => (optional ? "name" : "name, or prefix* to spread a child");

/** The name box's tooltip. */
export const nameTitleOf = (row: SlotRow): string | undefined =>
  row.spread === true ? "a spread: republishes every output of the bound child, prefixed" : undefined;

/**
 * The binding box's placeholder. The empty box IS the answer where one exists, so it says so; a slot's
 * DEFAULT is what an empty binding means, so it is what the empty box says (the panel rulings, 2026-09-24).
 */
export function bindingPlaceholderOf(row: SlotRow, emptyBindingMeans: string | undefined, bindingHint: string): string {
  return isProduced(row, emptyBindingMeans) ? emptyBindingMeans! : row.default.length > 0 ? `default: ${row.default}` : bindingHint;
}

/** The binding box's tooltip. */
export function bindingTitleOf(row: SlotRow, emptyBindingMeans: string | undefined): string | undefined {
  return row.structured === true
    ? "a computed binding — edit it on the JSON tab"
    : isProduced(row, emptyBindingMeans)
      ? "§3.3: an output with a binding is derived, one without is produced — there is no third case"
      : undefined;
}

/**
 * Whether a row's default & description block is drawn in a reading: not at all when it has none of
 * the three things it would show (a default, a description, a recorded value).
 */
export function slotMoreShown(readOnly: boolean, hasDefault: boolean, hasDescription: boolean, value: unknown): boolean {
  return !readOnly || hasDefault || hasDescription || value !== undefined;
}

export const DEFAULT_PLACEHOLDER = "default — also the opt-out from the reachability rule";
export const DEFAULT_TITLE = 'JSON, or plain text for a string: significant, 3, ["a"]';
export const OPTIONAL_TITLE = "SPEC §4.1: a slot is required unless it says otherwise";
export const LIST_TITLE = "wrap the type in an array — a list of these";
export const LINKED_LIST_TITLE = "wrap the named type in an array — a list of these";
export const MEDIA_TITLE = "the content's media type — what makes this slot a blob";
