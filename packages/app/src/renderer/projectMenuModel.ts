/**
 * A project's own menu (the person, 2026-11-20: "if you right click on a project, you should have a menu
 * with project actions. e.g. delete, settings, anything else you can think of"): what is done TO the
 * project, on a right-click of its tile in the rail or of its name at the head of the panel — and held,
 * on a touch screen. Pure, so which verbs a project offers is testable without drawing the sidebar.
 *
 * Delete takes the project out of JaiRA and nothing more (ruled 2026-11-20, "Remove only"): each
 * workspace closed and forgotten on its machine, every folder left on disk.
 */
import type { ProjectSummary } from "@jaira/shared/browser";
import type { AskSpec, MenuItem } from "./menuTypes";
import { SELF_MACHINE, machineOf } from "./scopeModel";
import { dirOf, type ProjectGroup } from "./workspaceGroups";

/** What the menu can do; a verb left out is a row not drawn. */
export interface ProjectMenuVerbs {
  newChat: () => void;
  /** Absent where the project has no source to make another workspace from (the shared root). */
  addWorkspace?: (() => void) | undefined;
  settings: () => void;
  reveal?: ((dir: string) => void) | undefined;
  copy: (text: string) => void;
  markSeen?: (() => void) | undefined;
  /** Asks first (`removeAsk`). Absent for the shared root, which every window stands on. */
  remove?: (() => void) | undefined;
}

/**
 * The workspace a project-wide verb that needs ONE folder means (Reveal, Copy path): the one the
 * window stands on when it is the project's, else this machine's first, else the project's first.
 */
export function folderOf(group: ProjectGroup, at: string | null): ProjectSummary | undefined {
  return group.members.find((m) => m.project === at) ?? group.members.find((m) => machineOf(m) === SELF_MACHINE) ?? group.members[0];
}

export function projectMenuItems(group: ProjectGroup, at: string | null, verbs: ProjectMenuVerbs): MenuItem[] {
  const folder = folderOf(group, at);
  const local = folder !== undefined && machineOf(folder) === SELF_MACHINE;
  const several = group.members.length > 1;
  const items: MenuItem[] = [
    { label: "New conversation", onSelect: verbs.newChat },
    ...(verbs.addWorkspace !== undefined ? [{ label: "Add a workspace…", onSelect: verbs.addWorkspace }] : []),
    { label: "Settings", separator: true, onSelect: verbs.settings },
    ...(verbs.markSeen !== undefined ? [{ label: "Mark all as seen", onSelect: verbs.markSeen }] : []),
  ];
  if (folder !== undefined) {
    const dir = dirOf(folder.project);
    const which = several ? folder.label : undefined;
    if (local && verbs.reveal !== undefined) items.push({ label: "Reveal in file explorer", separator: true, ...(which !== undefined ? { note: which } : {}), onSelect: () => verbs.reveal!(dir) });
    items.push({ label: "Copy path", ...(local && verbs.reveal !== undefined ? {} : { separator: true }), ...(which !== undefined ? { note: which } : {}), onSelect: () => verbs.copy(dir) });
  }
  if (verbs.remove !== undefined && group.kind === "user") items.push({ label: "Delete…", separator: true, danger: true, onSelect: verbs.remove });
  return items;
}

/** The question Delete asks: what leaves JaiRA, and that nothing leaves the disk. */
export function removeAsk(group: ProjectGroup, onConfirm: () => void): AskSpec {
  const n = group.members.length;
  const where = n === 1 ? "Its workspace is" : `Its ${n} workspaces are`;
  const elsewhere = group.members.some((m) => machineOf(m) !== SELF_MACHINE) ? ", on every machine that holds one" : "";
  return {
    title: `Delete ${group.label}?`,
    note: `${where} closed and taken out of JaiRA${elsewhere}. The folders and their history stay on disk: open a folder again to bring it back. Work running in it stops as a quit stops it, and what waits on you is asked again then.`,
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => onConfirm(),
  };
}
