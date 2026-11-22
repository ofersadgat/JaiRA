/**
 * A process as a task, in the window (decision 0032, "The view", rulings 3–7): what a process task's
 * card, row and task view say, the count its parent's card carries, the `Process` workflow's strip and
 * lanes, the sidebar's Nested | Flat, and which channels a process task's id may be sent on.
 *
 * Pure. The engine's contract is `processes.ts` in shared; this is only how the window words it.
 */
import {
  PROCESS_STATES,
  PROCESS_WORKFLOW,
  isProcessTaskId,
  processCount,
  processCountLabel,
  processEnded,
  processTaskStatus,
  type BoardCard,
  type BoardView,
  type ProcessCount,
  type ProcessOrigin,
  type ProcessState,
  type ProcessSummary,
  type ProcessTaskFacts,
} from "@jaira/shared/browser";

/** Whether a card, row or detail is a process task. */
export function isProcessTask(task: { type?: "process"; taskId: string } | null | undefined): boolean {
  return task !== null && task !== undefined && (task.type === "process" || isProcessTaskId(task.taskId));
}

export type ProcessTone = "accent" | "ok" | "warn" | "bad" | "dim";

/** The badge a process task wears where a task wears its status: `◉ listening :8145`, `⏸ waiting for input`, `✗ exited 1`. */
export interface ProcessBadge {
  glyph: string;
  /** The words after the glyph. */
  text: string;
  tone: ProcessTone;
}

/** How it ended, in a word or two: `exited 1`, `SIGTERM`, `exited 0`. */
function endWords(facts: Pick<ProcessTaskFacts, "state" | "exitCode" | "signal">): string {
  if (facts.state === "stopped") return "stopped";
  if (facts.exitCode !== undefined && facts.exitCode !== null) return `exited ${facts.exitCode}`;
  if (facts.signal !== undefined && facts.signal !== null) return facts.signal;
  return facts.state === "failed" ? "exited ≠ 0" : "exited";
}

/** The ports, as the badge says them: `:8145`, `:8145 +1`. */
export function portsLabel(ports: readonly number[]): string {
  if (ports.length === 0) return "";
  return `:${ports[0]}${ports.length > 1 ? ` +${ports.length - 1}` : ""}`;
}

export function processBadgeOf(facts: Pick<ProcessTaskFacts, "state" | "ports" | "exitCode" | "signal">): ProcessBadge {
  switch (facts.state) {
    case "starting":
      return { glyph: "◌", text: "starting", tone: "accent" };
    case "running":
      return { glyph: "▶", text: "running", tone: "accent" };
    case "listening":
      return { glyph: "◉", text: ["listening", portsLabel(facts.ports)].filter((p) => p.length > 0).join(" "), tone: "accent" };
    case "waiting":
      return { glyph: "⏸", text: "waiting for input", tone: "warn" };
    case "exited":
      return { glyph: "✓", text: endWords(facts), tone: "dim" };
    case "failed":
      return { glyph: "✗", text: endWords(facts), tone: "bad" };
    case "stopped":
      return { glyph: "■", text: "stopped", tone: "dim" };
  }
}

/** The state in a word, where a task row says its status (the sidebar): `listening`, `input`, `exited 1`. */
export function processWordOf(facts: Pick<ProcessTaskFacts, "state" | "exitCode" | "signal">): string {
  if (facts.state === "waiting") return "input";
  if (processEnded(facts.state)) return endWords(facts);
  return facts.state;
}

/** A state as the `Process` workflow names it: its lane's heading and its step in the strip. */
export const PROCESS_STATE_LABEL: Record<ProcessState, string> = {
  starting: "starting",
  running: "running",
  listening: "listening",
  waiting: "waiting for input",
  exited: "exited 0",
  failed: "exited ≠ 0",
  stopped: "stopped",
};

/** Where it came from, as the chip beside the machine says it: `run_in_background`, `escaped · WMI`, `Mine · watched`. */
export function originLabelOf(facts: { origin: ProcessOrigin; why?: string | undefined }): string {
  const why = facts.why ?? "";
  switch (facts.origin) {
    case "background":
      return "run_in_background";
    case "this-turn":
      return "this turn";
    case "left":
      return "left running";
    case "escaped": {
      const how = /\bWMI\b|WmiPrvSE/i.test(why) ? "WMI" : /task scheduler|schtasks/i.test(why) ? "Task Scheduler" : /\bat\b|cron|systemd-run/i.test(why) ? "scheduler" : undefined;
      return how === undefined ? "escaped" : `escaped · ${how}`;
    }
    case "native":
      return /powershell/i.test(why) ? "Claude's PowerShell" : "Claude's Bash";
    case "watched":
      return "Mine · watched";
  }
}

