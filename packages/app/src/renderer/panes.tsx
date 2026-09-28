/**
 * The layer switch, and the context the configuration surfaces are handed with nothing behind them.
 *
 * The raw `settings.json` pane that lived here went with the Settings page that drew it (2026-09-23):
 * every key of the document has a row on a page now, and the file itself is still one click away in
 * the Files view, where the same editor opens it.
 */
import type { JSX } from "react";
import type { ConfigLayer, WorkflowLayer } from "@jaira/shared/browser";
import { layerSegmentOf } from "./layerLabels";

export type { ConfigLayer };

/**
 * The layer switch, used wherever a write has to name where it lands.
 *
 * The configuration's three writable layers by default — Just you, This project, Shared — in the
 * order they win. A pane that holds something JaiRA SHIPS passes `layers` with `system` in it and
 * gets the read-only segment — "Built in" (decision 0006) — and a caller with no project open leaves
 * `project` out, which is what used to be a sentence in place of the switch. `projectName` puts the
 * project's own name on its segment instead of "This project", so the switch says WHOSE settings a
 * write changes.
 */
export function LayerPicker<L extends WorkflowLayer | ConfigLayer = ConfigLayer>({
  value,
  onChange,
  disabled,
  layers,
  projectName,
}: {
  value: L;
  onChange: (layer: L) => void;
  disabled?: boolean;
  /** The segments, in order. Absent ⇒ the three writable layers. */
  layers?: readonly L[];
  /** The open project's name, for its segment. Absent ⇒ "This project". */
  projectName?: string | undefined;
}): JSX.Element {
  return (
    <div className="layer-picker" role="group" aria-label="Configuration layer">
      {(layers ?? (["you", "project", "base"] as L[])).map((layer) => (
        <button key={layer} className={value === layer ? "layer-on" : "ghost"} onClick={() => onChange(layer)} disabled={disabled} title={layerSegmentOf(layer, projectName).title}>
          {layerSegmentOf(layer, projectName).label}
        </button>
      ))}
    </div>
  );
}

// The context no configuration surface reads — `emptySurfaceContext.ts`, shared with the universal
// copy (decision 0015).
export { EMPTY_CONTEXT } from "./emptySurfaceContext";
