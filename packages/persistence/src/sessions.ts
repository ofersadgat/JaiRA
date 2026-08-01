/**
 * Durable conversation streams (SESSIONS.md §2, §9).
 *
 * A **session** is an append-only sequence of messages. A **session ref** names one
 * AT a position, which is what makes "continue from here" and "branch from here" the
 * same primitive: hand someone a ref and they can do either, and neither disturbs
 * what the other sees.
 *
 * Two identifiers live here and confusing them is the easiest way to get this wrong:
 *
 *  - a **branch id** (`sessions.id`) names a row — one lineage node;
 *  - a **session ref id** ({@link SessionRef.id}) names a branch AT a position, and is
 *    what flows through inputs, outputs and expressions.
 *
 * **Both are opaque outside this module.** hw, promptop and every executor treat a ref
 * as a string and never parse it; only this store knows that a ref is spelled
 * `<branch>@<position>`. That is what lets the spelling change later — including the
 * human-readable label — without touching a single consumer.
 *
 * The **label** (`planning[0:14]/b`) is derived for observability, may be truncated for
 * display on deep chains, and is **never** a foreign key. Lineage is queried from
 * `parent_id`, not parsed out of a string.
 *
 * This module is storage only. Deciding whether a call appends or forks is the
 * wrapper's job (SESSIONS.md §5/§6); what lives here is the durable backstop that
 * decision rests on — {@link SessionStreams.append} is CONDITIONAL on the expected
 * position, so two writers racing the same position cannot both win.
 */
import type { Database } from "better-sqlite3";
import { canonicalize, sha256Hex, type JsonValue } from "@declarative-ai/json";
import { PositionTaken as ExecPositionTaken, resolveSessionRef } from "@declarative-ai/exec";
import type {
  RecordStore as ExecRecordStore,
  ResolvedSession as ExecResolvedSession,
  SessionRequest as ExecSessionRequest,
  SessionStore as ExecSessionStore,
} from "@declarative-ai/exec";

/**
 * How a branch came into being — recorded as the edge to its parent.
 *
 * Only `fork` shares a prefix with its parent, and only `fork` carries a cursor. A
 * compacted stream's first message is a summary that appears nowhere in the origin,
 * so calling it a fork would make `[0:n]` assert something false; `resync` re-reads
 * its contents from the provider and is no more prefix-identical. Both record a
 * parent for provenance and inherit no content.
 */
export type SessionEdge = "root" | "fork" | "compaction" | "resync";

/** A branch, as stored. `id` is opaque to everything outside this module. */
export interface SessionBranch {
  id: string;
  label: string;
  parentId?: string;
  /** Fork edges only: how many of the parent's messages this branch took. */
  parentCursor?: number;
  edge: SessionEdge;
  /** Rolling content commitment at this branch's head. */
  digest?: string;
  taskId?: string;
  runId?: number;
  createdAt: number;
}

/**
 * The value that flows through inputs, outputs and expressions.
 *
 * `id` is the only enumerable property, so the events journal, `inputs_json` and
 * `outputs_json` all see `{ id }` and nothing else. Richer resolved forms attach
 * their extras NON-enumerably (SESSIONS.md §3).
 */
export interface SessionRef {
  readonly id: string;
}

/** One stored entry: a `ModelMessage` verbatim, plus what the provider called it. */
export interface SessionEntry<Msg = JsonValue> {
  message: Msg;
  /** The provider's own id for this entry, when it has one. */
  providerRef?: string;
  /** Which operation appended it. */
  operationId?: string;
}

/** A stored entry read back, with the position it occupies. */
export interface SessionEntryAt<Msg = JsonValue> extends SessionEntry<Msg> {
  seq: number;
}

/**
 * Raised when an append targets a position that is no longer the head.
 *
 * The wrapper turns this into a fork (SESSIONS.md §5). It is a distinct class rather
 * than a bare `Error` precisely so that "someone else got there first" is never
 * mistaken for "the database is broken" — the first is routine and has a correct
 * answer, the second does not.
 */
export class SessionPositionConflict extends Error {
  constructor(
    readonly branchId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`session ${branchId}: expected to append at position ${expected}, but the head is ${actual}`);
    this.name = "SessionPositionConflict";
  }
}

