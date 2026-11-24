/**
 * Place sets (decision 0034): named groups of places the permission board draws as ONE chip —
 * "credentials" for the eight patterns secrets live at, "project files" for `$PROJECT`. A set is the
 * board's way of saying many places at once; the lines still hold each place (decision 0023), and a chip
 * for a set stands for all of them: moving it moves every one.
 *
 * What ships is {@link BUILTIN_PLACE_SETS}; the settings' `permissions.placeSets.<id>` (a list of places)
 * adds a set or replaces one by its id, in any settings layer. The machine's projects folder — where its
 * workspaces and their worktrees go (Settings → Machines) — is the `root` set, handed in by whoever knows
 * it ({@link placeSetsOf}).
 */

export interface PlaceSet {
  id: string;
  label: string;
  /** The places it stands for, as a line writes them. */
  places: readonly string[];
  /** It came from the settings. */
  custom?: boolean;
}

/** The place sets JaiRA ships, in the order the board looks for them. */
export const BUILTIN_PLACE_SETS: readonly PlaceSet[] = [
  { id: "credentials", label: "credentials", places: ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "~/.ssh", "~/.aws", "~/.claude/.credentials.json", "~/.codex/auth.json"] },
  { id: "jaira-settings", label: "JaiRA settings", places: ["$PROJECT/.jaira", "$PROJECT/.jaira/**/*", "$WORKTREE/.jaira", "$WORKTREE/.jaira/**/*"] },
  { id: "machine-key", label: "machine key", places: ["~/.jaira/system/machine.key"] },
  { id: "project", label: "project files", places: ["$PROJECT"] },
  { id: "worktree", label: "worktree files", places: ["$WORKTREE"] },
  { id: "agent-workspace", label: "agent workspace", places: ["$AGENT_WORKSPACE"] },
  { id: "temp", label: "temporary files", places: ["$TEMP"] },
];

/** The id of the set of the machine's projects folder. */
export const ROOT_PLACE_SET = "root";

/**
 * The place sets that hold here: what ships, the machine's projects folder as `root` when it is known,
 * and the settings' own (`permissions.placeSets`), which replace a set of the same id.
 */
export function placeSetsOf(settings: Readonly<Record<string, readonly string[]>> = {}, projectsFolder?: string): PlaceSet[] {
  const sets: PlaceSet[] = [...BUILTIN_PLACE_SETS];
  if (projectsFolder !== undefined && projectsFolder.trim() !== "") sets.push({ id: ROOT_PLACE_SET, label: "root folder", places: [projectsFolder.trim()] });
  for (const [id, places] of Object.entries(settings)) {
    const set = { id, label: id, places: [...places], custom: true };
    const at = sets.findIndex((each) => each.id === id);
    if (at >= 0) sets[at] = { ...set, label: sets[at]!.label };
    else sets.push(set);
  }
  // The bigger sets first: a place in two is said by the one that says more.
  return sets.filter((set) => set.places.length > 0).sort((a, b) => b.places.length - a.places.length);
}
