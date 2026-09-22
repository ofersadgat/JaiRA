/**
 * Watching merge requests (decision 0004, "Watching"): events only ever mean "go look".
 *
 * Two halves with a seam between them, and the seam is the design:
 *
 *  - A {@link RemoteEventSource} produces HINTS — "this request may have moved". {@link PollingSource}
 *    is one: cheap probes on an adaptive cadence. A relay or a webhook receiver is another, later,
 *    and changes nothing downstream.
 *  - {@link RemoteWatcher} is downstream of every source. A hint makes it `read()` the request —
 *    truth is always a read — run the pure settlement mapping over what it found, write the row, and
 *    say so when the gate settles. That is also what makes a missed or duplicated hint harmless: a
 *    duplicate costs one read, and a miss is caught by the backstop.
 *
 * No vendor-supported push channel reaches a desktop app with no public address (researched
 * 2026-09-19), so polling is what ships — made cheap by construction rather than by hoping:
 *
 *  - **Nothing parked, nothing polled.** A host with no awaited row has no timer at all.
 *  - **One probe per connection per tick**, however many requests are open.
 *  - **A full read only for what the probe says moved.**
 *  - **Adaptive cadence**: 60 s while a quiet window is open or the task is on screen, doubling to
 *    15 min while nothing moves, back to 60 s on any change. The forge's own floor
 *    (`X-Poll-Interval`, `Retry-After`, a `429`) always wins, and a failing host backs off by itself.
 *  - **A slow backstop**: a full read of every awaited request each 30 min, because whether an
 *    approval or a thread resolution alone moves `updated_at` / the ETag is not verified.
 *  - **Closed for a weekend is the normal case**: the cursor and `settle_at` are on the row, so the
 *    first probe after start sees everything since, and a window that ran out settles on that read.
 */
import {
  handleOfRow,
  parseDuration,
  settleRemote,
  type Changeset,
  type ForgeProvider,
  type ProbeCursor,
  type RemoteHandle,
  type RemoteHandlePort,
  type RemoteHandleRow,
  type RemoteSettlement,
  type RemoteState,
  type SettleStep,
} from "@jaira/shared";
import { ForgeError } from "./forge";

export interface Disposable {
  dispose(): void;
}

/** A hint: a connection's requests — or one of them — may have moved. */
export type RemoteHint = (connectionKey: string, handleKey?: string) => void;

export interface RemoteEventSource {
  start(onHint: RemoteHint): Disposable;
}

/** One place awaited rows live: an open project, its store, and how its forges are reached. */
export interface WatchTarget {
  /** The project's key — part of every handle key, because task ids are per project. */
  key: string;
  handles: RemoteHandlePort;
  /** The provider for a host, with this project's token. Throws a sentence when there is none. */
  provider(host: string): ForgeProvider;
  /** The default window, from `integrations.review.settleAfter`. */
  settleAfter: string;
}

export interface WatchClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: WatchClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    // A watch must never be the reason a process stays alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const connectionKeyOf = (target: string, host: string): string => JSON.stringify([target, host]);
export const handleKeyOf = (target: string, row: Pick<RemoteHandleRow, "taskId" | "key">): string => JSON.stringify([target, row.taskId, row.key]);

// --- cadence ---------------------------------------------------------------------------------------

export const FAST_MS = 60_000;
export const SLOW_MS = 15 * 60_000;
export const BACKSTOP_MS = 30 * 60_000;

/**
 * How long until a connection's next probe. Pure, so the cadence is a table and not a feeling.
 *
 * `quiet` counts consecutive probes that found nothing; `failures` consecutive probes that threw.
 * The forge's own floor always wins — it is the one number here that is not ours to choose.
 */
export function nextProbeDelay(state: { attention: boolean; quiet: number; failures: number; floorSeconds?: number }): number {
  const doubled = (times: number): number => Math.min(SLOW_MS, FAST_MS * 2 ** Math.min(times, 10));
  const ours = state.failures > 0 ? doubled(state.failures) : state.attention ? FAST_MS : doubled(state.quiet);
  return Math.max(ours, (state.floorSeconds ?? 0) * 1000);
}

// --- the polling source ----------------------------------------------------------------------------

export interface PollingOptions {
  targets: () => WatchTarget[];
  clock?: WatchClock;
  /** True while a task is what the person is looking at — it keeps its connection on the fast cadence. */
  onScreen?: (target: string, taskId: string) => boolean;
  onError?: (connectionKey: string, error: Error) => void;
}

interface ConnectionState {
  timer?: unknown;
  quiet: number;
  failures: number;
  floorSeconds?: number;
  backstopAt: number;
  probing: boolean;
}

