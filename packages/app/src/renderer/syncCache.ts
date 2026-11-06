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
 *
 * A phone follows several engines (`SyncSources`, §7): each its own clock and cursor, its pages applied
 * against its own, a whole page of one dropping only what that one put here. And it keeps a mirror on
 * the device (`syncMirror.ts`): the index and the views read before, shown from the moment it starts
 * and while no engine answers — a cache of the engines, which an engine's answer replaces.
 */
import type { IpcChannel, IpcRequest, IpcResponse, ProjectTask, PushMessage, SyncChange, SyncPage } from "@jaira/shared/browser";
import type { SyncMirror } from "./syncMirror";

export interface SyncIo {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
}

/**
 * The engines a cache follows when there are several — a phone paired with machines of different
 * fleets (decision 0018 §7). Each has its own clock, so each has its own cursor: a page is applied
 * against the cursor of the engine it came from, and a whole page drops only what that engine had put
 * here. Without it the cache follows the one engine its `io` reaches (source `""`).
 */
export interface SyncSources {
  /** The engines answering now, by id. */
  ids(): readonly string[];
  /** Hears when the engines answering change. */
  onChange(listener: () => void): () => void;
  /** `sync:since`, of one of them. */
  since(source: string, since: number): Promise<SyncPage>;
}

export interface SyncOptions {
  sources?: SyncSources;
  /** A copy of the cache kept on the device, read before any engine answers (a phone's mirror). */
  mirror?: SyncMirror;
}

/** The one engine of a cache without {@link SyncSources}. */
const LOCAL = "";

/**
 * `next`, with each part deep-equal to the same part of `was` taken from `was` — `was` itself when the two
 * are equal. JSON values: plain objects, arrays and primitives.
 */
export function sharedWith(was: unknown, next: unknown): unknown {
  if (was === next) return was;
  if (was === null || next === null || typeof was !== "object" || typeof next !== "object") return next;
  if (Array.isArray(was) !== Array.isArray(next)) return next;
  if (Array.isArray(next)) {
    const before = was as unknown[];
    let same = before.length === next.length;
    const out = next.map((item, i) => {
      const kept = i < before.length ? sharedWith(before[i], item) : item;
      if (kept !== before[i]) same = false;
      return kept;
    });
    return same ? was : out;
  }
  const before = was as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const kept = key in before ? sharedWith(before[key], after[key]) : after[key];
    if (kept !== before[key] || !(key in before)) same = false;
    out[key] = kept;
  }
  return same ? was : out;
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
  /** The newest read asked of it (counted as `at` is), landed or not; -1 before the first. */
  issued: number;
  /** Which read the current value or error came from; -1 before the first answer. */
  at: number;
  /** The value is the mirror's, kept from before: no engine has answered for it yet. */
  mirrored: boolean;
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
  /** Held with others for the first time, and shown with them: until they all have an answer, `shown` waits. */
  group: Together | undefined;
}

/**
 * Views first asked for together (in one turn of the event loop), shown together: each one's first
 * answer — the engine's or the mirror's — is kept back until every one of them has one, or
 * {@link TOGETHER_MAX_MS} has passed. A window asked a board per project, answered one after another, and drew each as it came
 * (2026-11-06: "i see tasks render one by one on the task view instead of all at once").
 */
interface Together {
  waiting: Set<Entry>;
  members: Entry[];
  done: boolean;
  /** No more join it: the turn it was formed in is over. */
  closed: boolean;
  cap: ReturnType<typeof setTimeout> | undefined;
  promise: Promise<void>;
  resolve: () => void;
}

/** The longest a group of views waits for its slowest before what it has is shown. */
const TOGETHER_MAX_MS = 400;

const NOTHING: Held<never> = Object.freeze({ value: undefined, error: undefined, loading: false });

/** A change in the log, as a row of it: what changed, without when. */
const changeKey = (change: SyncChange): string => `${change.collection}\u0000${change.id}`;

