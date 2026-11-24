/**
 * Settings → Tools → Place sets (decision 0034): the named groups of places the permission board draws
 * as one chip — what ships (`BUILTIN_PLACE_SETS`), the machine's projects folder as `root`, and the
 * settings' own (`permissions.placeSets.<name>`), which add a set or replace one by its name. Nothing
 * here draws.
 */
import { BUILTIN_PLACE_SETS, ROOT_PLACE_SET, placeSetsOf, type PathWrite } from "@jaira/shared/browser";
import { placeSetsSettingOf } from "./permissionBoardHost";

export interface PlaceSetRow {
  id: string;
  label: string;
  places: string[];
  /** Ships with JaiRA (or is the projects folder): its places can be replaced, and Reset puts them back. */
  builtin: boolean;
  /** The page's layer says it. */
  stated: boolean;
  /** Read from this machine: not a setting. */
  fixed: boolean;
}

/** The rows: every set, what ships first, in the order it ships, then the settings' own by name. */
export function placeSetRowsOf(effective: unknown, layerDoc: unknown, projectsFolder?: string): PlaceSetRow[] {
  const settled = placeSetsSettingOf(effective);
  const stated = placeSetsSettingOf(layerDoc);
  const sets = placeSetsOf(settled, projectsFolder);
  const order = [...BUILTIN_PLACE_SETS.map((set) => set.id), ROOT_PLACE_SET];
  return sets
    .map((set) => ({ id: set.id, label: set.label, places: [...set.places], builtin: order.includes(set.id), stated: Object.hasOwn(stated, set.id), fixed: set.id === ROOT_PLACE_SET && !Object.hasOwn(settled, set.id) }))
    .sort((a, b) => {
      const at = (row: PlaceSetRow): number => (order.includes(row.id) ? order.indexOf(row.id) : order.length);
      return at(a) - at(b) || a.id.localeCompare(b.id);
    });
}

/** What a person types for a set's places: one per comma or line, blanks dropped. */
export function placesOfText(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((each) => each.trim())
    .filter((each) => each !== "");
}

/** The write that keeps a set in the page's layer — or, `undefined`, takes the layer's word away. */
export function placeSetWriteOf(name: string, places: readonly string[] | undefined): PathWrite {
  return [["permissions", "placeSets", name.trim()], places === undefined ? undefined : [...places]];
}

/** Why a new set's name cannot be used, or undefined when it can. */
export function placeSetNameProblem(name: string, rows: readonly PlaceSetRow[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "a set needs a name";
  if (/[.\s]/.test(trimmed)) return "no spaces or dots in a set's name — `api-keys`, `build-output`";
  if (rows.some((row) => row.id === trimmed)) return `there is a set named ${trimmed} already`;
  return undefined;
}