export class PollingSource implements RemoteEventSource {
  private readonly clock: WatchClock;
  private readonly connections = new Map<string, ConnectionState>();
  private hint: RemoteHint | undefined;

  constructor(private readonly options: PollingOptions) {
    this.clock = options.clock ?? realClock;
  }

  start(onHint: RemoteHint): Disposable {
    this.hint = onHint;
    this.kick();
    return {
      dispose: () => {
        this.hint = undefined;
        for (const state of this.connections.values()) if (state.timer !== undefined) this.clock.clearTimeout(state.timer);
        this.connections.clear();
      },
    };
  }

  /** The awaited rows, grouped by connection — the whole of "what is there to poll". */
  private groups(): Map<string, { target: WatchTarget; host: string; rows: RemoteHandleRow[] }> {
    const out = new Map<string, { target: WatchTarget; host: string; rows: RemoteHandleRow[] }>();
    for (const target of this.options.targets()) {
      for (const row of target.handles.awaiting()) {
        const key = connectionKeyOf(target.key, row.host);
        const group = out.get(key) ?? { target, host: row.host, rows: [] };
        group.rows.push(row);
        out.set(key, group);
      }
    }
    return out;
  }

  /**
   * Probe NOW — app start, the window back in focus after five minutes away, the machine waking, a
   * "Check now" on the gate. Also how a newly parked gate gets its connection a timer at all.
   */
  kick(): void {
    if (this.hint === undefined) return;
    const groups = this.groups();
    // A connection nobody waits on any more loses its timer: nothing parked, nothing polled.
    for (const [key, state] of this.connections) {
      if (groups.has(key)) continue;
      if (state.timer !== undefined) this.clock.clearTimeout(state.timer);
      this.connections.delete(key);
    }
    for (const key of groups.keys()) void this.probe(key);
  }

  private async probe(connectionKey: string): Promise<void> {
    const group = this.groups().get(connectionKey);
    let state = this.connections.get(connectionKey);
    if (group === undefined) {
      if (state?.timer !== undefined) this.clock.clearTimeout(state.timer);
      this.connections.delete(connectionKey);
      return;
    }
    if (state === undefined) this.connections.set(connectionKey, (state = { quiet: 0, failures: 0, backstopAt: this.clock.now() + BACKSTOP_MS, probing: false }));
    if (state.probing) return;
    state.probing = true;
    if (state.timer !== undefined) this.clock.clearTimeout(state.timer);
    state.timer = undefined;

    const { target, rows } = group;
    let moved: string[] = [];
    try {
      const handles = rows.map((row) => handleOfRow(row)).filter((h): h is RemoteHandle => h !== undefined);
      // One cursor for the connection, composed from its rows: the EARLIEST `since` (a row that has
      // none yet makes the whole probe a first probe, which costs nothing and reports everything),
      // and every row's own ETag.
      const sinces = rows.map((row) => row.cursor.since);
      const cursor: ProbeCursor = {
        ...(sinces.every((s): s is string => s !== undefined) ? { since: [...sinces].sort()[0]! } : {}),
        etags: Object.assign({}, ...rows.map((row) => row.cursor.etags ?? {})) as Record<string, string>,
        // The connection's one notifications stamp: the EARLIEST any row remembers, so a row that
        // joined later cannot make the others skip what they have not yet been told.
        ...(() => {
          const stamps = rows.map((row) => row.cursor.notifiedAt).filter((s): s is string => s !== undefined);
          return stamps.length === rows.length && stamps.length > 0 ? { notifiedAt: stamps.sort((a, b) => Date.parse(a) - Date.parse(b))[0]! } : {};
        })(),
      };
      const probe = await target.provider(group.host).probe(handles, cursor);
      if (!this.live(target)) return this.forget(connectionKey, state);
      moved = probe.moved;
      for (const row of rows) {
        const id = handleOfRow(row)?.id;
        const etag = id !== undefined ? probe.cursor.etags?.[id] : undefined;
        target.handles.update(row.taskId, row.key, {
          cursor: {
            ...(probe.cursor.since !== undefined ? { since: probe.cursor.since } : {}),
            ...(etag !== undefined && id !== undefined ? { etags: { [id]: etag } } : {}),
            ...(probe.cursor.notifiedAt !== undefined ? { notifiedAt: probe.cursor.notifiedAt } : {}),
          },
        });
      }
      state.failures = 0;
      state.floorSeconds = probe.pollAfterSeconds;
      state.quiet = moved.length > 0 ? 0 : state.quiet + 1;
    } catch (error) {
      if (!this.live(target)) return this.forget(connectionKey, state);
      state.failures += 1;
      if (error instanceof ForgeError && error.retryAfterSeconds !== undefined) state.floorSeconds = error.retryAfterSeconds;
      this.options.onError?.(connectionKey, error as Error);
    }

    // The backstop: everything awaited is read, whatever the probe said.
    const now = this.clock.now();
    const backstop = state.failures === 0 && now >= state.backstopAt;
    if (backstop) state.backstopAt = now + BACKSTOP_MS;
    for (const row of rows) {
      const id = handleOfRow(row)?.id;
      if (backstop || (id !== undefined && moved.includes(id))) this.hint?.(connectionKey, handleKeyOf(target.key, row));
    }

    state.probing = false;
    const attention = rows.some((row) => row.settleAt !== undefined || this.options.onScreen?.(target.key, row.taskId) === true);
    const delay = nextProbeDelay({ attention, quiet: state.quiet, failures: state.failures, ...(state.floorSeconds !== undefined ? { floorSeconds: state.floorSeconds } : {}) });
    if (this.hint !== undefined) state.timer = this.clock.setTimeout(() => void this.probe(connectionKey), delay);
  }

