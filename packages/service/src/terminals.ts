/**
 * The engine's terminals (decision 0028): every command JaiRA's `shell` runs, and every one the person
 * runs in a conversation's workspace, kept per task while it runs and for a while after — what a window
 * draws as the terminal under a shell call's row, in a pane, in the side panel and in the Terminals tab.
 *
 * In memory only, and only this engine's: the last `TERMINALS_KEPT` per task, each with the last
 * `TERMINAL_OUTPUT_KEEP` characters it printed. A finished call's output is also in its result, which
 * is what a window falls back to once the engine no longer has the terminal.
 *
 * What goes out: `terminal:state` when one starts, is typed into, or ends; `terminal:output` with what
 * it printed, gathered for {@link OUTPUT_EVERY_MS} and sent together, each push saying from which
 * character of the whole it starts (`from`) so a window that missed one can tell and read it again.
 */
import {
  endsMidLine,
  TERMINAL_OUTPUT_KEEP,
  TERMINALS_KEPT,
  WAITING_AFTER_MS,
  YOU_CLOSE,
  YOU_OPEN,
  type CommandDialect,
  type PushMessage,
  type TerminalBy,
  type TerminalRead,
  type TerminalSignal,
  type TerminalSummary,
} from "@jaira/shared";
import type { ShellCallIo, ShellCallTerminal, ShellTerminals } from "@jaira/runtime";

/** How long a terminal's output is gathered before it is sent to the windows. */
export const OUTPUT_EVERY_MS = 80;

interface Kept {
  summary: TerminalSummary;
  /** What it printed, from `summary.dropped` on. */
  output: string;
  /** While it runs: how a person reaches it. */
  io?: ShellCallIo;
  /** Printed but not yet pushed, and where in the whole it starts. */
  held: string;
  heldFrom: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Waits for the output to have been still long enough to call a mid-line ending a prompt. */
  quiet?: ReturnType<typeof setTimeout>;
}

export interface OpenCall {
  callId: string;
  command: string;
  cwd: string | undefined;
  dialect: CommandDialect;
  shell?: string;
  by: TerminalBy;
  /** A process another tool call started (`TerminalSummary.tool`): that tool, and that call. */
  tool?: string;
  call?: string;
}

export class TerminalHub {
  private readonly byTask = new Map<string, Map<string, Kept>>();
  /** A call that came with no id still gets one, so it can be addressed. */
  private unnamed = 0;
  private yours = 0;

