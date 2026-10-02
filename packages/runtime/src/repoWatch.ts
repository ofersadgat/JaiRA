/**
 * The repository watcher (decision 0010 §2): per project, per git remote, a look at the forge every
 * minute while something is switched on for it — and a DIFFERENCE from the last look becomes events.
 *
 * `remoteWatch.ts` watches the merge requests a task opened itself, to settle a gate. This watches a
 * whole repository, for the events a workflow's `on_event` waits on. They share the clock and the
 * cadence rule ({@link nextProbeDelay}); nothing else, because what they remember is different.
 *
 * ## What is looked at
 *
 * Only what an enabled event needs, per remote (`enabledEvents`):
 *
 *  - **merge requests**, for any `merge_request.*` or `git.merged` — those updated since the cursor,
 *    in one list;
 *  - **comments**, for `merge_request.commented` — only on a request that list says changed;
 *  - **branch heads**, for `git.pushed` or a `pipeline.*` — the branch list;
 *  - **pipelines**, for a `pipeline.*` — of branch heads matching that event's branches, and only
 *    until each head's pipelines finish.
 *
 * Nothing is enabled, nothing is polled: a target with no events is no target at all.
 *
 * ## The latest-state rule
 *
 * "We should only handle a transition for the latest state that we missed." Every look compares the
 * forge's state NOW with the last state seen, and a difference is at most one occurrence per merge
 * request or branch (a request's comments are their own difference, and one event however many
 * arrived). One occurrence may carry two names (decision 0016 §4):
 *
 *  | last seen            | now                        | event                          |
 *  | -------------------- | -------------------------- | ------------------------------ |
 *  | —                    | open                       | `merge_request.opened`         |
 *  | —                    | merged / closed            | nothing (opened and closed unseen) |
 *  | open                 | open, title/description moved | `merge_request.updated`     |
 *  | open                 | open, head moved           | `merge_request.updated` and `merge_request.pushed` |
 *  | open                 | merged                     | `git.merged` and `merge_request.merged` |
 *  | open                 | closed                     | `merge_request.closed`         |
 *  | branch at A          | branch at B                | one `git.pushed` A..B          |
 *  | —                    | branch at B                | one `git.pushed` from {@link NEW_BRANCH_SHA} |
 *  | head's pipelines running | finished                | per pipeline: `pipeline.succeeded`, `.failed` or `.canceled` |
 *
 * A head's pipelines on GitLab are its newest (a re-run supersedes); on GitHub every suite, one per
 * workflow or app, each reporting its own. A skipped or manual pipeline raises nothing.
 *
 * A merge request that is merged or closed is forgotten once reported: if it reopens, it is open and
 * unseen, which is `opened` again.
 *
 * ## The baseline
 *
 * The first look at a remote — or at a kind newly needed, like branches once `git.pushed` is switched
 * on — stores what is there and emits NOTHING. A repository's existing hundred branches are not a
 * hundred pushes. Each kind's baseline is marked on the cursor, so a restart is not a first look:
 * closed for a weekend, the first look after start is one comparison, and the latest state is what
 * fires.
 *
 * Comments JaiRA posted are never events: every one carries JaiRA's marker (`signComment`,
 * `isJairaComment` — the forge's `own`), and an events task that answered its own comment would never
 * stop. Only the MARKER excludes, not the account (the rulings of 2026-09-25): the connection's token is
 * the person's, and what they write on the forge with it fires `merge_request.commented` like
 * anyone's.
 */
import { createHash } from "node:crypto";
import {
  EVENT_SPECS,
  isJairaComment,
  matchesGlobs,
  NEW_BRANCH_SHA,
  handleOfSummary,
  type PipelineStatus,
  type EnabledEvent,
  type EventComment,
  type EventDelivery,
  type EventMergeRequest,
  type EventName,
  type ForgeProvider,
  type GitEventBase,
  type JairaEvent,
  type MergeRequestSummary,
  type RepoWatchCursor,
  type RepoWatchPort,
  type RepoWatchScope,
  type SeenMergeRequest,
} from "@jaira/shared";
import { ForgeError } from "./forge";
import { FAST_MS, nextProbeDelay, type WatchClock } from "./remoteWatch";

