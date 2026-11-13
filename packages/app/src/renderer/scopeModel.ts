/**
 * What the project panel's title narrows the panel to: a machine, a workspace on it, or neither (the
 * sidebar mockups, round 3 and boards 49–50, 2026-11-12). The title is a breadcrumb, `project ›
 * [machine | workspace]`: the two halves of one pill, each its own menu. A workspace is one clone on ONE
 * machine (the person: "workspaces are specific to their machines"), so choosing a workspace chooses
 * its machine too; choosing a machine alone shows every workspace on it.
 *
 * Kept per project in `JairaUiState.modes`, by the group's key. Pure, so the narrowing and the title's
 * fit are testable without drawing the sidebar.
 */
import { projectNameOf, type JairaUiState, type ProjectSummary, type RunTarget } from "@jaira/shared/browser";
import { dirOf, type ProjectGroup } from "./workspaceGroups";

/** The machine id a workspace this machine holds is filed under. */
export const SELF_MACHINE = "self";

/** What the panel shows: everything (both absent), one machine, or one workspace (and so its machine). */
export interface Scope {
  machine?: string;
  /** A workspace's project key — one of the group's `members`. */
  workspace?: string;
}

export interface ScopeWorkspace {
  project: string;
  /** Its folder's name: `JaiRA`, `JaiRA-2`. */
  label: string;
  /** Where it is on disk, for the menu's second line and the title's tooltip. */
  dir: string;
}

export interface ScopeMachine {
  id: string;
  label: string;
  state: "online" | "offline" | "connecting" | "mismatch";
  self: boolean;
  workspaces: ScopeWorkspace[];
}

const machineKey = (scope: string): string => `sidebar.scope.machine:${scope}`;
const workspaceKey = (scope: string): string => `sidebar.scope.workspace:${scope}`;

/** The machine a workspace is on: its own id, or {@link SELF_MACHINE} for this machine's. */
export function machineOf(p: Pick<ProjectSummary, "machine">): string {
  return p.machine === undefined || p.machine.self === true ? SELF_MACHINE : p.machine.id;
}

/** A group's machines, this machine first, each with its workspaces in the order the group lists them. */
export function machinesOf(group: ProjectGroup): ScopeMachine[] {
  const out: ScopeMachine[] = [];
  for (const m of group.members) {
    const id = machineOf(m);
    let machine = out.find((x) => x.id === id);
    if (machine === undefined) {
      machine = {
        id,
        label: id === SELF_MACHINE ? (m.machine?.label ?? "this machine") : m.machine!.label,
        state: id === SELF_MACHINE ? "online" : m.machine!.state,
        self: id === SELF_MACHINE,
        workspaces: [],
      };
      out.push(machine);
    }
    const dir = dirOf(m.project);
    machine.workspaces.push({ project: m.project, label: projectNameOf(dir), dir });
  }
  return out;
}

/**
 * The scope kept for a group, made to agree with what the group holds now: a workspace that is gone,
 * or a machine with no workspace left, is no narrowing at all; a workspace carries its machine.
 */
export function scopeOf(ui: JairaUiState, group: ProjectGroup): Scope {
  const machines = machinesOf(group);
  const workspace = ui.modes[workspaceKey(group.key)];
  if (workspace !== undefined && workspace !== "") {
    const on = machines.find((m) => m.workspaces.some((w) => w.project === workspace));
    if (on !== undefined) return { machine: on.id, workspace };
  }
  const machine = ui.modes[machineKey(group.key)];
  if (machine !== undefined && machine !== "" && machines.some((m) => m.id === machine)) return { machine };
  return {};
}

/** The `modes` entries that keep `scope` for a group — both always written, an empty string being "all". */
export function scopeModes(groupKey: string, scope: Scope): Array<[string, string]> {
  return [
    [machineKey(groupKey), scope.machine ?? ""],
    [workspaceKey(groupKey), scope.workspace ?? ""],
  ];
}

/** Choosing a machine: its own scope — a workspace on another machine is let go, one on this one kept. */
export function chooseMachine(group: ProjectGroup, scope: Scope, machine: string | undefined): Scope {
  if (machine === undefined) return {};
  const keeps = scope.workspace !== undefined && machinesOf(group).find((m) => m.id === machine)?.workspaces.some((w) => w.project === scope.workspace);
  return keeps === true ? { machine, workspace: scope.workspace! } : { machine };
}

/** Choosing a workspace: it and its machine; none leaves the machine as it was. */
export function chooseWorkspace(group: ProjectGroup, scope: Scope, workspace: string | undefined): Scope {
  if (workspace === undefined) return scope.machine !== undefined ? { machine: scope.machine } : {};
  const on = machinesOf(group).find((m) => m.workspaces.some((w) => w.project === workspace));
  return on === undefined ? scope : { machine: on.id, workspace };
}

