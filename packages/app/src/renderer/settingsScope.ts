/**
 * Settings' path — `Settings › [project] › [machine] › [Just you] › +` (the person's design,
 * 2026-11-17) — which says whose settings a page edits, in place of the old three-way layer switch.
 *
 * Each part is optional, and one left out means "all": no part is Shared (every project, every machine,
 * everyone). The parts keep that order whatever order they were added in; `+` offers what can be added
 * next, and each crumb can be taken out again. The path makes one layer (`layerOfScope`): the project's
 * own, a machine's own, a project on one machine, Just you, or you in one project. A machine with Just
 * you makes none — the machines are the person's own — so once one is in the path the other is not
 * offered.
 *
 * Where a layer is read and written follows from the path too ({@link configTargetOf}): a project's
 * layers on the machine its workspace is on, a paired machine's on that machine (the engine forwards a
 * request naming it), and the rest here.
 *
 * Pure, so the picker and the targets are testable without drawing anything.
 */
import { layerOfScope, parseRemoteProjectKey, SHARED_SESSION, type ConfigLayer, type ProjectSummary } from "@jaira/shared/browser";
import { groupOf, groupProjects, type ProjectGroup } from "./workspaceGroups";

/** A Settings path. Every part optional; absent means "all". */
export interface SettingsPath {
  /** A project, by a key of one of its workspaces (`ProjectSummary.project`); its group is what is meant. */
  project?: string;
  /** A machine, by id — `self` when it is the one this window's engine runs on. */
  machine?: { id: string; self?: true };
  /** Just you. */
  you?: true;
}

/** No part: Shared. Where Settings opens. */
export const SHARED_PATH: SettingsPath = {};

export type SettingsPartKind = "project" | "machine" | "you";

/** The order the parts are always drawn in, whatever order they were added in. */
export const PART_ORDER: readonly SettingsPartKind[] = ["project", "machine", "you"];

/** One crumb of the path, or one choice of `+`. */
export type SettingsPart =
  | { kind: "project"; key: string; label: string; where?: string }
  | { kind: "machine"; id: string; self: boolean; label: string; state?: string }
  | { kind: "you"; label: string };

export const JUST_YOU = "Just you";

/** What the path is read against: the window's projects and the machines this one knows. */
export interface SettingsPathContext {
  /** Every workspace the window lists (`state.projects`). */
  projects: readonly ProjectSummary[];
  /** Clones of one repository as one project (`ui.groupWorkspaces`). */
  grouped: boolean;
  /** This machine, once the machines view is read. */
  self?: { id: string; label: string } | undefined;
  /** The paired machines, by id. */
  machines: ReadonlyArray<{ id: string; label: string; state?: string }>;
}

/** The layer a path makes; a machine with Just you, which makes none, is read as Just you. */
export function layerOfPath(path: SettingsPath): ConfigLayer {
  return layerOfScope({ project: path.project !== undefined, machine: path.machine !== undefined, you: path.you === true }) ?? (path.project !== undefined ? "projectYou" : "you");
}

/** The path a layer names on its own, for a door that names a layer (a project's ⚙): `project` the one the shell stands on. */
export function pathOfLayer(layer: ConfigLayer, now: SettingsPath, project: string | null, self?: { id: string }): SettingsPath {
  const machine = self !== undefined ? { id: self.id, self: true as const } : now.machine;
  const at = project ?? now.project;
  switch (layer) {
    case "base":
      return {};
    case "project":
      return at !== undefined ? { project: at } : now;
    case "machine":
      return machine !== undefined ? { machine } : now;
    case "projectMachine":
      return at !== undefined && machine !== undefined ? { project: at, machine } : now;
    case "you":
      return { you: true };
    case "projectYou":
      return at !== undefined ? { project: at, you: true } : { you: true };
  }
}

const isSelfMember = (member: ProjectSummary): boolean => member.machine === undefined || member.machine.self === true;

/** A workspace's machine: its id, or `self` for this machine's own. */
function machineOf(member: ProjectSummary, self: string | undefined): string | undefined {
  return isSelfMember(member) ? (self ?? "self") : member.machine?.id;
}

/** The project groups a picker lists: checkouts only, never the shared root (which is Shared itself). */
function groupsOf(ctx: SettingsPathContext): ProjectGroup[] {
  return groupProjects(
    ctx.projects.filter((p) => p.kind !== "shared"),
    ctx.grouped,
  );
}

/** The project a path names, as the window groups it. */
export function projectGroupOf(path: SettingsPath, ctx: SettingsPathContext): ProjectGroup | undefined {
  return path.project === undefined ? undefined : groupOf(groupsOf(ctx), path.project);
}

