/**
 * A session's shell environment, in words — what the bar under the composer says, what the list it opens
 * offers, and what the chip beside the title and the start page's sentence repeat (decision 0013 §5,
 * ruled 2026-10-02). Pure: `environmentStore.ts` fetches the view, `EnvironmentBar.tsx` draws this.
 *
 *   the bar      left: the machine's icon, then `machine / workspace`; right: the checkout — its branch,
 *                what is unpushed, the lines changed since the last commit, its merge request. The right
 *                is empty until a workspace is decided.
 *   the list     Automatic, then each machine (its first workspace with room) and each of its workspaces
 *                (that one). A machine that cannot be reached is listed and cannot be chosen.
 *
 * A choice that has no room is still the choice: the conversation waits for it.
 */
import type { EnvironmentMachine, EnvironmentView, EnvironmentWorkspace, PlacementNote, QueuedPlacement, RunTarget, WorkspaceGit } from "@jaira/shared/browser";
import type { MachineDot, MachineMark, MachineShape } from "./machineIcons";

/** A machine's icon: its shape, the mark of what it runs, and its dot. */
export interface MachineFace {
  shape: MachineShape;
  mark?: MachineMark;
  dot?: MachineDot;
}

/** Nothing decided yet: the dashed screen, with no mark and no dot. */
export const AUTO_FACE: MachineFace = { shape: "auto" };

/** A machine that answers is connected; one being reached is connecting; anything else cannot be used. */
export function dotOf(state: EnvironmentMachine["state"]): MachineDot {
  return state === "online" ? "on" : state === "connecting" ? "slow" : "off";
}

export function faceOf(machine: Pick<EnvironmentMachine, "form" | "os" | "state">): MachineFace {
  return { shape: machine.form, mark: machine.os, dot: dotOf(machine.state) };
}

/** What a machine is called: the one the engine is on is "this machine". */
export function machineNameOf(machine: Pick<EnvironmentMachine, "label" | "self">): string {
  return machine.self ? "this machine" : machine.label;
}

const OS_WORDS: Record<EnvironmentMachine["os"], string> = { windows: "Windows", mac: "Mac", linux: "Linux" };

/** What a machine is, in two words: "Windows desktop", "Mac mini", "Linux server". */
export function machineKindOf(machine: Pick<EnvironmentMachine, "form" | "os">): string {
  return `${OS_WORDS[machine.os]} ${machine.form}`;
}

/** Why a machine cannot be chosen, said on its line in place of its load. */
export function machineNoteOf(machine: Pick<EnvironmentMachine, "state">): { text: string; tone: "warn" | "bad" } | undefined {
  if (machine.state === "online") return undefined;
  if (machine.state === "connecting") return { text: "connecting…", tone: "warn" };
  return { text: machine.state === "mismatch" ? "another version" : "offline", tone: "bad" };
}

/** A meter on a machine's line: how much of it is in use, and whether that is too much to place on. */
export interface Meter {
  label: string;
  /** 0–100. */
  pct: number;
  text: string;
  /** Past where placement passes a machine over: 90% of the processor, 90% of the memory. */
  high: boolean;
}

export function metersOf(machine: Pick<EnvironmentMachine, "cpu" | "memoryFree" | "memoryTotal">): Meter[] {
  const out: Meter[] = [];
  const meter = (label: string, share: number): Meter => {
    const pct = Math.max(0, Math.min(100, Math.round(share * 100)));
    return { label, pct, text: `${pct}%`, high: pct >= 90 };
  };
  if (machine.cpu !== undefined) out.push(meter("CPU", machine.cpu));
  if (machine.memoryFree !== undefined && machine.memoryTotal !== undefined && machine.memoryTotal > 0) out.push(meter("Memory", 1 - machine.memoryFree / machine.memoryTotal));
  return out;
}

/** A checkout's facts as they are written, in the bar and in the list alike. */
export interface GitFacts {
  branch?: string;
  /** "↑2": commits its upstream does not have. */
  ahead?: string;
  /** "+128" and "−34": lines changed since the last commit. */
  added?: string;
  removed?: string;
  request?: { provider: "gitlab" | "github"; label: string; state: string; tone: "ok" | "accent" | "bad" | "dim"; url: string };
}

