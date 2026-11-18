/**
 * The window's copy of the engine's terminals (decision 0028): a screen per terminal, kept current by
 * `terminal:state` and `terminal:output`, read whole (`terminal:read`) when a terminal is first looked
 * at or a push shows that something was missed, and a task's list read once (`terminal:list`).
 *
 * Outside the app's state on purpose, like the push escape hatch it uses (`subscribe`): output arrives
 * a dozen times a second per running command, and only the views drawing that one terminal need to
 * hear of it. Views read it through `useTerminal` / `useTerminals` (`universal`), which subscribe here.
 */
import type { PushMessage, TerminalSummary } from "@jaira/shared/browser";
import { invoke, subscribe } from "./store";
import { TermScreen } from "./terminalModel";

export interface TerminalCopy {
  summary: TerminalSummary;
  screen: TermScreen;
  /** How much of the whole output the screen holds — `summary.length` once it has caught up. */
  length: number;
  /** Changes whenever anything about it does, for a view's memo. */
  version: number;
}

type OutputPush = Extract<PushMessage, { type: "terminal:output" }>;

const keyOf = (taskId: string, callId: string): string => `${taskId}\u0000${callId}`;

export class TerminalStore {
  private readonly copies = new Map<string, TerminalCopy>();
  private readonly byTask = new Map<string, Set<string>>();
  private readonly listed = new Set<string>();
  /** The person's commands already handed to the agent with a message. */
  private readonly handed = new Set<string>();
  /** Reads in flight, and the output that arrived meanwhile — replayed once the read lands. */
  private readonly reading = new Map<string, OutputPush[]>();
  private readonly listeners = new Set<() => void>();
  private stamp = 0;
  /** Moves when a terminal's facts change (started, typed into, waiting, ended), not on its output. */
  private stateStamp = 0;
  private unhook: (() => void) | undefined;

  constructor(
    private readonly calls: { invoke: typeof invoke; subscribe: typeof subscribe } = { invoke, subscribe },
  ) {}

  /** For `useSyncExternalStore`: the store's version, which moves on every change. */
  readonly version = (): number => this.stamp;

  /** For a view that draws terminals' facts but not their output (a tab's count, a list's statuses). */
  readonly stateVersion = (): number => this.stateStamp;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.hook();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(taskId: string, callId: string): TerminalCopy | undefined {
    return this.copies.get(keyOf(taskId, callId));
  }

