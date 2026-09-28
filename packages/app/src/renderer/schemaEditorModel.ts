/**
 * What the schema-aware editor's chrome says and decides, apart from the drawing (decision 0015):
 * `schemaEditor.tsx` draws it in the DOM and the universal copy natively, around the same editor
 * (an island there), from these — so the verdict, the words and the field reference's shape are
 * said once.
 */
import { propertiesOf, type SchemaEntry, type SchemaFormat, type SchemaProperty, type ValidateSchemaResult } from "@jaira/shared/browser";
import { PANE, paneDefault } from "./uiState";

/** How long to wait after the last keystroke before asking main to check the draft. */
export const VALIDATE_DEBOUNCE_MS = 300;

/** The syntax's name, as the chrome says it. */
export function schemaSyntax(format: SchemaFormat): "JSON" | "YAML" {
  return format === "yaml" ? "YAML" : "JSON";
}

/** The picker's first option: no schema. */
export function plainSchemaLabel(format: SchemaFormat): string {
  return `none — plain ${schemaSyntax(format)}`;
}

/** Why "Add missing fields" is, or is not, on offer. */
export function addMissingTitle(entry: SchemaEntry, parses: boolean, syntax: string): string {
  return parses ? entry.hint : `fix the ${syntax} first — a document that cannot be read cannot be merged into`;
}

/** A one-glance verdict, so "is it valid?" does not require reading the list below. */
export function schemaVerdict(result: ValidateSchemaResult | null, syntax: string): { text: string; tone: "plain" | "ok" | "bad" } {
  if (result === null) return { text: "checking…", tone: "plain" };
  if (result.parseError !== undefined) return { text: `not ${syntax}`, tone: "bad" };
  const count = result.violations.length;
  if (count === 0) return { text: "conforms", tone: "ok" };
  return { text: `${count} ${count === 1 ? "problem" : "problems"}`, tone: "bad" };
}

/**
 * How deep the panel will expand.
 *
 * A slot's `schema` refers to itself — `items` of `items` of `items` — so there is no natural
 * bottom. The cap is not about performance (expansion is lazy) but about the tree staying a
 * reference rather than becoming a fractal.
 */
export const REFERENCE_DEPTH = 6;

/**
 * How wide the reference column opens, and what a double-click on its divider restores.
 *
 * Read from the layout table so that the default and the remembered value cannot drift apart — the
 * shell stores this pane under {@link PANE.schemaReference}, and a second copy of the number here
 * would be the one a "reset" put back.
 */
export const REFERENCE_WIDTH = paneDefault(PANE.schemaReference);

/**
 * The placeholder a map's author-chosen key is walked as. Any name resolves the same way — as long as
 * it is a name: a published schema says what a map's keys may be with a `patternProperties` pattern
 * (a Compose service is `^[a-zA-Z0-9._-]+$`), and `*` would match none of them.
 */
export const ANY_KEY = "name";

/** The reference's heading. */
export function referenceTitle(entry: SchemaEntry): string {
  return String(entry.document["title"] ?? entry.label);
}

/** What the reference's ★ means, for this schema. */
export function referenceNote(entry: SchemaEntry): string {
  return entry.files !== undefined
    ? "★ marks what a complete document is expected to carry."
    : "★ marks what a complete document needs — required after the environment merge, never in the file itself.";
}

/**
 * What is inside one field of the reference, and so whether it discloses.
 *
 * Two ways a field has something inside it. Declared properties are the ordinary case; a MAP —
 * `inputs`, `children`, `properties` — declares none, because its keys are the author's, and its
 * shape lives one synthetic step further down. Probing for both is how the panel describes a slot
 * without needing to know the name of one.
 */
export function fieldInside(
  entry: SchemaEntry,
  path: readonly string[],
  property: SchemaProperty,
): { here: string[]; at: string; direct: SchemaProperty[]; perEntry: SchemaProperty[]; hasChildren: boolean } {
  const here = [...path, property.key];
  const deeper = path.length < REFERENCE_DEPTH;
  const direct = deeper ? propertiesOf(entry, here) : [];
  const perEntry = deeper && direct.length === 0 ? propertiesOf(entry, [...here, ANY_KEY]) : [];
  return { here, at: here.join("."), direct, perEntry, hasChildren: direct.length > 0 || perEntry.length > 0 };
}
