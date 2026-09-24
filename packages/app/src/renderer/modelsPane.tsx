/**
 * Settings → Models — what answers a state that names nothing, and how (DESIGN §8.3).
 *
 * Connections says what is installed and reachable; this says what gets used, and out of what. Four
 * sections, in the order a person asks them: the DEFAULTS a state that names nothing is filled in with
 * (the default model and the call settings — the one way in, where there used to be two), the ROUTES a
 * model id's prefix dispatches to, the PRESETS a state picks by name, and — under Advanced — the
 * executor TREE those are part of.
 *
 * The tree is the thing that was missing before any of this: an executor in declarative-ai is not one
 * object, it is a STACK — a core that makes the call, wrapped in layers that each add one
 * cross-cutting behaviour. Every form over it is generated from a SCHEMA (`@jaira/shared`'s
 * `executorStack.ts`, which the config parser and the composition also read), so a step that gains a
 * field gains a control here and nobody edits a form.
 */
import type { JSX } from "react";
import {
  DEFAULT_EXECUTOR,
  pin,
  type AvailabilitySnapshot,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type JairaOperationNode,
  type ProbeResult,
} from "@jaira/shared/browser";
import { ExecutorRoutes, ExecutorTree } from "./executorTreePane";
import { ModelDefaults, configWriter } from "./configPane";
import { Disclosure } from "./controls";
import { SettingsSection } from "./settingsLayout";
import { LAYER_LABELS } from "./layerLabels";
import { modelsBlock, type ModelPatch } from "./modelsConfig";
import { Presets, type PresetDocs } from "./presetTabs";
import { candidateLookupOf, candidatesInDraft, type CandidateLookup } from "./presetModel";
import type { ExecutorPatch, ExecutorTarget } from "./executorConfig";

