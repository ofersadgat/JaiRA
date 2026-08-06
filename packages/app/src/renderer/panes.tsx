/**
 * The settings drawer: project + shared configuration, and executors.
 *
 * Both panes share one idea, and it is the reason they live together. JaiRA now has TWO places a
 * thing can be configured — this project's `.jaira/`, and the shared base root behind every project
 * on the machine — so every screen here has to answer "which one am I changing?" before it lets
 * anyone change anything. That is why each pane names its layer in the control itself rather than in
 * a mode the user has to remember they are in.
 *
 * The workflow editor used to live here too and now has its own file: it grew a form over the whole
 * state format — slots, children and their wiring, the operation, the environment defaults layer —
 * and was several times the size of the two panes it was sharing a module with.
 *
 * Rendering only; every write goes through the store and is validated in the main process.
 */
import { useMemo, useState, type JSX } from "react";
import {
  CONFIG_JSON,
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  SUGGESTED_CREDENTIALS,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type FileSource,
  type ProbeResult,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import type { Drafts, SetDraft } from "./drafts";
import {
  CODEX_SANDBOXES,
  checkCredentialName,
  editableFields,
  executorBlock,
  formatArgs,
  formatEnv,
  parseArgs,
  parseEnv,
  type ExecutorPatch,
  type ExecutorTarget,
} from "./executorConfig";
import { ConfigEdit, ConfigEffectiveView } from "./fileSurfaces";
import type { FileSurfaceContext, FileSurfaceProps } from "./fileTypes";

export type { ConfigLayer };

const LAYER_LABELS: Record<ConfigLayer, string> = {
  project: "This project",
  base: "Shared (all projects)",
};

/** A two-way layer switch, used wherever a write has to name where it lands. */
export function LayerPicker({
  value,
  onChange,
  disabled,
}: {
  value: ConfigLayer;
  onChange: (layer: ConfigLayer) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="layer-picker" role="group" aria-label="Configuration layer">
      {(["project", "base"] as ConfigLayer[]).map((layer) => (
        <button
          key={layer}
          className={value === layer ? "layer-on" : "ghost"}
          onClick={() => onChange(layer)}
          disabled={disabled}
          title={
            layer === "base"
              ? "the shared root — changes here affect every project that has not overridden them"
              : "this project only"
          }
        >
          {LAYER_LABELS[layer]}
        </button>
      ))}
    </div>
  );
}

/**
 * The settings pane: each layer's `config.json`.
 *
 * The editor and the effective view are the SAME components the Files view renders when you click
 * `config.json` in the tree — `application/vnd.jaira.config+json` registers both, and this pane
 * borrows them rather than keeping a second textarea in sync with the first. That fold-in is the
 * point: two editors over one file is how they drift, and one of them ends up missing the parse
 * check or the layer notice.
 *
 * What stays here is what the registry cannot supply — the layer this section names, the path it
 * writes, and the warning that the shared root is not this project's.
 */
export function SettingsPane({
  config,
  layer,
  busy,
  drafts,
  onDraft,
  onSave,
}: {
  config: ConfigView | null;
  /**
   * Which layer this pane edits.
   *
   * Passed in rather than switched inside, now that the Settings view lists the two layers as
   * separate sections. "Which file am I about to write?" is answered by where you navigated, which
   * is the same rule the Files tree uses — and it means the question is asked once per surface
   * instead of once per pane.
   */
  layer: ConfigLayer;
  busy: boolean;
  /**
   * The session's unsaved edits, so this pane's editor is the same editor the Files view opens on
   * the same file.
   *
   * Threaded through rather than left to the surface's local fallback because switching sections
   * unmounts this pane: without it, half-written config was lost by a glance at Executors — the
   * same failure the drafts store exists to fix, one view along.
   */
  drafts?: Drafts | undefined;
  onDraft?: SetDraft | undefined;
  onSave: (layer: ConfigLayer, doc: unknown) => void;
}): JSX.Element {
  const [showEffective, setShowEffective] = useState(false);

  if (config === null) {
    return <p className="empty">Configuration is unavailable — the app could not read it.</p>;
  }

  const file = layer === "base" ? config.baseFile : config.projectFile;
  // Only the PROJECT layer needs a project. The shared root is machine-global and exists before any
  // checkout, so an empty window is exactly when someone sets it up — which is what this pane used
  // to refuse, having been given no config to render at all.
  if (layer === "project" && file.length === 0) {
    return (
      <p className="empty">
        No project is open, so there is no project configuration to edit. Open one, or switch to the
        shared layer — it applies to every project on this machine.
      </p>
    );
  }
  // The document as the registry's surfaces take it. `text` is empty because both config surfaces
  // read the parsed layer out of the context — the raw bytes are `config:read`'s business, and this
  // pane has never had them.
  const doc: FileSource = {
    layer,
    path: "config.json",
    file,
    mime: CONFIG_JSON,
    text: "",
    // Whether the layer has a `config.json` on disk, not whether it has a path — the shared root
    // always has one, and normally no file behind it until somebody saves here for the first time.
    exists: (layer === "base" ? config.base : config.project) !== null,
  };
  const surface: FileSurfaceProps = {
    doc,
    busy,
    onSave: () => undefined,
    context: { ...EMPTY_CONTEXT, config, drafts, onDraft, onSaveConfig: onSave },
  };

  return (
    <div className="pane">
      <div className="sub file-path" title={file}>
        {file}
      </div>
      {layer === "base" ? (
        <div className="notice">
          This is the shared root. Every project on this machine reads it unless it sets the same
          field itself.
        </div>
      ) : null}

      <ConfigEdit {...surface} />

      <div className="pane-actions">
        <button className="ghost" onClick={() => setShowEffective((v) => !v)}>
          {showEffective ? "Hide effective" : "Show effective"}
        </button>
      </div>

      {showEffective ? (
        <section>
          <h4>Effective configuration</h4>
          {/* The answer to "what will actually run": both layers merged, parsed, defaults filled in. */}
          <ConfigEffectiveView {...surface} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * The context fields no configuration surface reads.
 *
 * Spelled out rather than cast, so that adding a field to {@link FileSurfaceContext} makes this
 * fail to compile instead of quietly passing `undefined` into a surface that expects it.
 */
const EMPTY_CONTEXT: FileSurfaceContext = {
  state: null,
  config: null,
  tree: null,
  executors: [],
  selected: null,
  conversation: null,
  onSelectTask: () => undefined,
  onDrill: () => undefined,
  onSaveConfig: () => undefined,
  // The config surfaces validate through `config:write`, not through a schema — see ConfigEdit.
  validateSchema: async () => null,
  stateSlots: async () => null,
  schemaChoice: {},
  onSchemaChoice: () => undefined,
  detectSchema: async () => null,
  wrapJson: false,
  onWrapJson: () => undefined,
};

/** Status glyph + wording for one probe result. */
function ProbeBadge({ probe, probing }: { probe: ProbeResult | undefined; probing: boolean }): JSX.Element {
  if (probing) return <span className="chip">checking…</span>;
  if (!probe) return <span className="chip">not checked</span>;
  const tone =
    probe.status === "ok" ? "ok" : probe.status === "failed" ? "bad" : probe.status === "disabled" ? "dim" : "warn";
  return (
    <span className={`chip chip-${tone}`} title={probe.detail}>
      {probe.status}
    </span>
  );
}

/**
 * The executors pane (DESIGN §8.1, §8.2).
 *
 * Three things per executor, and all three were previously invisible: whether it is turned on,
 * whether it actually works on this machine, and where its credential comes from. The last is shown
 * as an ORIGIN — "shared .env.local" — and never as a value: the renderer is the untrusted half of
 * the IPC boundary, so a secret that never crosses it cannot leak through it.
 */
export function ExecutorsPane({
  executors,
  probes,
  probing,
  secrets,
  config,
  busy,
  layer,
  onProbe,
  onToggle,
  onConfigure,
  onAdd,
  onRemove,
  onSaveCredential,
}: {
  executors: ExecutorInfo[];
  probes: Record<string, ProbeResult>;
  probing: string[];
  secrets: SecretCapabilities;
  /**
   * Both layers as authored, plus the merged result.
   *
   * The pane needs all three because a settings form has two different jobs for them: the layer
   * being edited supplies the VALUES (only what this layer itself says, or saving would freeze
   * every inherited value into it), and the effective config supplies the PLACEHOLDERS, which is
   * what makes an inherited setting visible as something other than an empty box.
   */
  config: ConfigView | null;
  busy: boolean;
  /**
   * The layer every write here is made in.
   *
   * Passed in rather than held here, now that the Settings view owns the layer for every section
   * under it. Two controls for one question is how the config editor and this pane ended up able to
   * be pointed at different layers at the same time.
   */
  layer: ConfigLayer;
  onProbe: (name?: string) => void;
  onToggle: (name: string, enabled: boolean, layer: ConfigLayer) => void;
  onConfigure: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
  onRemove: (name: string, layer: ConfigLayer) => void;
  onSaveCredential: (request: {
    executor: ExecutorTarget & { credential?: string | undefined };
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
}): JSX.Element {
  // The built-in adapters are always listed, project or not, so an empty list means the read itself
  // failed rather than that nothing is configured.
  if (executors.length === 0) {
    return <p className="empty">No executors — the app could not read the configuration.</p>;
  }

  const layerDoc = config === null ? null : layer === "base" ? config.base : config.project;
  const editable = config !== null && (layer === "base" || config.projectFile.length > 0);
  const targets: SecretTarget[] = [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    ...(config !== null && config.projectFile.length > 0 ? (["project-env-local"] as SecretTarget[]) : []),
    "base-env-local",
  ];

  return (
    <div className="pane">
      <div className="pane-actions">
        <button onClick={() => onProbe()} disabled={busy || probing.length > 0}>
          Test all
        </button>
      </div>
      <div className="sub">every change here writes to: {LAYER_LABELS[layer].toLowerCase()}</div>
      {!editable ? (
        <div className="notice">
          No project is open, so there is nothing to write a project setting into. Switch to the
          shared layer — it applies to every project on this machine.
        </div>
      ) : null}
      {!secrets.keychain && secrets.keychainReason ? (
        <div className="notice">{secrets.keychainReason}</div>
      ) : null}

      <ul className="executors">
        {executors.map((executor) => (
          // Remounted per layer, so switching layers re-derives the form from the document it is
          // now editing rather than leaving the other layer's values in the boxes.
          <ExecutorRow
            key={`${layer}:${executor.name}`}
            executor={executor}
            probe={probes[executor.name]}
            probing={probing.includes(executor.name)}
            layerDoc={layerDoc}
            effective={config?.effective ?? null}
            layer={layer}
            busy={busy || !editable}
            targets={targets}
            onProbe={onProbe}
            onToggle={onToggle}
            onConfigure={onConfigure}
            onRemove={onRemove}
            onSaveCredential={onSaveCredential}
          />
        ))}
      </ul>

      <AddExecutor layer={layer} busy={busy || !editable} onAdd={onAdd} />
    </div>
  );
}

/** The wording and placeholder for each field, so the form says what a value is FOR. */
const FIELD_LABELS: Record<string, string> = {
  name: "registry name",
  command: "command",
  credential: "credential (names a secret)",
  sandbox: "sandbox",
  args: "arguments (one per line)",
  prompt: "prompt delivery",
  env: "environment (NAME=value per line)",
};

/**
 * One executor: its state, its settings, and its key.
 *
 * The form edits ONE layer's document. A field left empty removes the key from that layer rather
 * than pinning whatever was showing, so "clear it and save" is how a project goes back to
 * inheriting the shared root — the operation there was previously no way to express in the UI at
 * all.
 */
function ExecutorRow({
  executor,
  probe,
  probing,
  layerDoc,
  effective,
  layer,
  busy,
  targets,
  onProbe,
  onToggle,
  onConfigure,
  onRemove,
  onSaveCredential,
}: {
  executor: ExecutorInfo;
  probe: ProbeResult | undefined;
  probing: boolean;
  layerDoc: unknown;
  effective: unknown;
  layer: ConfigLayer;
  busy: boolean;
  targets: SecretTarget[];
  onProbe: (name?: string) => void;
  onToggle: (name: string, enabled: boolean, layer: ConfigLayer) => void;
  onConfigure: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  onRemove: (name: string, layer: ConfigLayer) => void;
  onSaveCredential: (request: {
    executor: ExecutorTarget & { credential?: string | undefined };
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
}): JSX.Element {
  const fields = useMemo(() => editableFields(executor.kind), [executor.kind]);
  const here = useMemo(() => executorBlock(layerDoc, executor.name) ?? {}, [layerDoc, executor.name]);
  const merged = useMemo(() => executorBlock(effective, executor.name) ?? {}, [effective, executor.name]);
  const saved = useMemo(() => formValues(fields, here, executor.name), [fields, here, executor.name]);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [keyTarget, setKeyTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");

  // The document changed under the form — normally because this row just saved, and a write can add
  // fields the form did not send: creating a generic-CLI override carries the command across, and a
  // box that stayed empty through that would offer to REMOVE the command on the next save. Untouched
  // fields therefore follow the document; edited ones are kept, so nothing discards typing.
  if (!sameForm(fields, baseline, saved)) {
    const next: Record<string, string> = { ...saved };
    for (const field of fields) {
      if ((form[field] ?? "") !== (baseline[field] ?? "")) next[field] = form[field] ?? "";
    }
    setBaseline(saved);
    setForm(next);
  }

  const dirty = fields.some((field) => (form[field] ?? "") !== (saved[field] ?? ""));
  const target: ExecutorTarget = { name: executor.name, kind: executor.kind, command: executor.command };
  // What a key would be stored under: what the form is proposing, else what config already names,
  // else the conventional variable for this executor. The last is what makes a first run possible
  // without reading the documentation to find out what JaiRA expects the key to be called.
  const credentialName =
    (form["credential"] ?? "").trim() || executor.credential || SUGGESTED_CREDENTIALS[executor.name] || "";

  const save = (): void => {
    try {
      const patch = buildPatch(fields, form, saved);
      setProblem(null);
      onConfigure(target, patch, layer);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <li className={executor.enabled ? undefined : "off"}>
      <div className="exec-head">
        <label className="toggle" title={`turn ${executor.name} ${executor.enabled ? "off" : "on"}`}>
          <input
            type="checkbox"
            checked={executor.enabled}
            disabled={busy}
            onChange={(e) => onToggle(executor.name, e.target.checked, layer)}
          />
          <span className="task-title">{executor.name}</span>
        </label>
        <ProbeBadge probe={probe} probing={probing} />
        <button className="ghost" onClick={() => onProbe(executor.name)} disabled={busy || probing}>
          Test
        </button>
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Done" : "Configure"}
        </button>
      </div>

      <div className="sub">
        {executor.kind}
        {executor.command ? ` · ${executor.command}` : ""}
        {executor.sandbox ? ` · sandbox ${executor.sandbox}` : ""}
      </div>

      {/* §8.2, made visible: a runtime that enforces nothing is refused under a policy that
          can ask a human, and that is worth knowing BEFORE a task fails to start. */}
      {executor.policyEnforcement === "none" ? (
        <div className="sub warn-text">
          enforces no policy — refused when this project&apos;s policy can require approval
        </div>
      ) : null}

      {probe ? <div className="sub">{probe.detail}</div> : null}
      {probe?.version ? <div className="sub">{probe.version}</div> : null}

      {open ? (
        <div className="exec-form">
          {fields.map((field) => (
            <label key={field} className="field">
              <span className="sub">
                {FIELD_LABELS[field]}
                {here[field] === undefined ? "" : " · set here"}
              </span>
              <ExecutorField
                field={field}
                value={form[field] ?? ""}
                placeholder={placeholderFor(field, executor, merged)}
                disabled={busy}
                onChange={(value) => setForm((f) => ({ ...f, [field]: value }))}
              />
            </label>
          ))}
          <div className="sub">
            An empty box removes the setting from {LAYER_LABELS[layer].toLowerCase()}, so it goes
            back to whatever the other layer or the built-in default says.
          </div>
          <div className="pane-actions">
            <button onClick={save} disabled={busy || !dirty}>
              Save
            </button>
            <button className="ghost" onClick={() => { setForm(saved); setProblem(null); }} disabled={!dirty}>
              Revert
            </button>
            {executor.kind === "generic" ? (
              <button
                className="ghost"
                onClick={() => onRemove(executor.name, layer)}
                disabled={busy}
                title="delete this CLI from the layer being edited — a built-in can only be turned off"
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Outside the form, deliberately: a refused credential NAME is raised from the key entry,
          which is reachable with the form closed — a message rendered inside it would be invisible
          exactly when it was needed. */}
      {problem ? <div className="sub warn-text">{problem}</div> : null}

      <div className="credential">
        <span className="sub">
          {executor.credential ? (
            <>
              credential <code>{executor.credential}</code>{" "}
              {probe?.credential
                ? `— found in ${SECRET_SOURCE_LABELS[probe.credential.source]}`
                : probe?.credentialMissing
                  ? "— not found"
                  : ""}
            </>
          ) : (
            <>
              no credential named — saving a key below names <code>{credentialName}</code> in{" "}
              {LAYER_LABELS[layer].toLowerCase()} so it is actually looked up
            </>
          )}
        </span>
        {keyOpen ? (
          <div className="key-entry">
            <input
              type="password"
              value={keyValue}
              placeholder={`the value of ${credentialName} (empty clears it)`}
              onChange={(e) => setKeyValue(e.target.value)}
            />
            <select value={keyTarget} onChange={(e) => setKeyTarget(e.target.value as SecretTarget)}>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {SECRET_TARGET_LABELS[t]}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                try {
                  checkCredentialName(credentialName);
                } catch (e) {
                  setProblem((e as Error).message);
                  return;
                }
                onSaveCredential({
                  executor: { ...target, credential: executor.credential },
                  name: credentialName,
                  value: keyValue,
                  target: keyTarget,
                  layer,
                });
                setKeyValue("");
                setKeyOpen(false);
              }}
              disabled={busy || credentialName.length === 0}
            >
              Save
            </button>
            <button className="ghost" onClick={() => { setKeyOpen(false); setKeyValue(""); }}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="ghost" onClick={() => setKeyOpen(true)} disabled={busy}>
            {executor.credential ? "Set key" : "Add a key"}
          </button>
        )}
      </div>
    </li>
  );
}

/** One field's control. Only `sandbox` and `prompt` are closed sets, and both are spelled as ones. */
function ExecutorField({
  field,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  field: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  if (field === "sandbox" || field === "prompt") {
    const options = field === "sandbox" ? CODEX_SANDBOXES : (["argument", "stdin"] as const);
    return (
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field === "args" || field === "env") {
    return (
      <textarea
        className="code-editor short"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Declare a new non-Claude CLI in the layer being edited (DESIGN §8.1's `generic-cli`). */
function AddExecutor({
  layer,
  busy,
  onAdd,
}: {
  layer: ConfigLayer;
  busy: boolean;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  return (
    <section className="exec-add">
      <h4>Add a CLI executor</h4>
      <div className="sub">
        Any coding-agent binary. It is registered under the name you give it, which is what a state&apos;s
        <code> function</code> then names — and it enforces no policy, so a project whose policy can
        require approval will refuse it.
      </div>
      <label className="field">
        <span className="sub">registry name</span>
        <input value={name} placeholder="opencode" disabled={busy} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="sub">command</span>
        <input value={command} placeholder="opencode" disabled={busy} onChange={(e) => setCommand(e.target.value)} />
      </label>
      <div className="pane-actions">
        <button
          onClick={() => {
            onAdd({ name: name.trim(), command: command.trim() }, layer);
            setName("");
            setCommand("");
          }}
          disabled={busy || name.trim().length === 0 || command.trim().length === 0}
        >
          Add to {LAYER_LABELS[layer].toLowerCase()}
        </button>
      </div>
    </section>
  );
}

/** Whether two sets of form values agree on every field this kind shows. */
function sameForm(fields: string[], a: Record<string, string>, b: Record<string, string>): boolean {
  return fields.every((field) => (a[field] ?? "") === (b[field] ?? ""));
}

/** The layer's own values, as the form's boxes hold them. */
function formValues(fields: string[], block: Record<string, unknown>, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = block[field];
    if (field === "args") out[field] = formatArgs(value);
    else if (field === "env") out[field] = formatEnv(value);
    else if (field === "name") out[field] = typeof value === "string" ? value : name;
    else out[field] = typeof value === "string" ? value : "";
  }
  return out;
}

/** What the field would be if this layer said nothing — the effective value, else the built-in. */
function placeholderFor(field: string, executor: ExecutorInfo, merged: Record<string, unknown>): string {
  const value = merged[field];
  if (field === "args") return formatArgs(value) || "{prompt} — or none, and the prompt is appended after --";
  if (field === "env") return formatEnv(value) || "none";
  if (field === "prompt") return typeof value === "string" ? `inherited: ${value}` : "inherited: argument";
  if (field === "sandbox") {
    return typeof value === "string" ? `inherited: ${value}` : "inherited: workspace-write";
  }
  if (field === "command") return executor.command ?? "";
  if (field === "credential") return SUGGESTED_CREDENTIALS[executor.name] ?? "e.g. OPENAI_API_KEY";
  return "";
}

/**
 * Turn the form into a patch: only what CHANGED, and an emptied box as a removal.
 *
 * Sending the untouched fields too would rewrite inherited values into this layer as literals the
 * moment anything else was saved, which is exactly the freezing the layer model exists to avoid.
 */
function buildPatch(fields: string[], form: Record<string, string>, saved: Record<string, string>): ExecutorPatch {
  const patch: ExecutorPatch = {};
  for (const field of fields) {
    const value = (form[field] ?? "").trim();
    if (value === (saved[field] ?? "").trim()) continue;
    if (value.length === 0) {
      patch[field] = undefined;
      continue;
    }
    if (field === "args") patch[field] = parseArgs(form[field] ?? "");
    else if (field === "env") patch[field] = parseEnv(form[field] ?? "");
    else if (field === "credential") {
      checkCredentialName(value);
      patch[field] = value;
    } else patch[field] = value;
  }
  return patch;
}

