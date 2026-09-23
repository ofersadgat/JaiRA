/**
 * Executors — WHO answers a prompt state, and how that executor is BUILT (DESIGN §8.3).
 *
 * The other half of the Providers split. Providers says what is installed and reachable; this says
 * what gets used, and out of what.
 *
 * The thing that was missing, and that this screen exists for: an executor in declarative-ai is not
 * one object, it is a STACK — a core that makes the call, wrapped in layers that each add one
 * cross-cutting behaviour. JaiRA hardcoded exactly one instance of that stack (two repair turns and
 * an on/off memo), so the composition was a fact about the program rather than a choice. A definition
 * here names the core, the model, the call settings, and which steps it is built from — each step
 * with its own parameters.
 *
 * Every form on this screen is generated from a SCHEMA. The step schemas live in `@jaira/shared`'s
 * `executorStack.ts`, which the config parser and the composition also read, so a step that gains a
 * field gains a control here — with its label, its hint and its validation — and nobody edits a form.
 * That is findmyprompt's signature-driven pattern, and the reason to take it: the alternative is
 * three hand-written descriptions of one shape, drifting.
 */
import type { JSX } from "react";
import {
  DEFAULT_EXECUTOR,
  type AvailabilitySnapshot,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type JairaOperationNode,
  type ProbeResult,
} from "@jaira/shared/browser";
import { ExecutorTree } from "./executorTreePane";
import { SettingsSection } from "./settingsLayout";
import { LAYER_LABELS } from "./layerLabels";
import { modelsBlock, type ModelPatch } from "./modelsConfig";
import { Presets, type PresetDocs } from "./presetTabs";
import type { ExecutorPatch, ExecutorTarget } from "./executorConfig";

export interface ExecutorsPaneProps {
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
}

export function ExecutorsPane(props: ExecutorsPaneProps): JSX.Element {
  const { config, executors, probes, availability, busy, layer, editable } = props;
  if (config === null) return <p className="empty">The configuration could not be read.</p>;

  const layerDoc = layer === "base" ? config.base : config.project;
  const locked = busy || !editable;

  return (
    <div className="cfg-pane">
      <SettingsSection
        id="default-executor"
        title="The default executor"
        info="What every UI-initiated operation uses — starting a task, proposing workflow changes, summarizing a conversation. It is a tree: an operation executor over a function executor and a router. Nothing here has to be configured: what is shown is derived from what is available, and a change pins only the field you changed, so a provider or agent you set up tomorrow still appears by itself."
      >
        {availability.tree === undefined ? (
          <p className="cfg-hint">Not resolved yet — the startup check has not finished.</p>
        ) : (
          <ExecutorTree
            resolved={availability.tree}
            overlay={definitionsOf(layerDoc)[DEFAULT_EXECUTOR]}
            locked={locked}
            agents={executors.map((e) => e.name)}
            onOverlay={(next) => props.onSaveDefinition(DEFAULT_EXECUTOR, next, layer)}
          />
        )}
      </SettingsSection>

      <PresetsGroup config={config} locked={locked} layer={layer} onSave={props.onSaveModels} />
    </div>
  );
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
 * Named LLM configurations a state selects with `operation.configRef`.
 *
 * The group head, and the three documents the tabs are drawn from: what THIS layer states, what is
 * in effect, and what the other layer states. Everything else is `presetTabs.tsx`.
 */
function PresetsGroup({
  config,
  locked,
  layer,
  onSave,
}: {
  config: ConfigView;
  locked: boolean;
  layer: ConfigLayer;
  onSave: (fields: ModelPatch, layer: ConfigLayer) => void;
}): JSX.Element {
  const other: ConfigLayer = layer === "base" ? "project" : "base";
  return (
    <SettingsSection
      id="presets"
      title="Presets"
      info="A named set of call settings a state picks with configRef, merged under its own config. A definition is the heavier tool — it chooses the provider and the stack too; a preset is only the settings."
    >
      <Presets
        // A different layer is a different list: start clean rather than show one layer's unsaved
        // edits, or its selection, over another's presets.
        key={layer}
        here={presetsOf(layer === "base" ? config.base : config.project)}
        effective={presetsOf(config.effective)}
        others={presetsOf(other === "base" ? config.base : config.project)}
        locked={locked}
        originLabel={LAYER_LABELS[other]}
        onWrite={(name, value) => onSave({ [`presets.${name}`]: value }, layer)}
      />
    </SettingsSection>
  );
}