export interface ModelsPaneProps {
  config: ConfigView | null;
  executors: ExecutorInfo[];
  probes: Record<string, ProbeResult>;
  availability: AvailabilitySnapshot;
  busy: boolean;
  layer: ConfigLayer;
  editable: boolean;
  onSaveModels: (fields: ModelPatch, layer: ConfigLayer) => void;
  onSaveExecutor: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  /** Write one named executor OVERLAY into the layer. `undefined` removes it. */
  onSaveDefinition: (name: string, definition: JairaOperationNode | undefined, layer: ConfigLayer) => void;
  /** Write the whole layer document — what the Defaults section saves through. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
}

export function ModelsPane(props: ModelsPaneProps): JSX.Element {
  const { config, executors, availability, busy, layer, editable } = props;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;

  const layerDoc = config[layer];
  const locked = busy || !editable;
  const overlay = definitionsOf(layerDoc)[DEFAULT_EXECUTOR];
  const onOverlay = (next: JairaOperationNode): void => props.onSaveDefinition(DEFAULT_EXECUTOR, next, layer);

  return (
    <div className="cfg-pane">
      <ModelDefaults {...configWriter(config, layer, locked, props.onSave)} />

      <SettingsSection
        id="routes"
        title="Routes"
        info="Where a model id's prefix sends a call — claude-cli/… to the CLI agent, anthropic/… to the API. Derived from everything available, so a provider or agent you set up appears here by itself; configuring one pins only what you changed."
      >
        {availability.tree === undefined ? (
          <p className="cfg-hint">Not resolved yet — the startup check has not finished.</p>
        ) : (
          <ExecutorRoutes resolved={availability.tree} overlay={overlay} locked={locked} onOverlay={onOverlay} />
        )}
      </SettingsSection>

      <PresetsGroup config={config} locked={locked} layer={layer} lookup={candidateLookupOf(availability)} onSave={props.onSaveModels} />

      <SettingsSection
        id="advanced"
        title="Advanced"
        info="The default executor as the tree it is: an operation executor over a function executor and a router, and the layers wrapped around each. What every UI-initiated operation uses — starting a task, proposing workflow changes, summarizing a conversation. Nothing here has to be configured: what is shown is derived from what is available, and a change pins only the field you changed."
      >
        {availability.tree === undefined ? (
          <p className="cfg-hint">Not resolved yet — the startup check has not finished.</p>
        ) : (
          <Disclosure summary="How a call is dispatched" desc="the executor tree, and the layers around each level">
            <ExecutorTree resolved={availability.tree} overlay={overlay} locked={locked} agents={executors.map((e) => e.name)} onOverlay={onOverlay} split />
          </Disclosure>
        )}
      </SettingsSection>
    </div>
  );
}

/**
 * What saving the default executor's function rules writes — Settings → Tools draws them as its
 * available column, and they are still the default executor's overlay, pinned like any other field.
 */
export function functionRulesOverlay(
  config: ConfigView,
  layer: ConfigLayer,
  rules: string[] | undefined,
): [name: string, definition: JairaOperationNode, layer: ConfigLayer] {
  const overlay = definitionsOf(config[layer])[DEFAULT_EXECUTOR];
  return [DEFAULT_EXECUTOR, pin(overlay, "function.rules", rules), layer];
}

/** The executor overlays a document states, as an object. */
function definitionsOf(doc: unknown): Record<string, JairaOperationNode> {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return {};
  const block = (doc as Record<string, unknown>)["executors"];
  if (block === null || typeof block !== "object" || Array.isArray(block)) return {};
  return block as Record<string, JairaOperationNode>;
}

/** The presets a document states, as an object. */
function presetsOf(doc: unknown): PresetDocs {
  const block = modelsBlock(doc)?.["presets"];
  return block !== null && typeof block === "object" && !Array.isArray(block) ? (block as PresetDocs) : {};
}

/**
 * The model ids a candidate's box suggests: every candidate a preset in view already names, then the
 * current families — suggestions only, the box takes any id.
 */
const MODEL_SUGGESTIONS = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

function suggestionsOf(...docs: PresetDocs[]): string[] {
  const named = docs.flatMap((doc) => Object.values(doc).flatMap((preset) => candidatesInDraft(preset["model"])));
  return [...new Set([...named, ...MODEL_SUGGESTIONS].filter((id) => id.trim().length > 0))];
}

/** A layer as words in a sentence — "Shared (all projects)" → "shared", "This project" → "this project". */
function layerWordOf(layer: ConfigLayer): string {
  return LAYER_LABELS[layer].replace(/\s*\(.*\)\s*$/, "").toLowerCase();
}

/**
 * Named LLM configurations a state selects with `operation.configRef`.
 *
 * The group head, and the documents the tabs are drawn from: what THIS layer states, what is in
 * effect, what the other layer states, and what ships (`ConfigView.system`). Everything else is
 * `presetTabs.tsx`.
 */
function PresetsGroup({
  config,
  locked,
  layer,
  lookup,
  onSave,
}: {
  config: ConfigView;
  locked: boolean;
  layer: ConfigLayer;
  lookup: CandidateLookup;
  onSave: (fields: ModelPatch, layer: ConfigLayer) => void;
}): JSX.Element {
  const builtIn = presetsOf(config.system);
  const effective = presetsOf(config.effective);
  const other: ConfigLayer = layer === "base" ? "project" : "base";
  return (
    <SettingsSection
      id="presets"
      title="Presets"
      info="A named model and set of call settings a state picks with configRef, merged under its own config — simple, coder and planner ship built in, and editing one saves your copy in this layer. A model field (the default model, the judge) may name a preset too. A definition is the heavier tool — it chooses the provider and the stack too."
    >
      <Presets
        // A different layer is a different list: start clean rather than show one layer's unsaved
        // edits, or its selection, over another's presets.
        key={layer}
        here={presetsOf(config[layer])}
        effective={effective}
        others={presetsOf(config[other])}
        builtIn={builtIn}
        locked={locked}
        originLabel={LAYER_LABELS[other]}
        layerWord={layerWordOf(layer)}
        lookup={lookup}
        suggestions={suggestionsOf(effective, builtIn)}
        onWrite={(name, value) => onSave({ [`presets.${name}`]: value }, layer)}
      />
    </SettingsSection>
  );
}

