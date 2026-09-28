/**
 * What a configuration layer is CALLED, wherever one is named.
 *
 * Its own module so that a sentence about a layer ("inherited from Shared (all projects)") uses the
 * words the layer picker uses, without importing the picker and everything it draws.
 */
import type { ConfigLayer, ConfigSource, WorkflowLayer } from "@jaira/shared/browser";

export const LAYER_LABELS: Record<ConfigLayer, string> = {
  you: "Just you",
  project: "This project",
  base: "Shared (all projects)",
};

/** The read-only layer under the others — what ships (decision 0006). Not a `ConfigLayer`: its `settings.json` is never written, and editing a value it holds writes that value into the layer being edited. */
export const BUILT_IN_LABEL = "Built in";

/**
 * Where a value comes from, as the middle of a sentence — "instead of sonnet from Shared". Lower-case
 * where it reads as a phrase rather than a name: "this project", "built in".
 */
export const SOURCE_WORDS: Record<ConfigSource, string> = {
  you: "you",
  project: "this project",
  base: "Shared",
  "built in": "built in",
};

/** What each of the layer switch's segments says on hover. */
export const LAYER_TITLES: Record<WorkflowLayer | ConfigLayer, string> = {
  you: "only you, on this machine — personal-settings.json, never shared, and read after every other layer",
  project: "this project only",
  base: "the shared root — changes here affect every project that has not overridden them",
  system: "what ships with JaiRA — read-only; it is changed by overriding it in one of the other two",
};

/**
 * A segment of the layer switch (`LayerPicker`): its words — the project's own name on its segment
 * when there is one, so the switch says WHOSE settings a write changes — and its tooltip.
 */
export function layerSegmentOf(layer: WorkflowLayer | ConfigLayer, projectName?: string): { label: string; title: string } {
  return {
    label: layer === "system" ? BUILT_IN_LABEL : layer === "project" && projectName !== undefined ? projectName : LAYER_LABELS[layer as ConfigLayer],
    title: layer === "project" && projectName !== undefined ? `${projectName} only` : LAYER_TITLES[layer],
  };
}
