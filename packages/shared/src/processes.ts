/**
 * A process as the window draws it (decision 0032, "The view"): the card wherever a process is shown,
 * the Terminals tab's List | Tree, and a process as a task of the built-in `Process` workflow.
 *
 * The engine keeps these in memory (its `ProcessHub`): every process a task's agent started and left
 * running (`run_in_background`, left running by a command, escaped, Claude Code's own), every command
 * running in a task right now (`this-turn`), and the machine's processes a person chose to watch. None
 * is written to disk or copied to another machine. An ended one is kept until the task that started it
 * lets it go (it is archived, deleted or moved) or the engine stops; a watched one only while watched.
 *
 * A process is keyed by its pid and start time ({@link processKey}): a pid alone is reused.
 */
import type { TaskStatus } from "./task";

/**
 * Where a process stands — the `Process` workflow's states: `starting` → `running` → `listening` (a
 * port is open) ⇄ `waiting` (for input), ending in `exited` (0, or an end JaiRA could not read),
 * `failed` (exited ≠ 0, or a signal it was not sent) or `stopped` (the agent, the person or the task's
 * end stopped it).
 */
export type ProcessState = "starting" | "running" | "listening" | "waiting" | "exited" | "failed" | "stopped";

/** The states in the workflow's order: the lanes of the `Process` board. */
export const PROCESS_STATES: readonly ProcessState[] = ["starting", "running", "listening", "waiting", "exited", "failed", "stopped"];

/** Whether a state is an end. */
export function processEnded(state: ProcessState): boolean {
  return state === "exited" || state === "failed" || state === "stopped";
}

/**
 * How the process came to be shown — a fact of it, never a state:
 *
 *  - `background` — `shell`'s `run_in_background`;
 *  - `this-turn` — a command running in the task now, the agent's or the person's (ended, it leaves);
 *  - `left` — left running by a command, kept as the session's (ruling 5);
 *  - `escaped` — started outside every tree JaiRA follows (WMI, the Task Scheduler) — see `why`;
 *  - `native` — Claude Code's own `Bash`/`PowerShell` `run_in_background` (ruling 6);
 *  - `watched` — another scope's process a person chose to watch (`process:watch`); no parent task.
 */
export type ProcessOrigin = "background" | "this-turn" | "left" | "escaped" | "native" | "watched";

/** Whose it is on the machine (decision 0032, ruling 4's places). */
export type ProcessStartedBy = "session" | "jaira" | "user" | "system";

/** Where its output can be read from (ruling 6). */
export type ProcessOutputSource = "spawned" | "file" | "console" | "unreadable";

/** One state a process went through, and when it entered it (epoch ms). */
export interface ProcessStateStep {
  state: ProcessState;
  at: number;
}

/** "Tell Claude when it prints…", armed: one-shot, until it matches, is cancelled, or the process ends. */
export interface ProcessTellWhen {
  /** A regular expression's source, matched against each line (escapes and `\r` taken out). */
  pattern: string;
  /** Its flags (`i`), if any. */
  flags?: string;
  armedAt: number;
}

/** A process, as every place that shows one draws it. */
export interface ProcessSummary {
  /** `pid@startedAt` — what every `process:*` channel names it by. */
  key: string;
  /** Its id as a task of the `Process` workflow (`t-p84456-…`); absent for a machine process nobody watches. */
  processTaskId?: string;
  /** The task whose session it is — the process task's parent. Absent for a watched or machine process. */
  taskId?: string;
  /** The project it is listed under (the engine's key for it, as the task lists stamp). */
  project?: string;
  /** The machine it runs on, by its label. */
  machine: string;
  pid: number;
  /** Epoch ms. */
  startedAt: number;
  /** Its command line, as started or as the machine says it. */
  command: string;
  /** A short name to show: the program (`node`, `one dev`). */
  name: string;
  cwd?: string;
  /** How it came to be shown; absent for a machine process nobody watches. */
  origin?: ProcessOrigin;
  /** Why, in words: for `escaped` how it got out ("started through WMI by …"), for `left` which command left it. */
  why?: string;
  /** Who ran a `this-turn` command: the agent or the person. */
  by?: "agent" | "you";
  startedBy: ProcessStartedBy;
  /** Its account, where the machine says. */
  account?: string;
  state: ProcessState;
  /** The states it went through, oldest first; the last is {@link state}. */
  states: ProcessStateStep[];
  /** Once ended: its exit code (null when a signal ended it, or JaiRA could not read it), signal and when. */
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: number;
  /** The TCP ports its tree listens on, ascending. */
  ports: number[];
  /** Its tree's CPU, percent of one core, over the last sample; absent until sampled. */
  cpu?: number;
  /** Its tree's memory, MB. */
  memoryMb?: number;
  /** The last {@link PROCESS_LOAD_SAMPLES} CPU readings, oldest first — the card's load trace. */
  load: number[];
  /** The tool call that started it (the transcript's `tool_use` id). */
  callId?: string;
  /**
   * The terminal its output streams through, when it has one: `terminal:read`/`terminal:output` with
   * `{ taskId, callId: terminal }`, and `terminal:input`/`terminal:signal` to type into it and stop it.
   * Without one, `process:read` follows what can be read.
   */
  terminal?: string;
  output: { source: ProcessOutputSource; path?: string; why?: string };
  /** The agent was told it ended (the "Claude was told" line). */
  told?: boolean;
  /** "Tell Claude when it prints…", while armed. */
  tellWhen?: ProcessTellWhen;
  /** The last time a pattern matched and the task was told: which, what line, when. */
  toldWhen?: { pattern: string; line: string; at: number };
  /** For the tree: its parent's pid, and the pids it started (directly), as last sampled. */
  parentPid?: number;
  children?: number[];
  /** Why Stop is refused for it (JaiRA's own, one the operating system needs); absent when it may be stopped. */
  protected?: string;
}