/** Raised when a ref names a branch that does not exist — unknown, or pruned away. */
export class UnknownSession extends Error {
  constructor(readonly ref: string) {
    super(`unknown session "${ref}" — it was never created, or it has been pruned`);
    this.name = "UnknownSession";
  }
}

// --- Ref spelling ---------------------------------------------------------------

/**
 * A ref is `<branch>@<position>`. Spelled in exactly two functions so that changing
 * it is a two-line edit and no consumer can have grown a dependency on the shape.
 */
export function formatSessionRef(branchId: string, position: number): string {
  return `${branchId}@${position}`;
}

/** The inverse. Returns `undefined` for anything not spelled by {@link formatSessionRef}. */
export function parseSessionRef(id: string): { branchId: string; position: number } | undefined {
  const at = id.lastIndexOf("@");
  if (at <= 0) return undefined;
  const position = Number(id.slice(at + 1));
  if (!Number.isInteger(position) || position < 0) return undefined;
  return { branchId: id.slice(0, at), position };
}

// --- Identity -------------------------------------------------------------------

/**
 * Branch ids are DERIVED FROM STABLE INPUTS, never random.
 *
 * SESSIONS.md §13: a fan-out that mints random ids produces different lineage labels
 * on every run, which degrades exactly the observability this table exists for. So a
 * branch id is a hash of (edge, parent, cursor, seed) and the caller supplies a seed
 * that is stable across runs — a child key plus iteration index, a state id, a
 * content hash.
 *
 * The consequence to be aware of: the SAME seed at the same parent and cursor yields
 * the SAME branch. That is right for a resumed or replayed run (idempotent), and
 * wrong for deliberately fanning three variants out of one point — which is why
 * {@link SessionStreams.fork} makes distinct seeds the caller's responsibility and
 * says so in its own contract.
 */
function branchIdFor(edge: SessionEdge, parentId: string | undefined, cursor: number | undefined, seed: string): string {
  const digest = sha256Hex(canonicalize({ edge, parentId: parentId ?? null, cursor: cursor ?? null, seed }));
  return `ses_${digest.slice(0, 24)}`;
}

/**
 * A rolling content commitment: `digest(n) = sha256(digest(n-1) || canonical(msg_n))`.
 *
 * Rolling rather than a hash of the whole prefix so that an append is O(1) — the
 * common case by a wide margin — at the cost of making a digest AT AN ARBITRARY
 * POSITION an O(n) recompute, which happens only when a fork is created.
 */
const EMPTY_DIGEST = sha256Hex("");

function rollDigest(previous: string, message: unknown): string {
  return sha256Hex(`${previous}\n${canonicalize(message as JsonValue)}`);
}

// --- Labels ---------------------------------------------------------------------

/**
 * Fork suffixes run b, c, … z, aa, ab, … — the origin is implicitly `a`, so the first
 * fork of a branch is `b`. Purely cosmetic; the label is not a key.
 */
function forkSuffix(n: number): string {
  let out = "";
  let i = n + 1; // 0 -> 'b' (the trunk occupies 'a')
  while (i >= 0) {
    out = String.fromCharCode(97 + (i % 26)) + out;
    i = Math.floor(i / 26) - 1;
  }
  return out;
}

/** How far a label may grow before {@link shortSessionLabel} elides its middle. */
const LABEL_DISPLAY_LIMIT = 48;

/**
 * A label for display on a deep chain. The full label is kept in the row — this only
 * decides what a fixed-width UI shows, and it elides the MIDDLE because the two ends
 * (the origin's name and the current branch) are the parts a reader is orienting by.
 */
export function shortSessionLabel(label: string, limit = LABEL_DISPLAY_LIMIT): string {
  if (label.length <= limit) return label;
  const keep = Math.max(4, Math.floor((limit - 1) / 2));
  return `${label.slice(0, keep)}…${label.slice(-keep)}`;
}

// --- Rows -----------------------------------------------------------------------

interface BranchRow {
  id: string;
  label: string | null;
  parent_id: string | null;
  parent_cursor: number | null;
  edge: string;
  digest: string | null;
  task_id: string | null;
  run_id: number | null;
  created_at: number;
}

