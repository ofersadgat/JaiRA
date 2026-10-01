/**
 * What Settings → Models (`ModelsPage.tsx`) reads out of the configuration, as pure functions — the
 * executor overlays and presets a document states, what a candidate's box suggests, a layer in a word.
 */
import { DEFAULT_EXECUTOR, pin, type ConfigLayer, type ConfigView, type JairaOperationNode } from "@jaira/shared/browser";
import { LAYER_LABELS } from "./layerLabels";
import type { LlmConfigDoc } from "./llmConfigModel";
import { modelsBlock } from "./modelsConfig";
import { candidatesInDraft } from "./presetCandidates";

export type PresetDocs = Record<string, LlmConfigDoc>;

/** The executor overlays a document states, as an object. */
export function definitionsOf(doc: unknown): Record<string, JairaOperationNode> {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return {};
  const block = (doc as Record<string, unknown>)["executors"];
  if (block === null || typeof block !== "object" || Array.isArray(block)) return {};
  return block as Record<string, JairaOperationNode>;
}

/** The presets a document states, as an object. */
export function presetsOf(doc: unknown): PresetDocs {
  const block = modelsBlock(doc)?.["presets"];
  return block !== null && typeof block === "object" && !Array.isArray(block) ? (block as PresetDocs) : {};
}

/**
 * The model ids a candidate's box suggests: every candidate a preset in view already names, then the
 * models the catalog knows, newest first (decision 0009 — no list kept here) — suggestions only, the
 * box takes any id.
 */
export function suggestionsOf(catalogIds: readonly string[], ...docs: PresetDocs[]): string[] {
  const named = docs.flatMap((doc) => Object.values(doc).flatMap((preset) => candidatesInDraft(preset["model"])));
  return [...new Set([...named, ...catalogIds].filter((id) => id.trim().length > 0))];
}

/** A layer as words in a sentence — "Shared (all projects)" → "shared", "This project" → "this project". */
export function layerWordOf(layer: ConfigLayer): string {
  return LAYER_LABELS[layer].replace(/\s*\(.*\)\s*$/, "").toLowerCase();
}

/** The layer the Presets section compares against — the other one a person writes. */
export function otherLayerOf(layer: ConfigLayer): ConfigLayer {
  return layer === "base" ? "project" : "base";
}

/** The default executor's overlay in the layer being edited. */
export function defaultOverlayOf(config: ConfigView, layer: ConfigLayer): JairaOperationNode | undefined {
  return definitionsOf(config[layer])[DEFAULT_EXECUTOR];
}

/**
 * What saving the default executor's function rules writes — Settings → Tools draws them as its
 * available column, and they are still the default executor's overlay, pinned like any other field.
 */
export function functionRulesOverlay(config: ConfigView, layer: ConfigLayer, rules: string[] | undefined): [name: string, definition: JairaOperationNode, layer: ConfigLayer] {
  const overlay = definitionsOf(config[layer])[DEFAULT_EXECUTOR];
  return [DEFAULT_EXECUTOR, pin(overlay, "function.rules", rules), layer];
}

/** The Defaults section's block: where the project-wide defaults live, and what they hold. */
export const DEFAULT_ENVIRONMENT = "executors.default.prompt.defaults";

/** The Defaults section's model and call settings, out of the merged document. */
export function modelDefaultsOf(effective: Record<string, unknown>): { model: string; knobs: LlmConfigDoc } {
  const executors = (effective["executors"] ?? {}) as Record<string, unknown>;
  const prompt = ((executors["default"] as Record<string, unknown> | undefined)?.["prompt"] ?? {}) as Record<string, unknown>;
  const defaults = (prompt["defaults"] ?? {}) as Record<string, unknown>;
  const model = typeof defaults["model"] === "string" ? (defaults["model"] as string) : "";
  const { model: _model, ...knobs } = defaults;
  return { model, knobs: knobs as LlmConfigDoc };
}

/** What editing a call-settings knob writes to the Defaults block: the knobs with the model merged back. */
export function mergedDefaultsOf(next: LlmConfigDoc, model: string): LlmConfigDoc | undefined {
  const merged = { ...next, ...(model === "" ? {} : { model }) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}