/** One remote of one open project, and the events switched on for it. */
export interface RepoWatchTarget {
  /** The project's key — events are delivered to that project's tasks only. */
  project: string;
  /** The git remote's name. */
  remote: string;
  host: string;
  /** The project's path on the host — `owner/repo`. */
  repository: string;
  /** The connection its host picked. */
  connection: string;
  /** The `git.*` events on for this remote, with their branch globs. */
  events: readonly EnabledEvent[];
  store: RepoWatchPort;
  /** The provider, with the connection's token. Throws a sentence when there is none. */
  provider(): ForgeProvider;
}

export interface RepositoryWatcherOptions {
  /** Every remote to watch now. Consulted on each {@link RepositoryWatcher.kick}. */
  targets: () => RepoWatchTarget[] | Promise<RepoWatchTarget[]>;
  /** An event happened on one of `project`'s remotes. */
  onEvent: (project: string, event: EventDelivery) => void;
  clock?: WatchClock;
  onError?: (target: RepoWatchTarget, error: Error) => void;
  /**
   * Whether a look that was awaiting the forge may still touch its target's store — not when the
   * project closed while the forge answered. Absent: always.
   */
  live?: (target: RepoWatchTarget) => boolean;
}

/** How far back a merge request list reaches past the cursor: a forge's clock and a request updated in the same second as the last look. Re-seeing an unchanged request costs nothing — it is compared, not reported. */
export const LOOKBACK_MS = 5 * 60_000;
/** A head no pipeline starts for is given up on after this — a branch with no CI. */
export const PIPELINES_GIVE_UP_MS = 60 * 60_000;

/** The pipeline events, and which a finished pipeline's status raises — skipped and manual raise none. */
const PIPELINE_EVENTS = ["pipeline.succeeded", "pipeline.failed", "pipeline.canceled"] as const;
const PIPELINE_EVENT_OF: Partial<Record<PipelineStatus, (typeof PIPELINE_EVENTS)[number]>> = {
  success: "pipeline.succeeded",
  failed: "pipeline.failed",
  canceled: "pipeline.canceled",
};
/** A list page the watcher reads at most — the forge's own maximum. */
const LIST_LIMIT = 100;

const realClock: WatchClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const handle = setTimeout(run, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A target's identity: which project, which remote, pointing where. */
export const repoWatchKeyOf = (target: Pick<RepoWatchTarget, "project" | "remote" | "host" | "repository">): string =>
  JSON.stringify([target.project, target.remote, target.host, target.repository]);

const scopeOf = (target: RepoWatchTarget): RepoWatchScope => ({ remote: target.remote, repository: `${target.host}/${target.repository}` });

const digest = (text: string | undefined): string => createHash("sha1").update(text ?? "").digest("hex").slice(0, 16);

const mergeRequestOf = (summary: MergeRequestSummary): EventMergeRequest => ({
  number: summary.number,
  title: summary.title,
  state: summary.state,
  author: summary.author,
  source_branch: summary.sourceBranch,
  target_branch: summary.targetBranch,
  head_sha: summary.head,
  url: summary.url,
});

const later = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) || Number.isNaN(Date.parse(a)) ? b : a);

interface Polling {
  target: RepoWatchTarget;
  timer?: unknown;
  failures: number;
  floorSeconds?: number;
  looking: boolean;
  again?: boolean;
  /** When the last look ended (epoch ms), and what it failed with — for {@link RepositoryWatcher.status}. */
  checkedAt?: number;
  error?: string;
}

/** What Settings shows of one watched remote (the `events:status` channel). */
export interface RepoWatchStatus {
  /** The watcher has it as a target now: something is switched on for it and it has a connection. */
  watching: boolean;
  /** When the last look at it ended, epoch ms. */
  checkedAt?: number;
  /** What the last look failed with — absent once one succeeds. */
  error?: string;
}

export class RepositoryWatcher {
  private readonly clock: WatchClock;
  private readonly polling = new Map<string, Polling>();
  private disposed = false;
  private kicking?: Promise<void>;
  private kickAgain = false;

