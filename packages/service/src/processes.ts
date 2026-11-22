/**
 * The engine's processes, as the window draws them (decision 0032, "The view"): every task's background
 * processes (its `SessionProcesses`), every command running in a task now (`this-turn`, from the
 * terminals), and the machine's processes a person chose to watch — each a task of the built-in
 * `Process` workflow, in memory only.
 *
 * What it adds to what the records say:
 *
 *  - **State**, derived: `starting` until first sampled (or two seconds), `listening` while its tree
 *    listens on a port, `waiting` while its terminal says it waits for input, `running` otherwise, and the
 *    ends from its exit (`exited`, `failed` for ≠ 0, `stopped`).
 *  - **Samples**: CPU, memory and ports of each running one's tree, every {@link SAMPLE_EVERY_MS} while a
 *    window shows them (`process:sampling`), every {@link IDLE_SAMPLE_EVERY_MS} otherwise.
 *  - **"Tell Claude when it prints…"**: a one-shot pattern; the line that matches, with a few around it,
 *    is sent to the task that owns the process as a message on the person's behalf.
 *
 * What goes out: `process:state` (coalesced, one per process), `process:stats` (per sample), and
 * `process:gone`; and a stamp in the change log for each process task whose facts moved, so a window's
 * task index reads it as it reads any task (decision 0018). A process task is written nowhere else.
 *
 * An ended process stays until the task that started it lets it go (archived, deleted, moved, the app
 * quit) — a `this-turn` command leaves when it ends (its result is in the transcript), and a watched one
 * when it is unwatched or gone.
 */
import {
  PROCESS_LOAD_SAMPLES,
  PROCESS_STATES,
  PROCESS_WORKFLOW,
  processEnded,
  processKey,
  processTaskIdOf,
  processTaskStatus,
  type BoardCard,
  type BoardView,
  type ProcessOrigin,
  type ProcessOutputSource,
  type ProcessReadAnswer,
  type ProcessStartedBy,
  type ProcessState,
  type ProcessStats,
  type ProcessSummary,
  type ProcessTaskFacts,
  type ProcessTreeNode,
  type ProjectTask,
  type PushMessage,
  type TaskDetail,
  type TerminalRead,
  type TerminalSignal,
  type TerminalSummary,
} from "@jaira/shared";
import { withTrees, type OutputRead, type ProcessSample, type ProcessSampler, type SessionProcessSummary } from "@jaira/runtime";

/** How often running processes are sampled while a window shows them. */
export const SAMPLE_EVERY_MS = 2_000;
/** …and while none does: enough to keep `listening` roughly right on the board. */
export const IDLE_SAMPLE_EVERY_MS = 30_000;
/** How long a new process is `starting` when nothing has sampled it yet. */
export const STARTING_MS = 2_000;
/** How long a command must run before it is a `this-turn` process task: a quick one never is. */
export const THIS_TURN_AFTER_MS = 1_000;
/** How long pushes about one process are gathered. */
export const PUSH_EVERY_MS = 50;
/** Lines sent around the one that matched a "Tell Claude when it prints…" pattern. */
export const TELL_BEFORE = 3;
export const TELL_AFTER = 3;
/** How long the lines after a match are waited for before the message goes. */
export const TELL_AFTER_MS = 400;
/** How often a pattern on output JaiRA did not keep (a file, a console) is looked for. */
export const TELL_FOLLOW_MS = 2_000;

/** What the hub needs of a task's `SessionProcesses`. */
export interface SessionProcessesLike {
  byKey(pid: number, startedAt: number): SessionProcessSummary | undefined;
  stopKey(pid: number, startedAt: number, how?: "interrupt" | "stop"): SessionProcessSummary | undefined;
  peek(pid: number, startedAt: number, since?: number): { summary: SessionProcessSummary; output: string; offset: number; dropped?: number } | undefined;
}

/** One machine process as a machine scope lists it (the System tools' placed row). */
export interface MachineRow {
  pid: number;
  parent_pid?: number;
  name: string;
  started?: string;
  memory_mb?: number;
  path?: string;
  started_by?: ProcessStartedBy;
  user?: string;
}

export interface ProcessHubOptions {
  publish(message: PushMessage): void;
  /** Stamp a process task in the change log (or its tombstone), so windows read it again. */
  touch?(processTaskId: string, deleted: boolean): void;
  /** This machine's label. */
  machine(): string;
  /** A project, from the engine key a terminal carries: its directory (what the lists stamp) and its key. */
  project?(key: string): { dir: string; key: string } | undefined;
  sampler?: ProcessSampler;
  /** A terminal's facts — whether a process's terminal waits for input. */
  terminal?(taskId: string, callId: string): TerminalSummary | undefined;
  /** A terminal whole — `process:read` of a `this-turn` command. */
  terminalRead?(taskId: string, callId: string): TerminalRead | null;
  /** Ctrl-C or stop a terminal's command. */
  terminalSignal?(taskId: string, callId: string, signal: TerminalSignal): boolean;
  /** Reads output JaiRA did not keep (a file, a console), followed from the first read. */
  outputs?: { read(pid: number, options?: { tail?: number; since?: number }): Promise<OutputRead> };
  /** Sends a task a message on the person's behalf. */
  tell?(taskId: string, project: string | undefined, text: string): Promise<unknown>;
  /** Stops a machine process (a watched one), refusing what may not be stopped. */
  stopMachine?(pid: number, startedAt: number, signal: TerminalSignal): Promise<{ stopped: boolean; why?: string }>;
  log?(level: "info" | "warn", message: string, taskId?: string): void;
  everyMs?: number;
  idleEveryMs?: number;
  now?: () => number;
}

type Source =
  | { kind: "session"; sp: SessionProcessesLike }
  | { kind: "terminal"; callId: string }
  | { kind: "watched" };