/** How many CPU readings a process keeps for its load trace. */
export const PROCESS_LOAD_SAMPLES = 30;

/** What a sample changed of a process — the `process:stats` push. */
export interface ProcessStats {
  key: string;
  cpu?: number;
  memoryMb?: number;
  ports: number[];
  load: number[];
  parentPid?: number;
  children?: number[];
}

/** A process and what it started, as the Tree draws it. */
export interface ProcessTreeNode {
  process: ProcessSummary;
  children: ProcessTreeNode[];
}

/**
 * Which processes a list or tree holds:
 *
 *  - `session` — one task's (`taskId`), as the Terminals tab's "This conversation";
 *  - `project` — every task's of a project (`project`), and what is watched there;
 *  - `projects` — every project's here;
 *  - `jaira`, `user`, `group` (with `group`), `system`, `all` — the machine's, placed as the process
 *    tools place them (decision 0032, ruling 4); a session's process among them is drawn as such.
 */
export type ProcessListScope = "session" | "project" | "projects" | "jaira" | "user" | "group" | "system" | "all";

export interface ProcessListRequest {
  scope: ProcessListScope;
  taskId?: string;
  project?: string;
  group?: string;
}

export interface ProcessListAnswer {
  /** Live ones first, then the newest. */
  processes: ProcessSummary[];
  /** For a machine scope: how many processes' accounts could not be read, said. */
  unplaced?: string;
}

/** What `process:read` answers: the output since `since`, where it came from, whether it is whole. */
export interface ProcessReadAnswer {
  key: string;
  source: ProcessOutputSource;
  /** Raw, as the program wrote it; empty when it cannot be read. */
  output: string;
  /** Pass back as `since` to read only what is new. */
  offset: number;
  /** When following began (epoch ms), for output JaiRA did not keep from the start. */
  from?: number;
  /** True when the output is kept from the process's start. */
  whole: boolean;
  path?: string;
  /** Why nothing can be read. */
  why?: string;
}

// --- a process as a task (the built-in `Process` workflow) ----------------------------------------

/** The workflow every process task belongs to: a column on the board, a status group in the sidebar. */
export const PROCESS_WORKFLOW = "Process";

/** What a task row, a board card and a task's detail carry when the task is a process. */
export interface ProcessTaskFacts {
  key: string;
  pid: number;
  state: ProcessState;
  origin: ProcessOrigin;
  why?: string;
  /** The task that started it — absent for a watched process. Also the summary's `parentTaskId`. */
  parentTaskId?: string;
  ports: number[];
  machine: string;
  exitCode?: number | null;
  signal?: string | null;
  told?: boolean;
  /** "Tell Claude when it prints…" is armed. */
  armed?: true;
}

/** A process's key: its pid and start time. */
export function processKey(pid: number, startedAt: number): string {
  return `${pid}@${startedAt}`;
}

/** A process task's id, from its pid and start time: `t-p<pid>-<start, base 36>`. Never a stored task's (`t-` and ten letters). */
export function processTaskIdOf(pid: number, startedAt: number): string {
  return `t-p${pid}-${Math.max(0, Math.floor(startedAt)).toString(36)}`;
}

/** Whether a task id names a process task — one the engine keeps in memory, with no file, run or journal. */
export function isProcessTaskId(taskId: string): boolean {
  return /^t-p\d+-[a-z0-9]+$/.test(taskId);
}

/**
 * A process task's status in the task lists' terms: live is `running`, `exited` is `completed`,
 * `failed` is `failed`, `stopped` is `canceled`. The process's own state is `process.state`.
 */
export function processTaskStatus(state: ProcessState): TaskStatus {
  if (state === "exited") return "completed";
  if (state === "failed") return "failed";
  if (state === "stopped") return "canceled";
  return "running";
}

/** What a parent's card says of its processes: "6 processes · 4 running · 1 escaped · 1 failed". */
export interface ProcessCount {
  total: number;
  /** Not ended (starting, running, listening, waiting). */
  live: number;
  listening: number;
  waiting: number;
  escaped: number;
  failed: number;
  stopped: number;
  exited: number;
}

/** The count of the process tasks under `parentTaskId`, from any list of task rows that carries them. */
export function processCount(tasks: ReadonlyArray<{ process?: ProcessTaskFacts }>, parentTaskId: string): ProcessCount {
  const count: ProcessCount = { total: 0, live: 0, listening: 0, waiting: 0, escaped: 0, failed: 0, stopped: 0, exited: 0 };
  for (const task of tasks) {
    const p = task.process;
    if (p === undefined || p.parentTaskId !== parentTaskId) continue;
    count.total++;
    if (!processEnded(p.state)) count.live++;
    if (p.state === "listening") count.listening++;
    if (p.state === "waiting") count.waiting++;
    if (p.state === "failed") count.failed++;
    if (p.state === "stopped") count.stopped++;
    if (p.state === "exited") count.exited++;
    if (p.origin === "escaped") count.escaped++;
  }
  return count;
}

/** {@link ProcessCount} in words, the parts that are not zero: "6 processes · 4 running · 1 escaped · 1 failed". */
export function processCountLabel(count: ProcessCount): string {
  if (count.total === 0) return "";
  const parts = [`${count.total} process${count.total === 1 ? "" : "es"}`];
  if (count.live > 0) parts.push(`${count.live} running`);
  if (count.escaped > 0) parts.push(`${count.escaped} escaped`);
  if (count.failed > 0) parts.push(`${count.failed} failed`);
  return parts.join(" · ");
}
