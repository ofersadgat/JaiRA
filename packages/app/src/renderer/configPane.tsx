/**
 * The typed settings blocks that are not a provider, a forge or a permission set — as FORMS, not a
 * JSON box — cut into the sections the Settings pages draw (the person's reorganisation, 2026-09-23):
 * Models draws the defaults a state that names nothing is filled in with; Runs draws where commands
 * run and the run-behaviour blocks; Data & history draws where artifacts land and how records are
 * stored.
 *
 * Every row has a SWITCH that says whether this layer states it — "use a switch to enable/disable a
 * row". Off, the row shows what it inherits and cannot be edited; on, it pins the value it shows.
 *
 * One block gets a bespoke control rather than the generic renderer: the exec environment is
 * `"windows" | { wsl }`, a discriminated union spelled as a string or an object, which no
 * `type: object` schema describes honestly. Everything else goes through `SchemaForm`.
 *
 * There is no raw-document page any more (2026-09-23): every key of `settings.json` has a row on a
 * page, and a save through a row writes one path of the layer's document, so a field these forms do
 * not know about survives every save. The file itself opens in the Files view.
 */
import { type JSX } from "react";
import {
  ARTIFACT_DESTINATIONS,
  ARTIFACT_VARIABLES,
  CONFIG_SECTIONS,
  type ConfigLayer,
  type ConfigView,
} from "@jaira/shared/browser";
import { Chip, Field, FieldGrid, NumInput, SelectInput, TextInput } from "./controls";
import { LlmConfigForm, summariseLlmConfig, type LlmConfigDoc } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsSection } from "./settingsLayout";
import { withPaths } from "./appearanceLayer";

export interface ConfigPaneProps {
  config: ConfigView | null;
  layer: ConfigLayer;
  busy: boolean;
  editable: boolean;
  /** Write the whole layer document. The caller validates it in main before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  /** The raw-JSON escape hatch, which is still the Files view's editor. */
  children?: JSX.Element;
}

/**
 * Write into ONE layer's document, a dotted path at a time — what every form on a settings screen
 * saves through.
 *
 * `set` writes one path; `undefined` removes it, so the field inherits again, and a container the
 * removal emptied goes with it. `stated` says whether THIS layer says anything at a path, which is
 * what a field's set/not-set switch shows. Both read the layer's own document and never the merged
 * one: saving in a project must not copy the shared root's settings out of it.
 */
export function layerWriter(
  doc: Record<string, unknown> | null,
  layer: ConfigLayer,
  onSave: (layer: ConfigLayer, doc: unknown) => void,
): { set: (path: string, value: unknown) => void; stated: (path: string) => boolean } {
  // A container the removal emptied goes with it, so an untouched section leaves no trace.
  const set = (path: string, value: unknown): void => onSave(layer, withPaths(doc, [[path, value]]));

  const stated = (path: string): boolean => {
    let cursor: unknown = doc;
    for (const part of path.split(".")) {
      if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
      cursor = (cursor as Record<string, unknown>)[part];
      if (cursor === undefined) return false;
    }
    return true;
  };
  return { set, stated };
}

/** The value at a dotted path of a document, or undefined. */
function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = doc;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * What every section here writes through: the layer's own document, the merged one it inherits from,
 * and a row's switch for one path — on while this layer states it. Switching it on pins the value the
 * row shows (the one it inherits), so nothing changes until it is edited; switching it off removes it,
 * and the row inherits again. With nothing to pin, the row is simply enabled (see `Field`).
 */
export function configWriter(
  config: ConfigView,
  layer: ConfigLayer,
  locked: boolean,
  onSave: (layer: ConfigLayer, doc: unknown) => void,
): Writer {
  const doc = config[layer] as Record<string, unknown> | null;
  const effective = config.effective as Record<string, unknown>;
  const { set, stated } = layerWriter(doc, layer, onSave);
  const toggle = (path: string, seed?: unknown): { on: boolean; onChange: (on: boolean) => void; disabled: boolean } => ({
    on: stated(path),
    disabled: locked,
    onChange: (on) => {
      if (!on) set(path, undefined);
      else {
        const current = seed ?? valueAt(effective, path);
        if (current !== undefined) set(path, current);
      }
    },
  });
  return { effective, locked, stated, set, toggle };
}

/**
 * One declared block of `settings.json` (`CONFIG_SECTIONS`) as a section of rows. `setAt` writes
 * each field at its own path: `value` is the MERGED block, and handing a rebuilt one back would pin
 * every inherited sibling into this layer with the one edit.
 */
export function ConfigBlockSection({ writer, block, title }: { writer: Writer; block: string; title?: string }): JSX.Element | null {
  const section = CONFIG_SECTIONS.find((s) => s.key === block);
  if (section === undefined) return null;
  return (
    <SettingsSection id={section.key} title={title ?? section.title} info={section.hint}>
      <SchemaForm
        schema={section.schema as Schema}
        value={writer.effective[section.key]}
        onChange={(next) => writer.set(section.key, next)}
        ctx={{ path: section.key, disabled: writer.locked, isSet: writer.stated, setAt: writer.set }}
      />
    </SettingsSection>
  );
}