  /**
   * Whether a probe that was awaiting the forge may still touch what it started from. Not when the
   * source was disposed, and not when the target's store has gone — its project closed while the
   * probe was out, and a closed store throws on any read (§ "Watching": the poller is owned by the
   * connection, so it must not outlive it).
   */
  private live(target: WatchTarget): boolean {
    return this.hint !== undefined && this.options.targets().some((t) => t.handles === target.handles);
  }

  /** Drop a connection whose probe came back to nothing: no write, no hint, no next tick. */
  private forget(connectionKey: string, state: ConnectionState): void {
    state.probing = false;
    if (state.timer !== undefined) this.clock.clearTimeout(state.timer);
    if (this.connections.get(connectionKey) === state) this.connections.delete(connectionKey);
  }
}

// --- the watcher -----------------------------------------------------------------------------------

/** What is being decided on a request — supplied by whoever parked on it. */
export interface WatchSubject {
  changeset?: Changeset;
  options?: readonly string[];
}

export interface RemoteSettled {
  target: string;
  /** The gate that was parked on this request, when one was — absent for a bare `on_remote_event`. */
  requestId?: string;
  row: RemoteHandleRow;
  handle: RemoteHandle;
  settlement: RemoteSettlement;
  state: RemoteState;
}

export interface RemoteProgress {
  target: string;
  row: RemoteHandleRow;
  state?: RemoteState;
  step?: SettleStep;
  /** Set when the read failed — the gate's "unreachable" state. */
  error?: string;
}

export interface WatcherOptions {
  targets: () => WatchTarget[];
  sources: RemoteEventSource[];
  clock?: WatchClock;
  /** The changes and the vocabulary a settlement is decided against. Absent ⇒ nothing per change. */
  subjectOf?: (target: string, row: RemoteHandleRow) => WatchSubject | undefined;
  onSettled: (event: RemoteSettled) => void | Promise<void>;
  /** Every read, settled or not: what the gate's remote strip draws from. */
  onProgress?: (event: RemoteProgress) => void;
}

export class RemoteWatcher {
  private readonly clock: WatchClock;
  private readonly subscriptions: Disposable[] = [];
  private readonly windows = new Map<string, unknown>();
  /** Reads in flight, by handle key — so a second asker waits for the first read instead of starting another. */
  private readonly reading = new Map<string, Promise<SettleStep | undefined>>();
  private disposed = false;

  constructor(private readonly options: WatcherOptions) {
    this.clock = options.clock ?? realClock;
  }