/** Whether a row of the given workspace is shown under `scope`. A row that names none is the group's primary's. */
export function inScope(group: ProjectGroup, scope: Scope, project: string | undefined): boolean {
  if (scope.machine === undefined && scope.workspace === undefined) return true;
  const key = project ?? group.key;
  if (scope.workspace !== undefined) return key === scope.workspace;
  const member = group.members.find((m) => m.project === key);
  return member !== undefined && machineOf(member) === scope.machine;
}

/**
 * What each row's workspace is called in a list narrowed to `scope`, where it says something: nothing
 * when only one workspace is in view, and nothing on the first one (the project's own, most rows).
 * Named by its folder on this machine or under a chosen machine, else by its machine (and folder, where
 * that machine has two).
 */
export function placesOf(group: ProjectGroup, scope: Scope): Record<string, string> {
  const machines = machinesOf(group);
  const shown = machines.flatMap((m) => m.workspaces.filter((w) => inScope(group, scope, w.project)).map((w) => ({ m, w })));
  if (shown.length <= 1) return {};
  const out: Record<string, string> = {};
  for (const { m, w } of shown.slice(1)) {
    out[w.project] = scope.machine !== undefined || m.self ? w.label : m.workspaces.length > 1 ? `${m.label}/${w.label}` : m.label;
  }
  return out;
}

/** What {@link placesOf} leaves unnamed — the first workspace in view — as a group's head calls it. */
export function homeOf(group: ProjectGroup, scope: Scope): string {
  for (const m of machinesOf(group)) for (const w of m.workspaces) if (inScope(group, scope, w.project)) return w.label;
  return group.label;
}

/**
 * Where a conversation started under `scope` runs (`RunTarget`): the workspace chosen; else the machine
 * chosen, by the engine's id for it (this machine's own workspaces carry none, so the first of them);
 * else wherever there is room.
 */
export function runTargetOf(group: ProjectGroup, scope: Scope): RunTarget | undefined {
  if (scope.workspace !== undefined) return { project: scope.workspace };
  if (scope.machine === undefined) return undefined;
  const members = group.members.filter((m) => machineOf(m) === scope.machine);
  const id = members.find((m) => m.machine !== undefined)?.machine?.id;
  return id !== undefined ? { machine: id } : members[0] !== undefined ? { project: members[0].project } : undefined;
}

// --- the title ------------------------------------------------------------------------------------

/** How one step of the title is drawn: its name, or only its icon (the project's tile, the machine's screen). */
export type CrumbForm = "name" | "icon";

export interface CrumbFit {
  project: CrumbForm;
  machine: CrumbForm;
  workspace: CrumbForm;
  /** Which step is the title — drawn large, and the last to give up its name (it trims instead). */
  current: "project" | "machine" | "workspace";
}

/** Rough advance widths of the title's two voices, in px per character, and its fixed parts. */
const SMALL = 6.9; // data 11.5
const LARGE = 9.0; // data 15, the current step
const ICON = 28; // a tile or a screen, with its padding
const CARET = 14;
const CHEVRON = 12;
const PILL = 8; // the pill's halves' padding and divider

/**
 * Which steps keep their names in `width` px (the title's own width, the ⚙ and ✕ already taken off).
 *
 * The rule (board 49): where you are is the title, large. Short of room, the steps before it shrink to
 * their icons, oldest first — the project, then the machine. A half that narrows nothing is always an
 * icon with its caret. Only when everything before it is an icon does the current step's name trim.
 */
export function crumbFit(names: { project: string; machine?: string; workspace?: string }, width: number): CrumbFit {
  const current: CrumbFit["current"] = names.workspace !== undefined ? "workspace" : names.machine !== undefined ? "machine" : "project";
  const fit: CrumbFit = { project: "name", machine: names.machine !== undefined ? "name" : "icon", workspace: names.workspace !== undefined ? "name" : "icon", current };
  const text = (step: "project" | "machine" | "workspace"): number => {
    const label = names[step] ?? "";
    const per = step === current ? LARGE : SMALL;
    return fit[step] === "icon" ? ICON + (step === "project" ? 0 : CARET) : label.length * per + (step === "project" ? 10 : ICON + CARET);
  };
  const total = (): number => text("project") + CHEVRON + PILL + text("machine") + text("workspace");
  for (const step of ["project", "machine"] as const) {
    if (total() <= width) break;
    if (step !== current && fit[step] === "name") fit[step] = "icon";
  }
  return fit;
}