  constructor(private readonly options: RepositoryWatcherOptions) {
    this.clock = options.clock ?? realClock;
  }

  /**
   * One remote of one project, as Settings shows it: whether it is watched, when it was last looked
   * at, and what that look failed with. Read-only; asks the forge nothing.
   */
  status(project: string, remote: string): RepoWatchStatus {
    const polling = [...this.polling.values()].find((one) => one.target.project === project && one.target.remote === remote);
    if (polling === undefined) return { watching: false };
    return {
      watching: true,
      ...(polling.checkedAt !== undefined ? { checkedAt: polling.checkedAt } : {}),
      ...(polling.error !== undefined ? { error: polling.error } : {}),
    };
  }

  /** The targets being watched now, by key. */
  watching(): string[] {
    return [...this.polling.keys()];
  }

  /**
   * Re-read the targets and look at every one NOW: a project opened, a setting changed, the machine
   * woke. A target no longer there loses its timer; a new one gets its first look. Calls that arrive
   * while one is working are folded into one more pass after it.
   */
  kick(): Promise<void> {
    return this.run(true);
  }

  /**
   * Re-read the targets WITHOUT looking again at the ones already watched — only a new one gets its
   * first look. What a wait beginning asks for: that the watcher exists and knows its remotes, not a
   * request to the forge per armed rule.
   */
  refresh(): Promise<void> {
    return this.run(false);
  }

  private run(lookAll: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.lookAll ||= lookAll;
    if (this.kicking !== undefined) {
      this.kickAgain = true;
      return this.kicking;
    }
    this.kicking = (async () => {
      do {
        this.kickAgain = false;
        const all = this.lookAll;
        this.lookAll = false;
        await this.reconcile(all);
      } while (this.kickAgain && !this.disposed);
    })().finally(() => (this.kicking = undefined));
    return this.kicking;
  }

  private lookAll = false;
  /** The targets being read — `git` run in each project — while a pass is reading them. */
  private reading?: Promise<void>;

  private async reconcile(lookAll: boolean): Promise<void> {
    let targets: RepoWatchTarget[];
    const reading = Promise.resolve().then(() => this.options.targets());
    this.reading = reading.then(
      () => undefined,
      () => undefined,
    );
    try {
      targets = (await reading).filter((target) => target.events.length > 0);
    } catch {
      return;
    }
    if (this.disposed) return;
    const wanted = new Map(targets.map((target) => [repoWatchKeyOf(target), target]));
    for (const [key, polling] of this.polling) {
      if (wanted.has(key)) continue;
      if (polling.timer !== undefined) this.clock.clearTimeout(polling.timer);
      this.polling.delete(key);
    }
    const looks: Array<Promise<void>> = [];
    for (const [key, target] of wanted) {
      const polling = this.polling.get(key);
      if (polling === undefined) this.polling.set(key, { target, failures: 0, looking: false });
      else polling.target = target;
      if (polling === undefined || lookAll) looks.push(this.look(key));
    }
    await Promise.all(looks);
  }

  /**
   * Stop: no more timers, no more looks. Resolves once a read of the targets already under way has
   * ended — it runs `git` IN each project, and a closed project whose directory a git process still stands in
   * cannot be removed (Windows: EBUSY). A forge request in flight is not waited for: its answer is
   * dropped (`alive`).
   */
  dispose(): Promise<void> {
    this.disposed = true;
    for (const polling of this.polling.values()) if (polling.timer !== undefined) this.clock.clearTimeout(polling.timer);
    this.polling.clear();
    return this.reading ?? Promise.resolve();
  }