/** How the origin chip is drawn: escaped amber, left running dashed (board 7), the rest plain. */
export function originLookOf(origin: ProcessOrigin): "warn" | "dashed" | "plain" {
  return origin === "escaped" ? "warn" : origin === "left" ? "dashed" : "plain";
}

/** `↰ from Dev server and the gutter`, or for a watched one with no parent, `no parent task`. */
export function fromLabelOf(facts: Pick<ProcessTaskFacts, "parentTaskId">, titleOf: (taskId: string) => string | undefined): string {
  if (facts.parentTaskId === undefined) return "no parent task";
  return `↰ from ${titleOf(facts.parentTaskId) ?? facts.parentTaskId}`;
}

// --- the parent's count ------------------------------------------------------------------------

/** Each parent's count of its process tasks, from any rows that carry them (the window's index). */
export function processCountsByParent(tasks: ReadonlyArray<{ process?: ProcessTaskFacts | undefined }>): Map<string, ProcessCount> {
  const by = new Map<string, Array<{ process?: ProcessTaskFacts }>>();
  for (const task of tasks) {
    const parent = task.process?.parentTaskId;
    if (parent === undefined) continue;
    const list = by.get(parent);
    if (list === undefined) by.set(parent, [task as { process?: ProcessTaskFacts }]);
    else list.push(task as { process?: ProcessTaskFacts });
  }
  const out = new Map<string, ProcessCount>();
  for (const [parent, list] of by) out.set(parent, processCount(list, parent));
  return out;
}

/** What the parent's card says: the head (`6 processes`) as the chip, and the rest (`4 running · 1 escaped`) after it. */
export function countChipOf(count: ProcessCount | undefined): { head: string; rest: string } | undefined {
  if (count === undefined || count.total === 0) return undefined;
  const [head, ...rest] = processCountLabel(count).split(" · ");
  return { head: head!, rest: rest.join(" · ") };
}

// --- the Process workflow, opened ----------------------------------------------------------------

export interface ProcessStripStep {
  state: ProcessState;
  label: string;
  count: number;
}

/** The strip over the lanes (board 7): the live states in the shape of the machine, then the ends, each with its count. */
export interface ProcessStrip {
  flow: ProcessStripStep[];
  ends: ProcessStripStep[];
  total: number;
  live: number;
  waiting: number;
}

export function processStripOf(cards: ReadonlyArray<{ process?: ProcessTaskFacts | undefined }>): ProcessStrip {
  const counts = new Map<ProcessState, number>(PROCESS_STATES.map((s) => [s, 0]));
  let total = 0;
  for (const card of cards) {
    if (card.process === undefined) continue;
    total++;
    counts.set(card.process.state, (counts.get(card.process.state) ?? 0) + 1);
  }
  const step = (state: ProcessState): ProcessStripStep => ({ state, label: PROCESS_STATE_LABEL[state], count: counts.get(state) ?? 0 });
  const flow = (["starting", "running", "listening", "waiting"] as const).map(step);
  const ends = (["exited", "failed", "stopped"] as const).map(step);
  return { flow, ends, total, live: flow.reduce((n, s) => n + s.count, 0), waiting: counts.get("waiting") ?? 0 };
}

/** `12 process tasks · 7 running · 1 waiting for input` — beside the crumbs. */
export function processHeadlineOf(strip: ProcessStrip): string {
  const parts = [`${strip.total} process task${strip.total === 1 ? "" : "s"}`];
  if (strip.live > 0) parts.push(`${strip.live} running`);
  if (strip.waiting > 0) parts.push(`${strip.waiting} waiting for input`);
  return parts.join(" · ");
}

/** How wide the opened workflow looks (board 7): this project, every project, and with the person's own. */
export type ProcessScope = "project" | "projects";

