/**
 * The window's store of engine data (decision 0018 §2, §5, §6): a cache of the local engine's
 * database, kept in step by cursor, never by a field remembering to refresh.
 *
 * It holds two things:
 *
 *  - **The index**: every task's summary, across every project and machine this engine knows of,
 *    always loaded. Loaded whole once (`sync:since` 0), then kept by pages.
 *  - **Views**: what the engine answers about one task (its detail, its conversation, a session…),
 *    each held under its own KEY — the channel and the request, which names the task by id. A view is
 *    read when something holds it, and read again when a page says its task changed.
 *
 * Pages arrive two ways: pushed (`sync:changed`, the optimization) and asked for (`sync:since` from
 * the cursor — the reconciliation, which needs nothing pushed to be right). A push whose `prev` is
 * newer than the cursor means one was missed, so the cache asks from its cursor instead of applying
 * it. Every page is applied the same way whatever its order: summaries upserted by id, the gone
 * dropped, the cursor moved only forward. So a lost, late, duplicated or reordered message costs
 * latency and nothing else.
 *
 * A view's answer lands only under its own key, and only if it was asked at a cursor no older than
 * the one its current value was asked at; one read per key at a time, a change during it reading
 * again after. So an answer cannot land on the wrong task, and an old one cannot overwrite a new one.
 * A read that fails keeps its error: a view that could not be read says so rather than looking empty.
 */
import type { IpcChannel, IpcRequest, IpcResponse, ProjectTask, PushMessage, SyncPage } from "@jaira/shared/browser";

export interface SyncIo {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
}

/** One view, as a reader sees it. */
export interface Held<T> {
  value: T | undefined;
  /** Why the last read failed, while it is the newest word on this view. */
  error: string | undefined;
  /** A read is in flight — the first, or one after a change. */
  loading: boolean;
}

interface Entry {
  channel: IpcChannel;
  request: unknown;
  taskId: string | null;
  /** For a view about no one task, the project it is scoped to, if it names one: only that project's changes read it again. */
  project: string | null;
  value: unknown;
  error: string | undefined;
  /** The cursor the current value or error was asked at; -1 before the first answer. */
  at: number;
  /** Whether it has ever been read. */
  asked: boolean;
  loading: boolean;
  /** Changed while being read: read again when this read lands. */
  again: boolean;
  /** Changed while held only still: read when it is next held live. */
  stale: boolean;
  /** The read under way, settling when the view is current. */
  idle: Promise<void> | undefined;
  /** When a change last had it read, and the read waiting out the gap, if one is. */
  changeReadAt: number;
  soon: ReturnType<typeof setTimeout> | undefined;
  /** Who holds it: owners by name — `live` kept current, `still` read once and then left — and component hooks by count. */
  owners: Map<string, "live" | "still">;
  count: number;
  usedAt: number;
  /** What `peek` answers: the same object until something in it changes, so a hook can compare it. */
  shown: Held<unknown>;
}

const NOTHING: Held<never> = Object.freeze({ value: undefined, error: undefined, loading: false });

function show(entry: Entry): void {
  const was = entry.shown;
  if (was.value === entry.value && was.error === entry.error && was.loading === entry.loading) return;
  entry.shown = { value: entry.value, error: entry.error, loading: entry.loading };
}

/** Views kept after nothing holds them, for coming back to — the newest this many. */
const KEEP_UNHELD = 64;

/**
 * A view a change names is read at most this often: a run streaming into a task changes it many times
 * a second, and a conversation can be most of a megabyte. The last change is always read.
 */
const CHANGE_READ_GAP_MS = 500;

/**
 * The key a view is held under: its channel and request — with the project left out of a request that
 * names a task, which the engine finds by its id wherever it is (so a guess of its project cannot make
 * a second copy of it). A request about no one task keeps its project: there the project is what it
 * asks about, and every project's board under one key would be one board.
 */
export function viewKey(channel: string, request: unknown): string {
  return `${channel} ${stableJson(withoutGuessedProject(request))}`;
}