  /** Look at one target now. Public for "check now" and for tests; one look per target at a time. */
  async look(key: string): Promise<void> {
    const polling = this.polling.get(key);
    if (polling === undefined || this.disposed) return;
    if (polling.looking) {
      // Asked again mid-look — a setting changed, a project re-opened: one more look right after.
      polling.again = true;
      return;
    }
    polling.looking = true;
    polling.again = false;
    if (polling.timer !== undefined) this.clock.clearTimeout(polling.timer);
    polling.timer = undefined;
    const target = polling.target;
    try {
      await this.diff(target);
      polling.failures = 0;
      polling.floorSeconds = undefined;
      polling.checkedAt = this.clock.now();
      polling.error = undefined;
    } catch (error) {
      if (!this.alive(key, target)) return;
      polling.failures += 1;
      polling.checkedAt = this.clock.now();
      polling.error = (error as Error).message;
      if (error instanceof ForgeError && error.retryAfterSeconds !== undefined) polling.floorSeconds = error.retryAfterSeconds;
      try {
        const scope = scopeOf(target);
        target.store.setCursor(scope, target.store.cursor(scope) ?? {}, (error as Error).message);
      } catch {
        // The store went with its project; the next kick drops the target.
      }
      this.options.onError?.(target, error as Error);
    } finally {
      polling.looking = false;
    }
    // Gone — disposed, dropped by a kick, or its project closed while the forge answered: no next look.
    if (this.disposed || this.polling.get(key) !== polling || !(this.options.live?.(polling.target) ?? true)) return;
    if (polling.again) return this.look(key);
    // Something is switched on, or this target would not be here: the fast cadence, unless the
    // forge failed (backing off by itself) or named its own floor.
    const delay = nextProbeDelay({ attention: true, quiet: 0, failures: polling.failures, ...(polling.floorSeconds !== undefined ? { floorSeconds: polling.floorSeconds } : {}) });
    polling.timer = this.clock.setTimeout(() => void this.look(key), Math.max(delay, FAST_MS));
  }

  /** Whether a look may still write: the watcher runs, the target is still watched, its store still open. */
  private alive(key: string, target: RepoWatchTarget): boolean {
    return !this.disposed && this.polling.get(key)?.target.store === target.store && (this.options.live?.(target) ?? true);
  }

  // --- one look ----------------------------------------------------------------------------------

