/**
 * What the renderer says about the built-in layer (decision 0006) — the third, read-only layer that
 * ships with the app — in the three places it has to say something:
 *
 *  - the state editor's top bar ({@link LayerBar}): a shipped file is "built in · read-only" and is
 *    changed by overriding it; a person's file of an id that also ships "overrides built in" and can
 *    be compared with what ships;
 *  - the Files tree's "Built in" root, which is read-only;
 *  - the Debug pane's rows, which name the layer each self-test state loads from.
 *
 * The DECISIONS are plain functions of plain data ({@link layerBarOf}) and the components only draw
 * them. That is where the logic has to live in a package with no DOM test infrastructure, and it is
 * also the honest split: which buttons a file offers is a fact about the file, not about a bar.
 */
import type { JSX } from "react";

export { LAYER_WORDS, layerActionLabel, layerBarOf, overrideTarget, type LayerBarAction, type LayerBarModel } from "./builtInModel";
import { layerActionLabel, type LayerBarAction, type LayerBarModel } from "./builtInModel";

/** The layer half of the state editor's top bar — the mockup's chip and `link` buttons, drawn from a model. */
export function LayerBar({
  model,
  busy,
  comparing,
  onAction,
}: {
  model: LayerBarModel | null;
  busy: boolean;
  /** True while the body below is the comparison, so the button reads as the way back. */
  comparing: boolean;
  onAction: (id: LayerBarAction["id"]) => void;
}): JSX.Element | null {
  if (model === null) return null;
  return (
    <>
      <span className={model.chip.tone === "warn" ? "chip chip-warn" : "chip"} title={model.chip.title}>
        {model.chip.text}
      </span>
      {model.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="link"
          title={action.title}
          disabled={busy || action.disabled === true}
          aria-pressed={action.id === "compare" ? comparing : undefined}
          onClick={() => onAction(action.id)}
        >
          {layerActionLabel(action, comparing)}
        </button>
      ))}
    </>
  );
}
