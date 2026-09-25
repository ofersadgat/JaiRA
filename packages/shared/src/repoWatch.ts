/**
 * The repository watcher's memory (decision 0010 §2, "Delivery is polling") — what it last saw of a
 * project's remote, so that the next look turns a DIFFERENCE into events.
 *
 * Here rather than in `@jaira/persistence` for the reason `RemoteHandlePort` is: `@jaira/runtime`
 * reads and writes it and cannot import the package that stores it.
 *
 * Two grains, both keyed by the git remote (its name in `.git/config`) and the forge repository it
 * points at (`host/path`) — so a remote re-pointed at another repository starts over from a baseline
 * rather than diffing one repository's branches against another's:
 *
 *  - the CURSOR, one per remote: where the next "what changed since" starts, and which kinds have had
 *    their baseline taken;
 *  - the LAST SEEN state, one per `(kind, key)`: a merge request by its number, a branch by its name,
 *    and a branch's head's checks by the branch's name.
 */
import type { EventName, JairaEvent } from "./events";

/** What the watcher remembers one of. */
export type RepoWatchKind = "merge_request" | "branch" | "checks";

export const REPO_WATCH_KINDS: readonly RepoWatchKind[] = ["merge_request", "branch", "checks"];

/** Which remote, on which repository. */
export interface RepoWatchScope {
  /** The git remote's name — `origin`. */
  remote: string;
  /** `host/path` — `github.com/owner/repo`. */
  repository: string;
}

/**
 * Where the next poll starts, per remote.
 *
 * Each kind's presence means its BASELINE was taken: the first sight of a remote (or of a kind newly
 * switched on) stores what is there and emits nothing, and only a later difference is news.
 */
export interface RepoWatchCursor {
  /** Merge requests: the newest `updated_at` the forge has reported (ISO) — the next list starts there. */
  mergeRequests?: { since: string };
  /** Branch heads have been read at least once. */
  branches?: true;
  /** Branch heads' checks have a baseline. */
  checks?: true;
  /** Conditional-request ETags, by request url, where a provider hands them back. */
  etags?: Record<string, string>;
}

/** A merge request as last seen. */
export interface SeenMergeRequest {
  state: "open" | "closed" | "merged";
  head: string;
  title: string;
  /** A digest of the description — a change to it is an update, and the text itself is not kept. */
  description: string;
  updatedAt: string;
  /** Comments written after this (ISO) are new. */
  commentsAt: string;
}

/** A branch as last seen. */
export interface SeenBranch {
  head: string;
}

/** A branch head's checks: which commit, and whether they have been concluded (reported or passed). */
export interface SeenChecks {
  sha: string;
  /** True once the checks of `sha` concluded — or the head was there at the baseline. */
  done: boolean;
  /** Epoch ms the head was first seen, so checks that never start are eventually given up on. */
  since: number;
}

export interface RepoWatchSeen {
  merge_request: SeenMergeRequest;
  branch: SeenBranch;
  checks: SeenChecks;
}

/** What the watcher needs of the store. `@jaira/persistence` implements it. */
export interface RepoWatchPort {
  cursor(scope: RepoWatchScope): RepoWatchCursor | undefined;
  setCursor(scope: RepoWatchScope, cursor: RepoWatchCursor, error?: string | null): void;
  seen<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string): RepoWatchSeen[K] | undefined;
  /** Every row of one kind, by key. */
  seenAll<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K): Map<string, RepoWatchSeen[K]>;
  see<K extends RepoWatchKind>(scope: RepoWatchScope, kind: K, key: string, state: RepoWatchSeen[K]): void;
  forget(scope: RepoWatchScope, kind: RepoWatchKind, key: string): void;
}

/**
 * Where a task's event waits started (decision 0010 §3): the hub queues what arrives for a task from
 * the moment it first waits on a name. Kept durably so that a task suspended by the app closing, and
 * resumed on the next start, still counts what the watcher catches up on as arriving AFTER that.
 */
export interface EventWaitPort {
  /** When this task's guards first waited on this event name — epoch ms — or `undefined`. */
  since(taskId: string, name: EventName): number | undefined;
  open(taskId: string, name: EventName, since: number): void;
  /** Every subscription of one task ends: its run ended for good. */
  closeTask(taskId: string): void;
}

/**
 * One event as it is DELIVERED — what `on_event(...)` resolves to and `wait_git_event` answers with:
 * its name, its payload, and when JaiRA saw it happen (ISO 8601).
 */
export type EventDelivery = JairaEvent & { at: string };