  private async diff(target: RepoWatchTarget): Promise<void> {
    const key = repoWatchKeyOf(target);
    const provider = target.provider();
    const scope = scopeOf(target);
    const store = target.store;
    const cursor: RepoWatchCursor = { ...(store.cursor(scope) ?? {}) };
    const on = new Map(target.events.map((event) => [event.name, event]));
    const base: GitEventBase = { remote: target.remote, connection: target.connection, host: target.host, repository: target.repository };
    const at = (): string => new Date(this.clock.now()).toISOString();
    /** Whether an event is on here, for this branch (its `branches` globs, where the event has them). */
    const wants = (name: EventName, branch: string): boolean => {
      const event = on.get(name);
      if (event === undefined) return false;
      return event.branches === undefined || EVENT_SPECS[name].branches === undefined || matchesGlobs(branch, event.branches);
    };
    const emit = (event: JairaEvent): void => {
      if (!this.alive(key, target)) return;
      this.options.onEvent(target.project, { ...event, at: at() } as EventDelivery);
    };
    const save = (): void => {
      if (this.alive(key, target)) store.setCursor(scope, cursor, null);
    };
    const hold = (): boolean => this.alive(key, target);

    // --- merge requests ---------------------------------------------------------------------------
    const mergeRequests = [...on.keys()].some((name) => name.startsWith("merge_request.") || name === "git.merged");
    if (mergeRequests) {
      if (cursor.mergeRequests === undefined) {
        const open = await provider.listMergeRequests(target.repository, { state: "open", limit: LIST_LIMIT });
        if (!hold()) return;
        let since = new Date(this.clock.now()).toISOString();
        for (const summary of open) {
          store.see(scope, "merge_request", String(summary.number), this.seenOf(summary, summary.updatedAt));
          since = later(since, summary.updatedAt);
        }
        cursor.mergeRequests = { since };
      } else {
        const since = cursor.mergeRequests.since;
        const from = Number.isNaN(Date.parse(since)) ? since : new Date(Date.parse(since) - LOOKBACK_MS).toISOString();
        const listed = await provider.listMergeRequests(target.repository, { state: "all", updatedSince: from, limit: LIST_LIMIT });
        if (!hold()) return;
        let newest = since;
        // Oldest first, so what a task hears is in the order it happened.
        for (const summary of [...listed].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
          newest = later(newest, summary.updatedAt);
          await this.mergeRequest(target, provider, scope, summary, base, wants, emit);
          if (!hold()) return;
        }
        cursor.mergeRequests = { since: newest };
      }
      save();
    }

    // --- branch heads -----------------------------------------------------------------------------
    const pushes = on.has("git.pushed");
    const pipelines = PIPELINE_EVENTS.some((name) => on.has(name));
    if (!pushes && !pipelines) return;
    const heads = await provider.branches(target.repository);
    if (!hold()) return;
    if (cursor.branches === undefined) {
      for (const branch of heads) store.see(scope, "branch", branch.name, { head: branch.head });
      cursor.branches = true;
    } else {
      const seen = store.seenAll(scope, "branch");
      for (const branch of heads) {
        const before = seen.get(branch.name)?.head;
        seen.delete(branch.name);
        if (before === branch.head) continue;
        store.see(scope, "branch", branch.name, { head: branch.head });
        if (pipelines && cursor.pipelines === true && PIPELINE_EVENTS.some((name) => wants(name, branch.name))) {
          store.see(scope, "pipelines", branch.name, { sha: branch.head, done: false, since: this.clock.now() });
        }
        if (pushes && wants("git.pushed", branch.name)) {
          const commits = await this.commits(provider, target.repository, before, branch.head);
          if (!hold()) return;
          emit({ name: "git.pushed", payload: { ...base, branch: branch.name, before: before ?? NEW_BRANCH_SHA, after: branch.head, commits } });
        }
      }
      // A branch deleted on the forge: forgotten, and nothing fires — a deletion is not a push.
      for (const gone of seen.keys()) {
        store.forget(scope, "branch", gone);
        store.forget(scope, "pipelines", gone);
      }
    }
    save();

    // --- pipelines --------------------------------------------------------------------------------
    if (!pipelines) return;
    if (cursor.pipelines === undefined) {
      // The heads there now had their chance before anybody was listening.
      for (const branch of heads) store.see(scope, "pipelines", branch.name, { sha: branch.head, done: true, since: this.clock.now() });
      cursor.pipelines = true;
      save();
      return;
    }
    for (const [branch, row] of store.seenAll(scope, "pipelines")) {
      if (row.done || !PIPELINE_EVENTS.some((name) => wants(name, branch))) continue;
      const { pipelines: ran } = await provider.pipelines(target.repository, { sha: row.sha, limit: 100 });
      if (!hold()) return;
      // GitLab: the newest pipeline of the commit is its verdict (a re-run supersedes the one before).
      // GitHub: every suite is a workflow of its own, and each reports.
      const current = provider.kind === "gitlab" ? ran.slice(0, 1) : ran;
      if (current.length === 0) {
        if (this.clock.now() - row.since >= PIPELINES_GIVE_UP_MS) store.see(scope, "pipelines", branch, { ...row, done: true });
        continue;
      }
      if (current.some((pipeline) => pipeline.status === "pending" || pipeline.status === "running")) continue;
      store.see(scope, "pipelines", branch, { ...row, done: true });
      for (const pipeline of current) {
        const name = PIPELINE_EVENT_OF[pipeline.status];
        if (name === undefined || !wants(name, branch)) continue;
        const payload = {
          ...base,
          ref: branch,
          sha: row.sha,
          pipeline_id: pipeline.id,
          ...(pipeline.name !== undefined ? { name: pipeline.name } : {}),
          source: pipeline.source,
          url: pipeline.url,
        };
        if (name !== "pipeline.failed") {
          emit({ name, payload });
          continue;
        }
        const failed = (await provider.pipeline(target.repository, pipeline.id, { jobStatus: ["failed"] })).jobs;
        if (!hold()) return;
        emit({
          name,
          payload: {
            ...payload,
            failed_jobs: failed.map((job) => ({
              job_id: job.id,
              name: job.name,
              ...(job.stage !== undefined ? { stage: job.stage } : {}),
              ...(job.failureReason !== undefined ? { failure_reason: job.failureReason } : {}),
              url: job.url,
            })),
          },
        });
      }
    }
  }

  private seenOf(summary: MergeRequestSummary, commentsAt: string): SeenMergeRequest {
    return {
      state: summary.state,
      head: summary.head,
      title: summary.title,
      description: digest(summary.description),
      updatedAt: summary.updatedAt,
      commentsAt,
    };
  }