/** A card for a process the engine listed (`process:list`), drawn as the board draws a process task's. */
export function processCardOf(p: ProcessSummary): BoardCard {
  const facts: ProcessTaskFacts = {
    key: p.key,
    pid: p.pid,
    state: p.state,
    origin: p.origin ?? "watched",
    ...(p.why !== undefined ? { why: p.why } : {}),
    ...(p.taskId !== undefined ? { parentTaskId: p.taskId } : {}),
    ports: [...p.ports],
    machine: p.machine,
    ...(p.exitCode !== undefined ? { exitCode: p.exitCode } : {}),
    ...(p.signal !== undefined ? { signal: p.signal } : {}),
    ...(p.told === true ? { told: true } : {}),
    ...(p.tellWhen !== undefined ? { armed: true as const } : {}),
  };
  return {
    // A machine process nobody watches has no task: its key stands in, and opening it watches it first.
    taskId: p.processTaskId ?? p.key,
    title: p.name,
    status: processTaskStatus(p.state),
    workflow: PROCESS_WORKFLOW,
    activeStateId: p.state,
    activePath: [{ instanceId: p.key, stateId: p.state }],
    hasSubBoard: false,
    type: "process",
    process: facts,
    updatedAt: p.states.at(-1)?.at ?? p.startedAt,
    createdAt: p.startedAt,
    ...(p.endedAt !== undefined ? { endedAt: p.endedAt } : {}),
    ...(p.project !== undefined ? { project: p.project } : {}),
  };
}

/**
 * The opened workflow's board: one lane per state, in the workflow's order, each card in the lane of
 * its state — the engine's `board:view {level: "Process"}`, widened by what `process:list` answered for
 * a wider scope (a card once, the engine's board winning).
 */
export function processLanesOf(board: BoardView | null | undefined, wider: readonly BoardCard[] = []): BoardView {
  const seen = new Set<string>();
  const all: BoardCard[] = [];
  for (const card of [...(board?.columns.flatMap((c) => c.cards) ?? []), ...wider]) {
    if (card.process === undefined || seen.has(card.taskId)) continue;
    seen.add(card.taskId);
    all.push(card);
  }
  const columns = PROCESS_STATES.map((state) => {
    const was = board?.columns.find((c) => c.key === state || c.stateId === state);
    return {
      ...(was ?? {}),
      key: state,
      stateId: state,
      label: PROCESS_STATE_LABEL[state],
      // Live lanes newest activity first; an end, the newest end first.
      cards: all.filter((c) => c.process!.state === state).sort((a, b) => (b.endedAt ?? b.updatedAt) - (a.endedAt ?? a.updatedAt)),
    };
  });
  return {
    ...(board ?? {}),
    level: PROCESS_WORKFLOW,
    label: PROCESS_WORKFLOW,
    breadcrumb: board?.breadcrumb ?? [{ stateId: PROCESS_WORKFLOW, label: PROCESS_WORKFLOW }],
    columns,
    atLevel: [],
    finished: all.filter((c) => processEnded(c.process!.state)),
  } as BoardView;
}

/** Whether a board is the `Process` workflow opened, whose columns are its states (no level below them). */
export function isProcessBoard(board: Pick<BoardView, "level"> | null | undefined): boolean {
  return board?.level === PROCESS_WORKFLOW;
}

// --- the sidebar's Tasks tab ----------------------------------------------------------------------

/** Nested shows each process under the task that started it; Flat lists them with `↰ from …`. */
export const PROCESS_NESTS = ["nested", "flat"] as const;
export type ProcessNest = (typeof PROCESS_NESTS)[number];
export const PROCESS_NEST_MODE = "tasks.list.processes";

export interface NestedRow<C> {
  card: C;
  /** 1: under its parent, the row above it (or the parent's other processes above it). */
  depth: 0 | 1;
}

/**
 * The status groups with each process task filed under the task that started it (board 9): a parent is
 * grouped by its own status and its processes come with it, so a done task keeps its live process under
 * it. A process whose parent is not listed (a watched one, or one whose parent is in another scope)
 * stays a row of its own where its own status put it. A group left empty is dropped.
 */
export function nestProcessRows<S extends { key: string; rows: ReadonlyArray<{ taskId: string; type?: "process"; process?: ProcessTaskFacts | undefined }> }>(
  sections: readonly S[],
): Array<Omit<S, "rows"> & { rows: NestedRow<S["rows"][number]>[] }> {
  type C = S["rows"][number];
  const listed = new Set(sections.flatMap((s) => s.rows.map((r) => r.taskId)));
  const under = new Map<string, C[]>();
  for (const s of sections) {
    for (const row of s.rows) {
      const parent = row.process?.parentTaskId;
      if (parent === undefined || !listed.has(parent) || parent === row.taskId) continue;
      const list = under.get(parent);
      if (list === undefined) under.set(parent, [row]);
      else list.push(row);
    }
  }
  const nested = new Set([...under.values()].flatMap((list) => list.map((c) => c.taskId)));
  const out: Array<Omit<S, "rows"> & { rows: NestedRow<C>[] }> = [];
  for (const s of sections) {
    const rows: NestedRow<C>[] = [];
    for (const row of s.rows) {
      if (nested.has(row.taskId)) continue;
      rows.push({ card: row, depth: 0 });
      for (const child of under.get(row.taskId) ?? []) rows.push({ card: child, depth: 1 });
    }
    if (rows.length > 0) out.push({ ...s, rows });
  }
  return out;
}

