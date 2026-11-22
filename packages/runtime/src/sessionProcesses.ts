/**
 * The processes a task's agent started and left running (decision 0032): what `shell` started with
 * `run_in_background`, and what a foreground call left behind that the session was allowed to keep.
 *
 * One record per process, keyed by pid and start time (a pid alone is reused). The agent works in pids
 * (`read_process`, `wait_process`, `stop_process`, `list_processes --scope=session`); the person sees
 * the same record as a terminal. Output is kept for what JaiRA spawned with pipes it holds: the last
 * {@link OUTPUT_KEEP} characters, with each reader's place in it, so `read_process` answers what is new
 * since the agent last looked.
 *
 * A process ends here when it exits, when the agent or the person stops it, or when the task lets it go
 * ({@link SessionProcesses.stopAll}). Each end is said once, as a note the next tool result carries.
 */
import type { Exec, ExecIo } from "./exec";
import type { ExecEnv } from "./paths";
import type { ContainmentGroup } from "./containment";

/** How much of a process's output is kept: the last million characters, as a terminal's. */
export const OUTPUT_KEEP = 1_000_000;

/** How long a background start waits before answering, so a process that fails at once is seen failing. */
export const START_SETTLE_MS = 2_000;

/** `wait_process`'s default and longest wait. */
export const PROCESS_WAIT_DEFAULT_MS = 30_000;
export const PROCESS_WAIT_MAX_MS = 10 * 60_000;

/**
 * How the session came to have it: started with `run_in_background`, left running by a command the
 * session was allowed to keep it from, or started outside every tree JaiRA follows (`escaped`, ruling 7).
 */
export type SessionProcessHow = "background" | "left" | "escaped";

export interface SessionProcessSummary {
  pid: number;
  /** Epoch ms. With `pid`, what names it. */
  startedAt: number;
  command: string;
  cwd?: string;
  /** The tool call that started it (the transcript's `tool_use` id). */
  callId?: string;
  how: SessionProcessHow;
  running: boolean;
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: number;
  /** The agent, the person or the task's end stopped it. */
  stopped?: boolean;
  /** Whether its output is kept here (`spawned`) or cannot be read (`unreadable`, with why). */
  output: "spawned" | "unreadable";
  unreadableWhy?: string;
}

export interface ReadAnswer {
  process: SessionProcessSummary;
  /** What it printed since the reader's last read (or the last `tail` lines), stdout and stderr in order. */
  output: string;
  /** Characters dropped from the head before the part answered, because the keep is full. */
  dropped?: number;
  /** Where this reader now stands, to pass back as `since`. */
  offset: number;
}

interface Kept {
  summary: SessionProcessSummary;
  text: string;
  /** Characters ever printed; `text` is the last of them. */
  length: number;
  /** Where the agent last read to. */
  read: number;
  io?: ExecIo;
  /** Stops it when it was not spawned here (left behind): the platform's tree stop. */
  stopOther?: (signal: NodeJS.Signals) => void;
  done: Promise<void>;
  finish: () => void;
  listeners: Set<() => void>;
}

export interface BackgroundStart {
  command: string;
  /** The interpreter and its arguments, the command last. */
  argv: readonly string[];
  cwd?: string;
  execEnv: ExecEnv;
  env?: Record<string, string>;
  callId?: string;
  /** Each chunk as it arrives, for the call's terminal. */
  onOutput?: (text: string) => void;
  /** The process has ended, for the call's terminal. */
  onEnd?: (end: { exitCode: number | null; signal: string | null; stopped: boolean }) => void;
  /** Handed the running process's io, so a terminal can type into and stop it. */
  onStart?: (io: ExecIo) => void;
  /** The session's containment (ruling 7): its argv and environment, and the pid put in its job. */
  contain?: ContainmentGroup;
}

export interface SessionProcessesOptions {
  /** How many may run at once; 0 or absent is no limit (`processes.backgroundLimit`). */
  limit?: () => number;
  /** Told each time a record starts or ends — the engine's push to the window. */
  onChange?: (summary: SessionProcessSummary) => void;
  /** The time, injectable for tests. */
  now?: () => number;
}

export class SessionProcessError extends Error {}

export class SessionProcesses {
  private readonly kept = new Map<string, Kept>();
  private readonly notes: string[] = [];
  private readonly now: () => number;

  constructor(
    private readonly exec: Exec,
    private readonly options: SessionProcessesOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Every record, running ones first, newest first within each. */
  list(): SessionProcessSummary[] {
    return [...this.kept.values()]
      .map((k) => ({ ...k.summary }))
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt);
  }

  running(): SessionProcessSummary[] {
    return this.list().filter((p) => p.running);
  }

  /** The record for `pid`, the latest one if the pid was reused. */
  get(pid: number): SessionProcessSummary | undefined {
    return this.find(pid)?.summary;
  }

  has(pid: number): boolean {
    return this.find(pid) !== undefined;
  }