  constructor(
    private readonly publish: (message: PushMessage) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** What a task's `shell` tool streams its calls to. */
  forTask(taskId: string, project: string | undefined): ShellTerminals {
    return {
      open: (call) =>
        this.open(taskId, project, {
          callId: call.callId ?? `call-${++this.unnamed}`,
          command: call.command,
          cwd: call.cwd,
          dialect: call.dialect,
          ...(call.shell !== undefined ? { shell: call.shell } : {}),
          ...(call.tool !== undefined ? { tool: call.tool } : {}),
          ...(call.call !== undefined ? { call: call.call } : {}),
          by: "agent",
        }),
    };
  }

  /** The id the person's next command in this engine is kept under. */
  nextYours(): string {
    return `you-${this.now().toString(36)}-${++this.yours}`;
  }

  open(taskId: string, project: string | undefined, call: OpenCall): ShellCallTerminal {
    const summary: TerminalSummary = {
      taskId,
      ...(project !== undefined ? { project } : {}),
      callId: call.callId,
      command: call.command,
      dialect: call.dialect,
      ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
      ...(call.shell !== undefined ? { shell: call.shell } : {}),
      by: call.by,
      ...(call.tool !== undefined ? { tool: call.tool } : {}),
      ...(call.call !== undefined ? { call: call.call } : {}),
      startedAt: this.now(),
      length: 0,
      dropped: 0,
      input: [],
    };
    const kept: Kept = { summary, output: "", held: "", heldFrom: 0 };
    const task = this.byTask.get(taskId) ?? new Map<string, Kept>();
    this.byTask.set(taskId, task);
    // A call id seen again (a retried call) starts afresh.
    task.delete(call.callId);
    task.set(call.callId, kept);
    this.trim(task);
    this.state(kept);
    return {
      output: (text) => this.append(kept, text),
      attach: (io) => {
        kept.io = io;
        const endsAt = io.endsAt();
        if (endsAt !== undefined) kept.summary.endsAt = endsAt;
        this.state(kept);
      },
      ended: (end) => {
        this.flush(kept);
        if (kept.quiet !== undefined) clearTimeout(kept.quiet);
        delete kept.quiet;
        delete kept.io;
        delete kept.summary.endsAt;
        delete kept.summary.waiting;
        kept.summary.endedAt = this.now();
        kept.summary.exitCode = end.exitCode;
        if (end.signal !== null) kept.summary.signal = end.signal;
        if (end.timedOut) kept.summary.timedOut = true;
        if (end.stopped) kept.summary.stopped = true;
        this.state(kept);
      },
    };
  }

  /** A task's terminals, oldest first. */
  list(taskId: string): TerminalSummary[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])].map((kept) => ({ ...kept.summary }));
  }

  read(taskId: string, callId: string): TerminalRead | null {
    const kept = this.byTask.get(taskId)?.get(callId);
    return kept === undefined ? null : { summary: { ...kept.summary }, output: kept.output };
  }

  /** Type into a running command. Written into the output as the person's, since a pipe does not echo. */
  input(taskId: string, callId: string, text: string): boolean {
    const kept = this.byTask.get(taskId)?.get(callId);
    if (kept?.io === undefined || text.length === 0) return false;
    if (!kept.io.type(text)) return false;
    const lines = text.split(/\r?\n/);
    const last = lines.pop() ?? "";
    for (const line of lines) {
      this.append(kept, `${YOU_OPEN}${line}${YOU_CLOSE}\n`);
      kept.summary.input.push(line);
    }
    if (last.length > 0) {
      this.append(kept, `${YOU_OPEN}${last}${YOU_CLOSE}`);
      kept.summary.input.push(last);
    }
    const endsAt = kept.io.endsAt();
    if (endsAt !== undefined) kept.summary.endsAt = endsAt;
    this.flush(kept);
    this.state(kept);
    return true;
  }

  signal(taskId: string, callId: string, signal: TerminalSignal): boolean {
    const io = this.byTask.get(taskId)?.get(callId)?.io;
    if (io === undefined) return false;
    if (signal === "interrupt") io.interrupt();
    else io.stop();
    return true;
  }

  /** Forget a task's terminals (it was deleted). Running ones are left to their calls. */
  forget(taskId: string): void {
    const task = this.byTask.get(taskId);
    if (task === undefined) return;
    for (const kept of task.values()) {
      if (kept.timer !== undefined) clearTimeout(kept.timer);
      if (kept.quiet !== undefined) clearTimeout(kept.quiet);
    }
    this.byTask.delete(taskId);
  }

  private append(kept: Kept, text: string): void {
    if (text.length === 0) return;
    if (kept.held.length === 0) kept.heldFrom = kept.summary.length;
    kept.held += text;
    kept.output += text;
    kept.summary.length += text.length;
    kept.summary.lastOutputAt = this.now();
    // The head goes first, past the limit — a little more than the excess, so a command printing
    // steadily trims once in a while rather than on every chunk.
    if (kept.output.length > TERMINAL_OUTPUT_KEEP) {
      const cut = kept.output.length - Math.floor(TERMINAL_OUTPUT_KEEP * 0.9);
      kept.output = kept.output.slice(cut);
      kept.summary.dropped += cut;
    }
    kept.timer ??= setTimeout(() => this.flush(kept), OUTPUT_EVERY_MS);
    // Waiting for input (ruling 6) is decided here, once, for every window: output that ends mid-line
    // and then stays still. Anything printed after takes it back.
    if (kept.quiet !== undefined) clearTimeout(kept.quiet);
    if (kept.summary.waiting === true) {
      delete kept.summary.waiting;
      this.flush(kept);
      this.state(kept);
    }
    // A tool's process cannot be typed into, so it is never waiting on anyone.
    if (kept.summary.tool !== undefined) return;
    kept.quiet = setTimeout(() => {
      delete kept.quiet;
      if (kept.summary.endedAt !== undefined || !endsMidLine(kept.output)) return;
      kept.summary.waiting = true;
      this.state(kept);
    }, WAITING_AFTER_MS);
  }

  private flush(kept: Kept): void {
    if (kept.timer !== undefined) clearTimeout(kept.timer);
    delete kept.timer;
    if (kept.held.length === 0) return;
    const text = kept.held;
    kept.held = "";
    const { taskId, project, callId } = kept.summary;
    this.publish({ type: "terminal:output", taskId, ...(project !== undefined ? { project } : {}), callId, from: kept.heldFrom, text });
  }

  private state(kept: Kept): void {
    const project = kept.summary.project;
    this.publish({ type: "terminal:state", ...(project !== undefined ? { project } : {}), terminal: { ...kept.summary, input: [...kept.summary.input] } });
  }

  /** Past the limit, the oldest ended ones go first; a running one only when every kept one runs. */
  private trim(task: Map<string, Kept>): void {
    while (task.size > TERMINALS_KEPT) {
      const victim = [...task.values()].find((kept) => kept.io === undefined && kept.summary.endedAt !== undefined) ?? task.values().next().value;
      if (victim === undefined) return;
      if (victim.timer !== undefined) clearTimeout(victim.timer);
      if (victim.quiet !== undefined) clearTimeout(victim.quiet);
      task.delete(victim.summary.callId);
    }
  }
}