interface Tell {
  pattern: RegExp;
  partial: string;
  before: string[];
  after?: { line: string; before: string[]; lines: string[]; timer: ReturnType<typeof setTimeout> };
  follow?: ReturnType<typeof setInterval>;
}

interface Entry {
  summary: ProcessSummary;
  source: Source;
  /** The project's engine key (as sessions are keyed), for scoping. */
  projectKey?: string;
  running: boolean;
  stopped?: boolean;
  waiting?: boolean;
  sampled: boolean;
  cpuSeen?: { seconds: number; at: number };
  tell?: Tell;
  /** What the change log last heard of it, so a sample that moves nothing stamps nothing. */
  facts?: string;
  startTimer?: ReturnType<typeof setTimeout>;
}

/**
 * A process's state from what is known of it — see the module header. `age` is how long it has run;
 * `sampled` whether a sample has seen it.
 */
export function deriveProcessState(p: { running: boolean; stopped?: boolean; exitCode?: number | null; signal?: string | null; waiting?: boolean; ports: readonly number[]; sampled: boolean; age: number }): ProcessState {
  if (!p.running) {
    if (p.stopped === true) return "stopped";
    if (p.exitCode !== undefined && p.exitCode !== null && p.exitCode !== 0) return "failed";
    if ((p.exitCode === undefined || p.exitCode === null) && p.signal !== undefined && p.signal !== null) return "failed";
    return "exited";
  }
  if (p.waiting === true) return "waiting";
  if (p.ports.length > 0) return "listening";
  if (p.sampled || p.age >= STARTING_MS) return "running";
  return "starting";
}

const RUNNERS = /^(?:(?:npx|bunx|pnpx)\s+(?:-y\s+|--yes\s+)?|(?:npm|pnpm|yarn|bun)\s+(?:run\s+|exec\s+|dlx\s+)?|cmd(?:\.exe)?\s+\/[ck]\s+|(?:ba|z)?sh\s+-c\s+|pwsh(?:\.exe)?\s+(?:-File\s+)?|powershell(?:\.exe)?\s+(?:-File\s+)?)/i;

