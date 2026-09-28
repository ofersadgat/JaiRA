/**
 * What `llmConfigForm.tsx`'s call-settings form decides, as pure functions — its categories and their
 * one-line summaries, the fields each draws, the rail's keys, and what the Advanced box's text means —
 * in a module of its own so the universal copy (decision 0015) runs the same code the DOM form does.
 */
import { REASONING_EFFORTS, type ModelParametersView } from "@jaira/shared/browser";
import type { Schema } from "./schemaForm/types";

/** The config as a plain document — what a preset or an executor's `models.config` holds. */
export type LlmConfigDoc = Record<string, unknown>;

/**
 * The knobs a sampling endpoint takes, and a reasoning endpoint REFUSES.
 *
 * Upstream's `SAMPLING_KEYS`, restated because `shared` must not import `@declarative-ai/llm` into
 * the renderer's bundle. If that list gains a key, this one does too — the cost of the split, and
 * cheaper than pulling the provider layer into Chromium.
 */
export const SAMPLING_KEYS = ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty"] as const;

/**
 * The keys this form edits with a dedicated control. Everything else is "advanced", never dropped.
 * `model` is one of them wherever it is edited — a preset's Model section, or the field a Defaults
 * form draws beside this one — so it never turns up in Advanced as an "extra".
 */
export const KNOWN_KEYS = new Set<string>(["model", ...SAMPLING_KEYS, "reasoning", "maxOutputTokens", "stopSequences", "seed", "maxSteps"]);

/**
 * The `reasoning` object's schema for SchemaForm: the resolved model's own (its levels as an `enum`
 * with their descriptions, a budget only where it takes one), or — for a model nothing describes — the
 * usual levels as SUGGESTIONS and a budget, since what it takes is not known.
 */
export function reasoningSchemaOf(view: ModelParametersView | undefined): Schema {
  const own = view?.reasoningSchema;
  if (own !== null && typeof own === "object" && !Array.isArray(own) && view?.levels !== undefined) return own as Schema;
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      effort: { type: "string", examples: [...REASONING_EFFORTS], description: "A level rather than a number of tokens. A model that tops out lower clamps rather than refusing." },
      budgetTokens: { type: "integer", minimum: 1, description: "A token ceiling on the thinking itself, for the models that take one." },
    },
  };
}

/**
 * The categories, their fields, and how each summarises itself when collapsed. `model` is drawn only
 * where a host supplies it (the form's `lead`) — a preset's Model.
 */
export type CategoryKey = "model" | "sampling" | "reasoning" | "limits" | "advanced";

/** What a key pressed on a rail tab asks for. `in` and `out` cross to the rail beside this one. */
export type RailMove = "prev" | "next" | "first" | "last" | "in" | "out";

/**
 * Read an arrow key against the way the rail is LAID OUT.
 *
 * A rail is a column of tabs until the window is narrow, where it becomes a row of them. The keys
 * that run ALONG the rail move the selection; the pair that runs ACROSS it steps to the rail beside
 * it — the presets' sections from the presets, and back — so two nested rails are one keyboard
 * surface instead of two tab stops with nothing between them. Turned into a row, the pairs swap,
 * because "the next tab" has to be the one the eye finds next.
 */
export function railMoveOf(key: string, row: boolean): RailMove | undefined {
  switch (key) {
    case "ArrowDown":
      return row ? "in" : "next";
    case "ArrowUp":
      return row ? "out" : "prev";
    case "ArrowRight":
      return row ? "next" : "in";
    case "ArrowLeft":
      return row ? "prev" : "out";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return undefined;
  }
}

/** The tab a move lands on. It wraps: a rail is short, and its ends are one key apart. */
export function railStep(index: number, count: number, move: "prev" | "next" | "first" | "last"): number {
  if (count <= 0) return -1;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  const from = index < 0 ? (move === "next" ? -1 : 0) : index;
  return (from + (move === "next" ? 1 : -1) + count) % count;
}

/** A number the document states at `key`, or nothing. */
export function numOf(doc: LlmConfigDoc, key: string): number | undefined {
  const value = doc[key];
  return typeof value === "number" ? value : undefined;
}

/** The document's `reasoning` object, when it states one. */
export function reasoningOf(doc: LlmConfigDoc): { effort?: string; budgetTokens?: number } | undefined {
  const value = doc["reasoning"];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { effort?: string; budgetTokens?: number }) : undefined;
}

/** The stop sequences a document states, as strings. */
export function stopsOf(doc: LlmConfigDoc): string[] {
  return Array.isArray(doc["stopSequences"]) ? (doc["stopSequences"] as unknown[]).filter((s): s is string => typeof s === "string") : [];
}

/** The keys this form has no control for — Advanced's. */
export function extrasOf(doc: LlmConfigDoc): string[] {
  return Object.keys(doc).filter((k) => !KNOWN_KEYS.has(k));
}

/** A category of the rail: its tab's name and the sentence at the top of its pane. */
export interface LlmCategory {
  key: CategoryKey;
  label: string;
  hint: string;
}

/** The rail's categories, a host's lead section (a preset's Model) first. */
export function llmCategoriesOf(lead: { key: "model"; label: string; hint: string } | undefined): LlmCategory[] {
  return [
    ...(lead !== undefined ? [{ key: lead.key, label: lead.label, hint: lead.hint }] : []),
    { key: "sampling", label: "Sampling", hint: "How the model picks its next token. A reasoning model rejects these outright, so they are only offered while reasoning is off." },
    { key: "reasoning", label: "Reasoning", hint: "How hard to think, as an effort level and/or a token budget. Provider-neutral: it is adapted to each provider's own shape at the call." },
    { key: "limits", label: "Output limits", hint: "How long an answer may run, and what ends it." },
    { key: "advanced", label: "Advanced", hint: "Anything this form has no dedicated control for. Editable as JSON so a setting is never silently dropped." },
  ];
}