export interface Writer {
  effective: Record<string, unknown>;
  locked: boolean;
  stated: (path: string) => boolean;
  set: (path: string, value: unknown) => void;
  toggle: (path: string, seed?: unknown) => { on: boolean; onChange: (on: boolean) => void; disabled: boolean };
}

/** Where a produced file lands — a template, offered as presets plus the variables it may use. */
export function Artifacts({ effective, locked, set, toggle }: Writer): JSX.Element {
  const artifacts = (effective["artifacts"] ?? {}) as Record<string, unknown>;
  const destination = typeof artifacts["destination"] === "string" ? (artifacts["destination"] as string) : "";

  return (
    <SettingsSection
      id="artifacts"
      title="Artifacts"
      info="Where a file an agent produces actually lands. A path template rather than a mode, because which backend and how the path is derived are independent questions and an enum conflates them."
    >
      <FieldGrid>
        <Field
          label="Destination"
          param="artifacts.destination"
          hint="Pick one, or write a template of your own."
          wide
          toggle={toggle("artifacts.destination", destination === "" ? ARTIFACT_DESTINATIONS[0]!.value : destination)}
        >
          <div className="cfg-stack">
            <div className="cfg-chips">
              {ARTIFACT_DESTINATIONS.map((option) => (
                <Chip
                  key={option.value}
                  active={destination === option.value}
                  disabled={locked}
                  title={option.what}
                  onClick={() => set("artifacts.destination", option.value)}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
            <TextInput
              value={destination}
              mono
              placeholder="$JAIRA/artifacts/$TASK_ID/$RELPATH"
              disabled={locked}
              onChange={(v) => set("artifacts.destination", v === "" ? undefined : v)}
            />
            <p className="cfg-hint">
              Variables: {ARTIFACT_VARIABLES.map((v) => <code key={v}>{v} </code>)}
            </p>
          </div>
        </Field>
        <Field
          label="Artifact directory"
          param="artifacts.dir"
          hint="What $ARTIFACT_DIR expands to, inside the root's system/ directory."
          toggle={toggle("artifacts.dir")}
        >
          <TextInput
            value={typeof artifacts["dir"] === "string" ? (artifacts["dir"] as string) : ""}
            mono
            placeholder="artifacts"
            disabled={locked}
            onChange={(v) => set("artifacts.dir", v === "" ? undefined : v)}
          />
        </Field>
        <Field
          label="Keep inline below"
          param="artifacts.inlineMaxBytes"
          hint="Content smaller than this rides along in bindings and prompts rather than being read back. Larger is fewer reads and bigger prompts."
          toggle={toggle("artifacts.inlineMaxBytes")}
        >
          <NumInput
            value={typeof artifacts["inlineMaxBytes"] === "number" ? (artifacts["inlineMaxBytes"] as number) : undefined}
            disabled={locked}
            onChange={(n) => set("artifacts.inlineMaxBytes", n)}
          />
        </Field>
        {/* Only the raw document reached this one before it went (2026-09-23). */}
        <Field
          label="Ask above"
          param="artifacts.askAboveBytes"
          hint="Producing an artifact bigger than this many bytes asks you first. There is no ceiling on size — this is a question, not a refusal; 0 turns it off."
          toggle={toggle("artifacts.askAboveBytes")}
        >
          <NumInput
            value={typeof artifacts["askAboveBytes"] === "number" ? (artifacts["askAboveBytes"] as number) : undefined}
            disabled={locked}
            onChange={(n) => set("artifacts.askAboveBytes", n)}
          />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** Where the project-wide defaults live in the config document — see {@link ModelDefaults}. */
const DEFAULT_ENVIRONMENT = "executors.default.prompt.defaults";

/**
 * The project's own `environment` block: what fills a call that a state left unsaid — Settings →
 * Models → Defaults, and the only way in (the executor tree no longer repeats it).
 *
 * A state's `environment` is a defaults layer over its descendants; this is the same idea one level
 * out, over every state in the project, and it writes to `executors.default.prompt.defaults` — the
 * router's `defaults` block. A second key meaning the same thing would be a second answer to "what
 * model does this project use by default", and the two would disagree the first time somebody edited
 * one of them.
 *
 * Only the call surface, deliberately. An `environment` may also carry `prompt`, `function` and
 * `args`, and a project-wide default for any of those is not a default — it is a state's whole
 * operation, applied to every state that never asked for one.
 */
export function ModelDefaults({ effective, locked, set, toggle }: Writer): JSX.Element {
  const executors = (effective["executors"] ?? {}) as Record<string, unknown>;
  const prompt = ((executors["default"] as Record<string, unknown> | undefined)?.["prompt"] ?? {}) as Record<string, unknown>;
  const defaults = (prompt["defaults"] ?? {}) as Record<string, unknown>;
  const model = typeof defaults["model"] === "string" ? (defaults["model"] as string) : "";
  const { model: _model, ...knobs } = defaults;
  const presets = presetNamesOf(effective);

  return (
    <SettingsSection
      id="defaults"
      title="Defaults"
      info="What a state that names nothing is filled in with — the same fields a state's own environment block carries, one level out. Applied under whatever a state says, so naming a field there always wins."
    >
      <FieldGrid>
        <Field
          label="Default model"
          param={`${DEFAULT_ENVIRONMENT}.model`}
          hint="A model id, or a preset's name — 'coder' means the model coder chooses. A bare id routes to whatever serves that family here — 'claude-sonnet-5' reaches the CLI agent on a machine with no API key. Prefix it ('claude-cli/sonnet') to insist on one route. Empty leaves the choice to the state."
          toggle={toggle(`${DEFAULT_ENVIRONMENT}.model`)}
        >
          <TextInput
            value={model}
            mono
            list={MODEL_OR_PRESET_LIST}
            placeholder="a model id, or a preset"
            disabled={locked}
            onChange={(v) => set(`${DEFAULT_ENVIRONMENT}.model`, v === "" ? undefined : v)}
          />
          <PresetOptions id={MODEL_OR_PRESET_LIST} presets={presets} />
        </Field>
        <Field label="Call settings" hint={summariseLlmConfig(knobs as LlmConfigDoc)} wide>
          <LlmConfigForm
            value={knobs as LlmConfigDoc}
            disabled={locked}
            onChange={(next) => {
              // The model is written by the field above and merged back here, so editing a knob cannot
              // drop it — the same shape the executor tree's own defaults editor uses, for the same
              // reason: `LlmConfigForm` owns every key it renders and would otherwise take the block.
              const merged = { ...next, ...(model === "" ? {} : { model }) };
              set(DEFAULT_ENVIRONMENT, Object.keys(merged).length === 0 ? undefined : merged);
            }}
          />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/** The id of the Default model box's list of presets. */
const MODEL_OR_PRESET_LIST = "default-model-presets";

/**
 * The presets a merged document states, by name — what a model field may name instead of a model id
 * (`resolveModelField`): the built-in ones and every layer's own.
 */
export function presetNamesOf(effective: Record<string, unknown>): string[] {
  const models = effective["models"];
  const presets = models !== null && typeof models === "object" ? (models as Record<string, unknown>)["presets"] : undefined;
  return presets !== null && typeof presets === "object" && !Array.isArray(presets) ? Object.keys(presets) : [];
}

/**
 * A model box's suggestions: the presets, each marked as one — a list to pick a preset from, in a box
 * that still takes any model id.
 */
function PresetOptions({ id, presets }: { id: string; presets: readonly string[] }): JSX.Element {
  return (
    <datalist id={id}>
      {presets.map((name) => (
        <option key={name} value={name}>
          preset
        </option>
      ))}
    </datalist>
  );
}

/**
 * `"windows" | { wsl: string }` — a discriminated union spelled two different ways.
 *
 * Its own control because no `type: object` schema describes that honestly: the generic renderer
 * would offer a `wsl` box on a value that is sometimes a bare string, and writing to it would produce
 * a document the parser refuses.
 */
export function ExecEnvironment({ effective, locked, stated, set, toggle }: Writer): JSX.Element {
  const value = effective["execEnvironment"];
  const distro = value !== null && typeof value === "object" ? String((value as { wsl?: string }).wsl ?? "") : "";

  return (
    <SettingsSection
      id="exec-environment"
      title="Where commands run"
      info="Natively, or inside a WSL distro — which is where git and every agent then run too. Deliberately not Windows git against \\wsl$, which is slow and permission-fragile."
    >
      <FieldGrid>
        <Field label="Environment" param="execEnvironment" hint="Naming a distro runs everything inside it." toggle={toggle("execEnvironment", value ?? "windows")}>
          <SelectInput
            value={distro === "" ? "windows" : "wsl"}
            options={[
              ["natively on Windows", "windows"],
              ["inside a WSL distro", "wsl"],
            ]}
            disabled={locked}
            onChange={(v) => set("execEnvironment", v === "windows" ? "windows" : { wsl: distro || "Ubuntu" })}
          />
        </Field>
        {distro !== "" || (typeof value === "object" && value !== null) ? (
          // The same key as the row above, so it follows that row's switch rather than having its own.
          <Field label="Distro" param="execEnvironment.wsl" hint="As `wsl -l` lists it." off={!stated("execEnvironment")}>
            <TextInput value={distro} mono placeholder="Ubuntu" disabled={locked} onChange={(v) => set("execEnvironment", { wsl: v })} />
          </Field>
        ) : null}
      </FieldGrid>
    </SettingsSection>
  );
}