  /**
   * Start `start.argv` and carry on: the answer comes once it has printed for {@link START_SETTLE_MS}
   * or exited, whichever is first, with what it printed so far.
   */
  async background(start: BackgroundStart, settleMs = START_SETTLE_MS): Promise<ReadAnswer> {
    const limit = this.options.limit?.() ?? 0;
    const running = this.running();
    if (limit > 0 && running.length >= limit) {
      throw new SessionProcessError(
        `this session already has ${running.length} background process${running.length === 1 ? "" : "es"} running, the most it may (processes.backgroundLimit): ${running.map((p) => `${p.pid} \`${p.command}\``).join(", ")}. Stop one with stop_process first.`,
      );
    }
    const [file, ...args] = start.contain?.wrapArgv(start.argv) ?? [...start.argv];
    const env = start.contain !== undefined ? { ...(start.env ?? {}), ...start.contain.env() } : start.env;
    let resolveIo: (io: ExecIo) => void = () => undefined;
    const ioReady = new Promise<ExecIo>((resolve) => (resolveIo = resolve));
    let kept: Kept | undefined;
    const early: string[] = [];
    const onChunk = (text: string): void => {
      if (kept === undefined) early.push(text);
      else this.append(kept, text);
      start.onOutput?.(text);
    };
    const run = this.exec.run(file!, args, {
      ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
      execEnv: start.execEnv,
      ...(env !== undefined ? { env } : {}),
      onOutput: (_stream, chunk) => onChunk(chunk),
      // Interactive: its own process group on POSIX, so a stop reaches what it starts, and its stdin
      // held open (a server that reads it is not handed an EOF).
      interactive: (io) => resolveIo(io),
    });
    const failed = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const io = await Promise.race([ioReady, failed.then((e) => (e === undefined ? undefined : Promise.reject(e)))]);
    if (io === undefined || io.pid === undefined) throw new SessionProcessError(`\`${start.command}\` did not start`);
    // Into the session's job before it has started anything (Windows; a no-op elsewhere).
    void start.contain?.add(io.pid);
    start.onStart?.(io);
    kept = this.record({ pid: io.pid, command: start.command, how: "background", output: "spawned", ...(start.cwd !== undefined ? { cwd: start.cwd } : {}), ...(start.callId !== undefined ? { callId: start.callId } : {}) }, io);
    for (const text of early) this.append(kept, text);
    const k = kept;
    void run.then(
      (result) => {
        this.ended(k, result.code, result.signal);
        start.onEnd?.({ exitCode: result.code, signal: result.signal, stopped: k.summary.stopped === true });
      },
      () => {
        this.ended(k, null, null);
        start.onEnd?.({ exitCode: null, signal: null, stopped: k.summary.stopped === true });
      },
    );
    await Promise.race([k.done, new Promise((resolve) => setTimeout(resolve, settleMs))]);
    return this.read(k.summary.pid);
  }

  /**
   * A process a foreground call left running, kept as the session's (decision 0032, ruling 5). Its
   * output is not this record's: what it writes went wherever it was pointed.
   */
  adopt(left: { pid: number; command: string; how?: "left" | "escaped"; callId?: string; cwd?: string; stop: (signal: NodeJS.Signals) => void; alive: () => boolean }): SessionProcessSummary {
    const how = left.how ?? "left";
    const kept = this.record(
      {
        pid: left.pid,
        command: left.command,
        how,
        output: "unreadable",
        unreadableWhy:
          how === "escaped"
            ? "it was started outside every tree JaiRA follows, so its output was never JaiRA's to keep; read_process with scope `user` follows it where it can"
            : "a command left it running, so its output was never JaiRA's to keep; read_process with scope `user` follows it where it can",
        ...(left.cwd !== undefined ? { cwd: left.cwd } : {}),
        ...(left.callId !== undefined ? { callId: left.callId } : {}),
      },
      undefined,
    );
    kept.stopOther = left.stop;
    // Nothing tells JaiRA when it exits; it is looked at each time it is asked about.
    kept.summary.running = left.alive();
    const poll = setInterval(() => {
      if (!kept.summary.running) return clearInterval(poll);
      if (!left.alive()) {
        clearInterval(poll);
        this.ended(kept, null, null);
      }
    }, 5_000);
    poll.unref?.();
    return { ...kept.summary };
  }

  /**
   * What `pid` printed since the agent last read it — or its last `tail` lines, or from `since` — and
   * where it stands. Reading moves the agent's place.
   */
  read(pid: number, options: { tail?: number; since?: number } = {}): ReadAnswer {
    const kept = this.need(pid);
    const head = kept.length - kept.text.length;
    let from = options.since ?? kept.read;
    let output: string;
    if (options.tail !== undefined) {
      const lines = kept.text.split(/\r?\n/);
      const trailing = lines.at(-1) === "" ? 1 : 0;
      output = lines.slice(Math.max(0, lines.length - options.tail - trailing)).join("\n");
      from = kept.length - output.length;
    } else {
      output = kept.text.slice(Math.max(0, from - head));
    }
    kept.read = kept.length;
    return {
      process: { ...kept.summary },
      output,
      ...(from < head ? { dropped: head - from } : {}),
      offset: kept.length,
    };
  }

  /**
   * Wait until `pid` exits, or — with `pattern` — until what it prints after the agent's last read
   * matches, or `timeoutMs` passes. Answers as {@link read} would, plus why it stopped waiting.
   */
  async wait(pid: number, until: { exit: true } | { pattern: RegExp }, timeoutMs: number, signal?: AbortSignal): Promise<ReadAnswer & { matched: boolean; timedOut: boolean; match?: string }> {
    const kept = this.need(pid);
    if ("pattern" in until && kept.summary.output !== "spawned") {
      throw new SessionProcessError(`the output of ${pid} cannot be read (${kept.summary.unreadableWhy ?? "it is not kept"}); wait for its exit instead`);
    }
    const head = (): number => kept.length - kept.text.length;
    const matchNow = (): string | undefined => {
      if (!("pattern" in until)) return undefined;
      const unread = kept.text.slice(Math.max(0, kept.read - head()));
      return until.pattern.exec(unread)?.[0];
    };
    const settled = (): boolean => matchNow() !== undefined || !kept.summary.running;
    if (!settled()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(Math.max(timeoutMs, 0), PROCESS_WAIT_MAX_MS));
        function done(): void {
          clearTimeout(timer);
          kept.listeners.delete(check);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        const check = (): void => {
          if (settled()) done();
        };
        kept.listeners.add(check);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    const match = matchNow();
    const answer = this.read(pid);
    return { ...answer, matched: match !== undefined, timedOut: match === undefined && answer.process.running, ...(match !== undefined ? { match } : {}) };
  }

  /** Stop `pid` and what it started: Ctrl-C (`interrupt`) or a stop. */
  stop(pid: number, how: "interrupt" | "stop" = "stop"): SessionProcessSummary {
    const kept = this.need(pid);
    if (!kept.summary.running) return { ...kept.summary };
    if (how === "stop") kept.summary.stopped = true;
    const signal: NodeJS.Signals = how === "interrupt" ? "SIGINT" : "SIGTERM";
    if (kept.io !== undefined) kept.io.signal(signal);
    else kept.stopOther?.(signal);
    return { ...kept.summary };
  }

  /** The task let them go: every running one is stopped. Answers how many were. */
  stopAll(): number {
    let n = 0;
    for (const kept of this.kept.values()) {
      if (!kept.summary.running) continue;
      this.stop(kept.summary.pid);
      n++;
    }
    return n;
  }

  /** What ended since the last time this was asked, said once each. */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }

  // --- inside -------------------------------------------------------------------------------

  private find(pid: number): Kept | undefined {
    let latest: Kept | undefined;
    for (const kept of this.kept.values()) if (kept.summary.pid === pid && (latest === undefined || kept.summary.startedAt > latest.summary.startedAt)) latest = kept;
    return latest;
  }

  private need(pid: number): Kept {
    const kept = this.find(pid);
    if (kept === undefined) throw new SessionProcessError(`${pid} is not a process this session started — list_processes lists them`);
    return kept;
  }

  private record(fields: Omit<SessionProcessSummary, "startedAt" | "running">, io: ExecIo | undefined): Kept {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const summary: SessionProcessSummary = { ...fields, startedAt: this.now(), running: true };
    const kept: Kept = { summary, text: "", length: 0, read: 0, ...(io !== undefined ? { io } : {}), done, finish, listeners: new Set() };
    this.kept.set(`${summary.pid}@${summary.startedAt}`, kept);
    this.options.onChange?.({ ...summary });
    return kept;
  }

  private append(kept: Kept, text: string): void {
    kept.length += text.length;
    kept.text += text;
    if (kept.text.length > OUTPUT_KEEP) kept.text = kept.text.slice(kept.text.length - OUTPUT_KEEP);
    for (const listener of [...kept.listeners]) listener();
  }

  private ended(kept: Kept, exitCode: number | null, signal: string | null): void {
    if (!kept.summary.running) return;
    kept.summary.running = false;
    kept.summary.exitCode = exitCode;
    kept.summary.signal = signal;
    kept.summary.endedAt = this.now();
    const minutes = Math.max(0, Math.round((kept.summary.endedAt - kept.summary.startedAt) / 60_000));
    const how = kept.summary.stopped ? "was stopped" : exitCode !== null ? `exited ${exitCode}` : signal !== null ? `ended on ${signal}` : "ended";
    const last = kept.summary.output === "spawned" ? lastLines(kept.text, 5) : "";
    this.notes.push(`\`${kept.summary.command}\` (pid ${kept.summary.pid}) ${how} after ${minutes < 1 ? "less than a minute" : `${minutes}m`}${last.length > 0 ? `; its last lines:\n${last}` : "."}`);
    kept.finish();
    for (const listener of [...kept.listeners]) listener();
    this.options.onChange?.({ ...kept.summary });
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  return lines.slice(-n).join("\n");
}
