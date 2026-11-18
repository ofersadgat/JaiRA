/**
 * Making a project's workspace on a machine — Open's "where it goes" and "how it gets there", and
 * Add a workspace — as the window and the engines speak of it.
 *
 * A workspace comes from a SOURCE: a forge repository (cloned at a branch), or a folder on a machine
 * (copied as it is: everything git does not ignore, with its commits and changes). It goes to a
 * folder on the TARGET machine — its projects folder and the project's name unless another is chosen —
 * and is then set up by the project's setup (`setup.ts`): the setup file's target, or the setup found
 * in the checkout when it has no file.
 *
 * `workspace:plan` says, before anything happens, where it would go and what its setup would take on
 * the target (each step `there`, `installs`, `password`, `runs`, `brings` or `cannot`). `workspace:create`
 * does it, on the target machine (a request naming `machine` is forwarded there), reporting with
 * `workspace:progress` pushes and ending with `workspace:finished`.
 */
import type { ForgeRepository } from "./forge";

export type WorkspaceSource =
  | { kind: "forge"; host: string; project: string; url: string; branch?: string }
  | { kind: "machine"; machine: string; dir: string };

/** A forge repository with the connection it was listed through. */
export interface ForgeRepositoryRow extends ForgeRepository {
  host: string;
  provider: "github" | "gitlab";
  /** The connection's name in `integrations.forges`. */
  connection: string;
}

export interface ForgeRepositoriesView {
  repositories: ForgeRepositoryRow[];
  /** Every connection asked, with why it could not list, when it could not. */
  connections: { name: string; host: string; provider: "github" | "gitlab"; error?: string }[];
}

/** A checkout's git state, as Open shows the folder it would copy. */
export interface WorkspaceCheckout {
  remote?: string;
  remoteName?: string;
  branch?: string;
  head: string;
  upstream?: string;
  /** Commits the remote does not have. */
  ahead: number;
  /** Files changed and not committed. */
  changed: number;
  /** New files git does not ignore. */
  untracked: number;
}

/**
 * What one setup step would take on a machine. `there`: nothing to do · `installs`: a tool is installed
 * first · `password`: an install needs one, typed on that machine · `runs`: a command runs · `brings`:
 * files are copied · `cannot`: it cannot be done there.
 */
export interface SetupStepNeed {
  label: string;
  status: "there" | "installs" | "password" | "runs" | "brings" | "cannot";
  detail?: string;
  /** Where it came from: `.nvmrc`, `.github/workflows/ci.yml · Install deps`. */
  source?: string;
}

/** How a machine stands for a whole setup: the worst of its steps. */
export type SetupReadiness = "ready" | "installs" | "password" | "cannot";

export interface WorkspacePlanRequest {
  source: WorkspaceSource;
  /** The machine it goes to; absent: the one asked. */
  machine?: string;
  /** A folder of the person's own choosing; absent: the projects folder and the project's name. */
  folder?: string;
  /** The project's name, when the source does not say it plainly. */
  name?: string;
  /** The setup file's target to run; absent: `default`. */
  target?: string;
}

export interface WorkspacePlan {
  name: string;
  /** Where it would go on the target machine. */
  dir: string;
  projectsFolder: string;
  /** The folder name that was taken, when `dir` had to take another (`atlas` → `atlas-1`). */
  taken?: string;
  setup: {
    /** `file`: the project's setup file · `found`: what its checkout states, with no file · `none`: nothing to set up. */
    from: "file" | "found" | "none";
    target: string;
    steps: SetupStepNeed[];
    readiness: SetupReadiness;
    /** What is wrong with the setup file, when something is. */
    problems?: string[];
  };
  /** The patterns of files git ignores that the setup brings. */
  bring: string[];
  /** The source folder's git state, for a folder on a machine. */
  checkout?: WorkspaceCheckout;
}

export interface WorkspaceCreateRequest extends WorkspacePlanRequest {
  /** The machine Bring takes ignored files from; absent: the source machine, else another workspace's. */
  bringFrom?: string;
  /** Leave the setup out (the folder only). */
  skipSetup?: boolean;
}

export type WorkspacePhase = "fetch" | "open" | "setup";

export interface WorkspaceStepEvent {
  index: number;
  label: string;
  status: "running" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface WorkspaceProgress {
  jobId: string;
  /** The machine doing it. */
  machine: string;
  phase: WorkspacePhase;
  step?: WorkspaceStepEvent;
  /** Output, as it comes. */
  text?: string;
}

export interface WorkspaceFinished {
  jobId: string;
  machine: string;
  ok: boolean;
  dir?: string;
  /** Why it did not finish, when it did not. */
  reason?: string;
  /** How the setup went, when it ran: the folder is made and opened even when a step failed. */
  setup?: { ok: boolean; steps: { label: string; status: "done" | "skipped" | "failed"; detail?: string }[]; reason?: string };
}
