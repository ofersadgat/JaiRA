/**
 * A durable {@link MemoCache} over the project database.
 *
 * The in-memory default answers "would someone else making this identical call reuse this answer?"
 * only within one process. That is the wrong scope for the thing that actually costs money: the same
 * model call repeats across runs of a task, across tasks that share a prompt, and across the CLI and
 * the app driving the same project. Keyed by `memoKey` — the operation's content hash folded with the
 * executor's namespace — an entry written by one of them is read by all of them.
 *
 * A DURABLE cache needs an explicit `namespace` on `withMemoize`. The default is a process-local
 * token, which makes a shared cache safe by construction but means a persisted entry could never be
 * hit; see {@link memoNamespace} for what JaiRA folds in.
 */
import type { Database } from "better-sqlite3";
import type { MemoCache } from "@declarative-ai/exec";
import type { ExecResult, ResolvedValue } from "@declarative-ai/exec";

/** Row shape — `outcome` is the serialized successful result. */
interface MemoRow {
  outcome: string;
}

export class SqliteMemoCache implements MemoCache {
  constructor(private readonly db: Database) {}

  get(key: string): ExecResult<ResolvedValue> | undefined {
    const row = this.db.prepare("SELECT outcome FROM call_memo WHERE key = ?").get(key) as MemoRow | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.outcome) as ExecResult<ResolvedValue>;
    } catch {
      // A row we cannot read is a miss, not a crash: the answer is recomputable by definition, and a
      // cache that can take down a run is worse than no cache.
      return undefined;
    }
  }

  set(key: string, outcome: ExecResult<ResolvedValue>): void {
    // Successes only. `withMemoize` already promises this, and it is re-checked here because DURABILITY
    // raises the stakes: an in-memory mistake evaporates with the process, while a persisted failure
    // would be served to every later run until someone noticed and cleared the table.
    if ("error" in outcome && outcome.error !== undefined) return;
    let payload: string;
    try {
      payload = JSON.stringify(outcome);
    } catch {
      return; // not serializable ⇒ not cacheable; recomputing is always correct
    }
    this.db
      .prepare("INSERT INTO call_memo (key, outcome, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET outcome = excluded.outcome")
      .run(key, payload, Date.now());
  }

  /** Entry count — for the pruning surface and for tests. */
  size(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM call_memo").get() as { n: number }).n;
  }

  clear(): void {
    this.db.prepare("DELETE FROM call_memo").run();
  }
}

/**
 * The `namespace` component of a memo key: what makes THIS executor's answers different from another's.
 *
 * Model routing is the whole of it for a prompt executor — the same prompt under a different default
 * model is a different question, and sharing one cache entry between them would hand back an answer
 * the caller never asked for. The version prefix is the escape hatch for when a change to how prompts
 * are rendered or results parsed invalidates everything written before it.
 */
export function memoNamespace(modelDefaults: Record<string, unknown>): string {
  return `jaira-prompt-v1:${JSON.stringify(modelDefaults, Object.keys(modelDefaults).sort())}`;
}