/** Each category's line under its name in the rail. */
export function llmSummariesOf(value: LlmConfigDoc, leadSummary = ""): Record<CategoryKey, string> {
  const reasoning = reasoningOf(value);
  const stops = stopsOf(value);
  const extras = extrasOf(value);
  return {
    model: leadSummary,
    sampling:
      reasoning !== undefined
        ? "not applicable — reasoning is on"
        : (() => {
            const set = SAMPLING_KEYS.filter((k) => value[k] !== undefined);
            return set.length === 0 ? "provider defaults" : set.join(" · ");
          })(),
    reasoning: reasoning === undefined ? "off" : (reasoning.effort ?? `${reasoning.budgetTokens ?? "?"} tokens`),
    limits: [value["maxOutputTokens"] === undefined ? null : `${String(value["maxOutputTokens"])} tokens`, stops.length > 0 ? `${stops.length} stop` : null].filter(Boolean).join(" · ") || "no limits",
    advanced: extras.length === 0 ? "none" : `${extras.length} extra`,
  };
}

/** One number field of the form: what it is called, the key it writes, and what it means. */
export interface LlmNumberField {
  label: string;
  param: string;
  hint: string;
}

/** Sampling's fields, in the order the pane draws them. */
export const SAMPLING_FIELDS: readonly LlmNumberField[] = [
  { label: "Temperature", param: "temperature", hint: "Higher is more varied, lower more repeatable. Empty inherits the provider's default." },
  { label: "Top-p", param: "topP", hint: "Nucleus sampling: consider only the most likely tokens adding up to this probability mass (0–1)." },
  { label: "Top-k", param: "topK", hint: "Consider only the k most likely tokens. Provider-dependent; empty inherits." },
  { label: "Presence penalty", param: "presencePenalty", hint: "Discourages tokens that already appeared at all." },
  { label: "Frequency penalty", param: "frequencyPenalty", hint: "Discourages tokens in proportion to how often they already appeared." },
  { label: "Seed", param: "seed", hint: "Fixes the sampler so an identical call draws an identical answer, where the provider supports it." },
];

/** Output limits' number fields; its stop sequences follow them. */
export const LIMIT_FIELDS: readonly LlmNumberField[] = [
  { label: "Max output tokens", param: "maxOutputTokens", hint: "A ceiling on the answer's length — the main lever on the cost of one call. Empty means the model's own maximum." },
  { label: "Max tool steps", param: "maxSteps", hint: "How many model→tool→model round trips one call may take before it is stopped." },
];

export const STOPS_FIELD: LlmNumberField = { label: "Stop sequences", param: "stopSequences", hint: "Comma-separated strings that end generation as soon as they appear." };

/** A document written into one key: `undefined` REMOVES it, which is how a box goes back to inheriting. */
export function withKey(value: LlmConfigDoc, key: string, next: unknown): LlmConfigDoc {
  const doc = { ...value };
  if (next === undefined) delete doc[key];
  else doc[key] = next;
  return doc;
}

/** What the stop-sequence box's text writes. */
export function stopsFromText(text: string): string[] | undefined {
  const list = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/** The sampling knobs a reasoning config also sets — which a reasoning endpoint refuses. */
export function refusedSamplingOf(value: LlmConfigDoc): string[] {
  return reasoningOf(value) !== undefined ? SAMPLING_KEYS.filter((k) => value[k] !== undefined) : [];
}

/** The document without its sampling knobs. */
export function withoutSampling(value: LlmConfigDoc): LlmConfigDoc {
  const doc = { ...value };
  for (const key of SAMPLING_KEYS) delete doc[key];
  return doc;
}

/** The Advanced box's text for a document: every key the form has no control for, as JSON. */
export function advancedTextOf(value: LlmConfigDoc): string {
  const extras = Object.fromEntries(Object.entries(value).filter(([k]) => !KNOWN_KEYS.has(k)));
  return Object.keys(extras).length === 0 ? "" : JSON.stringify(extras, null, 2);
}

/**
 * What typing `text` into the Advanced box does: the document it makes (the known keys kept, the
 * text's object over them), or why it is not saved.
 */
export function advancedEdit(value: LlmConfigDoc, text: string): { doc: LlmConfigDoc } | { problem: string } {
  const known = Object.fromEntries(Object.entries(value).filter(([k]) => KNOWN_KEYS.has(k)));
  if (text.trim() === "") return { doc: known };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "must be a JSON object" };
    return { doc: { ...known, ...(parsed as LlmConfigDoc) } };
  } catch (e) {
    return { problem: (e as Error).message };
  }
}

/** A one-line summary of a config, for a row that shows one without opening it. */
export function summariseLlmConfig(doc: LlmConfigDoc): string {
  const parts: string[] = [];
  const reasoning = reasoningOf(doc);
  if (reasoning !== undefined) parts.push(`reasoning ${reasoning.effort ?? `${reasoning.budgetTokens ?? "?"}t`}`);
  for (const key of SAMPLING_KEYS) if (doc[key] !== undefined) parts.push(`${key} ${String(doc[key])}`);
  if (doc["maxOutputTokens"] !== undefined) parts.push(`≤${String(doc["maxOutputTokens"])} tokens`);
  const extra = Object.keys(doc).filter((k) => !KNOWN_KEYS.has(k)).length;
  if (extra > 0) parts.push(`+${extra} more`);
  return parts.length === 0 ? "provider defaults" : parts.join(" · ");
}
