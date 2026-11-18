/**
 * What a configuration layer is CALLED, wherever one is named.
 *
 * Its own module so that a sentence about a layer ("inherited from Shared (all projects)") uses the
 * words Settings' path uses (`settingsScope.ts`), without importing what draws it.
 */
import type { ConfigLayer, ConfigSource } from "@jaira/shared/browser";

export const LAYER_LABELS: Record<ConfigLayer, string> = {
  base: "Shared (all projects)",
  project: "This project",
  machine: "This machine",
  projectMachine: "This project on this machine",
  you: "Just you",
  projectYou: "You in this project",
};

/** The read-only layer under the others — what ships (decision 0006). Not a `ConfigLayer`: its `settings.json` is never written, and editing a value it holds writes that value into the layer being edited. */
export const BUILT_IN_LABEL = "Built in";

/**
 * Where a value comes from, as the middle of a sentence — "instead of sonnet from Shared". Lower-case
 * where it reads as a phrase rather than a name: "this project", "built in".
 */
export const SOURCE_WORDS: Record<ConfigSource, string> = {
  base: "Shared",
  project: "this project",
  machine: "this machine",
  projectMachine: "this project on this machine",
  you: "you",
  projectYou: "you in this project",
  "built in": "built in",
};

/**
 * {@link SOURCE_WORDS} with the path's own names where it has them — "atlas", "build-01", "atlas on
 * build-01", "you in atlas" — since "this machine" read on another machine's settings would name the
 * wrong one.
 */
export function sourceWordsOf(from: ConfigSource, names: { project?: string | undefined; machine?: string | undefined } = {}): string {
  const { project, machine } = names;
  switch (from) {
    case "project":
      return project ?? SOURCE_WORDS.project;
    case "machine":
      return machine ?? SOURCE_WORDS.machine;
    case "projectMachine":
      return project !== undefined && machine !== undefined ? `${project} on ${machine}` : SOURCE_WORDS.projectMachine;
    case "projectYou":
      return project !== undefined ? `you in ${project}` : SOURCE_WORDS.projectYou;
    default:
      return SOURCE_WORDS[from];
  }
}
