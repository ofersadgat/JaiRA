/**
 * What the Components room derives: a card's document and what it parses to, the request or gate a
 * card stages from it, and which slide each row's variants are on. `GalleryPane`
 * (`packages/universal/src/components/gallery/GalleryPane.tsx`) draws from it.
 */
import {
  GALLERY_VARIANT_ORDER,
  isComponentName,
  parseComponentConfig,
  validateComponentResult,
  type ComponentConfig,
  type GalleryGroup,
  type GallerySurface,
  type PendingApproval,
  type PendingInteraction,
  type PendingQuestion,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";

/**
 * The project every fixture claims to belong to.
 *
 * A pending request carries the project whose database holds its task, and nothing here has either.
 * A visible placeholder is better than a plausible path: it appears in the dialog's subtitle, where
 * "gallery" reads as what it is and a real-looking project id would not.
 */
export const GALLERY_PROJECT = "gallery";

/** A string field of a parsed document, when it is one. */
const stringAt = (doc: Record<string, unknown>, key: string): string | undefined =>
  typeof doc[key] === "string" ? (doc[key] as string) : undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** What a card is currently showing its config as. */
export type Editor = "form" | "json";

export interface CardState {
  /** The document as text — the single source both editors write. */
  text: string;
  editor: Editor;
  /** The last answer the surface produced, and what the contract said about it. */
  result?: { value: unknown; check?: { ok: boolean; errors?: string } };
}

export const initialState = (surface: GallerySurface): CardState => ({
  text: JSON.stringify(surface.sample, null, 2),
  editor: "form",
});

/** The document, parsed — or the parse error, which is itself worth showing. */
export function parsedDoc(text: string): { doc?: Record<string, unknown>; error?: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: "the document must be a JSON object" };
    }
    return { doc: value as Record<string, unknown> };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * The variant ids these groups use, in the shared vocabulary's order, with how many rows have each; an
 * id the vocabulary does not know is appended rather than dropped.
 */
export function variantsAcross(groups: readonly GalleryGroup[]): { id: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const group of groups) for (const v of group.variants) counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
  const ordered = [...GALLERY_VARIANT_ORDER.filter((id) => counts.has(id)), ...[...counts.keys()].filter((id) => !GALLERY_VARIANT_ORDER.includes(id))];
  return ordered.map((id) => ({ id, rows: counts.get(id)! }));
}

/** Which slide a track is showing: its scroll offset in slide widths, rounded. */
export const slideAt = (scrollLeft: number, width: number): number => (width === 0 ? 0 : Math.round(scrollLeft / width));

/** A slide to go to, kept inside the row. */
export const clampSlide = (group: GalleryGroup, index: number): number => Math.max(0, Math.min(index, group.variants.length - 1));

/** The slide every row that HAS this variant goes to; a row that does not stays where it was. */
export function slidesFor(groups: readonly GalleryGroup[], variantId: string): [GalleryGroup, number][] {
  const out: [GalleryGroup, number][] = [];
  for (const group of groups) {
    const at = group.variants.findIndex((v) => v.id === variantId);
    if (at >= 0) out.push([group, at]);
  }
  return out;
}

/** The bar button's tooltip: which rows it slides. */
export const slideAllTitle = (id: string, rows: number): string => `slide the ${rows === 1 ? "one row" : `${rows} rows`} that ${rows === 1 ? "has" : "have"} a "${id}" variant to it`;

/** What a card's config caption says, by kind. */
export const configCaption = (surface: GallerySurface): string => (surface.kind === "interaction" ? "the state's authored args" : "the request the dialog was raised with");

/** An approval card's request, built from its edited document (`Stage`). */
export function approvalOf(surface: GallerySurface, doc: Record<string, unknown>): PendingApproval {
  return {
    requestId: `gallery-${surface.id}`,
    tool: stringAt(doc, "tool") ?? "Bash",
    ...(stringAt(doc, "command") !== undefined ? { command: stringAt(doc, "command")! } : {}),
    ...(stringAt(doc, "reason") !== undefined ? { reason: stringAt(doc, "reason")! } : {}),
    // The parts and the permission set are the engine's own shapes, typed in whole: the gallery has no
    // policy behind it to take a line apart, and a sample is the place to see exactly what one carries.
    ...(isRecord(doc["parts"]) ? { parts: doc["parts"] as unknown as NonNullable<PendingApproval["parts"]> } : {}),
    ...(isRecord(doc["permissionSet"]) ? { permissionSet: doc["permissionSet"] as unknown as NonNullable<PendingApproval["permissionSet"]> } : {}),
    input: (doc["input"] ?? {}) as Record<string, JsonValue>,
    project: GALLERY_PROJECT,
    at: 0,
  };
}

/** A question card's request, or `null` when the document asks no question. */
export function questionOf(surface: GallerySurface, doc: Record<string, unknown>): PendingQuestion | null {
  const questions = Array.isArray(doc["questions"]) ? (doc["questions"] as PendingQuestion["questions"]) : [];
  if (questions.length === 0) return null;
  return { requestId: `gallery-${surface.id}`, questions, project: GALLERY_PROJECT, at: 0 };
}

/**
 * An interaction card's gate, built from its edited document exactly as main builds one from a run: the
 * shared parse, so a config error is the string an author would read in a real run.
 */
export function interactionOf(
  surface: GallerySurface,
  doc: Record<string, unknown>,
): { pending: PendingInteraction; config: ComponentConfig | undefined; inputs: Record<string, JsonValue> } {
  const component = surface.component ?? "";
  const inputs = (surface.inputs ?? {}) as Record<string, JsonValue>;
  let config: ComponentConfig | undefined;
  let configError: string | undefined;
  if (isComponentName(component)) {
    try {
      config = parseComponentConfig(component, doc);
    } catch (e) {
      configError = (e as Error).message;
    }
  }
  const pending: PendingInteraction = {
    requestId: `gallery-${surface.id}`,
    taskId: "gallery",
    project: GALLERY_PROJECT,
    // An unrecognised gate names whatever the document says it does, so the fallback can be reached
    // by typing a function name rather than by breaking something.
    component: isComponentName(component) ? component : (stringAt(doc, "function") ?? component),
    inputs,
    ...(config === undefined ? {} : { config }),
    ...(configError === undefined ? {} : { configError }),
  };
  return { pending, config, inputs };
}

/** The same check main runs before an answer may enter a run. */
export function checkOf(config: ComponentConfig, value: unknown, inputs: Record<string, JsonValue>): { ok: boolean; errors?: string } {
  const checked = validateComponentResult(config, value, inputs);
  return checked.ok ? { ok: true } : { ok: false, errors: checked.errors };
}

/** What an interaction card records when its gate is answered: the value, and what the contract said. */
export const interactionResult = (config: ComponentConfig | undefined, value: unknown, inputs: Record<string, JsonValue>): NonNullable<CardState["result"]> => ({
  value,
  ...(config === undefined ? {} : { check: checkOf(config, value, inputs) }),
});
