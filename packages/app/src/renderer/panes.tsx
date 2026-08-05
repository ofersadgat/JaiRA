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
import { useState, type JSX } from "react";
import {
  CONFIG_JSON,
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type FileSource,
  type ProbeResult,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import type { Drafts, SetDraft } from "./drafts";
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
  busy,
  layer,
  onProbe,
  onToggle,
  onSaveSecret,
}: {
  executors: ExecutorInfo[];
  probes: Record<string, ProbeResult>;
  probing: string[];
  secrets: SecretCapabilities;
  busy: boolean;
  /**
   * The layer an enable/disable is written to.
   *
   * Passed in rather than held here, now that the Settings view owns the layer for every section
   * under it. Two controls for one question is how the config editor and this pane ended up able to
   * be pointed at different layers at the same time.
   */
  layer: ConfigLayer;
  onProbe: (name?: string) => void;
  onToggle: (name: string, enabled: boolean, layer: ConfigLayer) => void;
  onSaveSecret: (name: string, value: string, target: SecretTarget) => void;
}): JSX.Element {
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [keyTarget, setKeyTarget] = useState<SecretTarget>(secrets.keychain ? "keychain" : "base-env-local");

  // The built-in adapters are always listed, project or not, so an empty list means the read itself
  // failed rather than that nothing is configured.
  if (executors.length === 0) {
    return <p className="empty">No executors — the app could not read the configuration.</p>;
  }

  const targets: SecretTarget[] = [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    "project-env-local",
    "base-env-local",
  ];

  return (
    <div className="pane">
      <div className="pane-actions">
        <button onClick={() => onProbe()} disabled={busy || probing.length > 0}>
          Test all
        </button>
      </div>
      <div className="sub">enabling and disabling writes to: {LAYER_LABELS[layer].toLowerCase()}</div>
      {!secrets.keychain && secrets.keychainReason ? (
        <div className="notice">{secrets.keychainReason}</div>
      ) : null}

      <ul className="executors">
        {executors.map((executor) => {
          const probe = probes[executor.name];
          const isProbing = probing.includes(executor.name);
          return (
            <li key={executor.name} className={executor.enabled ? undefined : "off"}>
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
                <ProbeBadge probe={probe} probing={isProbing} />
                <button className="ghost" onClick={() => onProbe(executor.name)} disabled={busy || isProbing}>
                  Test
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

              {executor.credential ? (
                <div className="credential">
                  <span className="sub">
                    credential <code>{executor.credential}</code>{" "}
                    {probe?.credential
                      ? `— found in ${SECRET_SOURCE_LABELS[probe.credential.source]}`
                      : probe?.credentialMissing
                        ? "— not found"
                        : ""}
                  </span>
                  {keyFor === executor.credential ? (
                    <div className="key-entry">
                      <input
                        type="password"
                        value={keyValue}
                        placeholder="paste the key (empty clears it)"
                        onChange={(e) => setKeyValue(e.target.value)}
                      />
                      <select value={keyTarget} onChange={(e) => setKeyTarget(e.target.value as SecretTarget)}>
                        {targets.map((target) => (
                          <option key={target} value={target}>
                            {SECRET_TARGET_LABELS[target]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          onSaveSecret(executor.credential!, keyValue, keyTarget);
                          setKeyValue("");
                          setKeyFor(null);
                        }}
                        disabled={busy}
                      >
                        Save
                      </button>
                      <button className="ghost" onClick={() => { setKeyFor(null); setKeyValue(""); }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="ghost" onClick={() => setKeyFor(executor.credential ?? null)}>
                      Set key
                    </button>
                  )}
                </div>
              ) : (
                <div className="sub">
                  no credential named — add <code>credential</code> to this executor in Settings to
                  have JaiRA look one up
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