/** The machines a group's workspaces are on. */
function machinesOfGroup(group: ProjectGroup, self: string | undefined): Set<string> {
  return new Set(group.members.flatMap((m) => machineOf(m, self) ?? []));
}

/** Is this the machine the path names? */
function onMachine(member: ProjectSummary, machine: NonNullable<SettingsPath["machine"]>, self: string | undefined): boolean {
  return machine.self === true ? isSelfMember(member) : !isSelfMember(member) && member.machine?.id === machine.id;
}

/** The crumbs of a path, in their order. */
export function crumbsOf(path: SettingsPath, ctx: SettingsPathContext): SettingsPart[] {
  const out: SettingsPart[] = [];
  if (path.project !== undefined) {
    const group = projectGroupOf(path, ctx);
    out.push({ kind: "project", key: path.project, label: group?.label ?? path.project.split(/[\\/]/).filter(Boolean).pop() ?? path.project });
  }
  if (path.machine !== undefined) {
    const machine = path.machine;
    const label = machine.self === true ? (ctx.self?.label ?? "this machine") : (ctx.machines.find((m) => m.id === machine.id)?.label ?? "a paired machine");
    const state = machine.self === true ? undefined : ctx.machines.find((m) => m.id === machine.id)?.state;
    out.push({ kind: "machine", id: machine.id, self: machine.self === true, label, ...(state !== undefined ? { state } : {}) });
  }
  if (path.you === true) out.push({ kind: "you", label: JUST_YOU });
  return out;
}

/**
 * What `+` offers: every kind the path does not have yet, less the kinds that would make no layer —
 * a machine once Just you is in the path, Just you once a machine is. With a project in the path only
 * the machines it has a workspace on are offered, and with a machine only the projects that have one
 * there, so every choice names a layer that exists.
 */
export function addOptionsOf(path: SettingsPath, ctx: SettingsPathContext): SettingsPart[] {
  const self = ctx.self?.id;
  const out: SettingsPart[] = [];
  if (path.project === undefined) {
    for (const group of groupsOf(ctx)) {
      if (path.machine !== undefined && !group.members.some((m) => onMachine(m, path.machine!, self))) continue;
      out.push({ kind: "project", key: group.key, label: group.label, ...(group.where !== undefined ? { where: group.where } : {}) });
    }
  }
  if (path.machine === undefined && path.you !== true) {
    const group = projectGroupOf(path, ctx);
    const on = group !== undefined ? machinesOfGroup(group, self) : undefined;
    const hasSelf = group === undefined || group.members.some(isSelfMember);
    if (ctx.self !== undefined && hasSelf) out.push({ kind: "machine", id: ctx.self.id, self: true, label: ctx.self.label });
    for (const machine of ctx.machines) {
      if (on !== undefined && !on.has(machine.id)) continue;
      out.push({ kind: "machine", id: machine.id, self: false, label: machine.label, ...(machine.state !== undefined ? { state: machine.state } : {}) });
    }
  }
  if (path.you !== true && path.machine === undefined) out.push({ kind: "you", label: JUST_YOU });
  return out;
}

/** The path with a part added, in its place; a part that would make no layer is refused (the path is kept). */
export function withPart(path: SettingsPath, part: SettingsPart): SettingsPath {
  if (part.kind === "project") return { ...path, project: part.key };
  if (part.kind === "machine") return path.you === true ? path : { ...path, machine: { id: part.id, ...(part.self ? { self: true as const } : {}) } };
  return path.machine !== undefined ? path : { ...path, you: true };
}

/** The path with one kind taken out. */
export function withoutPart(path: SettingsPath, kind: SettingsPartKind): SettingsPath {
  const next: SettingsPath = { ...path };
  if (kind === "project") delete next.project;
  else if (kind === "machine") delete next.machine;
  else delete next.you;
  return next;
}

/** The path up to and including one crumb — what clicking an earlier crumb leaves. */
export function trimmedTo(path: SettingsPath, kind: SettingsPartKind | null): SettingsPath {
  if (kind === null) return {};
  const keep = PART_ORDER.slice(0, PART_ORDER.indexOf(kind) + 1);
  let next: SettingsPath = { ...path };
  for (const k of PART_ORDER) if (!keep.includes(k)) next = withoutPart(next, k);
  return next;
}

/**
 * The path with what no longer exists taken out: a project the window closed, a machine that was
 * unpaired, a project with no workspace left on the machine named. The same object when nothing went.
 */