function toBranch(row: BranchRow): SessionBranch {
  return {
    id: row.id,
    label: row.label ?? row.id,
    ...(row.parent_id !== null ? { parentId: row.parent_id } : {}),
    ...(row.parent_cursor !== null ? { parentCursor: row.parent_cursor } : {}),
    edge: row.edge as SessionEdge,
    ...(row.digest !== null ? { digest: row.digest } : {}),
    ...(row.task_id !== null ? { taskId: row.task_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
  };
}

/** Where a branch is anchored in a run — carried onto every branch it creates. */
export interface SessionOrigin {
  taskId?: string;
  runId?: number;
}

export interface CreateRootOptions extends SessionOrigin {
  /**
   * The stable discriminator this branch's id is derived from — a state id, an
   * instance path, an authored session name. Two roots created with the same seed
   * ARE the same root; see {@link branchIdFor}.
   */
  seed: string;
  /** Display name. Defaults to `seed`. */
  name?: string;
}

export interface ForkOptions extends SessionOrigin {
  /**
   * Stable discriminator, as for a root — but here it carries an extra duty: two
   * forks of the same parent at the same cursor with the same seed are ONE branch.
   * A deliberate fan-out must therefore vary it (child key, iteration index).
   */
  seed: string;
}

export interface DerivedOptions extends SessionOrigin {
  seed: string;
  /** The messages this branch starts with. Compaction supplies a summary; resync, the provider's log. */
  entries: readonly SessionEntry[];
}

// --- The store ------------------------------------------------------------------

/**
 * The durable stream store.
 *
 * Constructed app/CLI-side and injected — `@jaira/runtime` must not import
 * `@jaira/persistence` (DESIGN §4.2a), so the runtime sees only the narrow interface
 * it is handed, exactly as it does for `SummarizingSessionStore` today.
 */
export class SessionStreams<Msg = JsonValue> {
  constructor(private readonly db: Database) {}

  // --- Reads --------------------------------------------------------------------

  /** The branch row, or `undefined`. Takes a BRANCH id, not a ref. */
  branch(branchId: string): SessionBranch | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(branchId) as BranchRow | undefined;
    return row === undefined ? undefined : toBranch(row);
  }

  /**
   * The branch and position a ref names.
   *
   * Throws {@link UnknownSession} rather than returning `undefined` for a ref whose
   * branch is gone: SESSIONS.md §4 is explicit that an unresolvable id is an error
   * and must never silently create, because that turns a typo into a plausible-looking
   * result. A ref pointing PAST the branch's head is equally unresolvable — it commits
   * to content that does not exist.
   */
  resolve(ref: string): { branch: SessionBranch; position: number } {
    const parsed = parseSessionRef(ref);
    if (parsed === undefined) throw new UnknownSession(ref);
    const branch = this.branch(parsed.branchId);
    if (branch === undefined) throw new UnknownSession(ref);
    if (parsed.position > this.head(parsed.branchId)) throw new UnknownSession(ref);
    return { branch, position: parsed.position };
  }

  /**
   * The next position an append would occupy — i.e. how many messages the branch has.
   *
   * A branch's own rows begin at its `parent_cursor` (0 for a root, and for a
   * compaction or resync, which inherit nothing), so an empty branch's head is
   * exactly the cursor it was cut at.
   */
  head(branchId: string): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS max FROM session_messages WHERE session_id = ?`).get(branchId) as
      | { max: number | null }
      | undefined;
    if (row?.max !== null && row?.max !== undefined) return row.max + 1;
    const branch = this.branch(branchId);
    return branch?.parentCursor ?? 0;
  }

  /** A ref for a branch at its current head — what "append after me" means. */
  headRef(branchId: string): SessionRef {
    return { id: formatSessionRef(branchId, this.head(branchId)) };
  }

  /**
   * Materialize a branch's messages up to (exclusive) `position`, walking the parent
   * chain and taking each ancestor's entries below the cursor its child took.
   *
   * The recursion climbs only through `fork` edges: a compaction or resync holds all
   * of its own content and inherits none, so its parent link is provenance and the
   * walk stops there. Because `seq` continues from `parent_cursor` at every hop, the
   * ancestors' ranges tile `[0, position)` exactly — no overlap, no gap — which is why
   * a single `ORDER BY seq` is the whole of the reassembly.
   */
  materialize(branchId: string, position?: number): SessionEntryAt<Msg>[] {
    const upTo = position ?? this.head(branchId);
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, parent_id, parent_cursor, edge, limit_seq) AS (
           SELECT id, parent_id, parent_cursor, edge, @upTo FROM sessions WHERE id = @id
           UNION ALL
           SELECT p.id, p.parent_id, p.parent_cursor, p.edge, c.parent_cursor
             FROM sessions p JOIN chain c ON p.id = c.parent_id
            WHERE c.edge = 'fork' AND c.parent_cursor IS NOT NULL
         )
         SELECT m.seq, m.message_json, m.provider_ref, m.operation_id
           FROM chain c JOIN session_messages m ON m.session_id = c.id
          WHERE m.seq < c.limit_seq
          ORDER BY m.seq`,
      )
      .all({ id: branchId, upTo }) as Array<{
      seq: number;
      message_json: string;
      provider_ref: string | null;
      operation_id: string | null;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      message: JSON.parse(row.message_json) as Msg,
      ...(row.provider_ref !== null ? { providerRef: row.provider_ref } : {}),
      ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
    }));
  }

  /** Materialize by ref — the position the ref commits to, not the branch's head. */
  messagesAt(ref: string): SessionEntryAt<Msg>[] {
    const { branch, position } = this.resolve(ref);
    return this.materialize(branch.id, position);
  }

  // --- Pruning ------------------------------------------------------------------

  /**
   * Every branch reachable downward from `branchId`, itself included.
   *
   * The unit pruning works in. A branch with children cannot be deleted on its own without orphaning
   * their prefixes — a fork stores only what it appended, so deleting its parent deletes the first
   * fourteen messages of a conversation that still exists.
   *
   * Of the three options SESSIONS.md §9 offers — whole lineages, leaves only, or materializing a
   * child's prefix first — this store takes WHOLE LINEAGES. Leaves-only never reclaims the trunk,
   * which is where the bulk sits; materializing first turns a prune into a copy that makes the
   * database temporarily larger, and it destroys the copy-on-write property that made forks cheap.
   */
  lineageFrom(branchId: string): SessionBranch[] {
    // Ordered by DEPTH, shallowest first — which is what makes reversing it a safe deletion order.
    // Ordering by `created_at` looked equivalent and was not: three branches minted in the same
    // millisecond tie, the tiebreak falls to a hashed id, and the root lands somewhere in the middle.
    // The parent's delete then hits the foreign key its own children still reference.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants(id, depth) AS (
           SELECT id, 0 FROM sessions WHERE id = ?
           UNION
           SELECT s.id, d.depth + 1 FROM sessions s JOIN descendants d ON s.parent_id = d.id
         )
         SELECT s.* FROM sessions s JOIN descendants d ON s.id = d.id ORDER BY d.depth, s.created_at, s.id`,
      )
      .all(branchId) as BranchRow[];
    return rows.map(toBranch);
  }

  /**
   * Delete a whole lineage — `branchId` and everything descended from it.
   *
   * Children first, then the branch itself, or the foreign keys refuse. Refuses outright if the
   * lineage has a parent OUTSIDE it, because deleting a fork's parent is exactly the orphaning this
   * is here to prevent; prune from the root of a lineage, not its middle.
   *
   * The stakes are higher here than for other pruned history. A session id is a capability — hold one
   * and you may use it — so pruning is the ONLY thing that can make a held id unresolvable, and there
   * is no other check standing behind it.
   */
  prune(branchId: string): { branches: number; messages: number } {
    return this.db.transaction(() => {
      const lineage = this.lineageFrom(branchId);
      if (lineage.length === 0) throw new UnknownSession(branchId);
      const ids = new Set(lineage.map((b) => b.id));
      const root = lineage.find((b) => b.id === branchId)!;
      if (root.parentId !== undefined && !ids.has(root.parentId)) {
        throw new Error(
          `cannot prune ${branchId}: it descends from ${root.parentId}, which is outside the lineage — prune from the root, or its prefix is orphaned`,
        );
      }
      let messages = 0;
      // Deepest first, so a child is always gone before the parent it references.
      for (const branch of [...lineage].reverse()) {
        messages += (this.db.prepare(`DELETE FROM session_messages WHERE session_id = ?`).run(branch.id).changes ?? 0);
        this.db.prepare(`DELETE FROM session_providers WHERE session_id = ?`).run(branch.id);
        this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(branch.id);
      }
      return { branches: lineage.length, messages };
    })();
  }

  /** The lineage ROOTS a task owns — the units {@link prune} accepts. */
  rootsFor(taskId: string): SessionBranch[] {
    const owned = (
      this.db.prepare(`SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at, id`).all(taskId) as BranchRow[]
    ).map(toBranch);
    const ids = new Set(owned.map((b) => b.id));
    // A branch whose parent this task does not own is a root as far as this task is concerned —
    // pruning it would reach outside, which `prune` refuses.
    return owned.filter((b) => b.parentId === undefined || !ids.has(b.parentId));
  }

  /** Rows currently stored, for a "before you prune" summary. */
  size(): { sessions: number; messages: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return { sessions: one(`SELECT COUNT(*) n FROM sessions`), messages: one(`SELECT COUNT(*) n FROM session_messages`) };
  }

  /** Direct descendants, in creation order. What makes a branch un-prunable on its own. */
  children(branchId: string): SessionBranch[] {
    return (
      this.db.prepare(`SELECT * FROM sessions WHERE parent_id = ? ORDER BY created_at, id`).all(branchId) as BranchRow[]
    ).map(toBranch);
  }

  /** The chain from a branch up to its root, nearest first. Provenance, including non-fork edges. */
  lineage(branchId: string): SessionBranch[] {
    const out: SessionBranch[] = [];
    let cursor: string | undefined = branchId;
    const seen = new Set<string>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const branch: SessionBranch | undefined = this.branch(cursor);
      if (branch === undefined) break;
      out.push(branch);
      cursor = branch.parentId;
    }
    return out;
  }

  // --- Provider handles ---------------------------------------------------------

  /** The provider's handle for this branch, if one has been recorded. */
  providerHandle(branchId: string, providerKey: string): string | undefined {
    const row = this.db
      .prepare(`SELECT external_id FROM session_providers WHERE session_id = ? AND provider_key = ?`)
      .get(branchId, providerKey) as { external_id: string } | undefined;
    return row?.external_id;
  }

  /** Record (or replace) the provider's handle for this branch. */
  setProviderHandle(branchId: string, providerKey: string, externalId: string): void {
    this.db
      .prepare(
        `INSERT INTO session_providers (session_id, provider_key, external_id) VALUES (?, ?, ?)
         ON CONFLICT(session_id, provider_key) DO UPDATE SET external_id = excluded.external_id`,
      )
      .run(branchId, providerKey, externalId);
  }

  // --- Writes -------------------------------------------------------------------

  /** A brand-new empty stream. */
  createRoot(options: CreateRootOptions): SessionBranch {
    const id = branchIdFor("root", undefined, undefined, options.seed);
    const existing = this.branch(id);
    if (existing !== undefined) return existing;
    return this.insert({
      id,
      label: options.name ?? options.seed,
      edge: "root",
      digest: EMPTY_DIGEST,
      taskId: options.taskId,
      runId: options.runId,
    });
  }

  /**
   * Branch at `position`, leaving the parent untouched.
   *
   * The new branch's `seq` continues from the cursor, so no message is copied and a
   * position stays a single integer across the whole lineage. Its digest is the
   * parent's digest AT THE CURSOR, recomputed by materializing — the one O(n) path in
   * this store, and it runs once per fork rather than once per append.
   *
   * Re-forking the same parent at the same cursor with the same seed returns the
   * EXISTING branch (see {@link branchIdFor}); a deliberate fan-out must vary `seed`.
   */
  fork(parentId: string, position: number, options: ForkOptions): SessionBranch {
    const parent = this.branch(parentId);
    if (parent === undefined) throw new UnknownSession(parentId);
    const parentHead = this.head(parentId);
    if (position > parentHead) {
      throw new Error(`cannot fork ${parentId} at position ${position}: its head is ${parentHead}`);
    }
    const id = branchIdFor("fork", parentId, position, options.seed);
    const existing = this.branch(id);
    if (existing !== undefined) return existing;
    const siblings = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ? AND edge = 'fork'`)
      .get(parentId) as { n: number };
    return this.insert({
      id,
      label: `${parent.label}[0:${position}]/${forkSuffix(siblings.n)}`,
      parentId,
      parentCursor: position,
      edge: "fork",
      digest: this.digestAt(parentId, position),
      taskId: options.taskId ?? parent.taskId,
      runId: options.runId ?? parent.runId,
    });
  }

  /**
   * A new stream whose older turns have been replaced by a summary.
   *
   * NOT a fork: its first message appears nowhere in the origin, so it shares no
   * prefix and takes no cursor. The origin is left intact, which is what keeps a ref
   * into it a durable commitment — and it keeps compaction's prompt-cache cost honest,
   * since a genuinely new prefix pays exactly one cold write.
   */
  compact(originId: string, options: DerivedOptions): SessionBranch {
    return this.derive("compaction", "compact", originId, options);
  }

  /**
   * A new stream whose contents were re-read from the provider after the remote
   * diverged from our mirror (SESSIONS.md §11).
   *
   * Where the adapter has no read API the caller passes NO entries and the branch
   * starts empty — visible on the edge rather than silent, which is the whole point of
   * making this a distinct edge kind.
   */
  resync(originId: string, options: DerivedOptions): SessionBranch {
    return this.derive("resync", "resync", originId, options);
  }

  /**
   * Append entries at `expected`, or refuse.
   *
   * CONDITIONAL on purpose. The wrapper reserves a position before calling a provider
   * (SESSIONS.md §5) and an in-process lock is enough while a run is owned by one
   * process — but a lock is not durable and does not span processes, so the write
   * itself re-checks. A loser gets {@link SessionPositionConflict} and forks; nobody
   * silently clobbers.
   *
   * Returns the new head. Appending zero entries is a legal no-op — an operation that
   * failed before the provider saw anything has a real, empty delta.
   */
  append(branchId: string, expected: number, entries: readonly SessionEntry<Msg>[]): number {
    return this.db.transaction(() => {
      const branch = this.branch(branchId);
      if (branch === undefined) throw new UnknownSession(branchId);
      const actual = this.head(branchId);
      if (actual !== expected) throw new SessionPositionConflict(branchId, expected, actual);
      if (entries.length === 0) return actual;
      const insert = this.db.prepare(
        `INSERT INTO session_messages (session_id, seq, message_json, provider_ref, operation_id) VALUES (?, ?, ?, ?, ?)`,
      );
      let digest = branch.digest ?? this.digestAt(branchId, actual);
      let seq = actual;
      for (const entry of entries) {
        insert.run(branchId, seq, JSON.stringify(entry.message), entry.providerRef ?? null, entry.operationId ?? null);
        digest = rollDigest(digest, entry.message);
        seq += 1;
      }
      this.db.prepare(`UPDATE sessions SET digest = ? WHERE id = ?`).run(digest, branchId);
      return seq;
    })();
  }

  /**
   * The rolling digest of a branch's first `position` messages.
   *
   * O(position) — it materializes. Only fork creation and a cold append need it; a
   * warm append rolls the stored head digest forward instead.
   */
  digestAt(branchId: string, position: number): string {
    let digest = EMPTY_DIGEST;
    for (const entry of this.materialize(branchId, position)) digest = rollDigest(digest, entry.message);
    return digest;
  }

  // --- Internals ----------------------------------------------------------------

  /** Compaction and resync differ only in the edge and the label word. */
  private derive(edge: SessionEdge, word: string, originId: string, options: DerivedOptions): SessionBranch {
    const origin = this.branch(originId);
    if (origin === undefined) throw new UnknownSession(originId);
    const id = branchIdFor(edge, originId, undefined, options.seed);
    const existing = this.branch(id);
    if (existing !== undefined) return existing;
    const nth =
      (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE parent_id = ? AND edge = ?`).get(originId, edge) as {
        n: number;
      }).n + 1;
    const branch = this.insert({
      id,
      // `~compact1` / `~resync1`, not `[0:n]`: no cursor, because no prefix is shared.
      // Naming the EDGE rather than a bare generation counter means a reader can see
      // that a resync's contents came from the provider without querying the table.
      label: `${origin.label}~${word}${nth}`,
      parentId: originId,
      edge,
      digest: EMPTY_DIGEST,
      taskId: options.taskId ?? origin.taskId,
      runId: options.runId ?? origin.runId,
    });
    if (options.entries.length > 0) this.append(branch.id, 0, options.entries as readonly SessionEntry<Msg>[]);
    return this.branch(branch.id) ?? branch;
  }
  // --- The executor-facing contract --------------------------------------------

  /**
   * Adapt this store to the pair of interfaces the executor stack consumes: conversation lineage
   * (`SessionStore`) and the two-phase record write (`RecordStore`).
   *
   * A separate object rather than implementing them directly, because the surfaces answer different
   * questions. This class is the LINEAGE store — branches, edges, digests, what a human scrubbing a
   * conversation in the UI needs. The exec contract is one call's view: where am I, claim it, fill it
   * in. Conflating them would put pruning and lineage queries in front of every executor that only
   * wanted to append a turn.
   *
   * The reservation is `append`'s position check, which is durable and holds across processes — no
   * in-process lock, because uniqueness on the position is the only thing that can decide a race
   * without one.
   *
   * NB the messages still live in `session_messages` here. Under the reworked model a conversation is
   * the RECORDS sharing a session id, so this class's storage should become the records table and
   * these two halves collapse into one query. That migration is deliberately separate from the
   * contract change: the semantics below are the new ones, the rows underneath are not yet.
   */
  asExecStore(origin: SessionOrigin = {}): ExecSessionStore<Msg> & ExecRecordStore {
    const streams = this;
    /** A record stub's position, remembered between `open` and `close`. */
    const pending = new Map<string, { branch: string; seq: number }>();
    return {
      resolve(request: ExecSessionRequest): ExecResolvedSession<Msg> {
        const { branch, position } = streams.open(request, origin);
        let on = branch;
        let at = position;
        let mode: "append" | "fork" = "append";
        // `fork: true` is the only fork decided HERE — the answer is already known. Every other fork
        // is decided by the write, because that is the only place that can decide it without a race.
        if (request.fork === true) {
          on = streams.fork(on.id, at, { ...origin, seed: request.seed ?? `${on.id}@${at}:${streams.children(on.id).length}` });
          at = streams.head(on.id);
          mode = "fork";
        }
        return resolveSessionRef<Msg>(formatSessionRef(on.id, at), {
          mode,
          at: { id: on.id, seq: at },
          messages: async () => streams.materialize(on.id, at).map((e) => e.message),
        });
      },

      fork(ref: string, seed?: string): string {
        const { branch, position } = streams.resolveLoose(ref);
        const forked = streams.fork(branch.id, position, {
          ...origin,
          seed: seed ?? `${branch.id}@${position}:${streams.children(branch.id).length}`,
        });
        return formatSessionRef(forked.id, streams.head(forked.id));
      },

      messages(ref: string): Msg[] {
        // A bare NAME nobody has written to is EMPTY, not unknown — that is what an untouched
        // conversation looks like, and the first call to it creates it. A ref carrying a POSITION is
        // different: it commits to content, so a branch that is not there is a typo or a pruned id,
        // and §4 is explicit that those must be errors rather than silently empty.
        if (parseSessionRef(ref) === undefined && streams.branch(ref) === undefined) return [];
        const { branch, position } = streams.resolveLoose(ref);
        return streams.materialize(branch.id, position).flatMap((e) => SessionStreams.messagesOf(e.message));
      },

      compact(ref: string, messages: readonly Msg[]): string {
        const { branch } = streams.resolveLoose(ref);
        const compacted = streams.compact(branch.id, {
          ...origin,
          seed: `${branch.id}:${streams.children(branch.id).length}`,
          entries: [{ message: { messages } as unknown as JsonValue }],
        });
        return formatSessionRef(compacted.id, streams.head(compacted.id));
      },

      resync(ref: string, messages: readonly Msg[]): string {
        const { branch } = streams.resolveLoose(ref);
        const resynced = streams.resync(branch.id, {
          ...origin,
          seed: `${branch.id}:${streams.children(branch.id).length}`,
          entries: messages.length > 0 ? [{ message: { messages } as unknown as JsonValue }] : [],
        });
        return formatSessionRef(resynced.id, streams.head(resynced.id));
      },

      // --- The record half ----------------------------------------------------

      open(stub: { id: string; session?: { id: string; seq: number } }): void {
        const at = stub.session;
        if (at === undefined) return; // a record outside a conversation is not this store's business
        // Claim by APPENDING NOTHING at the position. `append` refuses a position that is not the head,
        // which is the whole reservation — durable, and across processes, unlike any lock.
        if (streams.head(at.id) !== at.seq) throw new ExecPositionTaken(at.id, at.seq);
        pending.set(stub.id, { branch: at.id, seq: at.seq });
      },

      close(id: string, settled: { result?: { value?: unknown } }): void {
        const at = pending.get(id);
        if (at === undefined) return;
        pending.delete(id);
        const payload = settled.result?.value as { messages?: readonly Msg[] } | undefined;
        const messages = payload?.messages ?? [];
        // ONE entry per RECORD, not one per message. A position counts operations — that is what makes
        // `[0:14]` mean "after fourteen calls" and what §8's per-operation forking rests on — so a call
        // that produced six turns still advances the conversation by one.
        //
        // A call that produced nothing still occupied its position; appending zero entries is a legal
        // no-op that frees it rather than an error.
        if (messages.length > 0) {
          streams.append(at.branch, at.seq, [{ message: { messages } as unknown as Msg }]);
        }
      },

      bySession(session: string, upTo?: number): Array<{ id: string; source: never; startMs: number }> {
        return streams.materialize(session, upTo).map((entry) => ({ id: `${session}:${entry.seq}`, source: undefined as never, startMs: 0 }));
      },
    };
  }

  /**
   * The messages one stored entry carries.
   *
   * An entry written by a CALL holds a record payload — `{ messages }` — because a position counts
   * operations. An entry written directly through {@link SessionStreams.append} is a bare message.
   * Both shapes read back the same way, which is what lets the lineage layer stay message-agnostic
   * while the exec-facing view speaks records.
   */
  private static messagesOf<T>(message: T): T[] {
    const payload = message as { messages?: readonly T[] } | null;
    return payload !== null && typeof payload === "object" && Array.isArray(payload.messages) ? [...payload.messages] : [message];
  }

  /** Resolve a ref that may be a bare branch id rather than a position. */
  private resolveLoose(ref: string): { branch: SessionBranch; position: number } {
    const parsed = parseSessionRef(ref);
    if (parsed !== undefined) return this.resolve(ref);
    const branch = this.branch(ref);
    if (branch === undefined) throw new UnknownSession(ref);
    return { branch, position: this.head(ref) };
  }

  /** The branch and position a request starts from, creating a root when it names none. */
  private open(request: ExecSessionRequest, origin: SessionOrigin): { branch: SessionBranch; position: number } {
    if (request.ref === undefined) {
      const root = this.createRoot({ ...origin, seed: request.seed ?? `root:${Date.now()}` });
      return { branch: root, position: this.head(root.id) };
    }
    const parsed = parseSessionRef(request.ref);
    if (parsed === undefined && this.branch(request.ref) === undefined) {
      // A bare NAME nobody has used yet is a root, seeded from the name so a replayed run lands on
      // the same stream rather than minting a second one beside it.
      const root = this.createRoot({ ...origin, seed: request.ref, name: request.ref });
      return { branch: root, position: this.head(root.id) };
    }
    return this.resolveLoose(request.ref);
  }

  private insert(branch: Omit<SessionBranch, "createdAt">): SessionBranch {
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, label, parent_id, parent_cursor, edge, digest, task_id, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        branch.id,
        branch.label,
        branch.parentId ?? null,
        branch.parentCursor ?? null,
        branch.edge,
        branch.digest ?? null,
        branch.taskId ?? null,
        branch.runId ?? null,
        createdAt,
      );
    return { ...branch, createdAt };
  }
}