  /** One merge request the list says was updated: compare, remember, and say what changed. */
  private async mergeRequest(
    target: RepoWatchTarget,
    provider: ForgeProvider,
    scope: RepoWatchScope,
    summary: MergeRequestSummary,
    base: GitEventBase,
    wants: (name: EventName, branch: string) => boolean,
    emit: (event: JairaEvent) => void,
  ): Promise<void> {
    const store = target.store;
    const key = String(summary.number);
    const prev = store.seen(scope, "merge_request", key);
    const branch = summary.targetBranch;
    const payload = { ...base, merge_request: mergeRequestOf(summary) };

    if (prev === undefined) {
      // Unseen and already merged or closed: opened and closed between two looks — nothing.
      if (summary.state !== "open") return;
      store.see(scope, "merge_request", key, this.seenOf(summary, summary.updatedAt));
      if (wants("merge_request.opened", branch)) emit({ name: "merge_request.opened", payload });
      return;
    }

    // Comments first: they happened before the request was merged, if it was.
    let commentsAt = prev.commentsAt;
    if (summary.updatedAt !== prev.updatedAt && wants("merge_request.commented", branch)) {
      const handle = handleOfSummary(provider.kind, target.host, target.repository, summary);
      const notes = await provider.comments(handle, { since: prev.commentsAt });
      // The marker, read here rather than trusted off `own`: this is the rule, and a note is its body.
      const fresh = notes.filter((note) => !isJairaComment(note.body) && note.at > prev.commentsAt);
      for (const note of notes) commentsAt = later(commentsAt, note.at);
      if (fresh.length > 0) {
        const comments: EventComment[] = fresh.map((note) => ({
          id: note.id,
          author: note.who,
          body: note.body,
          created_at: note.at,
          ...(note.threadId !== undefined ? { thread_id: note.threadId } : {}),
          ...(note.anchor !== undefined ? { anchor: note.anchor } : {}),
        }));
        emit({ name: "merge_request.commented", payload: { ...payload, comments } });
      }
    }
    commentsAt = later(commentsAt, summary.updatedAt);

    if (summary.state !== "open") {
      // Reported once, then forgotten: a reopened request is an unseen open one — `opened` again.
      store.forget(scope, "merge_request", key);
      if (prev.state !== "open") return;
      if (summary.state === "merged") {
        // One merge, two names (decision 0016 §4): git_merge's, and the merge request's.
        if (wants("git.merged", branch)) emit({ name: "git.merged", payload });
        if (wants("merge_request.merged", branch)) emit({ name: "merge_request.merged", payload });
      } else if (wants("merge_request.closed", branch)) emit({ name: "merge_request.closed", payload });
      return;
    }
    store.see(scope, "merge_request", key, this.seenOf(summary, commentsAt));
    if (prev.state !== "open") {
      if (wants("merge_request.opened", branch)) emit({ name: "merge_request.opened", payload });
      return;
    }
    const moved = prev.head !== summary.head || prev.title !== summary.title || prev.description !== digest(summary.description);
    if (moved && wants("merge_request.updated", branch)) emit({ name: "merge_request.updated", payload });
    // New commits are also the push, told as the request's — the same occurrence under a second name.
    if (prev.head !== summary.head && wants("merge_request.pushed", branch)) {
      const commits = await this.commits(provider, target.repository, prev.head, summary.head);
      emit({ name: "merge_request.pushed", payload: { ...payload, before: prev.head, after: summary.head, commits } });
    }
  }

  /** The commits a push brought, when the provider can say cheaply; none when it cannot. */
  private async commits(provider: ForgeProvider, repository: string, before: string | undefined, after: string): Promise<Array<{ sha: string; message: string; author: string }>> {
    if (provider.compare === undefined) return [];
    try {
      return await provider.compare(repository, before, after);
    } catch {
      // A force-push can leave `before` unknown to the forge: the head alone still says who pushed what.
      if (before === undefined) return [];
      try {
        return await provider.compare(repository, undefined, after);
      } catch {
        return [];
      }
    }
  }
}

