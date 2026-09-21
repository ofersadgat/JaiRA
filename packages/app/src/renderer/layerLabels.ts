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
