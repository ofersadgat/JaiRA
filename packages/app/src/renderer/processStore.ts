/**
 * The window's copy of the engine's processes (decision 0032, "The view"): each `ProcessSummary` it has
 * been told of, by key, kept current by `process:state`, `process:stats` and `process:gone`, and read
 * (`process:get`, `process:list`) when a view first looks. Outside the app's state for the reason the
 * terminals are (`terminalStore.ts`): the readings move every couple of seconds, and only a view drawing
 * that process needs to hear of it. Views read it through `useProcess` (`universal`).
 */
import { processEnded, type ProcessListRequest, type ProcessReadAnswer, type ProcessSummary, type ProcessTreeNode, type PushMessage } from "@jaira/shared/browser";
import { invoke, subscribe } from "./store";

export class ProcessStore {
  private readonly byKey = new Map<string, ProcessSummary>();
  private readonly listeners = new Set<() => void>();
  private readonly asked = new Set<string>();
  /** Process tasks the engine answered it no longer keeps. */
  private readonly missing = new Set<string>();
  private stamp = 0;
  private unhook: (() => void) | undefined;

  constructor(private readonly calls: { invoke: typeof invoke; subscribe: typeof subscribe } = { invoke, subscribe }) {}

  readonly version = (): number => this.stamp;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.hook();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A process by its key. */
  get(key: string): ProcessSummary | undefined {
    return this.byKey.get(key);
  }

  /** Every process the window has been told of. */
  all(): ProcessSummary[] {
    return [...this.byKey.values()];
  }

  /** A process by its process task's id. */
  ofTask(taskId: string): ProcessSummary | undefined {
    for (const p of this.byKey.values()) if (p.processTaskId === taskId) return p;
    return undefined;
  }

  /** A task's processes, as known here, live first, then the newest. */
  ofSession(taskId: string): ProcessSummary[] {
    return [...this.byKey.values()].filter((p) => p.taskId === taskId).sort((a, b) => Number(processEnded(a.state)) - Number(processEnded(b.state)) || b.startedAt - a.startedAt);
  }

  /** What a tool call started that a task keeps: its background process, what it left running or let escape. */
  ofCall(taskId: string, callId: string): ProcessSummary[] {
    return this.ofSession(taskId).filter((p) => p.callId === callId || p.terminal === callId);
  }

  /** The process whose output streams through a terminal. */
  ofTerminal(taskId: string, callId: string): ProcessSummary | undefined {
    for (const p of this.byKey.values()) if (p.taskId === taskId && p.terminal === callId) return p;
    return undefined;
  }

  /** A watched process (another scope's) running at this pid. */
  watchedAt(pid: number): ProcessSummary | undefined {
    for (const p of this.byKey.values()) if (p.pid === pid && p.origin === "watched" && !processEnded(p.state)) return p;
    return undefined;
  }

  /** Read a task's processes once (the pushes keep them current after). */
  ensureSession(taskId: string, project?: string): void {
    this.hook();
    const key = `session:${taskId}`;
    if (this.asked.has(key)) return;
    this.asked.add(key);
    void this.list({ scope: "session", taskId, ...(project !== undefined ? { project } : {}) }).catch(() => this.asked.delete(key));
  }

  /** A scope as a tree; each process in it known here as well. */
  async tree(request: ProcessListRequest): Promise<ProcessTreeNode[]> {
    this.hook();
    const nodes = await this.calls.invoke("process:tree", request);
    const walk = (list: readonly ProcessTreeNode[]): void => {
      for (const node of list) {
        if (node.process.processTaskId !== undefined) this.byKey.set(node.process.key, node.process);
        walk(node.children);
      }
    };
    walk(nodes);
    this.changed();
    return nodes;
  }

  /** "Tell Claude when it prints…": arm a pattern on a task's process. */
  async tellWhen(key: string, pattern: string, project?: string): Promise<ProcessSummary> {
    const p = await this.calls.invoke("process:tellWhen", { key, pattern, ...(project !== undefined ? { project } : {}) });
    this.know(p);
    return p;
  }