  start(): Disposable {
    for (const source of this.options.sources) {
      this.subscriptions.push(source.start((connectionKey, handleKey) => void this.onHint(connectionKey, handleKey)));
    }
    // Windows already running on the rows — a process that was not there when they started.
    for (const target of this.options.targets()) for (const row of target.handles.awaiting()) this.armWindow(target.key, row);
    return { dispose: () => this.dispose() };
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const timer of this.windows.values()) this.clock.clearTimeout(timer);
    this.windows.clear();
  }

  private async onHint(connectionKey: string, handleKey?: string): Promise<void> {
    if (this.disposed) return;
    const [targetKey, host] = JSON.parse(connectionKey) as [string, string];
    const target = this.options.targets().find((t) => t.key === targetKey);
    if (target === undefined) return;
    const rows = target.handles.awaiting().filter((row) => row.host === host && (handleKey === undefined || handleKeyOf(targetKey, row) === handleKey));
    await Promise.all(rows.map((row) => this.check(target, row)));
  }

  /**
   * Read one request and act on what it says. Public: "Check now" is exactly this.
   *
   * One read per request at a time. A check that arrives while one is in flight gets THAT read's
   * answer — "Check now" pressed a moment after a probe must not report "nothing new" because it
   * declined to look.
   */
  check(target: WatchTarget, stale: RemoteHandleRow): Promise<SettleStep | undefined> {
    const id = handleKeyOf(target.key, stale);
    const inFlight = this.reading.get(id);
    if (inFlight !== undefined) return inFlight;
    const read = this.read(target, stale, id).finally(() => this.reading.delete(id));
    this.reading.set(id, read);
    return read;
  }

  private async read(target: WatchTarget, stale: RemoteHandleRow, id: string): Promise<SettleStep | undefined> {
    {
      if (!this.live(target)) return undefined;
      // Re-read the row: a hint can outlive the wait it was for.
      const row = target.handles.get(stale.taskId, stale.key);
      const handle = row === undefined ? undefined : handleOfRow(row);
      if (row === undefined || handle === undefined || !row.awaiting) return undefined;

      let state: RemoteState;
      try {
        state = await target.provider(row.host).read(handle);
      } catch (error) {
        if (!this.live(target)) return undefined;
        const message = (error as Error).message;
        const failed = target.handles.update(row.taskId, row.key, { checkedAt: this.clock.now(), lastError: message }) ?? row;
        this.options.onProgress?.({ target: target.key, row: failed, error: message });
        return undefined;
      }

      // The read took time, and the OTHER door may have been used during it: a person answered the
      // gate, or the run was stopped. Whichever settles first answers — so a read that comes back to a
      // row nobody awaits any more is dropped, not acted on. So is one that comes back to a store that
      // is no longer there: the watcher was stopped, or the project closed, while the forge answered.
      if (!this.live(target)) return undefined;
      const still = target.handles.get(row.taskId, row.key);
      if (still === undefined || !still.awaiting || still.requestId !== row.requestId) return undefined;

      const subject = this.options.subjectOf?.(target.key, row);
      const settleAfterMs = row.settleAfterMs ?? parseDuration(target.settleAfter) ?? 0;
      const step = settleRemote(state, {
        ...(subject?.changeset !== undefined ? { changeset: subject.changeset } : {}),
        ...(subject?.options !== undefined ? { options: subject.options } : {}),
        seen: row.seen,
        ...(row.settleAt !== undefined ? { settleAt: row.settleAt } : {}),
        settleAfterMs,
        now: this.clock.now(),
        source: row.provider,
      });

      if (step.kind === "settled") {
        // Off the awaited list BEFORE anybody is told: a second hint must find nothing to settle.
        const done = target.handles.update(row.taskId, row.key, { seen: step.seen, settleAt: null, awaiting: false, requestId: null, checkedAt: this.clock.now(), lastError: null }) ?? row;
        this.disarm(id);
        this.options.onProgress?.({ target: target.key, row: done, state, step });
        await this.options.onSettled({ target: target.key, ...(row.requestId !== undefined ? { requestId: row.requestId } : {}), row: done, handle: { ...handle, head: state.mergeCommit ?? state.head }, settlement: step.settlement, state });
        return step;
      }
      const waiting = target.handles.update(row.taskId, row.key, { seen: step.seen, settleAt: step.settleAt ?? null, checkedAt: this.clock.now(), lastError: null }) ?? row;
      this.armWindow(target.key, waiting);
      this.options.onProgress?.({ target: target.key, row: waiting, state, step });
      return step;
    }
  }

  /**
   * Whether a read may touch this target's store. A read awaits the forge, and the process can shut
   * down — or the project close — in that time; its store is closed then, and the row is someone
   * else's to read on the next open.
   */
  private live(target: WatchTarget): boolean {
    return !this.disposed && this.options.targets().some((t) => t.handles === target.handles);
  }

  private disarm(id: string): void {
    const timer = this.windows.get(id);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.windows.delete(id);
  }

  /**
   * A running window gets a timer of its own, to the deadline on the row — and what fires is a READ,
   * not a settlement: a comment made in the last minute must be in what goes back.
   */
  private armWindow(targetKey: string, row: RemoteHandleRow): void {
    const id = handleKeyOf(targetKey, row);
    this.disarm(id);
    if (row.settleAt === undefined || !row.awaiting) return;
    const wait = Math.max(0, row.settleAt - this.clock.now());
    this.windows.set(
      id,
      this.clock.setTimeout(() => {
        this.windows.delete(id);
        const target = this.options.targets().find((t) => t.key === targetKey);
        if (target !== undefined) void this.check(target, row);
      }, wait),
    );
  }
}
