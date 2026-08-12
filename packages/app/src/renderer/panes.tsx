/**
 * The Configuration section: the raw `config.json` of a layer, and what the layers add up to.
 *
 * The escape hatch, and deliberately only that. Providers and Executors are the screens for the two
 * things anyone configures day to day; this is where the rest of the document lives — the policy
 * block, the artifact destination, the exec environment — plus the merged view, which is the one
 * place that answers "what is actually in effect here".
 *
 * The executor and provider forms used to live here too and now have their own files: they grew a
 * type hierarchy, an availability model and an LLM-config editor between them, and were several
 * times the size of the pane they were sharing a module with.
 *
 * Rendering only; every write goes through the store and is validated in the main process.
 */
import { useState, type JSX } from "react";
import { CONFIG_JSON, type ConfigLayer, type ConfigView, type FileSource } from "@jaira/shared/browser";
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
  showEffective,
  onShowEffective,
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
  /**
   * Whether the merged result is showing, and where that is remembered.
   *
   * Controlled by the shell, which keeps it with the rest of the window's layout, and local when
   * rendered without one. "What will actually run" is a question some people want answered on every
   * screen and others never — which makes it a preference rather than a per-visit decision.
   */
  showEffective?: boolean;
  onShowEffective?: ((open: boolean) => void) | undefined;
}): JSX.Element {
  const [localEffective, setLocalEffective] = useState(false);
  const showing = showEffective ?? localEffective;
  const show = (next: boolean): void => (onShowEffective ? onShowEffective(next) : setLocalEffective(next));

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
        <button className="ghost" onClick={() => show(!showing)}>
          {showing ? "Hide effective" : "Show effective"}
        </button>
      </div>

      {showing ? (
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
  detail: null,
  sessions: {},
  onLoadSession: () => undefined,
  onLoadSessions: () => undefined,
  sessionHistory: [],
  session: null,
  sessionInstance: null,
  liveTurn: null,
  onShowSession: () => undefined,
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