function show(entry: Entry): void {
  // Shown with its group, when the group is.
  if (entry.group !== undefined) return;
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
  // The settings pages' (group 7): what the engine holds in memory or in files, logged as it changes.
  "limits:read": ["limits"],
  "waiting:list": ["waiting"],
  "machines:view": ["machine"],
  "machines:outbox": ["machine"],
  "machines:copies": ["machine", "workspace"],
  "forge:signIns": ["forge", "config"],
  "permissionSets:read": ["config"],
  // The composer's stack and its set browser (decision 0023 §4.1): the set files and the settings.
  "permissionSets:tree": ["config"],
  "permissionSets:own": ["config"],
  "permissionSets:stack": ["config"],
  "catalog:status": ["config", "availability"],
  "mcp:tools": ["config"],
  "mcp:detect": ["config"],
  "cli:status": [],
  "licenses:read": [],
};

/**
 * Views drawn in part from the workflow files, which the change log does not carry: a board's columns
 * are its workflows, with their labels and which are disabled (decision 0021). Read again when the
 * files change ({@link SyncCache.filesChanged}).
 */
const FROM_FILES = new Set<string>(["board:roots", "board:view"]);

/** Views whose answer never changes once had — a placeholder's string, by its hash: never read again. */
const IMMUTABLE = new Set<string>(["lazy:value"]);

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
  /**
   * The engine and page each task's summary (or its deletion) was taken from: an older page of the
   * same engine never overwrites it. Another engine's clock says nothing of this one's, so a page from
   * another engine is newer by arriving.
   */
  private readonly indexAt = new Map<string, { source: string; at: number }>();
  private indexList: ProjectTask[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  /** Per engine, the newest stamp of its clock this cache has everything up to. */
  private readonly cursors = new Map<string, number>();
  /**
   * Per engine, the changes applied at its cursor's stamp. The read is inclusive, so they come again on
   * the next page; no two changes share a stamp (migration 33), so one seen at the cursor is the same
   * change and reads nothing again — every ask once read the boards again for the last change made.
   */
  private readonly atCursor = new Map<string, Set<string>>();
  private started = false;
  private loading: Promise<void> | undefined;
  private readonly reconciling = new Map<string, { run: Promise<void>; again: boolean }>();
  /** Counts reads: which one a view's value came from. */
  private reads = 0;
  private readonly sources: SyncSources | undefined;
  private readonly mirror: SyncMirror | undefined;
  /** Bumped on every change a reader could see — what `useSyncExternalStore` compares. */
  version = 0;

  constructor(
    private readonly io: SyncIo,
    options: SyncOptions = {},
  ) {
    this.sources = options.sources;
    this.mirror = options.mirror;
    this.sources?.onChange(() => {
      if (this.started) void this.reconcile();
    });
  }

  /** The cursor of the one engine of a cache without {@link SyncSources}. */
  get cursor(): number {
    return this.cursorOf(LOCAL);
  }

  /** One engine's cursor: the newest stamp of its clock this cache has everything up to. */
  cursorOf(source: string): number {
    return this.cursors.get(source) ?? 0;
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

  /**
   * Load the index: from the mirror first, when there is one, and then from each engine — whole from a
   * cursor of 0, else what changed since the mirror's. Idempotent; what arrives before it is applied after.
   */
  start(): Promise<void> {
    this.loading ??= this.loadMirror().then(() => {
      this.started = true;
      return this.reconcile();
    });
    return this.loading;
  }

  /**
   * Bring everything up to date from each engine's cursor — the reconciliation that needs no push.
   * Whole from a cursor of 0. One at a time per engine; asked again while one runs, it runs once more after.
   */
  reconcile(): Promise<void> {
    const ids = this.sources?.ids() ?? [LOCAL];
    return Promise.all(ids.map((id) => this.reconcileOne(id))).then(() => undefined);
  }

  private reconcileOne(source: string): Promise<void> {
    const running = this.reconciling.get(source);
    if (running !== undefined) {
      running.again = true;
      return running.run;
    }
    const state = { run: Promise.resolve(), again: false };
    this.reconciling.set(source, state);
    state.run = (async () => {
      try {
        do {
          state.again = false;
          const cursor = this.cursorOf(source);
          // A view asked after this page was is answered as of it or later: the engine answers in order.
          let asked = this.reads;
          let page = await this.since(source, cursor);
          // A clock behind the cursor is another database under the engine's name (a machine set up
          // again): nothing taken from the old one stands, its stamps least of all.
          if (!page.whole && page.at < cursor) {
            asked = this.reads;
            page = await this.since(source, 0);
            this.drop(source);
          }
          this.apply(page, source, asked);
        } while (state.again);
      } catch {
        // The engine is away or refused: the cache stays as it was, and the next trigger asks again.
      } finally {
        this.reconciling.delete(source);
      }
    })();
    return state.run;
  }

  private since(source: string, since: number): Promise<SyncPage> {
    return this.sources !== undefined ? this.sources.since(source, since) : this.io.invoke("sync:since", { since });
  }

  /**
   * A push from an engine. `sync:changed` is applied, or — one having been missed — reconciled from that
   * engine's cursor. Which engine sent it is the message's `source`, set by a bridge over several.
   */
  push(message: PushMessage): void {
    if (message.type !== "sync:changed") return;
    if (!this.started) return;
    const source = message.source ?? LOCAL;
    if (message.prev > this.cursorOf(source)) {
      void this.reconcileOne(source);
      return;
    }
    this.apply(message.page, source);
  }

  /** An engine no longer followed — a machine forgotten: what it put here goes, from the mirror too. */
  forget(source: string): void {
    this.drop(source);
    this.mirror?.forgetIndex(source);
    this.sortIndex();
    this.bump();
  }

  /** Everything one engine put in the index, and its cursor. */
  private drop(source: string): void {
    for (const [id, had] of [...this.indexAt]) {
      if (had.source !== source) continue;
      this.index.delete(id);
      this.indexAt.delete(id);
    }
    this.cursors.delete(source);
    this.atCursor.delete(source);
  }

  /**
   * Apply one page of an engine: summaries upserted, the gone dropped, its cursor moved forward, held
   * views of what changed read again.
   */
  apply(page: SyncPage, source: string = LOCAL, askedAt = Number.POSITIVE_INFINITY): void {
    /** This page is older than what the index has of a task — which only the same engine's clock can say. */
    const older = (id: string): boolean => {
      const had = this.indexAt.get(id);
      return had !== undefined && had.source === source && had.at > page.at;
    };
    // The changes this page brings that were not applied before: the rows at the cursor come again.
    const was = this.cursorOf(source);
    const seen = page.whole ? undefined : this.atCursor.get(source);
    const changes = seen === undefined ? page.changes : page.changes.filter((c) => !(c.at === was && seen.has(changeKey(c))));
    if (page.whole) {
      // Whole is everything the engine has as of its cursor: what it put here and lacks now is gone,
      // unless a newer page put it here.
      for (const [id, had] of [...this.indexAt]) if (had.source === source && had.at <= page.at) this.index.delete(id);
    }
    // The summaries that moved: one the same as the index has keeps its object, and reads nothing again.
    const moved = new Set<string>();
    for (const task of page.tasks) {
      if (older(task.taskId)) continue;
      const before = this.index.get(task.taskId);
      const kept = sharedWith(before, task) as ProjectTask;
      if (kept !== before) moved.add(task.taskId);
      this.index.set(task.taskId, kept);
      this.indexAt.set(task.taskId, { source, at: page.at });
    }
    for (const id of page.gone) {
      if (older(id)) continue;
      this.index.delete(id);
      this.indexAt.set(id, { source, at: page.at });
    }
    // A whole page is the engine's state as of its stamp, whatever came before — one from a database set
    // up again sets the cursor back.
    if (page.whole || page.at > was) this.cursors.set(source, page.at);
    const now = this.cursorOf(source);
    const atNow = new Set(page.changes.filter((c) => c.at === now).map(changeKey));
    if (now === was && seen !== undefined) for (const key of seen) atNow.add(key);
    this.atCursor.set(source, atNow);
    // A page that only brought again what was applied moves nothing of the index; what an engine has not
    // answered for yet (the mirror's views, the unreadable) is still read below, as on any page.
    if (page.whole || moved.size > 0 || page.gone.length > 0) {
      this.sortIndex();
      this.keepIndex(source);
    }
    // A draft's change moves its draft and nothing else of its task (decision 0018 §9).
    const changed = new Set<string>([...moved, ...page.gone, ...changes.flatMap((c) => (c.taskId !== null && c.collection !== "draft" ? [c.taskId] : []))]);
    const drafted = new Set(changes.flatMap((c) => (c.collection === "draft" ? [c.id] : [])));
    const collections = new Set(changes.map((c) => c.collection));
    // Where the changed tasks are — a project-scoped view is read only for its own project's.
    const projects = new Set(page.tasks.filter((t) => moved.has(t.taskId)).map((t) => t.project));
    for (const [key, entry] of this.entries) {
      // Asked after this page was (`askedAt`, the reads counted when it was asked): its answer is as of
      // this page or later. The window's first whole page once read every view it held again, each
      // asked a moment before it (2026-11-06).
      if (entry.issued > askedAt) continue;
      // Shown from the mirror, or unreadable: an engine answering is the time to ask it again.
      if (entry.mirrored || entry.error !== undefined) {
        if (this.isLive(entry)) this.readForChange(key, entry);
        else entry.stale = true;
        continue;
      }
      if (IMMUTABLE.has(entry.channel)) continue;
      if (entry.channel === "draft:get") {
        if (!page.whole && !drafted.has((entry.request as { key: string }).key)) continue;
      } else if (!page.whole && !this.touches(entry, changed, collections, projects, page.gone.length > 0)) continue;
      // Held live, read now; held still or not held at all (a board while another room is on screen),
      // read when next held — so arriving back needs no read of its own.
      if (this.isLive(entry)) this.readForChange(key, entry);
      else entry.stale = true;
    }
    this.bump();
  }

  /**
   * The workflow files changed on disk (an engine's `workflows` invalidation): every held view drawn
   * from them is read again — now if held live, else when next it is.
   */
  filesChanged(): void {
    for (const [key, entry] of this.entries) {
      if (!FROM_FILES.has(entry.channel) || !this.isHeld(entry)) continue;
      if (this.isLive(entry)) this.readForChange(key, entry);
      else entry.stale = true;
    }
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
    if (entry.stale) {
      entry.stale = false;
      void this.read(key);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.count -= 1;
      entry.usedAt = Date.now();
      this.evict();
    };
  }

  /**
   * Read one view again now — after something this window did to it, before the change log says so.
   * A view nothing has read yet is read by {@link ensure}, after the asking: that read is the fresh one,
   * and asking for one more behind it read every conversation's records twice as it was opened.
   */
  refresh<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<void> {
    const unread = this.entries.get(viewKey(channel, request))?.asked !== true;
    const key = this.ensure(channel, request);
    const entry = this.entries.get(key);
    const read = unread ? (entry?.idle ?? Promise.resolve()) : this.read(key);
    // A view still waiting for its group answers with it: what is read after this sees it.
    const group = entry?.group;
    return group === undefined ? read : Promise.all([read, group.promise]).then(() => undefined);
  }

  /**
   * A view asked for the first time joins the group of every other view first asked in the same turn of
   * the event loop — a hold's, a refresh's, a component's — and is shown with them (see {@link Together}).
   */
  private join(entry: Entry): void {
    let group = this.forming;
    if (group === undefined) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => (resolve = r));
      const made: Together = { waiting: new Set(), members: [], done: false, closed: false, cap: undefined, promise, resolve };
      made.cap = setTimeout(() => this.showTogether(made), TOGETHER_MAX_MS);
      // Closed once this turn is over: what is asked after it is another group.
      setTimeout(() => {
        made.closed = true;
        if (this.forming === made) this.forming = undefined;
        if (made.waiting.size === 0) this.showTogether(made);
      }, 0);
      this.forming = made;
      group = made;
    }
    entry.group = group;
    group.members.push(entry);
    group.waiting.add(entry);
  }
  private forming: Together | undefined;

  /** A view has its first answer; its group is shown once all of them have, and no more can join. */
  private landed(entry: Entry): void {
    const group = entry.group;
    if (group === undefined) return;
    group.waiting.delete(entry);
    if (group.waiting.size === 0 && group.closed) this.showTogether(group);
  }

  private showTogether(group: Together): void {
    if (group.done) return;
    group.done = true;
    group.closed = true;
    if (this.forming === group) this.forming = undefined;
    if (group.cap !== undefined) clearTimeout(group.cap);
    for (const entry of group.members) {
      entry.group = undefined;
      show(entry);
    }
    group.resolve();
    this.bump();
  }

  private ensure(channel: IpcChannel, request: unknown): string {
    const key = viewKey(channel, request);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { channel, request, taskId: taskOf(request), project: projectOf(request), value: undefined, error: undefined, at: -1, mirrored: false, asked: false, loading: false, again: false, stale: false, idle: undefined, changeReadAt: 0, soon: undefined, owners: new Map(), count: 0, usedAt: Date.now(), shown: NOTHING, group: undefined, issued: -1 };
      this.entries.set(key, entry);
      this.join(entry);
      this.fromMirror(key, entry);
    }
    entry.usedAt = Date.now();
    if (!entry.asked) void this.read(key);
    return key;
  }

  /** The index the mirror kept, for each engine no page has come from yet — what a phone shows offline. */
  private async loadMirror(): Promise<void> {
    if (this.mirror === undefined) return;
    let kept: Awaited<ReturnType<SyncMirror["indexes"]>>;
    try {
      kept = await this.mirror.indexes();
    } catch {
      return;
    }
    for (const [source, index] of kept) {
      if (this.cursors.has(source)) continue;
      for (const [task, at] of index.tasks) {
        if (this.indexAt.has(task.taskId)) continue;
        this.index.set(task.taskId, task);
        this.indexAt.set(task.taskId, { source, at });
      }
      this.cursors.set(source, index.cursor);
    }
    this.sortIndex();
    this.bump();
  }

  /** A view the mirror kept, shown until an engine answers for it. */
  private fromMirror(key: string, entry: Entry): void {
    if (this.mirror === undefined) return;
    void this.mirror.view(key).then(
      (value) => {
        if (value === undefined || this.entries.get(key) !== entry || entry.value !== undefined) return;
        entry.value = value;
        entry.error = undefined;
        // A placeholder's string is what it was wherever it is read; anything else, as it was then.
        entry.mirrored = !IMMUTABLE.has(entry.channel);
        show(entry);
        this.landed(entry);
        this.bump();
      },
      () => undefined,
    );
  }

  /** Have the mirror keep what one engine put in the index, and its cursor. */
  private keepIndex(source: string): void {
    this.mirror?.keepIndex(source, () => ({
      cursor: this.cursorOf(source),
      tasks: [...this.indexAt].flatMap(([id, had]): Array<[ProjectTask, number]> => {
        const task = had.source === source ? this.index.get(id) : undefined;
        return task === undefined ? [] : [[task, had.at]];
      }),
    }));
  }

  private sortIndex(): void {
    this.indexList = [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
          const asked = ++this.reads;
          entry.issued = asked;
          try {
            const answered = await this.io.invoke(entry.channel, entry.request as never);
            if (asked >= entry.at) {
              // What did not move keeps its object, the whole answer included when nothing did: a reader
              // compares by identity, and redraws only what moved.
              const value = sharedWith(entry.value, answered);
              const moved = value !== entry.value || entry.mirrored;
              entry.value = value;
              entry.error = undefined;
              entry.at = asked;
              entry.mirrored = false;
              if (moved) this.mirror?.keepView(key, value);
            }
          } catch (e) {
            // A view shown from the mirror stays shown while no engine can answer for it.
            if (asked >= entry.at && !entry.mirrored) {
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
        // Answered, or refused: either is its first word, which its group waits on.
        this.landed(entry);
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

  /**
   * A change, told to the readers a moment later, with whatever else lands in that moment: the answers
   * that queue up while the window is busy drawing are drawn once, not once each (2026-11-06: a task
   * opened on the phone drew its panel again for each of its views, ~150 ms apart). What `peek` answers
   * is current at once; only the redraw waits.
   */
  private bump(): void {
    this.version += 1;
    if (this.telling !== undefined) return;
    this.telling = setTimeout(() => {
      this.telling = undefined;
      for (const listener of [...this.listeners]) listener();
    }, TELL_AFTER_MS);
  }
  private telling: ReturnType<typeof setTimeout> | undefined;
}

/** How long a change waits for the ones after it before the readers are told: about a frame. */
const TELL_AFTER_MS = 16;
