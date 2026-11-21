/**
 * The Open dialog's model (decision 0027): its four steps — the project, where it goes, how it gets
 * there, go — and the words each part says, kept apart from the drawing so they can be tested.
 *
 * Opened from `+ Open` it starts at the project; opened to add a workspace to a project it starts at
 * where it goes, the project already chosen (and the machine too, when one was picked in the
 * project's machine menu), everything filled in so Add is all that is left.
 */
import type {
  MachinesView,
  ProjectSummary,
  SetupReadiness,
  SetupStepNeed,
  WorkspaceCreateRequest,
  WorkspaceFinished,
  WorkspacePhase,
  WorkspacePlan,
  WorkspaceSource,
  WorkspaceStepEvent,
} from "@jaira/shared/browser";
import { parseRemoteProjectKey, repositoryIdentity } from "@jaira/shared/browser";
import { dirOf, type ProjectGroup } from "./workspaceGroups";

export type OpenStep = "project" | "where" | "how" | "go";

export const OPEN_STEPS: readonly OpenStep[] = ["project", "where", "how", "go"];

export const OPEN_STEP_LABELS: Record<OpenStep, string> = {
  project: "Project",
  where: "Where it goes",
  how: "How it gets there",
  go: "Go",
};

/** How the dialog is opened. */
export interface OpenFlowStart {
  /** `open`: a project, from `+ Open`. `add`: another workspace of a project the person has. */
  mode: "open" | "add";
  /** The step it opens at. */
  step?: OpenStep;
  /** The project, already chosen. */
  source?: ChosenSource;
  /** The project's name, for the title of Add. */
  name?: string;
  /** Adding: one of the project's workspaces (its group's key), which says which project it is. */
  project?: string;
  /** The machine whose folders Project opens at: a folder already there, added as it is. */
  browse?: string;
  /** The machine it goes to, already chosen. */
  machine?: string;
  /** A workspace being made already (Add's popover, "Details"): the dialog opens at Go, following it. */
  job?: string;
}

/** A project as Open and Add carry it: what is sent, its words, and — a folder's — its repository. */
export type ChosenSource = WorkspaceSource & { label: string; identity?: string };

/**
 * Where a chosen project stands among the person's (the person, 2026-11-21: "if you navigate to a
 * project folder and that folder belongs to the same project (i.e. has a same git remote) then you
 * should be able to add that workspace to the existing project. also, if you add a new project and that
 * project has the same git remote as an existing project, it should be added to the existing project"):
 *
 *   `new`        a project of its own (Open only)
 *   `joins`      the same repository as `group` and not yet one of its workspaces: it becomes one — a
 *                folder where it is, a repository cloned
 *   `workspace`  already one of `group`'s workspaces: Open goes to it, Add copies it to make another
 *   `other`      Add only: not the project being added to, and why
 *
 * The same repository is the identity workspaces are grouped by (decision 0013 §4), so what joins here
 * is what the sidebar shows as one project.
 */
export type SourceStanding =
  | { kind: "new" }
  | { kind: "joins"; group: ProjectGroup }
  | { kind: "workspace"; group: ProjectGroup }
  | { kind: "other"; reason: string };

/** The repository a chosen project is: a forge's from its URL, a folder's as its listing read it. */
export function identityOfSource(source: ChosenSource): string | undefined {
  return source.kind === "forge" ? repositoryIdentity(source.url) : source.identity;
}

/** The person's project a folder on a machine is a workspace of, if it is one. */
export function groupHolding(groups: readonly ProjectGroup[], machine: string, dir: string, selfId: string | undefined): ProjectGroup | undefined {
  const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
  return groups.find((g) =>
    g.members.some((m) => (parseRemoteProjectKey(m.project)?.machineId ?? m.machine?.id ?? selfId) === machine && same(dirOf(m.project), dir)),
  );
}

/** The person's project of a repository: one of their own, never the shared root. */
export function groupOfIdentity(groups: readonly ProjectGroup[], identity: string | undefined): ProjectGroup | undefined {
  return identity === undefined ? undefined : groups.find((g) => g.kind === "user" && g.identity === identity);
}