/** The rows as they are, each at the top level: Flat. */
export function flatRows<S extends { rows: ReadonlyArray<unknown> }>(sections: readonly S[]): Array<Omit<S, "rows"> & { rows: NestedRow<S["rows"][number]>[] }> {
  return sections.map((s) => ({ ...s, rows: s.rows.map((card) => ({ card, depth: 0 as const })) }));
}

// --- what the engine takes a process task's id on ---------------------------------------------------

/**
 * The channels that take a process task's id (decision 0032, the engine's `PROCESS_TASK_CHANNELS`): its
 * detail is the process, and cancelling, deleting or archiving it stops it. The engine refuses every
 * other channel naming one; the window does not send them.
 */
export const PROCESS_TASK_CHANNELS: ReadonlySet<string> = new Set(["task:detail", "task:cancel", "task:delete", "task:archive", "task:unarchive", "process:get"]);

/** The process task a request names on a channel that refuses one, if any. */
export function refusedProcessTask(channel: string, request: unknown): string | undefined {
  if (PROCESS_TASK_CHANNELS.has(channel) || request === null || typeof request !== "object") return undefined;
  const { taskId, taskIds } = request as { taskId?: unknown; taskIds?: unknown };
  const ids = [taskId, ...(Array.isArray(taskIds) ? (taskIds as unknown[]) : [])].filter((id): id is string => typeof id === "string");
  return ids.find(isProcessTaskId);
}

/** Thrown in place of sending a request the engine would refuse: quiet, never a toast. */
export class ProcessTaskRefused extends Error {
  readonly processTask = true;
  constructor(channel: string, taskId: string) {
    super(`${taskId} is a process task: ${channel} is not asked of one`);
  }
}

export function isProcessTaskRefusal(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { processTask?: unknown }).processTask === true;
}

// --- a process task opened (board 8) --------------------------------------------------------------

/** One step of the states it went through, as the head draws it: `listening :8145, :24678 since 10:41:14 · 4m`. */
export interface ProcessStepLine {
  state: ProcessState;
  text: string;
  /** The one it is in now. */
  current: boolean;
}

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** How long, to one unit: `12s`, `4m`, `1h`, `2d`. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function processStepsOf(p: Pick<ProcessSummary, "states" | "ports" | "state" | "exitCode" | "signal">, now: number = Date.now()): ProcessStepLine[] {
  return p.states.map((step, i) => {
    const current = i === p.states.length - 1;
    const ports = step.state === "listening" && current && p.ports.length > 0 ? ` ${p.ports.map((port) => `:${port}`).join(", ")}` : "";
    const name = processEnded(step.state) ? endWords({ state: step.state, exitCode: p.exitCode, signal: p.signal }) : PROCESS_STATE_LABEL[step.state];
    return { state: step.state, text: current && !processEnded(step.state) ? `${name}${ports} since ${clock(step.at)} · ${shortAge(now - step.at)}` : `${name}${ports} ${clock(step.at)}`, current };
  });
}

/** What can come next from a state (the workflow's transitions): `waiting for input, exited, stopped`. */
export function nextStatesOf(state: ProcessState): string {
  switch (state) {
    case "starting":
      return "running, listening, exited, stopped";
    case "running":
      return "listening, waiting for input, exited, stopped";
    case "listening":
      return "waiting for input, exited, stopped";
    case "waiting":
      return "running, listening, exited, stopped";
    default:
      return "";
  }
}

/** The facts line: `pid 84456 · 2.1% · 182 MB`. */
export function factsLineOf(p: Pick<ProcessSummary, "pid" | "cpu" | "memoryMb">): string {
  return [`pid ${p.pid}`, ...(p.cpu !== undefined ? [`${p.cpu < 10 ? p.cpu.toFixed(1) : Math.round(p.cpu)}%`] : []), ...(p.memoryMb !== undefined ? [`${Math.round(p.memoryMb)} MB`] : [])].join(" · ");
}