export function gitFactsOf(git: WorkspaceGit | undefined): GitFacts | undefined {
  if (git === undefined) return undefined;
  const out: GitFacts = {};
  if (git.branch !== undefined) out.branch = git.branch;
  if ((git.ahead ?? 0) > 0) out.ahead = `↑${git.ahead}`;
  if ((git.added ?? 0) + (git.removed ?? 0) > 0) {
    out.added = `+${git.added ?? 0}`;
    out.removed = `−${git.removed ?? 0}`;
  }
  const mr = git.mergeRequest;
  if (mr !== undefined) {
    const state = mr.draft === true && mr.state === "open" ? "draft" : mr.state;
    out.request = {
      provider: mr.provider,
      label: `${mr.provider === "gitlab" ? "!" : "#"}${mr.number}`,
      state,
      tone: state === "open" ? "ok" : state === "merged" ? "accent" : state === "closed" ? "bad" : "dim",
      url: mr.url,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What was chosen, found in the view. Something named that the view does not hold is no choice. */
export type Choice =
  | { kind: "auto" }
  | { kind: "machine"; machine: EnvironmentMachine }
  | { kind: "workspace"; machine: EnvironmentMachine; workspace: EnvironmentWorkspace };

export function choiceOf(view: EnvironmentView | undefined, target: RunTarget | undefined): Choice {
  if (view === undefined || target === undefined) return { kind: "auto" };
  if (target.project !== undefined) {
    for (const machine of view.machines) {
      const workspace = machine.workspaces.find((w) => w.project === target.project);
      if (workspace !== undefined) return { kind: "workspace", machine, workspace };
    }
    return { kind: "auto" };
  }
  const machine = target.machine !== undefined ? view.machines.find((m) => m.id === target.machine) : undefined;
  return machine !== undefined ? { kind: "machine", machine } : { kind: "auto" };
}

/** Where a workspace is, by its project key. */
export function workspaceIn(view: EnvironmentView | undefined, project: string | undefined): { machine: EnvironmentMachine; workspace: EnvironmentWorkspace } | undefined {
  if (view === undefined || project === undefined) return undefined;
  for (const machine of view.machines) {
    const workspace = machine.workspaces.find((w) => w.project === project || w.dir === project);
    if (workspace !== undefined) return { machine, workspace };
  }
  return undefined;
}

/** How many workspaces a view holds. One is no choice: nothing is placed, and the bar offers no list. */
export function workspaceCount(view: EnvironmentView | undefined): number {
  return (view?.machines ?? []).reduce((n, m) => n + m.workspaces.length, 0);
}

/** What a conversation is, for the bar: not started, being placed, waiting, or running somewhere. */
export type EnvironmentStage =
  | { kind: "choosing"; target?: RunTarget | undefined }
  | { kind: "placing"; queued: QueuedPlacement }
  | { kind: "waiting"; queued: QueuedPlacement }
  | { kind: "running"; project: string; placed?: PlacementNote | undefined };

/** The bar: the machine's icon and words on the left, the checkout on the right, and whether it opens the list. */
export interface BarFacts {
  face: MachineFace;
  /** The machine's name, or "automatic". */
  machine: string;
  /** After the slash: the workspace's folder, or what is happening instead of one. */
  workspace?: { text: string; icon: "folder" | "clock" | "spinner"; dim?: boolean };
  git?: GitFacts;
  /** The list may be opened: there is more than one workspace, and nothing has started. */
  open: boolean;
  /** For the icon's tooltip and a reader: everything, in a sentence. */
  title: string;
  /** The same, short enough for the chip beside the title. */
  chip: string;
}

const waitingWords = (choice: Choice): string =>
  choice.kind === "workspace" ? `waiting for room in ${choice.workspace.label}` : choice.kind === "machine" ? `waiting for room on ${machineNameOf(choice.machine)}` : "waiting for a workspace with room";

export function barFactsOf(view: EnvironmentView | undefined, stage: EnvironmentStage): BarFacts | undefined {
  if (view === undefined || view.machines.length === 0) return undefined;
  const many = workspaceCount(view) > 1;
  if (stage.kind === "running") {
    const at = workspaceIn(view, stage.project);
    // Running somewhere the view no longer holds (a workspace closed since): the note still says where.
    if (at === undefined) {
      if (stage.placed === undefined) return undefined;
      const label = folderOf(stage.placed.on.dir);
      return { face: { shape: "desktop" }, machine: stage.placed.on.label, workspace: { text: label, icon: "folder" }, open: false, title: `${stage.placed.on.label} / ${label}`, chip: `${stage.placed.on.label} / ${label}` };
    }
    const git = gitFactsOf(at.workspace.git);
    const name = machineNameOf(at.machine);
    return { face: faceOf(at.machine), machine: name, workspace: { text: at.workspace.label, icon: "folder" }, ...(git !== undefined ? { git } : {}), open: false, title: `${name} / ${at.workspace.label}`, chip: `${name} / ${at.workspace.label}` };
  }
  const only = !many ? view.machines[0]!.workspaces[0] : undefined;
  const target = stage.kind === "choosing" ? stage.target : stage.queued.target;
  const choice: Choice = only !== undefined ? { kind: "workspace", machine: view.machines[0]!, workspace: only } : choiceOf(view, target);
  const face = choice.kind === "auto" ? AUTO_FACE : faceOf(choice.machine);
  const machine = choice.kind === "auto" ? "automatic" : machineNameOf(choice.machine);
  const open = many;
  if (stage.kind === "placing") {
    return { face, machine, workspace: { text: "choosing a workspace", icon: "spinner", dim: true }, open: false, title: `${machine} — choosing a workspace`, chip: `${machine} · choosing` };
  }
  if (stage.kind === "waiting") {
    const words = waitingWords(choice);
    return { face, machine, workspace: { text: words, icon: "clock", dim: true }, open, title: `${machine} — ${words}`, chip: `${machine} · waiting for room` };
  }
  if (choice.kind === "workspace") {
    const git = gitFactsOf(choice.workspace.git);
    return { face, machine, workspace: { text: choice.workspace.label, icon: "folder" }, ...(git !== undefined ? { git } : {}), open, title: `${machine} / ${choice.workspace.label}`, chip: `${machine} / ${choice.workspace.label}` };
  }
  if (choice.kind === "machine") {
    const n = choice.machine.workspaces.length;
    // A machine with one workspace is that workspace: its checkout is already known.
    const git = n === 1 ? gitFactsOf(choice.machine.workspaces[0]!.git) : undefined;
    const words = n === 1 ? choice.machine.workspaces[0]!.label : `the first of ${n} workspaces with room`;
    return { face, machine, workspace: { text: words, icon: "folder", dim: n !== 1 }, ...(git !== undefined ? { git } : {}), open, title: `${machine} / ${words}`, chip: n === 1 ? `${machine} / ${words}` : machine };
  }
  // The ones it could go to now: a machine that cannot be reached is asked nothing.
  const n = view.machines.filter((m) => m.state === "online").reduce((sum, m) => sum + m.workspaces.length, 0);
  const words = n === 1 ? "the one workspace in reach, when it has room" : `the first of ${n} workspaces with room`;
  return { face, machine, workspace: { text: words, icon: "folder", dim: true }, open, title: `${machine} — ${words}`, chip: machine };
}

/** A folder's name, from its path — either slash. */
export function folderOf(dir: string): string {
  return dir.split(/[\\/]/).filter((part) => part !== "").pop() ?? dir;
}

/** The chip beside the title: the same choice as the bar, in one line. Dashed while nothing is decided. */
export function titleChipOf(bar: BarFacts | undefined): { face: MachineFace; text: string; dashed: boolean; open: boolean } | undefined {
  if (bar === undefined) return undefined;
  return { face: bar.face, text: bar.chip, dashed: bar.face.shape === "auto", open: bar.open };
}

/**
 * The start page's sentence about where a new conversation runs: words, and the part of them that is the
 * choice (a link that opens the list, when there is one to open).
 */
export function startSentenceOf(view: EnvironmentView | undefined, target: RunTarget | undefined, hasProject: boolean): { before: string; choice?: string; after: string } {
  if (!hasProject) return { before: "No project is open, so this runs in JaiRA's own root. Open one to talk about your code.", after: "" };
  const after = " — it asks before it runs or changes anything.";
  if (view === undefined || workspaceCount(view) <= 1) return { before: "This conversation works in the open project", after };
  const choice = choiceOf(view, target);
  const words =
    choice.kind === "workspace"
      ? `in ${choice.workspace.label} on ${machineNameOf(choice.machine)}`
      : choice.kind === "machine"
        ? `on ${machineNameOf(choice.machine)}, in its first workspace with room`
        : "in the first workspace with room";
  return { before: "This conversation runs ", choice: words, after };
}

/** One line of the list. */
export type ListRow =
  | { kind: "auto"; on: boolean }
  | { kind: "machine"; machine: EnvironmentMachine; face: MachineFace; name: string; what: string; note?: { text: string; tone: "warn" | "bad" }; meters: Meter[]; on: boolean; usable: boolean; target: RunTarget }
  | { kind: "workspace"; machine: EnvironmentMachine; workspace: EnvironmentWorkspace; work: number; workTitle: string; git?: GitFacts; on: boolean; usable: boolean; target: RunTarget };

/** How much is going on in a workspace, in words: "3 tasks: 1 at work, 2 waiting". */
export function workTitleOf(running: number, queued: number): string {
  const total = running + queued;
  return `${total} ${total === 1 ? "task" : "tasks"}: ${running} at work, ${queued} waiting`;
}

/** The list the bar opens: Automatic, then every machine and under it its workspaces. */
export function listRowsOf(view: EnvironmentView, target: RunTarget | undefined): ListRow[] {
  const choice = choiceOf(view, target);
  const rows: ListRow[] = [{ kind: "auto", on: choice.kind === "auto" }];
  for (const machine of view.machines) {
    const usable = machine.state === "online";
    const note = machineNoteOf(machine);
    rows.push({
      kind: "machine",
      machine,
      face: faceOf(machine),
      name: machineNameOf(machine),
      what: machineKindOf(machine),
      ...(note !== undefined ? { note } : {}),
      meters: usable ? metersOf(machine) : [],
      on: choice.kind === "machine" && choice.machine.id === machine.id,
      usable,
      target: { machine: machine.id },
    });
    for (const workspace of machine.workspaces) {
      const git = gitFactsOf(workspace.git);
      rows.push({
        kind: "workspace",
        machine,
        workspace,
        work: usable ? workspace.running + workspace.queued : 0,
        workTitle: workTitleOf(workspace.running, workspace.queued),
        ...(git !== undefined ? { git } : {}),
        on: choice.kind === "workspace" && choice.workspace.project === workspace.project,
        usable,
        target: { project: workspace.project },
      });
    }
  }
  return rows;
}

/**
 * Which stage a conversation is in, from what the Chat room knows of it: none open (choosing where the
 * next one runs), in the queue (being placed, or waiting), created and not started yet (about to be
 * placed: automatic, and not the person's to change now), or running where it is.
 */
export function stageOf(input: {
  taskId: string | null;
  project: string | undefined;
  queued?: QueuedPlacement | undefined;
  runOn?: RunTarget | undefined;
  detail?: { status: string; runs: readonly unknown[]; placed?: PlacementNote | undefined } | null | undefined;
}): { stage: EnvironmentStage; choosable: boolean } {
  if (input.taskId === null) return { stage: { kind: "choosing", target: input.runOn }, choosable: true };
  if (input.queued !== undefined) return input.queued.phase === "waiting" ? { stage: { kind: "waiting", queued: input.queued }, choosable: true } : { stage: { kind: "placing", queued: input.queued }, choosable: false };
  if (input.detail != null && input.detail.status === "queued" && input.detail.runs.length === 0) return { stage: { kind: "choosing", target: input.runOn }, choosable: false };
  return { stage: { kind: "running", project: input.project ?? "", placed: input.detail?.placed }, choosable: false };
}

/** Each machine's icon, by id — what a placement's actions wear. */
export function facesOf(view: EnvironmentView | undefined): Record<string, MachineFace> {
  return Object.fromEntries((view?.machines ?? []).map((m) => [m.id, faceOf(m)]));
}
