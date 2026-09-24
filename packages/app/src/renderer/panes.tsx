/**
 * The layer switch, and the context the configuration surfaces are handed with nothing behind them.
 *
 * The raw `settings.json` pane that lived here went with the Settings page that drew it (2026-09-23):
 * every key of the document has a row on a page now, and the file itself is still one click away in
 * the Files view, where the same editor opens it.
 */
import type { JSX } from "react";
import type { ConfigLayer, WorkflowLayer } from "@jaira/shared/browser";
import type { FileSurfaceContext } from "./fileTypes";
import { BUILT_IN_LABEL, LAYER_LABELS } from "./layerLabels";

export type { ConfigLayer };

const LAYER_TITLES: Record<WorkflowLayer | ConfigLayer, string> = {
  you: "only you, on this machine — personal-settings.json, never shared, and read after every other layer",
  project: "this project only",
  base: "the shared root — changes here affect every project that has not overridden them",
  system: "what ships with JaiRA — read-only; it is changed by overriding it in one of the other two",
};

/**
 * The layer switch, used wherever a write has to name where it lands.
 *
 * The configuration's three writable layers by default — Just you, This project, Shared — in the
 * order they win. A pane that holds something JaiRA SHIPS passes `layers` with `system` in it and
 * gets the read-only segment — "Built in" (decision 0006) — and a caller with no project open leaves
 * `project` out, which is what used to be a sentence in place of the switch.
 */
export function LayerPicker<L extends WorkflowLayer | ConfigLayer = ConfigLayer>({
  value,
  onChange,
  disabled,
  layers,
}: {
  value: L;
  onChange: (layer: L) => void;
  disabled?: boolean;
  /** The segments, in order. Absent ⇒ the three writable layers. */
  layers?: readonly L[];
}): JSX.Element {
  return (
    <div className="layer-picker" role="group" aria-label="Configuration layer">
      {(layers ?? (["you", "project", "base"] as L[])).map((layer) => (
        <button key={layer} className={value === layer ? "layer-on" : "ghost"} onClick={() => onChange(layer)} disabled={disabled} title={LAYER_TITLES[layer]}>
          {layer === "system" ? BUILT_IN_LABEL : LAYER_LABELS[layer as ConfigLayer]}
        </button>
      ))}
    </div>
  );
}

/**
 * The context fields no configuration surface reads.
 *
 * Spelled out rather than cast, so that adding a field to {@link FileSurfaceContext} makes this
 * fail to compile instead of quietly passing `undefined` into a surface that expects it.
 *
 * EXPORTED for the surfaces that mount one at a time with no shell behind them — the file-types
 * preview is the one in the tree — because they need exactly this: every channel present and inert.
 * A second hand-written copy would be a second thing to keep in step with the interface, and it
 * would rot the first time somebody added a field.
 */
export const EMPTY_CONTEXT: FileSurfaceContext = {
  // No shell behind this, so there is nowhere for a definition to be opened.
  onOpenDefinition: undefined,
  revealAt: null,
  state: null,
  config: null,
  tree: null,
  executors: [],
  records: {},
  selected: null,
  conversation: null,
  detail: null,
  sessions: {},
  onLoadSession: () => undefined,
  onLoadSessions: () => undefined,
  shutStates: new Set<string>(),
  onToggleShutState: () => undefined,
  onSetShutStates: () => undefined,
  userEvents: [],
  onDeliverUserEvent: () => undefined,
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