/** A short name for a command line: its runner (`npx`, `npm run`, `cmd /c`) off, and its first words up to an option — `npx one dev --port 8145` is `one dev`, `npx tsc --noEmit` is `tsc --noEmit`. */
export function processDisplayName(command: string): string {
  let line = command.trim().replace(/^["']|["']$/g, "");
  for (let i = 0; i < 3; i++) {
    const next = line.replace(RUNNERS, "").replace(/^["']/, "");
    if (next === line) break;
    line = next;
  }
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return command.trim().slice(0, 40);
  const first = words[0]!.replace(/^.*[\\/]/, "");
  const plain = [first];
  for (const word of words.slice(1)) {
    if (word.startsWith("-") || plain.length >= 3) break;
    plain.push(word);
  }
  if (plain.length === 1 && words[1] !== undefined) plain.push(words[1]);
  return plain.join(" ").slice(0, 60);
}

/** What a session record's command says of it: the program and why, for one left running or escaped. */
function describeSession(s: SessionProcessSummary): { name: string; why?: string } {
  const m = s.command.match(/^(.+?), (left running by|started outside JaiRA by) `([\s\S]*)`$/);
  if (m === null) return { name: processDisplayName(s.command) };
  const [, program, how, by] = m;
  if (s.how === "escaped") return { name: program!, why: `${how} \`${by}\`` };
  return { name: program!.replace(/\.exe$/i, ""), why: `${how} \`${by}\`` };
}

const ORIGIN_OF: Record<SessionProcessSummary["how"], ProcessOrigin> = { background: "background", left: "left", escaped: "escaped", native: "native" };

/** Escapes and carriage returns out, for matching a line as it reads. */
function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g, "").replace(/\r(?!\n)/g, "\n").replace(/\r/g, "");
}

export class ProcessHub {
  private readonly entries = new Map<string, Entry>();
  /** What a task let go: its later news is not taken back in. */
  private readonly letGo = new WeakSet<object>();
  private readonly lettingGo = new Set<string>();
  /** `this-turn` commands not yet a second old: taken in if they are still running then. */
  private readonly pendingTurns = new Map<string, { timer: ReturnType<typeof setTimeout>; taskId: string }>();
  private readonly pending = new Set<string>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private watchers = 0;
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  private sampling: Promise<void> | undefined;
  private lastSample: ProcessSample | undefined;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly options: ProcessHubOptions) {
    this.now = options.now ?? Date.now;
  }

  // --- what comes in ---------------------------------------------------------------------------

  /** A task's process record started, ended, or was told — `SessionProcesses`' `onChange`. */
  fromSession(taskId: string, project: { dir: string; key: string } | undefined, s: SessionProcessSummary, sp: SessionProcessesLike): void {
    const key = processKey(s.pid, s.startedAt);
    if (this.closed || this.letGo.has(sp) || this.discarded.has(key)) return;
    let entry = this.entries.get(key);
    const described = describeSession(s);
    if (entry === undefined) {
      entry = {
        summary: {
          key,
          processTaskId: processTaskIdOf(s.pid, s.startedAt),
          taskId,
          ...(project !== undefined ? { project: project.dir } : {}),
          machine: this.options.machine(),
          pid: s.pid,
          startedAt: s.startedAt,
          command: s.command,
          name: described.name,
          ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
          origin: ORIGIN_OF[s.how],
          ...(described.why !== undefined ? { why: described.why } : {}),
          startedBy: "session",
          state: "starting",
          states: [],
          ports: [],
          load: [],
          ...(s.callId !== undefined ? { callId: s.callId } : {}),
          ...(s.how === "background" && s.callId !== undefined ? { terminal: s.callId } : {}),
          output: { source: "unreadable" },
        },
        source: { kind: "session", sp },
        ...(project !== undefined ? { projectKey: project.key } : {}),
        running: s.running,
        sampled: false,
      };
      this.entries.set(key, entry);
      this.armStarting(entry);
    }
    entry.running = s.running;
    if (s.stopped === true) entry.stopped = true;
    const summary = entry.summary;
    summary.output = s.output === "spawned" ? { source: "spawned" } : s.output === "file" ? { source: "file", ...(s.outputPath !== undefined ? { path: s.outputPath } : {}) } : { source: summary.output.source === "console" ? "console" : "unreadable", ...(s.unreadableWhy !== undefined ? { why: s.unreadableWhy } : {}) };
    if (s.told === true) summary.told = true;
    if (!s.running) {
      summary.exitCode = s.exitCode ?? null;
      summary.signal = s.signal ?? null;
      if (s.endedAt !== undefined) summary.endedAt = s.endedAt;
      this.ended(entry);
    }
    if (entry.summary.terminal !== undefined) entry.waiting = this.options.terminal?.(taskId, entry.summary.terminal)?.waiting === true;
    this.settle(entry);
  }

  /** A spawned session process printed — `SessionProcesses`' `onOutput`. */
  output(s: { pid: number; startedAt: number }, text: string): void {
    const entry = this.entries.get(processKey(s.pid, s.startedAt));
    if (entry?.tell !== undefined) this.feed(entry, text);
  }

  /** A terminal started, was typed into, waits, or ended — the `this-turn` commands, and a background one's waiting. */
  fromTerminal(t: TerminalSummary): void {
    if (this.closed) return;
    if (t.shell === "background") {
      // A background process's own terminal: whether it waits for input.
      for (const entry of this.entries.values()) {
        if (entry.summary.taskId !== t.taskId || entry.summary.terminal !== t.callId) continue;
        entry.waiting = t.waiting === true && t.endedAt === undefined;
        this.settle(entry);
      }
      return;
    }
    if (t.pid === undefined || this.lettingGo.has(t.taskId)) return;
    const key = processKey(t.pid, t.startedAt);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      if (t.endedAt !== undefined) {
        const timer = this.pendingTurns.get(key)?.timer;
        if (timer !== undefined) clearTimeout(timer);
        this.pendingTurns.delete(key);
        return;
      }
      if (this.pendingTurns.has(key)) return;
      const timer = setTimeout(() => {
        this.pendingTurns.delete(key);
        const now = this.options.terminal?.(t.taskId, t.callId);
        if (now === undefined || now.endedAt !== undefined || this.closed) return;
        this.addTurn(now);
      }, THIS_TURN_AFTER_MS);
      timer.unref?.();
      this.pendingTurns.set(key, { timer, taskId: t.taskId });
      return;
    }
    if (t.endedAt !== undefined) {
      this.drop(entry);
      return;
    }
    entry.waiting = t.waiting === true;
    this.settle(entry);
  }

  private addTurn(t: TerminalSummary): void {
    const key = processKey(t.pid!, t.startedAt);
    const project = t.project !== undefined ? (this.options.project?.(t.project) ?? { dir: t.project, key: t.project }) : undefined;
    const entry: Entry = {
      summary: {
        key,
        processTaskId: processTaskIdOf(t.pid!, t.startedAt),
        taskId: t.taskId,
        ...(project !== undefined ? { project: project.dir } : {}),
        machine: this.options.machine(),
        pid: t.pid!,
        startedAt: t.startedAt,
        command: t.command,
        name: processDisplayName(t.command),
        ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
        origin: "this-turn",
        by: t.by,
        startedBy: "session",
        state: "starting",
        states: [],
        ports: [],
        load: [],
        callId: t.callId,
        terminal: t.callId,
        output: { source: "spawned" },
      },
      source: { kind: "terminal", callId: t.callId },
      ...(project !== undefined ? { projectKey: project.key } : {}),
      running: true,
      waiting: t.waiting === true,
      sampled: false,
    };
    this.entries.set(key, entry);
    this.armStarting(entry);
    this.settle(entry);
    this.schedule();
  }

  /**
   * A task let its processes go (archived, deleted, moved, the app quit): its process tasks leave, and
   * what its records say from now on (the stops just sent) is not taken back in.
   */
  letGoOf(taskId: string, sp?: object): void {
    if (sp !== undefined) this.letGo.add(sp);
    this.lettingGo.add(taskId);
    queueMicrotask(() => this.lettingGo.delete(taskId));
    for (const entry of [...this.entries.values()]) if (entry.summary.taskId === taskId) this.drop(entry);
    for (const [key, pending] of this.pendingTurns) {
      if (pending.taskId !== taskId) continue;
      clearTimeout(pending.timer);
      this.pendingTurns.delete(key);
    }
  }

  // --- what the window asks ---------------------------------------------------------------------

  /** The processes kept, of one task, of one project (its engine key), or all; live first, then newest. */
  list(filter: { taskId?: string; projectKey?: string } = {}): ProcessSummary[] {
    return [...this.entries.values()]
      .filter((e) => (filter.taskId === undefined || e.summary.taskId === filter.taskId) && (filter.projectKey === undefined || e.projectKey === filter.projectKey))
      .map((e) => this.copy(e))
      .sort((a, b) => Number(processEnded(a.state)) - Number(processEnded(b.state)) || b.startedAt - a.startedAt);
  }

  /** One, by key or by its process task's id. */
  get(ref: { key?: string; taskId?: string }): ProcessSummary | null {
    const entry = this.find(ref);
    return entry === undefined ? null : this.copy(entry);
  }

  /** Whether a process task with this id is kept. */
  has(processTaskId: string): boolean {
    return this.find({ taskId: processTaskId }) !== undefined;
  }

  /** The same scope's processes as a tree: what each started (from the last sample), an escaped one under its real parent. */
  async tree(filter: { taskId?: string; projectKey?: string } = {}): Promise<ProcessTreeNode[]> {
    const shown = this.list(filter);
    if (this.lastSample === undefined && shown.some((p) => !processEnded(p.state))) await this.sampleNow();
    const sample = this.lastSample;
    const kept = new Map(shown.map((p) => [p.pid, p] as const));
    const nodeOf = (pid: number, depth: number, seen: Set<number>): ProcessTreeNode | undefined => {
      const row = sample?.rows.get(pid);
      const own = kept.get(pid);
      if (own === undefined && row === undefined) return undefined;
      seen.add(pid);
      const process = own ?? this.rowSummary({ pid, name: row?.name ?? String(pid), ...(row?.parentPid !== undefined ? { parent_pid: row.parentPid } : {}), ...(row?.startedAt !== undefined ? { started: new Date(row.startedAt).toISOString() } : {}), ...(row?.memoryMb !== undefined ? { memory_mb: row.memoryMb } : {}), started_by: "session" });
      const children = depth > 32 || own !== undefined && processEnded(own.state) ? [] : this.childrenOf(pid, sample).filter((c) => !seen.has(c) && !kept.has(c)).flatMap((c) => nodeOf(c, depth + 1, seen) ?? []);
      return { process, children };
    };
    const roots: ProcessTreeNode[] = [];
    const byParent = new Map<number, ProcessTreeNode>();
    for (const p of shown) {
      const node = nodeOf(p.pid, 0, new Set()) ?? { process: p, children: [] };
      // What got out hangs under the program that really started it (WmiPrvSE.exe, the Task Scheduler).
      const parentPid = p.parentPid ?? sample?.rows.get(p.pid)?.parentPid;
      if (p.origin === "escaped" && parentPid !== undefined && !kept.has(parentPid)) {
        let parent = byParent.get(parentPid);
        if (parent === undefined) {
          const row = sample?.rows.get(parentPid);
          parent = { process: this.rowSummary({ pid: parentPid, name: row?.name ?? `pid ${parentPid}`, ...(row?.startedAt !== undefined ? { started: new Date(row.startedAt).toISOString() } : {}), started_by: "system" }), children: [] };
          byParent.set(parentPid, parent);
          roots.push(parent);
        }
        parent.children.push(node);
        continue;
      }
      roots.push(node);
    }
    return roots;
  }

  /** A machine scope's rows as summaries: a kept process drawn as kept; the rest as the machine says. */
  machineList(rows: readonly MachineRow[], protectedWhy?: ReadonlyMap<number, string>): ProcessSummary[] {
    const kept = new Map([...this.entries.values()].filter((e) => e.running).map((e) => [e.summary.pid, e] as const));
    return rows.map((row) => {
      const own = kept.get(row.pid);
      if (own !== undefined) return this.copy(own);
      const summary = this.rowSummary(row);
      const why = protectedWhy?.get(row.pid);
      return why !== undefined ? { ...summary, protected: why } : summary;
    });
  }

  /** A machine scope's rows as a forest, by parent pid. */
  machineTree(rows: readonly MachineRow[], protectedWhy?: ReadonlyMap<number, string>): ProcessTreeNode[] {
    const summaries = this.machineList(rows, protectedWhy);
    const nodes = new Map(summaries.map((p) => [p.pid, { process: p, children: [] as ProcessTreeNode[] }] as const));
    const roots: ProcessTreeNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.pid)!;
      const parent = row.parent_pid !== undefined && row.parent_pid !== row.pid ? nodes.get(row.parent_pid) : undefined;
      if (parent !== undefined && parent.process.startedAt <= node.process.startedAt) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  /** What a process printed from `since`: its kept output, its terminal's, or followed where it writes. */
  async read(key: string, since = 0): Promise<ProcessReadAnswer> {
    const entry = this.need(key);
    const s = entry.summary;
    if (entry.source.kind === "session" && s.output.source === "spawned") {
      const peek = entry.source.sp.peek(s.pid, s.startedAt, since);
      if (peek !== undefined) return { key, source: "spawned", output: peek.output, offset: peek.offset, whole: peek.dropped === undefined && since === 0 };
    }
    if (entry.source.kind === "terminal" && s.taskId !== undefined) {
      const read = this.options.terminalRead?.(s.taskId, entry.source.callId);
      if (read != null) {
        const from = Math.max(0, since - read.summary.dropped);
        return { key, source: "spawned", output: read.output.slice(from), offset: read.summary.length, whole: read.summary.dropped === 0 && since === 0 };
      }
    }
    if (!entry.running) return { key, source: s.output.source, output: "", offset: since, whole: false, ...(s.output.path !== undefined ? { path: s.output.path } : {}), why: s.output.source === "file" && s.output.path !== undefined ? `it has ended; what it wrote is in ${s.output.path}` : "it has ended, and its output was not JaiRA's to keep" };
    if (this.options.outputs === undefined) return { key, source: "unreadable", output: "", offset: since, whole: false, why: s.output.why ?? `another program's output cannot be followed on this machine (${process.platform})` };
    const read = await this.options.outputs.read(s.pid, { since });
    if (read.source === "unreadable") {
      this.setSource(entry, { source: "unreadable", why: read.why });
      return { key, source: "unreadable", output: "", offset: since, whole: false, why: read.why };
    }
    this.setSource(entry, { source: read.source, ...(read.path !== undefined ? { path: read.path } : {}) });
    const from = Date.parse(read.from);
    return { key, source: read.source, output: read.output, offset: read.offset, whole: read.whole, ...(Number.isNaN(from) ? {} : { from }), ...(read.path !== undefined ? { path: read.path } : {}) };
  }

  /** Stop it and what it started, or send it Ctrl-C. The person's: no permission set is asked. */
  async stop(key: string, signal: TerminalSignal = "stop"): Promise<{ stopped: boolean; why?: string }> {
    const entry = this.need(key);
    const s = entry.summary;
    if (!entry.running) return { stopped: false, why: "it has already ended" };
    if (s.protected !== undefined) return { stopped: false, why: s.protected };
    if (entry.source.kind === "session") {
      const was = entry.source.sp.stopKey(s.pid, s.startedAt, signal);
      if (was === undefined) return { stopped: false, why: "its task no longer keeps it" };
      if (signal === "stop") {
        entry.stopped = true;
        this.settle(entry);
      }
      return { stopped: true };
    }
    if (entry.source.kind === "terminal") {
      const sent = s.taskId !== undefined && (this.options.terminalSignal?.(s.taskId, entry.source.callId, signal) ?? false);
      return sent ? { stopped: true } : { stopped: false, why: "its command has ended" };
    }
    if (this.options.stopMachine === undefined) return { stopped: false, why: `stopping another program is not built on this machine (${process.platform})` };
    const done = await this.options.stopMachine(s.pid, s.startedAt, signal);
    if (done.stopped && signal === "stop") {
      entry.stopped = true;
      this.settle(entry);
    }
    return done;
  }

  /**
   * Watch a machine process: a process task of origin `watched`, with no parent, listed under
   * `project`, until it is unwatched or gone. One a task already keeps is answered as it is.
   */
  watch(row: MachineRow, project: { dir: string; key: string } | undefined): ProcessSummary {
    const startedAt = this.startedOf(row);
    const key = processKey(row.pid, startedAt);
    const kept = this.entries.get(key) ?? [...this.entries.values()].find((e) => e.running && e.summary.pid === row.pid);
    if (kept !== undefined) return this.copy(kept);
    const base = this.rowSummary(row);
    const entry: Entry = {
      summary: { ...base, key, processTaskId: processTaskIdOf(row.pid, startedAt), origin: "watched", ...(project !== undefined ? { project: project.dir } : {}) },
      source: { kind: "watched" },
      ...(project !== undefined ? { projectKey: project.key } : {}),
      running: true,
      sampled: false,
    };
    this.entries.set(key, entry);
    this.armStarting(entry);
    this.settle(entry);
    void this.sampleNow();
    return this.copy(entry);
  }

  /**
   * A process task deleted or archived: stopped if it runs (a watched one is only let go — it was never
   * this engine's), and let go. False when no such process task is kept.
   */
  discard(processTaskId: string): boolean {
    const entry = this.find({ taskId: processTaskId });
    if (entry === undefined) return false;
    if (entry.running && entry.source.kind !== "watched") void this.stop(entry.summary.key).catch(() => undefined);
    // Its stop's news is not taken back in: a session record that ends now is let go already.
    if (entry.source.kind === "session") this.discarded.add(entry.summary.key);
    this.drop(entry);
    return true;
  }

  /** Session records deleted or archived as process tasks: what they say later is not taken in. */
  private readonly discarded = new Set<string>();

  unwatch(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.source.kind !== "watched") return false;
    this.drop(entry);
    return true;
  }

  /**
   * "Tell Claude when it prints…": a one-shot pattern on a task's process. Refused (thrown) for one with
   * no task, one that ended, a command of this turn, and one whose output cannot be read.
   */
  async tellWhen(key: string, pattern: string, flags?: string): Promise<ProcessSummary> {
    const entry = this.need(key);
    const s = entry.summary;
    if (s.taskId === undefined) throw new Error(`${s.name} (${s.pid}) is no task's process: there is no conversation to tell`);
    if (!entry.running) throw new Error(`${s.name} (${s.pid}) has ended`);
    if (entry.source.kind === "terminal") throw new Error(`${s.name} is a command of this turn: its result reaches Claude when it ends`);
    const safeFlags = (flags ?? "").replace(/[^imsu]/g, "");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, safeFlags);
    } catch (error) {
      throw new Error(`not a pattern: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (pattern.length === 0) throw new Error("a pattern cannot be empty");
    this.disarm(entry);
    const tell: Tell = { pattern: regex, partial: "", before: [] };
    if (s.output.source !== "spawned") {
      if (this.options.outputs === undefined) throw new Error(s.output.why ?? `its output cannot be followed on this machine (${process.platform})`);
      // Following starts now; what it wrote before is not what was asked about.
      const first = await this.options.outputs.read(s.pid, {});
      if (first.source === "unreadable") {
        this.setSource(entry, { source: "unreadable", why: first.why });
        throw new Error(`its output cannot be read: ${first.why}`);
      }
      this.setSource(entry, { source: first.source, ...(first.path !== undefined ? { path: first.path } : {}) });
      const outputs = this.options.outputs;
      tell.follow = setInterval(() => {
        if (entry.tell !== tell) return;
        void outputs.read(s.pid, {}).then(
          (read) => {
            if (entry.tell === tell && read.source !== "unreadable" && read.output.length > 0) this.feed(entry, read.output);
          },
          () => undefined,
        );
      }, TELL_FOLLOW_MS);
      tell.follow.unref?.();
    }
    entry.tell = tell;
    s.tellWhen = { pattern, ...(safeFlags.length > 0 ? { flags: safeFlags } : {}), armedAt: this.now() };
    this.settle(entry, true);
    return this.copy(entry);
  }

  tellCancel(key: string): ProcessSummary | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.disarm(entry);
    this.settle(entry, true);
    return this.copy(entry);
  }

  /** A window started or stopped showing processes' readings. */
  setSampling(watching: boolean): void {
    this.watchers = Math.max(0, this.watchers + (watching ? 1 : -1));
    if (watching && this.watchers === 1) void this.sampleNow();
    else this.planSample();
  }

  // --- process tasks -----------------------------------------------------------------------------

  /** The process tasks kept, as task rows: of one project (its engine key), of some ids, or all. */
  tasks(filter: { projectKey?: string; ids?: ReadonlySet<string> } = {}): ProjectTask[] {
    const out: ProjectTask[] = [];
    for (const entry of this.entries.values()) {
      const id = entry.summary.processTaskId;
      if (id === undefined) continue;
      if (filter.projectKey !== undefined && entry.projectKey !== filter.projectKey) continue;
      if (filter.ids !== undefined && !filter.ids.has(id)) continue;
      out.push(this.taskOf(entry));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** A process task's detail: what its task view draws — the process whole. */
  detail(processTaskId: string): TaskDetail | undefined {
    const entry = this.find({ taskId: processTaskId });
    if (entry === undefined) return undefined;
    const task = this.taskOf(entry);
    return {
      taskId: task.taskId,
      title: task.title,
      workflow: PROCESS_WORKFLOW,
      status: task.status,
      createdAt: task.createdAt,
      instances: [],
      activePath: [{ instanceId: entry.summary.key, stateId: entry.summary.state }],
      blocked: [],
      runs: [],
      timeline: [],
      type: "process",
      process: this.copy(entry),
    };
  }

  /** The board's `Process` column (the root listing) for a project. */
  rootColumn(projectKey: string): BoardView["columns"][number] {
    return { key: PROCESS_WORKFLOW, stateId: PROCESS_WORKFLOW, label: PROCESS_WORKFLOW, cards: this.cards(projectKey) };
  }

  /** The `Process` workflow opened: a lane per state, the ended ones also under `finished`. */
  board(projectKey: string): BoardView {
    const cards = this.cards(projectKey);
    return {
      level: PROCESS_WORKFLOW,
      label: PROCESS_WORKFLOW,
      breadcrumb: [{ stateId: PROCESS_WORKFLOW, label: PROCESS_WORKFLOW }],
      columns: PROCESS_STATES.map((state) => ({ key: state, stateId: state, label: STATE_LABEL[state], cards: cards.filter((c) => c.process?.state === state) })),
      atLevel: [],
      finished: cards.filter((c) => c.process !== undefined && processEnded(c.process.state)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    };
  }

  private cards(projectKey: string): BoardCard[] {
    return [...this.entries.values()]
      .filter((e) => e.summary.processTaskId !== undefined && e.projectKey === projectKey)
      .map((e) => {
        const task = this.taskOf(e);
        return {
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          workflow: PROCESS_WORKFLOW,
          activeStateId: e.summary.state,
          activePath: [{ instanceId: e.summary.key, stateId: e.summary.state }],
          hasSubBoard: false,
          type: "process" as const,
          process: task.process!,
          updatedAt: task.updatedAt,
          createdAt: e.summary.startedAt,
          ...(e.summary.endedAt !== undefined ? { endedAt: e.summary.endedAt } : {}),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private taskOf(entry: Entry): ProjectTask {
    const s = entry.summary;
    return {
      taskId: s.processTaskId!,
      title: s.name,
      status: processTaskStatus(s.state),
      workflow: PROCESS_WORKFLOW,
      ...(s.taskId !== undefined ? { parentTaskId: s.taskId } : {}),
      type: "process",
      process: this.factsOf(entry),
      createdAt: new Date(s.startedAt).toISOString(),
      updatedAt: s.states.at(-1)?.at ?? s.startedAt,
      project: s.project ?? "",
    };
  }

  private factsOf(entry: Entry): ProcessTaskFacts {
    const s = entry.summary;
    return {
      key: s.key,
      pid: s.pid,
      state: s.state,
      origin: s.origin ?? "watched",
      ...(s.why !== undefined ? { why: s.why } : {}),
      ...(s.taskId !== undefined ? { parentTaskId: s.taskId } : {}),
      ports: [...s.ports],
      machine: s.machine,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s.signal !== undefined ? { signal: s.signal } : {}),
      ...(s.told === true ? { told: true } : {}),
      ...(s.tellWhen !== undefined ? { armed: true as const } : {}),
    };
  }

  close(): void {
    this.closed = true;
    if (this.sampleTimer !== undefined) clearTimeout(this.sampleTimer);
    if (this.pushTimer !== undefined) clearTimeout(this.pushTimer);
    for (const pending of this.pendingTurns.values()) clearTimeout(pending.timer);
    for (const entry of this.entries.values()) {
      this.disarm(entry);
      if (entry.startTimer !== undefined) clearTimeout(entry.startTimer);
    }
  }

  // --- inside -----------------------------------------------------------------------------------

  private find(ref: { key?: string; taskId?: string }): Entry | undefined {
    if (ref.key !== undefined) return this.entries.get(ref.key);
    if (ref.taskId !== undefined) for (const entry of this.entries.values()) if (entry.summary.processTaskId === ref.taskId) return entry;
    return undefined;
  }

  private need(key: string): Entry {
    const entry = this.entries.get(key);
    if (entry === undefined) throw new Error(`no process ${key} is kept here — it ended and was let go, or it is another machine's`);
    return entry;
  }

  private copy(entry: Entry): ProcessSummary {
    const s = entry.summary;
    return { ...s, states: s.states.map((step) => ({ ...step })), ports: [...s.ports], load: [...s.load], output: { ...s.output }, ...(s.children !== undefined ? { children: [...s.children] } : {}), ...(s.tellWhen !== undefined ? { tellWhen: { ...s.tellWhen } } : {}) };
  }

  private startedOf(row: MachineRow): number {
    const t = row.started !== undefined ? Date.parse(row.started) : NaN;
    return Number.isNaN(t) ? 0 : t;
  }

  private rowSummary(row: MachineRow): ProcessSummary {
    const startedAt = this.startedOf(row);
    const sampled = this.lastSample?.rows.get(row.pid);
    const ports = this.lastSample?.ports.get(row.pid) ?? [];
    const memory = row.memory_mb ?? sampled?.memoryMb;
    return {
      key: processKey(row.pid, startedAt),
      machine: this.options.machine(),
      pid: row.pid,
      startedAt,
      command: row.path ?? row.name,
      name: row.name,
      startedBy: row.started_by ?? "system",
      ...(row.user !== undefined ? { account: row.user } : {}),
      state: ports.length > 0 ? "listening" : "running",
      states: [],
      ports: [...ports],
      ...(memory !== undefined ? { memoryMb: memory } : {}),
      load: [],
      output: { source: "unreadable", why: "not read until it is watched or read" },
      ...(row.parent_pid !== undefined ? { parentPid: row.parent_pid } : {}),
    };
  }

  private setSource(entry: Entry, output: ProcessSummary["output"]): void {
    if (entry.summary.output.source === output.source && entry.summary.output.path === output.path) return;
    entry.summary.output = output;
    this.settle(entry, true);
  }

  /** A new process is `starting` for a moment, then `running` whether or not a sample has come. */
  private armStarting(entry: Entry): void {
    const left = STARTING_MS - (this.now() - entry.summary.startedAt);
    entry.startTimer = setTimeout(() => {
      delete entry.startTimer;
      this.settle(entry);
    }, Math.max(0, left) + 5);
    entry.startTimer.unref?.();
    this.planSample();
  }

  private ended(entry: Entry): void {
    this.disarm(entry);
    if (entry.startTimer !== undefined) clearTimeout(entry.startTimer);
    delete entry.startTimer;
    entry.waiting = false;
    entry.summary.ports = [];
    delete entry.summary.cpu;
  }

  /** Derive its state again; push and stamp what moved. `shown`: something besides the state moved. */
  private settle(entry: Entry, shown = false): void {
    const s = entry.summary;
    const state = deriveProcessState({
      running: entry.running,
      ...(entry.stopped === true ? { stopped: true } : {}),
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
      ...(s.signal !== undefined ? { signal: s.signal } : {}),
      ...(entry.waiting === true ? { waiting: true } : {}),
      ports: s.ports,
      sampled: entry.sampled,
      age: this.now() - s.startedAt,
    });
    const moved = s.states.at(-1)?.state !== state;
    if (moved) {
      s.state = state;
      s.states.push({ state, at: this.now() });
    }
    if (moved || shown || entry.facts === undefined) this.dirty(entry);
  }

  private dirty(entry: Entry): void {
    this.pending.add(entry.summary.key);
    this.schedule();
  }

  private schedule(): void {
    if (this.pushTimer !== undefined || this.closed) return;
    this.pushTimer = setTimeout(() => this.flush(), PUSH_EVERY_MS);
    this.pushTimer.unref?.();
  }

  private flush(): void {
    this.pushTimer = undefined;
    const keys = [...this.pending];
    this.pending.clear();
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      const process = this.copy(entry);
      this.options.publish({ type: "process:state", ...(process.project !== undefined ? { project: process.project } : {}), process });
      const id = entry.summary.processTaskId;
      if (id === undefined) continue;
      const facts = JSON.stringify([this.factsOf(entry), entry.summary.name]);
      if (facts === entry.facts) continue;
      entry.facts = facts;
      this.options.touch?.(id, false);
    }
  }

  /** Let a process go: its pushes, its pattern, and its row in every window's index. */
  private drop(entry: Entry): void {
    const s = entry.summary;
    this.disarm(entry);
    if (entry.startTimer !== undefined) clearTimeout(entry.startTimer);
    this.entries.delete(s.key);
    this.pending.delete(s.key);
    this.options.publish({ type: "process:gone", ...(s.project !== undefined ? { project: s.project } : {}), key: s.key, ...(s.processTaskId !== undefined ? { processTaskId: s.processTaskId } : {}) });
    if (s.processTaskId !== undefined && entry.facts !== undefined) this.options.touch?.(s.processTaskId, true);
  }

  // --- "Tell Claude when it prints…" ----------------------------------------------------------------

  private disarm(entry: Entry): void {
    const tell = entry.tell;
    if (tell === undefined) return;
    if (tell.follow !== undefined) clearInterval(tell.follow);
    if (tell.after !== undefined) clearTimeout(tell.after.timer);
    delete entry.tell;
    delete entry.summary.tellWhen;
  }

  /** New output for an armed pattern: complete lines are matched; the lines after a match are waited for briefly. */
  private feed(entry: Entry, text: string): void {
    const tell = entry.tell;
    if (tell === undefined) return;
    const lines = (tell.partial + plainText(text)).split("\n");
    tell.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (entry.tell !== tell) return;
      if (tell.after !== undefined) {
        tell.after.lines.push(line);
        if (tell.after.lines.length >= TELL_AFTER) this.fire(entry, tell);
        continue;
      }
      tell.pattern.lastIndex = 0;
      if (tell.pattern.test(line)) {
        const timer = setTimeout(() => this.fire(entry, tell), TELL_AFTER_MS);
        timer.unref?.();
        tell.after = { line, before: [...tell.before], lines: [], timer };
        continue;
      }
      tell.before.push(line);
      if (tell.before.length > TELL_BEFORE) tell.before.shift();
    }
  }

  /** Once: the task is told, and the pattern is disarmed. */
  private fire(entry: Entry, tell: Tell): void {
    if (entry.tell !== tell || tell.after === undefined) return;
    const s = entry.summary;
    const { line, before, lines } = tell.after;
    const armed = s.tellWhen;
    this.disarm(entry);
    s.toldWhen = { pattern: armed?.pattern ?? tell.pattern.source, line, at: this.now() };
    this.settle(entry, true);
    const shown = `/${armed?.pattern ?? tell.pattern.source}/${armed?.flags ?? ""}`;
    const fence = [...before, line, ...lines].join("\n").replace(/```/g, "ʼʼʼ");
    const message = `\`${s.command}\` (pid ${s.pid}) printed a line matching ${shown}. The person asked to be told when it did:\n\n\`\`\`\n${fence}\n\`\`\``;
    if (s.taskId === undefined || this.options.tell === undefined) return;
    void this.options.tell(s.taskId, s.project, message).catch((error: unknown) => this.options.log?.("warn", `could not tell the task that \`${s.command}\` (${s.pid}) printed ${shown}: ${error instanceof Error ? error.message : String(error)}`, s.taskId));
  }

  // --- samples ------------------------------------------------------------------------------------

  private live(): Entry[] {
    return [...this.entries.values()].filter((e) => e.running);
  }

  /** The next sample: soon while a window watches, slowly otherwise, none while nothing runs. */
  private planSample(): void {
    if (this.closed || this.options.sampler === undefined) return;
    if (this.sampleTimer !== undefined) clearTimeout(this.sampleTimer);
    this.sampleTimer = undefined;
    if (this.live().length === 0) return;
    const every = this.watchers > 0 ? (this.options.everyMs ?? SAMPLE_EVERY_MS) : (this.options.idleEveryMs ?? IDLE_SAMPLE_EVERY_MS);
    this.sampleTimer = setTimeout(() => void this.sampleNow(), every);
    this.sampleTimer.unref?.();
  }

  /** Sample now (one at a time), take the readings in, and plan the next. */
  sampleNow(): Promise<void> {
    if (this.sampling !== undefined) return this.sampling;
    const sampler = this.options.sampler;
    if (sampler === undefined || this.closed) return Promise.resolve();
    const live = this.live();
    if (live.length === 0) return Promise.resolve();
    this.sampling = sampler(live.map((e) => e.summary.pid))
      .then(
        (sample) => this.take(sample),
        (error: unknown) => this.options.log?.("warn", `could not sample the running processes: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        this.sampling = undefined;
        this.planSample();
      });
    return this.sampling;
  }

  /** A sample's readings into each running process: its tree's CPU, memory and ports, and its children. */
  take(sample: ProcessSample): void {
    this.lastSample = sample;
    const stats: ProcessStats[] = [];
    for (const entry of this.live()) {
      const s = entry.summary;
      const row = sample.rows.get(s.pid);
      if (row === undefined) {
        // A watched process the machine no longer has: gone, its exit unknown.
        if (entry.source.kind === "watched" && sample.complete) {
          entry.running = false;
          s.exitCode = null;
          s.endedAt = sample.at;
          this.ended(entry);
          this.settle(entry, true);
        }
        continue;
      }
      if (entry.source.kind === "watched" && row.startedAt !== undefined && s.startedAt !== 0 && Math.abs(row.startedAt - s.startedAt) > 2_000) {
        // The pid names another process now.
        entry.running = false;
        s.exitCode = null;
        s.endedAt = sample.at;
        this.ended(entry);
        this.settle(entry, true);
        continue;
      }
      const tree = withTrees(sample.rows, [s.pid]);
      let cpuSeconds: number | undefined;
      let memory: number | undefined;
      const ports = new Set<number>();
      for (const pid of tree) {
        const r = sample.rows.get(pid);
        if (r?.cpuSeconds !== undefined) cpuSeconds = (cpuSeconds ?? 0) + r.cpuSeconds;
        if (r?.memoryMb !== undefined) memory = (memory ?? 0) + r.memoryMb;
        for (const port of sample.ports.get(pid) ?? []) ports.add(port);
      }
      const before = JSON.stringify([s.ports, s.cpu, s.memoryMb, s.children, s.parentPid]);
      const portsNow = [...ports].sort((a, b) => a - b);
      const portsMoved = portsNow.join(",") !== s.ports.join(",");
      s.ports = portsNow;
      if (cpuSeconds !== undefined) {
        if (entry.cpuSeen !== undefined && sample.at > entry.cpuSeen.at) {
          const percent = Math.max(0, ((cpuSeconds - entry.cpuSeen.seconds) / ((sample.at - entry.cpuSeen.at) / 1000)) * 100);
          s.cpu = Math.round(percent * 10) / 10;
          s.load.push(s.cpu);
          if (s.load.length > PROCESS_LOAD_SAMPLES) s.load.splice(0, s.load.length - PROCESS_LOAD_SAMPLES);
        }
        entry.cpuSeen = { seconds: cpuSeconds, at: sample.at };
      }
      if (memory !== undefined) s.memoryMb = Math.round(memory * 10) / 10;
      if (row.parentPid !== undefined) s.parentPid = row.parentPid;
      s.children = this.childrenOf(s.pid, sample);
      entry.sampled = true;
      if (JSON.stringify([s.ports, s.cpu, s.memoryMb, s.children, s.parentPid]) !== before || s.load.length > 0) {
        stats.push({ key: s.key, ...(s.cpu !== undefined ? { cpu: s.cpu } : {}), ...(s.memoryMb !== undefined ? { memoryMb: s.memoryMb } : {}), ports: [...s.ports], load: [...s.load], ...(s.parentPid !== undefined ? { parentPid: s.parentPid } : {}), children: [...s.children] });
      }
      this.settle(entry, portsMoved);
    }
    if (stats.length > 0) this.options.publish({ type: "process:stats", stats });
  }

  private childrenOf(pid: number, sample: ProcessSample | undefined): number[] {
    if (sample === undefined) return [];
    const parent = sample.rows.get(pid);
    const out: number[] = [];
    for (const row of sample.rows.values()) {
      if (row.parentPid !== pid || row.pid === pid) continue;
      if (parent?.startedAt !== undefined && row.startedAt !== undefined && row.startedAt < parent.startedAt) continue;
      out.push(row.pid);
    }
    return out.sort((a, b) => a - b);
  }
}

const STATE_LABEL: Record<ProcessState, string> = {
  starting: "starting",
  running: "running",
  listening: "listening",
  waiting: "waiting for input",
  exited: "exited 0",
  failed: "exited ≠ 0",
  stopped: "stopped",
};

export type { ProcessOutputSource };