  async tellCancel(key: string, project?: string): Promise<void> {
    const p = await this.calls.invoke("process:tellCancel", { key, ...(project !== undefined ? { project } : {}) });
    if (p !== null) this.know(p);
  }

  /** Read a process task's process once (again after it was let go and came back). */
  ensureTask(taskId: string, project?: string): void {
    this.hook();
    if (this.asked.has(taskId)) return;
    this.asked.add(taskId);
    void this.calls
      .invoke("process:get", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((p) => {
        if (p !== null) {
          this.missing.delete(taskId);
          this.know(p);
          return;
        }
        this.asked.delete(taskId);
        this.missing.add(taskId);
        this.changed();
      })
      .catch(() => this.asked.delete(taskId));
  }

  /** Whether the engine said it keeps no process for this task (it was let go). */
  isGone(taskId: string): boolean {
    return this.missing.has(taskId) && this.ofTask(taskId) === undefined;
  }

  /** A scope's processes, each known here as well. */
  async list(request: ProcessListRequest): Promise<ProcessSummary[]> {
    this.hook();
    const answer = await this.calls.invoke("process:list", request);
    for (const p of answer.processes) this.byKey.set(p.key, p);
    this.changed();
    return answer.processes;
  }

  /** What a process printed since `since`: for one with no terminal, followed read-only. */
  read(key: string, since?: number, project?: string): Promise<ProcessReadAnswer> {
    return this.calls.invoke("process:read", { key, ...(since !== undefined ? { since } : {}), ...(project !== undefined ? { project } : {}) });
  }

  /** Stop a process (and what it started), or send it Ctrl-C. */
  stop(key: string, signal?: "interrupt" | "stop", project?: string): Promise<{ stopped: boolean; why?: string }> {
    return this.calls.invoke("process:stop", { key, ...(signal !== undefined ? { signal } : {}), ...(project !== undefined ? { project } : {}) });
  }

  /** Watch a machine process: it becomes a process task of origin `watched`. */
  async watch(pid: number, project?: string): Promise<ProcessSummary> {
    const p = await this.calls.invoke("process:watch", { pid, ...(project !== undefined ? { project } : {}) });
    this.know(p);
    return p;
  }

  /** A view showing readings came (`true`) or went (`false`): the engine counts them, as `limits:watch`. */
  sampling(watching: boolean): void {
    void this.calls.invoke("process:sampling", { watching }).catch(() => undefined);
  }

  /** What the engine pushed. Exposed for tests; the store hooks itself to the pushes. */
  onPush(message: PushMessage): void {
    if (message.type === "process:state") {
      this.know(message.process);
      return;
    }
    if (message.type === "process:stats") {
      let moved = false;
      for (const s of message.stats) {
        const was = this.byKey.get(s.key);
        if (was === undefined) continue;
        const { key: _key, ...rest } = s;
        this.byKey.set(s.key, { ...was, ...rest });
        moved = true;
      }
      if (moved) this.changed();
      return;
    }
    if (message.type === "process:gone") {
      const was = this.byKey.get(message.key);
      this.byKey.delete(message.key);
      if (message.processTaskId !== undefined) {
        this.asked.delete(message.processTaskId);
        this.missing.add(message.processTaskId);
      }
      if (was !== undefined) this.changed();
    }
  }

  private know(p: ProcessSummary): void {
    this.byKey.set(p.key, p);
    this.changed();
  }

  private changed(): void {
    this.stamp++;
    for (const listener of [...this.listeners]) listener();
  }

  private hook(): void {
    if (this.unhook !== undefined) return;
    try {
      this.unhook = this.calls.subscribe((message) => this.onPush(message));
    } catch {
      // No bridge yet (a specimen page): nothing pushes, and a read says so when it is made.
    }
  }
}

export const processes = new ProcessStore();
