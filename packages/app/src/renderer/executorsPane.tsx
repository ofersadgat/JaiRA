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
import { useMemo, useState, type JSX } from "react";
import {
  DEFAULT_EXECUTOR,
  type AvailabilitySnapshot,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type JairaOperationNode,
  type ProbeResult,
} from "@jaira/shared/browser";
import { Disclosure, Field, FieldGrid, TextArea, TextInput } from "./controls";
import { LlmConfigForm, summariseLlmConfig, type LlmConfigDoc } from "./llmConfigForm";
import { ExecutorTree } from "./executorTreePane";
import { providerState } from "./providersPane";
import { modelsBlock, type ModelPatch } from "./modelsConfig";
import { executorBlock, formatAllow, parseAllow, type ExecutorPatch, type ExecutorTarget } from "./executorConfig";

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
      <section className="cfg-group">
        <header className="cfg-group-head">
          <h4>The default executor</h4>
          <p className="cfg-hint">
            What every UI-initiated operation uses — starting a task, proposing workflow changes,
            summarizing a conversation. It is a TREE: an operation executor over a function executor
            and a router, and the whole of it is below. Nothing here has to be configured: what is
            shown is DERIVED from what is available, and a change pins only the field you changed, so
            a provider or agent you set up tomorrow still appears by itself.
          </p>
        </header>
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
      </section>

      <Presets
        layerDoc={layerDoc}
        effective={config.effective}
        locked={locked}
        layer={layer}
        onSave={props.onSaveModels}
      />
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

/** Named LLM configurations a state selects with `operation.configRef`. */
function Presets({
  layerDoc,
  effective,
  locked,
  layer,
  onSave,
}: {
  layerDoc: unknown;
  effective: unknown;
  locked: boolean;
  layer: ConfigLayer;
  onSave: (fields: ModelPatch, layer: ConfigLayer) => void;
}): JSX.Element {
  const here = (modelsBlock(layerDoc)?.["presets"] ?? {}) as Record<string, LlmConfigDoc>;
  const inherited = (modelsBlock(effective)?.["presets"] ?? {}) as Record<string, LlmConfigDoc>;
  const [adding, setAdding] = useState("");
  const names = Object.keys(here);
  const inheritedOnly = Object.keys(inherited).filter((n) => !(n in here));

  return (
    <section className="cfg-group">
      <header className="cfg-group-head">
        <h4>Presets</h4>
        <p className="cfg-hint">
          A named set of call settings a state picks with <code>configRef</code>, merged under its own
          config. A definition is the heavier tool — it chooses the provider and the stack too; a preset
          is only the settings.
        </p>
      </header>

      {names.length === 0 && inheritedOnly.length === 0 ? (
        <p className="cfg-hint">None yet.</p>
      ) : (
        <ul className="cfg-rows">
          {names.map((name) => (
            <PresetRow
              key={`${layer}:${name}`}
              name={name}
              value={here[name] ?? {}}
              locked={locked}
              onSave={(next) => onSave({ [`presets.${name}`]: next }, layer)}
              onRemove={() => onSave({ [`presets.${name}`]: undefined }, layer)}
            />
          ))}
          {inheritedOnly.map((name) => (
            <li key={`inherited:${name}`} className="cfg-row">
              <div className="cfg-row-head">
                <span className="cfg-row-title mono">{name}</span>
                <span className="cfg-status unchecked">
                  <span className="cfg-dot" aria-hidden="true" />
                  inherited
                </span>
              </div>
              <p className="cfg-hint">{summariseLlmConfig(inherited[name] ?? {})}</p>
            </li>
          ))}
        </ul>
      )}

      <Disclosure summary="Add a preset" desc="a named set of call settings">
        <div className="cfg-stack">
          <FieldGrid>
            <Field label="Name" param="models.presets.<name>" hint="What a state will write in configRef.">
              <TextInput value={adding} mono placeholder="fast" disabled={locked} onChange={setAdding} />
            </Field>
          </FieldGrid>
          <div className="pane-actions">
            <button
              disabled={locked || adding.trim().length === 0}
              onClick={() => {
                onSave({ [`presets.${adding.trim()}`]: {} }, layer);
                setAdding("");
              }}
            >
              Add it
            </button>
          </div>
        </div>
      </Disclosure>
    </section>
  );
}

function PresetRow({
  name,
  value,
  locked,
  onSave,
  onRemove,
}: {
  name: string;
  value: LlmConfigDoc;
  locked: boolean;
  onSave: (next: LlmConfigDoc) => void;
  onRemove: () => void;
}): JSX.Element {
  const savedJson = JSON.stringify(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<LlmConfigDoc>(value);
  const [baseline, setBaseline] = useState(savedJson);

  if (baseline !== savedJson) {
    if (JSON.stringify(draft) === baseline) setDraft(value);
    setBaseline(savedJson);
  }

  const dirty = JSON.stringify(draft) !== savedJson;

  return (
    <li className="cfg-row">
      <div className="cfg-row-head">
        <span className="cfg-row-title mono">{name}</span>
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Configure"}
        </button>
      </div>
      <p className="cfg-hint">{summariseLlmConfig(draft)}</p>
      {open ? (
        <div className="cfg-row-body">
          <LlmConfigForm value={draft} disabled={locked} onChange={setDraft} />
          <div className="pane-actions">
            <button className="primary" disabled={locked || !dirty} onClick={() => onSave(draft)}>
              Save
            </button>
            <button className="ghost" disabled={!dirty} onClick={() => setDraft(value)}>
              Revert
            </button>
            <button className="ghost danger" disabled={locked} onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