/** `adding`: the project a workspace is being added to; absent, Open. */
export function standingOf(source: ChosenSource, groups: readonly ProjectGroup[], selfId: string | undefined, adding?: ProjectGroup): SourceStanding {
  const identity = identityOfSource(source);
  const holder = source.kind === "machine" ? groupHolding(groups, source.machine, source.dir, selfId) : undefined;
  if (adding === undefined) {
    if (holder !== undefined) return { kind: "workspace", group: holder };
    const group = groupOfIdentity(groups, identity);
    return group !== undefined ? { kind: "joins", group } : { kind: "new" };
  }
  if (holder !== undefined && holder.key === adding.key) return { kind: "workspace", group: adding };
  if (identity !== undefined && identity === adding.identity) return { kind: "joins", group: adding };
  const name = source.kind === "forge" ? source.project : (source.dir.split(/[\\/]/).filter(Boolean).pop() ?? source.dir);
  if (holder !== undefined) return { kind: "other", reason: `${name} is a workspace of ${holder.label}, not ${adding.label}.` };
  if (adding.identity === undefined) return { kind: "other", reason: `${adding.label} has no git remote, so nothing else can be told to be it: only a copy of one of its workspaces can be added.` };
  if (source.kind === "forge") return { kind: "other", reason: `${name} is another repository: ${adding.label} is ${adding.identity}.` };
  if (identity === undefined) return { kind: "other", reason: `${name} has no git remote, so it isn't ${adding.label} (${adding.identity}).` };
  return { kind: "other", reason: `${name} is ${identity}, not ${adding.label} (${adding.identity}).` };
}

/**
 * What the dialog says of a chosen project's standing, above its foot: nothing for a project of its
 * own, nor — adding, where the title says the project — for the project's own repository or one of its
 * workspaces copied, which is what Add always did. `stays`: the folder opens where it is.
 */
export function standingWords(standing: SourceStanding, source: ChosenSource, adding: boolean, stays: boolean): { text: string; tone: "plain" | "ok" | "bad" } | undefined {
  switch (standing.kind) {
    case "new":
      return undefined;
    case "other":
      return { text: standing.reason, tone: "bad" };
    case "workspace":
      return adding
        ? undefined
        : stays
          ? { text: `Already a workspace of ${standing.group.label}: opening it goes to it.`, tone: "plain" }
          : { text: `A workspace of ${standing.group.label}: the copy becomes another of its workspaces.`, tone: "ok" };
    case "joins":
      if (adding && source.kind === "forge") return undefined;
      return source.kind === "forge"
        ? { text: `${standing.group.label}'s repository: the clone becomes another of its workspaces.`, tone: "ok" }
        : stays
          ? { text: `The same repository as ${standing.group.label}: it becomes another of its workspaces, where it is. Nothing is copied.`, tone: "ok" }
          : { text: `The same repository as ${standing.group.label}: the copy becomes another of its workspaces.`, tone: "ok" };
  }
}

/** A folder's chip in Project's list: the project it is a workspace of, or would join, before what it is. */
export function folderChip(entry: { path: string; project: boolean; git: boolean; identity?: string }, machine: string, groups: readonly ProjectGroup[], selfId: string | undefined): string | undefined {
  const holder = groupHolding(groups, machine, entry.path, selfId);
  // The shared root is named by its whole path, too long for a chip: it is only said to be open.
  if (holder !== undefined) return holder.kind === "user" ? `${holder.label} · open` : "open";
  const same = groupOfIdentity(groups, entry.identity);
  if (same !== undefined) return same.label;
  return entry.project ? "JaiRA project" : entry.git ? "git" : undefined;
}

/** A workspace being made, as the window follows it. */
export interface WorkspaceJob {
  jobId: string;
  /** The machine making it. */
  machine: string;
  /** What it is, for its title: `atlas on build-01`. */
  label: string;
  phase: WorkspacePhase;
  steps: WorkspaceStepEvent[];
  /** What it printed, the end kept. */
  text: string;
  finished?: WorkspaceFinished;
  request: WorkspaceCreateRequest;
}

