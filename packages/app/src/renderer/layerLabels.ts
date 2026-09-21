/**
 * What a configuration layer is CALLED, wherever one is named.
 *
 * Its own module so that a sentence about a layer ("inherited from Shared (all projects)") uses the
 * words the layer picker uses, without importing the picker and everything it draws.
 */
import type { ConfigLayer } from "@jaira/shared/browser";

export const LAYER_LABELS: Record<ConfigLayer, string> = {
  project: "This project",
  base: "Shared (all projects)",
};

/** The third, read-only layer — what ships (decision 0006). Not a `ConfigLayer`: it has no `settings.json`. */
export const BUILT_IN_LABEL = "Built in";
