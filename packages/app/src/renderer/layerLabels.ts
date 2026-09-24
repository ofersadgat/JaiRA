/**
 * What a configuration layer is CALLED, wherever one is named.
 *
 * Its own module so that a sentence about a layer ("inherited from Shared (all projects)") uses the
 * words the layer picker uses, without importing the picker and everything it draws.
 */
import type { ConfigLayer, ConfigSource } from "@jaira/shared/browser";

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
