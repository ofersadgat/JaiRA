/**
 * The Disable / Enable items of a state (decision 0021), in the words the layer of the file that
 * decides calls for — one builder for the file tree's menu and a board column's, so the two never
 * disagree about where a switch is written.
 *
 * A project's own file is switched in place: Disable, Enable. A file the project only inherits —
 * Shared's, or one that ships — is switched either for this project (a file here that follows it)
 * or for every project (Shared's own file, or one there that follows what ships). Enable undoes
 * whichever wrote it; what the service does with each is `AppService.setWorkflowDisabled`.
 */
import type { WorkflowLayer, WritableLayer } from "@jaira/shared/browser";
import type { MenuItem } from "./menuTypes";

/** What the items are about. */
export interface SwitchTarget {
  stateId: string;
  /** The layer of the file that wins for the state — the one written into, or followed. */
  layer: WorkflowLayer;
  /** The state that switches this one off now — itself, or one above it — when one does. */
  disabledBy?: string | undefined;
  /** A project is open, so "in this project" has somewhere to write. False on the shared root alone. */
  hasProject: boolean;
}

/** Write the switch: `disabled` in `layer`. */
export type SetSwitch = (layer: WritableLayer, disabled: boolean) => void;

/**
 * The items, empty when there is nothing to switch here. A state switched off by one ABOVE it has
 * only that to say: it comes back on with that one, not with a field of its own.
 */
export function switchItems(target: SwitchTarget, set: SetSwitch): MenuItem[] {
  const { stateId, layer, disabledBy, hasProject } = target;
  if (disabledBy !== undefined && disabledBy !== stateId) {
    return [{ label: "Enable", disabled: true, note: `'${disabledBy}' is disabled`, onSelect: () => undefined }];
  }
  const off = disabledBy === stateId;
  const verb = off ? "Enable" : "Disable";
  // A layer's own file is switched where it lies — the project's, or one of the settings' newer layers'.
  if (layer === "project" || layer === "projectMachine" || layer === "projectYou" || layer === "you" || layer === "machine") {
    return [{ label: verb, note: stateId, onSelect: () => set(layer, !off) }];
  }
  // What ships is never switched off where it lies: its switch is a file in a layer above it.
  if (layer === "system" && off) return [];
  if (!hasProject) return [{ label: verb, note: "in Shared, for every project", onSelect: () => set("base", !off) }];
  return [
    { label: `${verb} in this project`, onSelect: () => set("project", !off) },
    { label: `${verb} in every project`, note: "Shared", onSelect: () => set("base", !off) },
  ];
}

/** What a tree row's `disabled` chip says on hover: where the field that switched it off is written. */
export function disabledChipTitle(layer: WorkflowLayer): string {
  switch (layer) {
    case "base":
      return "Disabled in Shared, for every project";
    case "machine":
      return "Disabled on this machine, for every project on it";
    case "you":
      return "Disabled for just you, in every project of yours";
    case "projectMachine":
      return "Disabled in this project on this machine";
    case "projectYou":
      return "Disabled for you in this project";
    default:
      return "Disabled in this project";
  }
}