/** The most of a job's output kept for its log. */
const KEEP = 60_000;

export function appendJobText(job: WorkspaceJob, text: string): WorkspaceJob {
  const all = job.text + text;
  return { ...job, text: all.length > KEEP ? all.slice(all.length - KEEP) : all };
}

/**
 * A job's output as its log draws it (`TermLog`): a block a command — each `$ …` line the service
 * printed starts one — and what was said before the first in a block of its own.
 */
export function jobBlocks(text: string): { command?: string; text: string }[] {
  const blocks: { command?: string; text: string }[] = [{ text: "" }];
  const commandLine = /^\$ (.*?)\r?(?:\n|$)/gm;
  let from = 0;
  for (let match = commandLine.exec(text); match !== null; match = commandLine.exec(text)) {
    blocks[blocks.length - 1]!.text += text.slice(from, match.index);
    blocks.push({ command: match[1]!, text: "" });
    from = commandLine.lastIndex;
    if (match[0].length === 0) commandLine.lastIndex++;
  }
  blocks[blocks.length - 1]!.text += text.slice(from);
  return blocks.filter((block, i) => i > 0 || block.text.length > 0);
}

/** A step event folded into the job: a running step is replaced by how it ended. */
export function withStep(job: WorkspaceJob, step: WorkspaceStepEvent): WorkspaceJob {
  const steps = job.steps.filter((s) => s.index !== step.index);
  return { ...job, steps: [...steps, step].sort((a, b) => a.index - b.index) };
}

/** The words and tone a machine's readiness for a setup is shown in, at the right of its row. */
export function readinessWords(plan: WorkspacePlan | undefined): { text: string; tone: "ok" | "accent" | "warn" | "dim" | "bad" } | undefined {
  if (plan === undefined) return undefined;
  const r: SetupReadiness = plan.setup.readiness;
  if (r === "ready") return { text: "ready", tone: "ok" };
  if (r === "cannot") return { text: "can't", tone: "dim" };
  if (r === "password") return { text: "password", tone: "warn" };
  const first = plan.setup.steps.find((s) => s.status === "installs");
  const tool = first !== undefined ? /^Install (\S+)/.exec(first.label)?.[1] : undefined;
  return { text: tool !== undefined ? `installs ${tool}` : "installs", tone: "accent" };
}

/** A step's status as a few words, for the right of its row in How it gets there. */
export function needWords(need: SetupStepNeed): { text: string; tone: "ok" | "accent" | "warn" | "dim" | "bad" } {
  switch (need.status) {
    case "there":
      return { text: need.detail !== undefined ? `✓ ${need.detail} there` : "✓ already there", tone: "ok" };
    case "installs":
      return { text: "installs first", tone: "accent" };
    case "password":
      return { text: "needs a password there", tone: "warn" };
    case "runs":
      return { text: "runs", tone: "dim" };
    case "brings":
      return { text: "copies", tone: "dim" };
    case "cannot":
      return { text: need.detail !== undefined ? `can't: ${need.detail}` : "can't run there", tone: "bad" };
  }
}

/** How the folder a workspace goes in reads: `/srv/work/atlas-1 · atlas is taken, so atlas-1`. */
export function folderNote(plan: WorkspacePlan): string {
  const name = plan.dir.split(/[\\/]/).filter(Boolean).pop() ?? plan.dir;
  return plan.taken !== undefined ? `${plan.taken} is taken there, so ${name}` : "its projects folder, named after the project";
}

/** One sentence for the whole plan, above How it gets there. */
export function planSentence(source: WorkspaceSource & { label: string }, target: string, plan: WorkspacePlan): string {
  const fetch =
    source.kind === "forge"
      ? `clones ${source.branch ?? "the default branch"} from ${source.host}`
      : `copies what git doesn't ignore from ${source.label}`;
  const bring = plan.bring.length > 0 ? `, brings ${plan.bring.join(", ")}` : "";
  const setup = plan.setup.from === "none" ? "" : plan.setup.steps.length > 0 ? ", then sets it up" : "";
  return `${target} ${fetch}${bring}${setup}.`;
}