  /** A task's terminals the window knows of, oldest first. */
  listOf(taskId: string): TerminalSummary[] {
    const keys = this.byTask.get(taskId);
    if (keys === undefined) return [];
    return [...keys].flatMap((key) => {
      const copy = this.copies.get(key);
      return copy === undefined ? [] : [copy.summary];
    }).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * The person's own commands in a task not yet handed to its agent — each handed once, with the next
   * message (decision 0028, ruling 8). Held in full or not, what the window has is what goes.
   */
  takeYours(taskId: string): TerminalCopy[] {
    const yours = [...(this.byTask.get(taskId) ?? [])].flatMap((key) => {
      const copy = this.copies.get(key);
      return copy !== undefined && copy.summary.by === "you" && !this.handed.has(key) ? [copy] : [];
    });
    for (const copy of yours) this.handed.add(keyOf(copy.summary.taskId, copy.summary.callId));
    return yours.sort((a, b) => a.summary.startedAt - b.summary.startedAt);
  }

  /** The person's commands in a task the next message will carry. */
  yoursPending(taskId: string): TerminalSummary[] {
    return this.listOf(taskId).filter((one) => one.by === "you" && !this.handed.has(keyOf(one.taskId, one.callId)));
  }

  /** Read a task's list once, so a conversation opened late knows what ran before it looked. */
  ensureList(taskId: string, project: string | undefined): void {
    this.hook();
    if (this.listed.has(taskId)) return;
    this.listed.add(taskId);
    void this.calls
      .invoke("terminal:list", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((list) => {
        for (const summary of list) this.know(summary);
        this.changed();
      })
      .catch(() => this.listed.delete(taskId));
  }

  /** Read one terminal whole, unless it is already being read or held in full. */
  ensure(taskId: string, callId: string, project: string | undefined): void {
    this.hook();
    const copy = this.get(taskId, callId);
    if (copy !== undefined && copy.length >= copy.summary.length) return;
    this.read(taskId, callId, project);
  }

  /** What the engine pushed. Exposed for tests; the store hooks itself to the pushes. */
  onPush(message: PushMessage): void {
    if (message.type === "terminal:state") {
      this.know(message.terminal, message.project);
      this.changed();
      return;
    }
    if (message.type !== "terminal:output") return;
    const key = keyOf(message.taskId, message.callId);
    const queued = this.reading.get(key);
    if (queued !== undefined) {
      queued.push(message);
      return;
    }
    const copy = this.copies.get(key);
    if (copy === undefined) return;
    if (this.apply(copy, message)) this.changed();
    else this.read(message.taskId, message.callId, message.project);
  }

  private hook(): void {
    this.unhook ??= this.calls.subscribe((message) => this.onPush(message));
  }

  private changed(): void {
    this.stamp++;
    for (const listener of this.listeners) listener();
  }

  private know(summary: TerminalSummary, project?: string): void {
    this.stateStamp++;
    const key = keyOf(summary.taskId, summary.callId);
    const was = this.copies.get(key);
    const facts = project !== undefined ? { ...summary, project } : summary;
    if (was === undefined) {
      // A terminal first heard of with output already behind it is read when somebody looks.
      this.copies.set(key, { summary: facts, screen: new TermScreen(), length: summary.length === 0 ? 0 : -1, version: 1 });
    } else this.copies.set(key, { ...was, summary: facts, version: was.version + 1 });
    const task = this.byTask.get(summary.taskId) ?? new Set<string>();
    task.add(key);
    this.byTask.set(summary.taskId, task);
  }

  /** Append a push that follows on from what the copy holds; false when there is a gap. */
  private apply(copy: TerminalCopy, push: OutputPush): boolean {
    if (copy.length < 0) return false;
    const end = push.from + push.text.length;
    if (end <= copy.length) return true;
    if (push.from > copy.length) return false;
    copy.screen.write(push.text.slice(copy.length - push.from));
    copy.length = end;
    copy.version++;
    return true;
  }

  private read(taskId: string, callId: string, project: string | undefined): void {
    const key = keyOf(taskId, callId);
    if (this.reading.has(key)) return;
    this.reading.set(key, []);
    void this.calls
      .invoke("terminal:read", { taskId, callId, ...(project !== undefined ? { project } : {}) })
      .then((read) => {
        const queued = this.reading.get(key) ?? [];
        this.reading.delete(key);
        if (read === null) return;
        const screen = new TermScreen();
        screen.write(read.output);
        const copy: TerminalCopy = { summary: read.summary, screen, length: read.summary.length, version: (this.copies.get(key)?.version ?? 0) + 1 };
        this.copies.set(key, copy);
        const task = this.byTask.get(taskId) ?? new Set<string>();
        task.add(key);
        this.byTask.set(taskId, task);
        for (const push of queued) this.apply(copy, push);
        this.stateStamp++;
        this.changed();
      })
      .catch(() => this.reading.delete(key));
  }
}

/** The window's one store of terminals. */
export const terminals = new TerminalStore();

/** Type into a running command (a line carries its own newline). */
export function typeInto(taskId: string, callId: string, text: string, project: string | undefined): Promise<boolean> {
  return invoke("terminal:input", { taskId, callId, text, ...(project !== undefined ? { project } : {}) }).then((r) => r.sent, () => false);
}

/** Ctrl-C, or stop. */
export function signalTerminal(taskId: string, callId: string, signal: "interrupt" | "stop", project: string | undefined): Promise<boolean> {
  return invoke("terminal:signal", { taskId, callId, signal, ...(project !== undefined ? { project } : {}) }).then((r) => r.sent, () => false);
}

/** Run a line in the conversation's workspace, as the person. */
export function runYours(taskId: string, command: string, project: string | undefined): Promise<TerminalSummary> {
  return invoke("terminal:run", { taskId, command, ...(project !== undefined ? { project } : {}) });
}
