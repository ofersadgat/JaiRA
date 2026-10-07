/**
 * What a reader syncs by (decision 0018 §3–§5): the change log's entries, and a page of what changed
 * since a cursor. The log itself is `@jaira/persistence`'s `sync.ts`.
 */
import type { ProjectTask } from "./view";

/** One entry of the change log: a row of `collection` changed (or was deleted) at `at`, this engine's clock. */
export interface SyncChange {
  collection: string;
  id: string;
  /** The task it belongs to, where it belongs to one. */
  taskId: string | null;
  at: number;
  deleted: boolean;
}

/**
 * What changed at or after a cursor, as `sync:since` answers it and `sync:changed` pushes it.
 *
 * A reader upserts `tasks` by id, drops `gone`, and re-reads whatever it holds of a task named in
 * `changes`; then holds `at` as its cursor. The read is inclusive, so whatever was stamped `at` comes
 * again on the next page and merges.
 */
export interface SyncPage {
  /** The cursor to hold next: the newest stamp when the page was read, taken before its rows. */
  at: number;
  /** Below this, tombstones were dropped; a cursor older than it cannot be followed, and the page is whole. */
  horizon: number;
  /** Everything, not a difference: the cursor was 0, or older than the horizon. Replace, don't merge. */
  whole: boolean;
  /** The summaries of every task that changed (all of them, when whole) — this machine's and its copies'. */
  tasks: ProjectTask[];
  /** Tasks deleted since the cursor. */
  gone: string[];
  /** The log's entries since the cursor (none when whole): what of each task changed. */
  changes: SyncChange[];
}