/** The machines a workspace can go to, grouped the way Open's column draws them. */
export interface PlaceGroup {
  title: string;
  machines: { id: string; label: string; online: boolean; self: boolean; os?: string }[];
}

export function placeGroupsOf(view: MachinesView | undefined): PlaceGroup[] {
  if (view === undefined) return [];
  const self = { id: view.self.id, label: view.self.label, online: true, self: true, os: view.self.os };
  const groups = new Map<string, PlaceGroup["machines"]>();
  for (const peer of view.machines) {
    const title = peer.os === "mac" ? "Macs" : peer.os === "linux" ? "Linux" : peer.os === "windows" ? "Windows" : "Other";
    const list = groups.get(title) ?? [];
    list.push({ id: peer.id, label: peer.label, online: peer.state === "online", self: false, ...(peer.os !== undefined ? { os: peer.os } : {}) });
    groups.set(title, list);
  }
  return [
    { title: "This machine", machines: [self] },
    ...["Macs", "Linux", "Windows", "Other"].flatMap((title) => {
      const machines = groups.get(title);
      return machines !== undefined && machines.length > 0 ? [{ title, machines: machines.sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label)) }] : [];
    }),
  ];
}

/**
 * Where a new workspace of a project comes from when nothing says otherwise: its remote, cloned — the
 * forge it lives on — else a copy of one of its workspaces, this machine's first.
 */
export function sourceForProject(members: readonly ProjectSummary[], remoteUrl: string | undefined, selfId: string | undefined): (WorkspaceSource & { label: string }) | undefined {
  if (remoteUrl !== undefined) {
    const forge = forgeOfUrl(remoteUrl);
    if (forge !== undefined) return { kind: "forge", host: forge.host, project: forge.project, url: forge.httpsUrl, label: `${forge.host}/${forge.project}` };
  }
  const local = members.find((m) => m.machine?.self === true || parseRemoteProjectKey(m.project) === undefined);
  const chosen = local ?? members[0];
  if (chosen === undefined) return undefined;
  const remote = parseRemoteProjectKey(chosen.project);
  const machine = remote?.machineId ?? chosen.machine?.id ?? selfId;
  if (machine === undefined) return undefined;
  const dir = remote?.dir ?? chosen.project;
  // Said as Project's folder pane says a folder chosen there: the machine, and the folder's name.
  return { kind: "machine", machine, dir, label: `${chosen.machine?.label ?? "this machine"} · ${folderNameOf(dir)}` };
}

/** A folder's last part: `/srv/work/atlas` → `atlas`. */
function folderNameOf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** What a workspace from `source` is called, as the engine names it before its plan says: the repository's or the folder's name. */
export function sourceName(source: WorkspaceSource): string {
  return source.kind === "forge" ? (source.project.split("/").pop() ?? source.project) : folderNameOf(source.dir);
}

/** A machine that holds a workspace of the project: where Bring can take the files git ignores from. */
export interface BringPlace {
  machine: string;
  label: string;
}

/**
 * The workspaces of the project `source` is, as the engine finds them when it brings files: every
 * workspace with the repository's identity — a forge's repository, or the folder's own when it has
 * one. A folder with no remote is a project of one.
 */
export function workspacesOfSource(projects: readonly ProjectSummary[], source: WorkspaceSource, selfId: string | undefined): ProjectSummary[] {
  if (source.kind === "forge") {
    const identity = repositoryIdentity(source.url);
    return identity === undefined ? [] : projects.filter((p) => p.identity === identity);
  }
  const at = projects.find((p) => {
    const remote = parseRemoteProjectKey(p.project);
    return remote !== undefined ? remote.machineId === source.machine && remote.dir === source.dir : (p.machine?.id ?? selfId) === source.machine && p.project === source.dir;
  });
  if (at === undefined) return [];
  return at.identity === undefined ? [at] : projects.filter((p) => p.identity === at.identity);
}

