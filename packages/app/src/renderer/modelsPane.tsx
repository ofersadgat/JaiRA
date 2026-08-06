/**
 * Which model answers a prompt state, and how each provider route is reached (DESIGN §8.3).
 *
 * The surface that was missing when a sync failed with `no model configured`: the message named a file
 * and a field, and there was nowhere in the app to set either. `config.models` was reachable only
 * through the raw JSON textarea — fine for a policy block nobody touches, wrong for the one setting a
 * first run cannot start without.
 *
 * Its shape follows the Executors pane deliberately: the same layer rules, the same "an empty box
 * removes the setting", the same Test that never spends money. They are the same kind of screen, and a
 * second set of conventions would be a second set of surprises.
 *
 * Its own file rather than another section of `panes.tsx` because that file is already the settings
 * screen plus the board plus the inbox, and one more form with two components and a label table is the
 * point where "where does this live" stops having an obvious answer.
 */
import { useMemo, useState, type JSX } from "react";
import type { ConfigLayer, ConfigView, ProbeResult } from "@jaira/shared/browser";
import {
  MODEL_ROUTES,
  checkModelId,
  defaultModel,
  formatJson,
  formatServe,
  modelsBlock,
  parseJsonBlock,
  parseServe,
  routeBlock,
  type ModelPatch,
  type RouteField,
  type RouteSpec,
} from "./modelsConfig";
import { checkCredentialName } from "./executorConfig";

const LAYER_LABELS: Record<ConfigLayer, string> = {
  base: "the shared root",
  project: "this project",
};

/** The wording for each route field, so the form says what a value is FOR. */
const FIELD_LABELS: Record<RouteField, string> = {
  credential: "credential (names a secret)",
  baseURL: "server URL",
  supportsStructuredOutputs: "structured output",
  serve: "start it with (blank ⇒ expect it running)",
  weights: "weights (JSON: model id → { modelPath })",
};

/** What a probe concluded, in one word. Mirrors the executor badge so the two read alike. */
function RouteBadge({ probe }: { probe: ProbeResult | undefined }): JSX.Element {
  if (probe === undefined) return <span className="sub">not checked</span>;
  const tone = probe.status === "ok" ? "ok-text" : probe.status === "failed" ? "warn-text" : "sub";
  return <span className={`sub ${tone}`}>{probe.status}</span>;
}