export function prunedPath(path: SettingsPath, ctx: SettingsPathContext): SettingsPath {
  let next = path;
  if (next.project !== undefined && projectGroupOf(next, ctx) === undefined) next = withoutPart(next, "project");
  // Paired machines only once they are known (`self` read with them): before, every one would look unpaired.
  if (ctx.self !== undefined && next.machine !== undefined && next.machine.self !== true && !ctx.machines.some((m) => m.id === next.machine!.id)) next = withoutPart(next, "machine");
  if (next.project !== undefined && next.machine !== undefined) {
    const group = projectGroupOf(next, ctx);
    if (group !== undefined && !group.members.some((m) => onMachine(m, next.machine!, ctx.self?.id))) next = withoutPart(next, "machine");
  }
  return next;
}

/** Where a path's layers are read and written: the request's `project` and, for another machine's, `machine`. */
export interface ConfigTarget {
  project?: string;
  machine?: string;
}

/**
 * The request a path's view is read with — and its writes made with.
 *
 *  - A project: one of its workspaces — the one on the machine the path names, else the one the shell
 *    stands on, else this machine's, else the first — by its key, which the engine forwards to the
 *    workspace's machine when it is another's.
 *  - A paired machine and no project: that machine, for no project ({@link SHARED_SESSION}).
 *  - Otherwise this machine, for the project the shell stands on when it is one of this machine's — so
 *    a change shows in the window (`clearedAbove` takes it out of that project's stronger layers) — or
 *    for none.
 *
 * Undefined when the path names a project with no workspace there: there is nothing to read.
 */
export function configTargetOf(path: SettingsPath, ctx: SettingsPathContext, at: string | null): ConfigTarget | undefined {
  if (path.project !== undefined) {
    const group = projectGroupOf(path, ctx);
    const members = group?.members ?? ctx.projects.filter((p) => p.project === path.project);
    if (members.length === 0) return path.machine === undefined ? { project: path.project } : undefined;
    const machine = path.machine;
    const on = machine !== undefined ? members.filter((m) => onMachine(m, machine, ctx.self?.id)) : members;
    const chosen = on.find((m) => m.project === at) ?? on.find(isSelfMember) ?? on[0];
    return chosen === undefined ? undefined : { project: chosen.project };
  }
  if (path.machine !== undefined && path.machine.self !== true) return { project: SHARED_SESSION, machine: path.machine.id };
  const local = at !== null && at !== SHARED_SESSION && parseRemoteProjectKey(at) === undefined && ctx.projects.some((p) => p.project === at && p.kind !== "shared");
  return { project: local ? at : SHARED_SESSION };
}

/**
 * The project a Settings page's project-bound parts read — its files, permission sets, automations,
 * where its tasks run: the workspace the path's project is read in, else the project the shell stands on.
 */
export function settingsProjectOf(path: SettingsPath, ctx: SettingsPathContext, at: string | null): string | null {
  if (path.project === undefined) return at;
  return configTargetOf(path, ctx, at)?.project ?? path.project;
}

/** Whether two targets read the same view. */
export function sameTarget(a: ConfigTarget | undefined, b: ConfigTarget | undefined): boolean {
  return a !== undefined && b !== undefined && (a.project ?? "") === (b.project ?? "") && (a.machine ?? "") === (b.machine ?? "");
}

/** The machine a path's layers are read on, when it is another one: its id. */
export function remoteMachineOf(path: SettingsPath, ctx: SettingsPathContext, at: string | null): string | undefined {
  const target = configTargetOf(path, ctx, at);
  if (target?.machine !== undefined) return target.machine;
  return parseRemoteProjectKey(target?.project)?.machineId;
}

/**
 * The names a sentence about the path's layers uses — "atlas", "build-01" — where the generic ones
 * ("this project", "this machine") would be wrong or vague.
 */
export function pathNamesOf(path: SettingsPath, ctx: SettingsPathContext): { project?: string; machine?: string } {
  const crumbs = crumbsOf(path, ctx);
  const project = crumbs.find((c) => c.kind === "project")?.label;
  const machine = crumbs.find((c) => c.kind === "machine")?.label;
  return { ...(project !== undefined ? { project } : {}), ...(machine !== undefined ? { machine } : {}) };
}

/**
 * Whether a view can hold this layer: an engine that predates the machine's own layers reads them as
 * nothing and would write them into the wrong file, so Settings does not write them there.
 */
export function viewKnowsLayer(view: { machineFile?: string } | null, layer: ConfigLayer): boolean {
  if (view === null) return false;
  if (layer === "base" || layer === "project" || layer === "you") return true;
  return typeof view.machineFile === "string";
}