/** The machines a project's workspaces are on, each once, in the order they are listed (this machine's first). */
export function bringPlacesOf(members: readonly ProjectSummary[], selfId: string | undefined): BringPlace[] {
  const out: BringPlace[] = [];
  for (const m of members) {
    const machine = parseRemoteProjectKey(m.project)?.machineId ?? m.machine?.id ?? selfId;
    if (machine === undefined || out.some((p) => p.machine === machine)) continue;
    out.push({ machine, label: m.machine?.label ?? "this machine" });
  }
  return out;
}

/**
 * Where Bring can take the files git ignores from (decision 0027), the one it takes them from first: a
 * copy's own machine (the folder copied); else the target's own workspace of the project, else the
 * first machine that holds one. Empty when nothing holds the project yet. The window sends the one
 * shown as `bringFrom`, so what it says is what happens.
 */
export function bringChoices(source: WorkspaceSource & { label: string }, target: string, places: readonly BringPlace[]): BringPlace[] {
  if (source.kind === "machine") {
    return [{ machine: source.machine, label: source.label.split(" · ")[0]! }, ...places.filter((p) => p.machine !== source.machine)];
  }
  const own = places.find((p) => p.machine === target);
  return own !== undefined ? [own, ...places.filter((p) => p !== own)] : [...places];
}

/** A git remote URL as a forge, a project on it, and the HTTPS URL to clone it by. */
export function forgeOfUrl(url: string): { host: string; project: string; httpsUrl: string } | undefined {
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url);
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url);
  const m = web ?? scp;
  if (m === null) return undefined;
  const host = m[1]!.toLowerCase();
  const project = m[2]!;
  return { host, project, httpsUrl: `https://${host}/${project}.git` };
}

/**
 * Add's popover (decision 0027): another workspace of a project on the machine picked in its machine
 * menu, said in four lines — the project, where it goes, what is brought, what runs then — each line
 * the answer the full form's step would have.
 */
export interface AddLines {
  project: { mark: "github" | "gitlab" | "git" | "machine"; place: string; name: string; branch?: string };
  where: { machine: string; dir: string; note?: string };
  bring: { text: string; patterns: readonly string[] };
  then: { text: string; tone: "ok" | "accent" | "warn" | "dim" | "bad"; count: number };
}

/** `from`: where Bring takes the files from — the first of {@link bringChoices}; absent, nothing holds them. */
export function addLines(source: WorkspaceSource & { label: string }, target: string, plan: WorkspacePlan, from: BringPlace | undefined): AddLines {
  const project: AddLines["project"] =
    source.kind === "forge"
      ? {
          mark: /gitlab/.test(source.host) ? "gitlab" : /github/.test(source.host) ? "github" : "git",
          place: source.host,
          name: source.project,
          branch: source.branch ?? plan.checkout?.branch ?? "default branch",
        }
      : {
          mark: "machine",
          place: source.label.split(" · ")[0]!,
          name: source.dir.split(/[\\/]/).filter(Boolean).pop() ?? source.dir,
          ...(plan.checkout?.branch !== undefined ? { branch: plan.checkout.branch } : {}),
        };
  const name = plan.dir.split(/[\\/]/).filter(Boolean).pop() ?? plan.dir;
  const where: AddLines["where"] = { machine: target, dir: plan.dir, ...(plan.taken !== undefined ? { note: `${plan.taken} is taken there, so ${name}` } : {}) };
  const bring: AddLines["bring"] =
    plan.bring.length === 0
      ? { text: "nothing git ignores", patterns: [] }
      : { text: from !== undefined ? `${plan.bring.join(", ")} from ${from.label}` : `${plan.bring.join(", ")}: no other workspace of it to bring them from`, patterns: plan.bring };
  const steps = plan.setup.steps.filter((s) => s.status !== "brings");
  const ready = readinessWords(plan);
  const then: AddLines["then"] =
    steps.length === 0
      ? { text: "nothing to set up", tone: "dim", count: 0 }
      : {
          text: `${steps
            .slice(0, 2)
            .map((s) => s.label)
            .join(" · ")}${steps.length > 2 ? ` · ${steps.length - 2} more` : ""}`,
          tone: ready?.tone ?? "dim",
          count: steps.length,
        };
  return { project, where, bring, then };
}