function withoutGuessedProject(request: unknown): unknown {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return request;
  const named = request as Record<string, unknown>;
  if (typeof named["taskId"] !== "string" && !Array.isArray(named["taskIds"])) return request;
  const { project: _project, ...rest } = named;
  return rest;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * What a view that is about no one task shows, by the change log's collections — what a page has to
 * bring for it to be read again. A view not listed here and naming no task is read on every page.
 */
const SHOWS: Partial<Record<string, readonly string[]>> = {
  "project:list": ["task", "event", "gate", "approval", "question", "userEvent", "placement", "workspace", "remote", "wait"],
  "board:roots": ["task", "event", "gate", "approval", "question", "userEvent", "remote", "wait"],
  "board:view": ["task", "event", "gate", "approval", "question", "userEvent", "remote", "wait"],
  "placement:queue": ["placement", "task"],
  "history:size": ["task", "event", "record", "job"],
  "interaction:pending": ["gate"],
  "approval:pending": ["approval"],
  "question:pending": ["question"],
  "userEvent:pending": ["userEvent"],
  "state:view": ["task", "event"],
};

const projectOf = (request: unknown): string | null => {
  const project = (request as { project?: unknown } | null)?.project;
  return typeof project === "string" ? project : null;
};

const taskOf = (request: unknown): string | null => {
  const id = (request as { taskId?: unknown } | null)?.taskId;
  return typeof id === "string" ? id : null;
};

export class SyncCache {
  private readonly index = new Map<string, ProjectTask>();
  /** The page each task's summary (or its deletion) was taken from: an older page never overwrites it. */
  private readonly indexAt = new Map<string, number>();
  private indexList: ProjectTask[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private cursorAt = 0;
  private started = false;
  private reconciling: Promise<void> | undefined;
  private reconcileAgain = false;
  /** Bumped on every change a reader could see — what `useSyncExternalStore` compares. */
  version = 0;

  constructor(private readonly io: SyncIo) {}

  /** The cursor: the newest stamp this cache has everything up to. */
  get cursor(): number {
    return this.cursorAt;
  }

  /** Every task's summary, newest first. */
  tasks(): readonly ProjectTask[] {
    return this.indexList;
  }

  task(taskId: string): ProjectTask | undefined {
    return this.index.get(taskId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load the index whole. Idempotent; what arrives before it is applied after. */
  start(): Promise<void> {
    this.started = true;
    return this.reconcile();
  }

  /**
   * Bring everything up to date from the cursor — the reconciliation that needs no push. Whole from a
   * cursor of 0. One at a time; asked again while one runs, it runs once more after.
   */
  reconcile(): Promise<void> {
    if (this.reconciling !== undefined) {
      this.reconcileAgain = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      try {
        do {
          this.reconcileAgain = false;
          const page = await this.io.invoke("sync:since", { since: this.cursorAt });
          this.apply(page);
        } while (this.reconcileAgain);
      } catch {
        // The engine is away or refused: the cache stays as it was, and the next trigger asks again.
      } finally {
        this.reconciling = undefined;
      }
    })();
    return this.reconciling;
  }

  /** A push from the engine. `sync:changed` is applied, or — one having been missed — reconciled from the cursor. */
  push(message: PushMessage): void {
    if (message.type !== "sync:changed") return;
    if (!this.started) return;
    if (message.prev > this.cursorAt) {
      void this.reconcile();
      return;
    }
    this.apply(message.page);
  }

  /** Apply one page: summaries upserted, the gone dropped, the cursor moved forward, held views of what changed read again. */
  apply(page: SyncPage): void {
    if (page.whole) {
      // Whole is everything as of its cursor: what it lacks is gone, unless a newer page put it here.
      for (const id of [...this.index.keys()]) if ((this.indexAt.get(id) ?? 0) <= page.at) this.index.delete(id);
    }
    for (const task of page.tasks) {
      if ((this.indexAt.get(task.taskId) ?? -1) > page.at) continue;
      this.index.set(task.taskId, task);
      this.indexAt.set(task.taskId, page.at);
    }
    for (const id of page.gone) {
      if ((this.indexAt.get(id) ?? -1) > page.at) continue;
      this.index.delete(id);
      this.indexAt.set(id, page.at);
    }
    if (page.at > this.cursorAt || page.whole) this.cursorAt = Math.max(this.cursorAt, page.at);
    this.indexList = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const changed = new Set<string>([...page.tasks.map((t) => t.taskId), ...page.gone, ...page.changes.flatMap((c) => (c.taskId !== null ? [c.taskId] : []))]);
    const collections = new Set(page.changes.map((c) => c.collection));
    // Where the changed tasks are — a project-scoped view is read only for its own project's.
    const projects = new Set(page.tasks.map((t) => t.project));
    for (const [key, entry] of this.entries) {
      if (!this.isHeld(entry)) continue;
      if (!page.whole && !this.touches(entry, changed, collections, projects, page.gone.length > 0)) continue;
      if (this.isLive(entry)) this.readForChange(key, entry);
      else entry.stale = true;
    }
    this.bump();
  }

  /** What is known of one view, reading it first if nothing has. Does not hold it. */
  peek<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Held<IpcResponse<C>> {
    const entry = this.entries.get(viewKey(channel, request));
    return (entry?.shown ?? NOTHING) as Held<IpcResponse<C>>;
  }

  /**
   * The views `owner` holds — replacing what it held before. Each is read if it never has been. `views`
   * are kept current; `still` ones are read once and then left as they are while a change arrives,
   * and read when next held live if one did (a transcript while its turn streams, which the live tail
   * is drawing).
   */
  hold(owner: string, views: ReadonlyArray<readonly [IpcChannel, unknown]>, still: ReadonlyArray<readonly [IpcChannel, unknown]> = []): void {
    const modes = new Map<string, "live" | "still">();
    for (const [channel, request] of still) modes.set(this.ensure(channel, request), "still");
    for (const [channel, request] of views) modes.set(this.ensure(channel, request), "live");
    for (const [key, entry] of this.entries) {
      const mode = modes.get(key);
      if (mode === undefined) entry.owners.delete(owner);
      else entry.owners.set(owner, mode);
      if (entry.stale && this.isLive(entry)) {
        entry.stale = false;
        void this.read(key);
      }
    }
    this.evict();
  }

  /** Hold one view for as long as the returned function is not called — a component's hook. */
  acquire<C extends IpcChannel>(channel: C, request: IpcRequest<C>): () => void {
    const key = this.ensure(channel, request);
    const entry = this.entries.get(key)!;
    entry.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.count -= 1;
      entry.usedAt = Date.now();
      this.evict();
    };
  }

  /** Read one view again now — after something this window did to it, before the change log says so. */
  refresh<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<void> {
    return this.read(this.ensure(channel, request));
  }

  private ensure(channel: IpcChannel, request: unknown): string {
    const key = viewKey(channel, request);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { channel, request, taskId: taskOf(request), project: projectOf(request), value: undefined, error: undefined, at: -1, asked: false, loading: false, again: false, stale: false, idle: undefined, changeReadAt: 0, soon: undefined, owners: new Map(), count: 0, usedAt: Date.now(), shown: NOTHING };
      this.entries.set(key, entry);
    }
    entry.usedAt = Date.now();
    if (!entry.asked) void this.read(key);
    return key;
  }

  private isHeld(entry: Entry): boolean {
    return entry.owners.size > 0 || entry.count > 0;
  }

  /** Whether a page that changed these tasks and collections, in these projects, moves this view. */
  private touches(entry: Entry, tasks: ReadonlySet<string>, collections: ReadonlySet<string>, projects: ReadonlySet<string>, deleted: boolean): boolean {
    if (entry.taskId !== null) return tasks.has(entry.taskId);
    const shows = SHOWS[entry.channel];
    if (shows !== undefined && ![...collections].some((c) => shows.includes(c))) return false;
    // A project's view: moved by its own tasks, by a deletion (whose project the page does not say), and
    // by what belongs to no task (a workspace, the queue).
    if (entry.project !== null && !projects.has(entry.project) && !deleted) {
      const unowned = [...collections].some((c) => c === "workspace" || c === "placement");
      if (!unowned) return false;
    }
    return true;
  }

  /** Held by someone who wants it kept current. */
  private isLive(entry: Entry): boolean {
    return entry.count > 0 || [...entry.owners.values()].includes("live");
  }

  /** Read for a change — now, or when the gap since the last such read is up, once however many arrive. */
  private readForChange(key: string, entry: Entry): void {
    if (entry.soon !== undefined) return;
    const wait = entry.changeReadAt + CHANGE_READ_GAP_MS - Date.now();
    const go = (): void => {
      entry.soon = undefined;
      entry.changeReadAt = Date.now();
      void this.read(key);
    };
    if (wait <= 0) go();
    else entry.soon = setTimeout(go, wait);
  }

  /**
   * Read a view, and answer when it is current: a read already under way is waited for, and one more
   * after it if something changed meanwhile — so "read this again now" never answers before the view has.
   */
  private read(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve();
    if (entry.idle !== undefined) {
      entry.again = true;
      return entry.idle;
    }
    entry.asked = true;
    entry.loading = true;
    show(entry);
    this.bump();
    entry.idle = (async () => {
      try {
        do {
          entry.again = false;
          const asked = this.cursorAt;
          try {
            const value = await this.io.invoke(entry.channel, entry.request as never);
            if (asked >= entry.at) {
              entry.value = value;
              entry.error = undefined;
              entry.at = asked;
            }
          } catch (e) {
            if (asked >= entry.at) {
              entry.error = e instanceof Error ? e.message : String(e);
              entry.at = asked;
            }
          }
          if (entry.again) {
            show(entry);
            this.bump();
          }
        } while (entry.again);
      } finally {
        entry.loading = false;
        entry.idle = undefined;
        show(entry);
        this.bump();
      }
    })();
    return entry.idle;
  }

  /** Drop views nothing holds, past the newest {@link KEEP_UNHELD}. */
  private evict(): void {
    const unheld = [...this.entries].filter(([, e]) => !this.isHeld(e) && !e.loading);
    if (unheld.length <= KEEP_UNHELD) return;
    unheld.sort(([, a], [, b]) => b.usedAt - a.usedAt);
    for (const [key] of unheld.slice(KEEP_UNHELD)) this.entries.delete(key);
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