export function ModelsPane({
  config,
  probes,
  busy,
  layer,
  editable,
  onSave,
  onProbe,
}: {
  /**
   * Both layers as authored, plus the merged result.
   *
   * All three, because a settings form has two different jobs for them: the layer being edited
   * supplies the VALUES (only what this layer itself says, or saving would freeze every inherited
   * value into it), and the effective config supplies the PLACEHOLDERS, which is what makes an
   * inherited setting visible as something other than an empty box.
   */
  config: ConfigView | null;
  probes: Record<string, ProbeResult>;
  busy: boolean;
  layer: ConfigLayer;
  /** False with no project open and the project layer selected — there is no document to write. */
  editable: boolean;
  onSave: (fields: ModelPatch, layer: ConfigLayer) => void;
  onProbe: () => void;
}): JSX.Element {
  const layerDoc = layer === "base" ? config?.base : config?.project;
  const effective = config?.effective ?? null;
  const saved = defaultModel(layerDoc);
  const inherited = defaultModel(effective);
  const savedPresets = useMemo(() => formatJson(modelsBlock(layerDoc)?.["presets"]), [layerDoc]);

  const [model, setModel] = useState(saved);
  const [presets, setPresets] = useState(savedPresets);
  const [baseline, setBaseline] = useState({ model: saved, presets: savedPresets });
  const [problem, setProblem] = useState<string | null>(null);

  // The document changed under the form — normally because this pane just saved. Untouched fields
  // follow the document; edited ones are kept, so nothing discards typing. The same reconciliation the
  // executor rows do, for the same reason.
  if (baseline.model !== saved || baseline.presets !== savedPresets) {
    if (model === baseline.model) setModel(saved);
    if (presets === baseline.presets) setPresets(savedPresets);
    setBaseline({ model: saved, presets: savedPresets });
  }

  const dirty = model !== saved || presets !== savedPresets;
  const save = (): void => {
    try {
      const id = model.trim();
      checkModelId(id);
      setProblem(null);
      onSave({ default: id.length > 0 ? id : undefined, presets: parseJsonBlock(presets, "presets") }, layer);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <div className="settings-pane">
      <div className="pane-head">
        <span className="task-title">Models</span>
        <button className="ghost" onClick={onProbe} disabled={busy}>
          Test all
        </button>
      </div>

      <label className="field">
        <span className="sub">default model{modelsBlock(layerDoc)?.["default"] === undefined ? "" : " · set here"}</span>
        <input
          value={model}
          placeholder={
            inherited.length > 0 ? `${inherited} (inherited)` : "chosen automatically — the first route that works, else an agent"
          }
          disabled={busy || !editable}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      {/* The rule that turns "no model configured" from a dead end into a choice. */}
      <div className="sub">
        The PREFIX decides who answers. <code>anthropic/…</code> and <code>openrouter/…</code> call a
        provider and need a key below; <code>claude-cli/…</code> runs the CLI agent on its own
        subscription and needs nothing configured at all. Left empty, JaiRA picks the first that works.
      </div>

      <ul className="exec-list">
        {MODEL_ROUTES.map((route) => (
          <RouteRow
            key={`${layer}:${route.key}`}
            spec={route}
            probe={probes[route.key]}
            here={routeBlock(layerDoc, route.key) ?? {}}
            merged={routeBlock(effective, route.key) ?? {}}
            busy={busy || !editable}
            onSave={(fields) => onSave(fields, layer)}
          />
        ))}
      </ul>

      <label className="field">
        <span className="sub">presets (JSON) — a state selects one with configRef</span>
        <textarea
          className="code-editor short"
          value={presets}
          placeholder={'{ "fast": { "model": "anthropic/claude-haiku-4-5", "temperature": 0 } }'}
          disabled={busy || !editable}
          onChange={(e) => setPresets(e.target.value)}
        />
      </label>

      <div className="sub">
        An empty box removes the setting from {LAYER_LABELS[layer].toLowerCase()}, so it goes back to
        whatever the other layer or the built-in default says.
      </div>
      {problem ? <div className="sub warn-text">{problem}</div> : null}
      <div className="pane-actions">
        <button onClick={save} disabled={busy || !editable || !dirty}>
          Save
        </button>
        <button
          className="ghost"
          onClick={() => {
            setModel(saved);
            setPresets(savedPresets);
            setProblem(null);
          }}
          disabled={!dirty}
        >
          Revert
        </button>
      </div>
    </div>
  );
}

/** One provider route: what it is for, whether it can be reached, and its settings. */
function RouteRow({
  spec,
  probe,
  here,
  merged,
  busy,
  onSave,
}: {
  spec: RouteSpec;
  probe: ProbeResult | undefined;
  here: Record<string, unknown>;
  merged: Record<string, unknown>;
  busy: boolean;
  onSave: (fields: ModelPatch) => void;
}): JSX.Element {
  const saved = useMemo(
    () => Object.fromEntries(spec.fields.map((f) => [f, fieldText(f, here)])) as Record<string, string>,
    [spec, here],
  );

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);

  if (spec.fields.some((f) => (baseline[f] ?? "") !== (saved[f] ?? ""))) {
    const next: Record<string, string> = { ...saved };
    for (const f of spec.fields) if ((form[f] ?? "") !== (baseline[f] ?? "")) next[f] = form[f] ?? "";
    setBaseline(saved);
    setForm(next);
  }

  const dirty = spec.fields.some((f) => (form[f] ?? "") !== (saved[f] ?? ""));
  const enabled = here["enabled"] !== false;

  const save = (): void => {
    try {
      const patch: ModelPatch = {};
      for (const field of spec.fields) {
        const text = (form[field] ?? "").trim();
        const key = `routes.${spec.key}.${field}`;
        if (field === "serve") patch[key] = parseServe(text);
        else if (field === "weights") patch[key] = parseJsonBlock(text, `${spec.label} weights`);
        else if (field === "supportsStructuredOutputs") patch[key] = text === "no" ? false : undefined;
        else {
          // A credential NAMES a secret; checked here so a pasted key is refused before it can be
          // written into a file that gets committed.
          if (field === "credential" && text.length > 0) checkCredentialName(text);
          patch[key] = text.length > 0 ? text : undefined;
        }
      }
      setProblem(null);
      onSave(patch);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <li className={enabled ? undefined : "off"}>
      <div className="exec-head">
        <label className="toggle" title={`turn the ${spec.label} route ${enabled ? "off" : "on"}`}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            // `undefined` REMOVES the key rather than writing `true`: on is the default, and a layer
            // that says so explicitly is a layer overriding something for no reason.
            onChange={(e) => onSave({ [`routes.${spec.key}.enabled`]: e.target.checked ? undefined : false })}
          />
          <span className="task-title">{spec.label}</span>
        </label>
        <RouteBadge probe={probe} />
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Configure"}
        </button>
      </div>
      <div className="sub">{spec.hint}</div>
      {probe ? <div className="sub">{probe.detail}</div> : null}

      {open ? (
        <div className="exec-form">
          {spec.fields.map((field) => (
            <label key={field} className="field">
              <span className="sub">
                {FIELD_LABELS[field]}
                {here[field] === undefined ? "" : " · set here"}
              </span>
              <RouteField
                field={field}
                spec={spec}
                value={form[field] ?? ""}
                merged={merged}
                disabled={busy}
                onChange={(value) => setForm((f) => ({ ...f, [field]: value }))}
              />
            </label>
          ))}
          {problem ? <div className="sub warn-text">{problem}</div> : null}
          <div className="pane-actions">
            <button onClick={save} disabled={busy || !dirty}>
              Save
            </button>
            <button
              className="ghost"
              onClick={() => {
                setForm(saved);
                setProblem(null);
              }}
              disabled={!dirty}
            >
              Revert
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** One editable field, in whatever control its shape calls for. */
function RouteField({
  field,
  spec,
  value,
  merged,
  disabled,
  onChange,
}: {
  field: RouteField;
  spec: RouteSpec;
  value: string;
  merged: Record<string, unknown>;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  if (field === "supportsStructuredOutputs") {
    return (
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">yes — this server honours a full json_schema</option>
        <option value="no">no — cap it at json_object</option>
      </select>
    );
  }
  if (field === "weights") {
    return (
      <textarea
        className="code-editor short"
        value={value}
        placeholder={placeholderFor(field, spec, merged)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input value={value} placeholder={placeholderFor(field, spec, merged)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
  );
}

/** This layer's own value for a field, as text. */
function fieldText(field: RouteField, block: Record<string, unknown>): string {
  if (field === "serve") return formatServe(block["serve"]);
  if (field === "weights") return formatJson(block["weights"]);
  if (field === "supportsStructuredOutputs") return block["supportsStructuredOutputs"] === false ? "no" : "";
  const value = block[field];
  return typeof value === "string" ? value : "";
}

/** What the effective config already supplies, so an inherited value is visible rather than blank. */
function placeholderFor(field: RouteField, spec: RouteSpec, merged: Record<string, unknown>): string {
  if (field === "credential") {
    const value = merged["credential"];
    if (typeof value === "string") return `${value} (inherited)`;
    // The conventional variable, for the first-run case — someone has a key and no idea what JaiRA
    // wants it called. A SUGGESTION only: no lookup falls back to it, because a credential found under
    // a name the config never mentions is a credential nobody can trace.
    return spec.credential ?? "the secret this route's key is stored under";
  }
  if (field === "baseURL") {
    const value = merged["baseURL"];
    return typeof value === "string" ? `${value} (inherited)` : "http://localhost:11434/v1";
  }
  if (field === "serve") return formatServe(merged["serve"]) || "ollama serve";
  if (field === "weights") return formatJson(merged["weights"]) || '{ "qwen2.5-7b": { "modelPath": "/models/qwen.gguf" } }';
  return "";
}
