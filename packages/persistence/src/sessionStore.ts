/**
 * Conversations that outlive the process (SESSIONS.md §9) — and, since CHANGESETS.md §5.1, the
 * per-attempt operation record store those conversations are a PROJECTION of.
 *
 * Every run already built one of these — `sessionServicesFor` constructs a `MapSessionStore` and the
 * engine writes every model call into it, complete: the messages, the thinking, the tool calls and
 * their results, the provider's own session handle. Then the run ends and it is garbage. Every
 * transcript JaiRA has ever produced was computed and thrown away, and `conversation.ts`'s claim that
 * "there is no separate transcript to show" was true only because nobody kept the one there was.
 *
 * ## The two tables (CHANGESETS.md §5.1)
 *
 * The system has an irreducible pair — the journal records *that* operations ran, this store records
 * *what they returned* — and the payload half is normalised into:
 *
 *  - **`operation_records`** — one row per operation attempt: `request_json` (the operation as
 *    asked), `result_json` / `error_json` (what came back), metrics, the provider's session handle,
 *    status and attempt. EVERY call this store sees lands here, placed in a conversation or not.
 *  - **`session_positions`** — conversation membership: `(session_id, seq, operation_record_id)`.
 *    The primary key IS the position claim, so a duplicate insert is `PositionTaken` → fork rather
 *    than a check with a race in it. An unplaced record simply has no row here, which is what keeps
 *    the transcripts clean now that the dispatcher records unconditionally (§5.2).
 *
 * ## What it is NOT
 *
 * Not a message table. A session IS the records claiming positions under one `session_id`, ordered
 * by `seq` — upstream's design, and the reason a record holds the whole `LlmOutput` verbatim.
 * Splitting messages out would mean deciding, here, which parts of a provider's answer are worth
 * keeping.
 *
 * ## The two rules that make the lineage work
 *
 * **A position is claimed by the record occupying it.** `open` inserts the record and its position
 * row in one transaction, and the primary key is what refuses a second claim. The caller answers by
 * FORKING, never by retrying at the next slot: appending at 15 instead of 14 continues a
 * conversation containing a turn the call never saw.
 *
 * **A fork shares its prefix by lineage, not by copying.** A branch stores only what it appended and
 * points at where it left its parent, so materializing walks the chain. Cost is proportional to
 * divergence, and a fork of a long conversation costs one row.
 *
 * ## The read-side projection
 *
 * `close()` used to decide what a record's conversational value was ("the payload wins when it is
 * already a conversation") and store the decision. It now stores what actually happened — the result
 * verbatim, the reported session outcome verbatim — and the projection happens on READ
 * ({@link projectValue}), where changing it is a view change rather than a migration.
 */
import type { JsonValue } from "@declarative-ai/json";
import {
  PositionTaken,
  resolveSessionRef,
  type RecordStore,
  type RecordStub,
  type ResolvedSession,
  type SessionRequest,
  type SessionStore,
  type StoredRecord,
} from "@declarative-ai/exec";
import type { JairaDb } from "./db";

/** `<id>@<position>` — the ref spelling upstream uses, restated because both halves must agree. */
const join = (id: string, seq: number): string => `${id}@${seq}`;

/** Split on the LAST `@`: a compaction mints `planning~compact1`, and a ref into it carries two. */
function split(ref: string): [string, number | undefined] {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return [ref, undefined];
  const seq = Number(ref.slice(at + 1));
  return Number.isInteger(seq) && seq >= 0 ? [ref.slice(0, at), seq] : [ref, undefined];
}

interface Branch {
  parent?: string;
  cursor: number;
}

interface Row {
  seq: number;
  /** Which branch this row is on — the same id everywhere else, and what a fork is legible BY. */
  sessionId: string;
  recordId: string;
  /**
   * The row's lifecycle, verbatim from the `status` column — THE state signal, now that an open
   * row can carry a value. Presence of `value` used to double as "the call settled" purely because
   * `result_json` stayed NULL until close; streamed partials (see {@link SqliteSessionStore.streamPartial})
   * end that, so every reader that cares whether a turn HAPPENED must ask this field, never the value.
   */
  status: "open" | "completed" | "failed";
  value?: JsonValue;
  externalId?: string;
  /**
   * The operation as it was ASKED — `request_json`, pinned at open and never recomputed.
   *
   * Carried on the row because it is the only place one thing lives: what somebody typed. A record's
   * value is what the call PRODUCED, and a transport streams the answer rather than the question — so
   * a turn that was interrupted has the half-written reply and no sign of the message that provoked
   * it. That message was never lost, only unreachable from the read side.
   */
  request?: JsonValue;
}

/**
 * Which RUN a store's conversations belong to.
 *
 * Not merely a tag for finding them later — it namespaces them, and it has to. A session id is
 * instance-scoped (`#i2`), and instance ids restart at 1 on every run, so two runs of one workflow
 * name their conversations identically. That cost nothing while the store died with the run; a
 * durable one made run 2 continue run 1's conversation, read its whole transcript back as a preamble,
 * and store the result as its own — which compounds, and took the test suite out of memory.
 *
 * So the scope is part of the key. Ids stay opaque and unprefixed to everything outside this class;
 * the mapping happens at the SQL boundary.
 */
export interface SessionScope {
  taskId?: string;
  runId?: number;
}

export class SqliteSessionStore implements SessionStore<JsonValue>, RecordStore {
  private minted = 0;

  constructor(
    private readonly db: JairaDb,
    private readonly scope: SessionScope = {},
  ) {}

  // --- SessionStore ------------------------------------------------------------

  resolve(request: SessionRequest): ResolvedSession<JsonValue> {
    const asked = request.ref !== undefined ? split(request.ref) : undefined;
    let id = asked?.[0] ?? this.mint(request.seed);
    if (asked === undefined) this.branch(id, { cursor: 0 });
    let seq = asked?.[1] ?? this.head(id);
    let mode: "append" | "fork" = "append";
    // `fork: true` skips any check — the answer is already known. Everything else is decided by the
    // record write itself, which is the only place that can decide it without a race.
    if (request.fork === true) {
      id = this.branchFrom(id, seq, request.seed);
      seq = this.head(id);
      mode = "fork";
    }
    // A FORK inherits no provider handle: two branches sharing one remote session would be two
    // conversations writing into the same place.
    const handle = mode === "append" ? this.handleAt(id, seq) : undefined;
    return resolveSessionRef<JsonValue>(join(id, seq), {
      mode,
      at: { id, seq },
      ...(handle !== undefined ? { providerSessionId: handle } : {}),
      // Carried so a FORK does not need the original request back — see `ResolvedSession.seed`.
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      messages: async () => this.materialize(id, seq),
    });
  }

  fork(ref: string, seed?: string): string {
    const [id, seq] = split(ref);
    const forked = this.branchFrom(id, seq ?? this.head(id), seed);
    return join(forked, this.head(forked));
  }

  /**
   * The ref naming one position — the same spelling `resolve` and `fork` hand out, built here so a
   * caller holding an `at` pair never has to concatenate one itself.
   *
   * Unscoped on purpose. The run namespace belongs to the SQL boundary ({@link SessionScope}), and a
   * ref that leaked it would be stored in a workflow's output and carried into another run.
   */
  refAt(at: { id: string; seq: number }): string {
    return join(at.id, at.seq);
  }

  messages(ref: string): JsonValue[] {
    const [id, seq] = split(ref);
    return this.materialize(id, seq ?? this.head(id));
  }

  compact(ref: string, messages: readonly JsonValue[]): string {
    return this.derive(ref, "compact", messages);
  }

  resync(ref: string, messages: readonly JsonValue[]): string {
    return this.derive(ref, "resync", messages);
  }

  // --- RecordStore -------------------------------------------------------------

  open(stub: RecordStub): void {
    // EVERY record lands in operation_records — placed or not (CHANGESETS.md §5.2). The store that
    // holds transcripts is session_positions, and an unplaced call never touches it.
    const at = stub.session;
    if (at === undefined) {
      this.insertRecord(stub);
      return;
    }
    this.branch(at.id, { cursor: this.cursorOf(at.id) });
    try {
      // One transaction: the record and its position claim land together, so a lost race leaves no
      // orphaned record behind the PositionTaken it reports.
      this.db
        .transaction(() => {
          const recordId = this.insertRecord(stub);
          this.db
            .prepare(`INSERT INTO session_positions (session_id, seq, operation_record_id) VALUES (?, ?, ?)`)
            .run(this.k(at.id), at.seq, recordId);
        })
        .immediate();
    } catch (e) {
      // The primary key IS the claim, so a duplicate is the position being held rather than a fault.
      // Reported as the class the session layer forks on, never as a database error.
      if (String((e as Error).message).includes("UNIQUE")) throw new PositionTaken(at.id, at.seq);
      throw e;
    }
  }

  close(id: string, settled: Pick<StoredRecord, "result" | "metrics" | "sessionOutcome">): void {
    // Scoped, because a record id is unique only within a run — `#i2:0` names the first call of the
    // second instance of EVERY run of a workflow. Closing on the bare id would settle another run's.
    // Within the scope, the OPEN row wins (retries reuse an id; the settled one is not up for grabs),
    // newest first.
    const row = this.db
      .prepare(
        `SELECT id, result_json, request_json FROM operation_records
          WHERE record_id = ? AND task_id IS ? AND run_id IS ?
          ORDER BY (status = 'open') DESC, id DESC LIMIT 1`,
      )
      .get(id, this.scope.taskId ?? null, this.scope.runId ?? null) as
      | { id: number; result_json: string | null; request_json: string | null }
      | undefined;
    if (row === undefined) return;
    // Stored VERBATIM — the result as it settled, the session outcome as reported. What a record
    // MEANS as a conversation turn is the read side's question now (projectValue), which is what
    // "the payload-wins projection moves to the read side" (§5.1) says.
    const error = (settled.result as { error?: unknown } | undefined)?.error;
    // An ERRORED settle keeps the streamed partial when it arrives with nothing better, and completes
    // it with the message the call was MADE with. The turns a call streamed before it died were
    // really exchanged — the same reason a failed call is a record at all ("its turns may already
    // exist remotely") — and an agent's error result is `{error, value: {finishReason}}`, which
    // would replace them with nothing.
    //
    // A SUCCESS settle always wins outright: its payload or its session outcome is the complete,
    // authoritative version of what the partial was an early copy of, and merging the partial in
    // would put a copy of the messages where `projectValue`'s payload-wins rule would prefer them.
    //
    // A SUCCESS settle still takes ONE thing from the partial: the per-turn clocks. They are the only
    // field the settle cannot reproduce — a provider result carries no wall clock per message, so the
    // times exist exactly once, in the stream that measured them, and dropping them at the settle is
    // why a finished run's thinking rows had no "thought for 12 s" while a live one did. Times only:
    // the messages themselves still come from the authoritative result.
    const result =
      error !== undefined
        ? preservePartial(settled.result as JsonValue, settled.sessionOutcome, row.result_json, row.request_json)
        : carryMessageTimes(settled.result as JsonValue, row.result_json);
    this.db
      .prepare(
        `UPDATE operation_records
            SET result_json = ?, error_json = ?, metrics_json = ?, session_outcome_json = ?,
                provider_session_id = COALESCE(?, provider_session_id),
                status = ?, ended_at = ?
          WHERE id = ?`,
      )
      .run(
        result === undefined ? null : JSON.stringify(result),
        error === undefined ? null : JSON.stringify(error),
        settled.metrics === undefined ? null : JSON.stringify(settled.metrics),
        settled.sessionOutcome === undefined ? null : JSON.stringify(settled.sessionOutcome),
        settled.sessionOutcome?.providerSessionId ?? null,
        error === undefined ? "completed" : "failed",
        Date.now(),
        row.id,
      );
  }

  /**
   * Stream a call's PARTIAL value into the open row at a position — the durable copy of the live
   * turn, refreshed on a debounce while the call runs.
   *
   * The `status = 'open'` guard is the whole safety story: `close()` settles the row and flips the
   * status in one statement, so a flush racing the settle (a debounce timer firing after the result
   * landed) matches nothing and writes nothing — the settled result is never clobbered by a stale
   * partial. Targeting the NEWEST open row at the position mirrors `close()`'s own choice for
   * retried ids.
   *
   * Only `result_json` moves. Status, timestamps and the provider handle stay the settle's to
   * write, which is what keeps "open" meaning exactly "a live process is streaming into this row".
   */
  streamPartial(sessionId: string, seq: number, value: JsonValue, providerSessionId?: string): void {
    // The row is found first rather than in a subselect, because the write needs the REQUEST on it:
    // a flush replaces `result_json` wholesale, and the question `insertRecord` put there would go
    // with it — leaving the record correct until the moment the model said something, which is the
    // worst of the three possible times to be wrong.
    const row = this.db
      .prepare(
        `SELECT r.id AS id, r.request_json AS request_json FROM session_positions p
           JOIN operation_records r ON r.id = p.operation_record_id
          WHERE p.session_id = ? AND p.seq = ? AND r.status = 'open'
          ORDER BY r.id DESC LIMIT 1`,
      )
      .get(this.k(sessionId), seq) as { id: number; request_json: string | null } | undefined;
    if (row === undefined) return;
    // The provider handle is stamped EARLY when the stream carried one — it rides nearly every
    // envelope, and waiting for the settle is why a crashed call used to have no handle to resume
    // or resync from. First writer wins (COALESCE on the existing value); the settle's own
    // COALESCE then prefers its authoritative id over ours.
    //
    // The `status = 'open'` guard stays on the UPDATE as well as on the SELECT: a settle landing
    // between the two would otherwise be clobbered by a flush that read the row a microsecond early.
    this.db
      .prepare(
        `UPDATE operation_records SET result_json = ?, provider_session_id = COALESCE(provider_session_id, ?)
          WHERE id = ? AND status = 'open'`,
      )
      .run(JSON.stringify(withOpening(value, row.request_json)), providerSessionId ?? null, row.id);
  }

  bySession(session: string, upTo?: number): StoredRecord[] {
    return this.rowsOf(session, upTo).map((row) => ({
      id: row.recordId,
      source: undefined as never,
      startMs: 0,
      // The STATE field decides, not value presence: an open row may now carry a streamed partial,
      // and "a session's records" is a history read — a turn that has not settled is not in it.
      ...(row.status !== "open" && row.value !== undefined ? { result: row.value as never } : {}),
    }));
  }

  // --- Reads the app adds ------------------------------------------------------

  /** One conversation's records, oldest first — lineage included, exactly as `messages` walks it.
   *  Rows carry `status`: an `open` row's value is a streamed PARTIAL, and a caller that treats it
   *  as a settled turn is making the mistake the field exists to prevent. */
  transcript(ref: string): Row[] {
    const [id, seq] = split(ref);
    const out: Row[] = [];
    for (const [branch, bound] of this.chain(id, seq ?? this.head(id))) {
      const start = this.cursorOf(branch);
      for (const row of this.rowsOf(branch)) {
        if (row.seq >= start && row.seq < bound) out.push(row);
      }
    }
    return out;
  }

  /**
   * Where this conversation DIVERGED, and what each divergence left behind.
   *
   * A fork is the honest answer to two calls wanting one position — an edit resending an earlier
   * message, most often — and `transcript` walks straight through one: it follows the lineage back
   * and takes each ancestor only up to the point its child left it. Everything past that point is
   * still there and is on no path anybody reads. That is right for materializing a conversation to
   * send to a model, and wrong as the only view a person gets: what the conversation said INSTEAD is
   * a fact about it, and losing sight of it is how an edit comes to look like a deletion.
   *
   * So this reports the seams. For each one: the position the branches share, the branch this path
   * took, and every branch it did not — the parent's own tail past the cursor (the continuation an
   * edit replaced) and any sibling that forked at the same place (a second edit at the same message).
   *
   * Rows only, no interpretation: what a row MEANS as a turn is the read side's question, and it is
   * answered for these by exactly the same code that answers it for the path itself.
   */
  forks(ref: string): Array<{ at: { sessionId: string; seq: number }; taken: string; left: Array<{ sessionId: string; rows: Row[] }> }> {
    const [id, seq] = split(ref);
    const chain = this.chain(id, seq ?? this.head(id));
    const out: Array<{ at: { sessionId: string; seq: number }; taken: string; left: Array<{ sessionId: string; rows: Row[] }> }> = [];
    for (const [i, entry] of chain.entries()) {
      const child = chain[i + 1];
      if (child === undefined) continue; // the tip of the path: nothing forked off it that this walk took
      const [parent, cursor] = entry;
      const left: Array<{ sessionId: string; rows: Row[] }> = [];
      // The parent's OWN tail: the turns that were there before something branched away from them.
      const tail = this.rowsOf(parent).filter((row) => row.seq >= cursor);
      if (tail.length > 0) left.push({ sessionId: parent, rows: tail });
      // …and any sibling that left from the same place, which is what a second edit at one message
      // produces. The branch this path is on is not one of them.
      for (const sibling of this.branchesFrom(parent, cursor)) {
        if (sibling === child[0]) continue;
        const rows = this.rowsOf(sibling);
        if (rows.length > 0) left.push({ sessionId: sibling, rows });
      }
      if (left.length > 0) out.push({ at: { sessionId: parent, seq: cursor }, taken: child[0], left });
    }
    return out;
  }

  /** Every branch that left one conversation at one position — see {@link forks}. */
  private branchesFrom(parent: string, cursor: number): string[] {
    const prefix = this.k("");
    return (
      this.db.prepare(`SELECT id FROM sessions WHERE parent = ? AND cursor = ? ORDER BY created_at`).all(this.k(parent), cursor) as Array<{
        id: string;
      }>
    ).map((row) => (row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id));
  }

  /** One record, by the position it claimed. What a state's `sessionRef` resolves to. */
  at(sessionId: string, seq: number): Row | undefined {
    return this.rowsOf(sessionId).find((row) => row.seq === seq);
  }

  /**
   * The latest attempt of a record by its CONTENT id — how the positionless `db://` form resolves
   * (CHANGESETS.md §10.6, settled): settled `operation.*` events carry this id, and an unplaced
   * record is keyed by it, so a journal row leads here whether or not the call ever sat in a
   * conversation. Returns the request too: §5.3 puts a gate's changeset in `request_json`, and
   * addressing the record without it would hide the half that design points at.
   */
  record(recordId: string): { request?: JsonValue; result?: JsonValue } | undefined {
    const row = this.db
      .prepare(
        `SELECT request_json, result_json FROM operation_records
          WHERE record_id = ? AND task_id IS ? AND run_id IS ?
          ORDER BY attempt DESC, id DESC LIMIT 1`,
      )
      .get(recordId, this.scope.taskId ?? null, this.scope.runId ?? null) as
      | { request_json: string | null; result_json: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      ...(row.request_json !== null ? { request: JSON.parse(row.request_json) as JsonValue } : {}),
      ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as JsonValue } : {}),
    };
  }

  /**
   * Records a crashed run left behind that could still be recovered from the agent's own files.
   *
   * The pair a recovery needs and nothing else: the provider handle (streamed onto the row while
   * the call ran — see {@link SqliteSessionStore.streamPartial} — which is the whole reason a call
   * that never reached a close has one) and the start time, which is the cut that keeps a resumed
   * session's earlier lines out.
   *
   * Narrowed to rows that have a handle and no capture yet, so a second open after a successful
   * recovery finds nothing and re-reads no files.
   */
  recoverable(taskId: string): Array<{ id: number; providerSessionId: string; startedAt: number }> {
    return this.db
      .prepare(
        `SELECT id, provider_session_id, started_at FROM operation_records
          WHERE task_id = ? AND status = 'failed' AND provider_session_id IS NOT NULL
            AND (result_json IS NULL OR result_json NOT LIKE '%"nativeLines"%')`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as { id: number; provider_session_id: string; started_at: number };
        return { id: r.id, providerSessionId: r.provider_session_id, startedAt: r.started_at };
      });
  }

  /**
   * Fold a recovered capture into a record that never got one — the crash counterpart of the close
   * decorator's enrichment.
   *
   * The lines join the payload's `value`, exactly where `withNativeCapture` puts them, so the
   * transcript reader finds them where it already looks. A row whose payload is not record-shaped
   * (a scripted value, a bare string) is left alone rather than wrapped in a shape nothing reads.
   */
  foldNativeCapture(recordRowId: number, captured: Record<string, JsonValue>): void {
    const row = this.db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(recordRowId) as
      | { result_json: string | null }
      | undefined;
    if (row === undefined) return;
    const existing = row.result_json === null ? {} : (JSON.parse(row.result_json) as { value?: unknown });
    const value = existing.value;
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) return;
    const merged = { ...existing, value: { ...((value ?? {}) as object), ...captured } };
    this.db.prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`).run(JSON.stringify(merged), recordRowId);
  }

  // --- Internals ---------------------------------------------------------------

  /**
   * Stamp the per-attempt row. The request is pinned here — nothing recomputes it (§5.3).
   *
   * The row is BORN holding the message the call was made with, so a record is the delta it will
   * finally be from its first instant and only ever grows: the question, then the turns as they
   * stream, then the provider's authoritative version of both. That is what lets every reader treat
   * a record the same way whatever state it is in — and the alternative was found the hard way, since
   * a process killed between `open` and the first flush leaves a row that no later write ever reaches.
   */
  private insertRecord(stub: RecordStub): number | bigint {
    const attempt = this.db
      .prepare(`SELECT COUNT(*) AS n FROM operation_records WHERE record_id = ? AND task_id IS ? AND run_id IS ?`)
      .get(stub.id, this.scope.taskId ?? null, this.scope.runId ?? null) as { n: number };
    const request = stub.source === undefined ? null : JSON.stringify(stub.source);
    const opening = openingMessage(request, []);
    const info = this.db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, request_json, result_json, started_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        stub.id,
        this.scope.taskId ?? null,
        this.scope.runId ?? null,
        attempt.n + 1,
        request,
        opening.length === 0 ? null : JSON.stringify({ value: { messages: opening } }),
        stub.startMs ?? Date.now(),
      );
    return info.lastInsertRowid;
  }

  /** Walk the lineage, taking each ancestor's records below the cursor its child took. */
  private materialize(id: string, upTo: number): JsonValue[] {
    const out: JsonValue[] = [];
    // Settled rows only — the state field, not value presence. A streamed partial on an open row is
    // the live view's business; materialized history feeds provider REPLAY and inherited context,
    // and a half-written turn replayed into a provider is a conversation that never happened.
    for (const row of this.transcript(join(id, upTo))) {
      if (row.status === "open") continue;
      out.push(...messagesOfRecord(row.value));
    }
    return out;
  }

  /** Ancestors first, each with the bound its child took from it. */
  private chain(id: string, upTo: number): Array<[string, number]> {
    const chain: Array<[string, number]> = [];
    let at: string | undefined = id;
    let limit = upTo;
    while (at !== undefined) {
      chain.unshift([at, limit]);
      const branch = this.branchOf(at);
      if (branch?.parent === undefined) break;
      limit = branch.cursor;
      at = branch.parent;
    }
    return chain;
  }

  /** The latest handle at or before a position, walking the lineage as materializing does. */
  private handleAt(id: string, upTo: number): string | undefined {
    let at: string | undefined = id;
    let bound = upTo;
    while (at !== undefined) {
      for (const row of [...this.rowsOf(at)].reverse()) {
        if (row.seq < bound && row.externalId !== undefined) return row.externalId;
      }
      const branch = this.branchOf(at);
      if (branch?.parent === undefined) return undefined;
      bound = branch.cursor;
      at = branch.parent;
    }
    return undefined;
  }

  /** The next position an append would occupy. A branch's own records begin at its cursor. */
  private head(id: string): number {
    const max = this.db
      .prepare(`SELECT MAX(seq) AS m FROM session_positions WHERE session_id = ?`)
      .get(this.k(id)) as { m: number | null } | undefined;
    return max?.m === null || max?.m === undefined ? this.cursorOf(id) : max.m + 1;
  }

  private branchFrom(id: string, cursor: number, seed?: string): string {
    const forked = this.mint(seed !== undefined ? `${seed}@${id}:${cursor}` : undefined);
    // `seq` CONTINUES from the cursor, so a position is one integer across a whole lineage.
    this.branch(forked, { parent: id, cursor });
    return forked;
  }

  private derive(ref: string, word: string, messages: readonly JsonValue[]): string {
    const [id] = split(ref);
    // A distinct conversation, so the origin keeps meaning exactly what every ref into it meant.
    const derived = `${id}~${word}${++this.minted}`;
    this.branch(derived, { cursor: 0 });
    this.db
      .transaction(() => {
        const info = this.db
          .prepare(
            `INSERT INTO operation_records (record_id, task_id, run_id, status, result_json, started_at, ended_at)
             VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
          )
          .run(
            `${derived}:0`,
            this.scope.taskId ?? null,
            this.scope.runId ?? null,
            JSON.stringify({ value: { messages } }),
            Date.now(),
            Date.now(),
          );
        this.db
          .prepare(`INSERT OR REPLACE INTO session_positions (session_id, seq, operation_record_id) VALUES (?, 0, ?)`)
          .run(this.k(derived), info.lastInsertRowid);
      })
      .immediate();
    return join(derived, 1);
  }

  private mint(seed: string | undefined): string {
    return seed !== undefined ? `s_${seed}` : `s_${++this.minted}`;
  }

  /**
   * A session id as this store keys it — namespaced by the run that owns it.
   *
   * Applied at the SQL boundary and nowhere else, so every id this class hands back is the plain one
   * the engine stated. A store with no scope keys by the bare id, which is what a read of a single
   * run's conversations wants once it has narrowed to that run.
   */
  private k(id: string): string {
    const { taskId, runId } = this.scope;
    return taskId === undefined && runId === undefined ? id : `${taskId ?? ""}/${runId ?? ""}/${id}`;
  }

  private branch(id: string, branch: Branch): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO sessions (id, parent, cursor, created_at) VALUES (?, ?, ?, ?)`)
      .run(this.k(id), branch.parent === undefined ? null : this.k(branch.parent), branch.cursor, Date.now());
  }

  private branchOf(id: string): Branch | undefined {
    const row = this.db.prepare(`SELECT parent, cursor FROM sessions WHERE id = ?`).get(this.k(id)) as
      | { parent: string | null; cursor: number }
      | undefined;
    if (row === undefined) return undefined;
    // The parent comes back namespaced; strip it, because everything above this line speaks plain ids.
    const prefix = this.k("");
    const parent = row.parent === null ? undefined : row.parent.startsWith(prefix) ? row.parent.slice(prefix.length) : row.parent;
    return { ...(parent !== undefined ? { parent } : {}), cursor: row.cursor };
  }

  private cursorOf(id: string): number {
    return this.branchOf(id)?.cursor ?? 0;
  }

  private rowsOf(session: string, upTo?: number): Row[] {
    const rows = this.db
      .prepare(
        `SELECT p.seq AS seq, r.record_id AS record_id, r.status AS status, r.result_json AS result_json,
                r.session_outcome_json AS session_outcome_json, r.provider_session_id AS provider_session_id,
                r.request_json AS request_json
           FROM session_positions p JOIN operation_records r ON r.id = p.operation_record_id
          WHERE p.session_id = ? ${upTo === undefined ? "" : "AND p.seq < ?"} ORDER BY p.seq`,
      )
      .all(...(upTo === undefined ? [this.k(session)] : [this.k(session), upTo])) as Array<{
      seq: number;
      record_id: string;
      status: "open" | "completed" | "failed";
      result_json: string | null;
      session_outcome_json: string | null;
      provider_session_id: string | null;
      request_json: string | null;
    }>;
    return rows.map((row) => {
      const value = projectValue(
        row.result_json === null ? undefined : (JSON.parse(row.result_json) as JsonValue),
        row.session_outcome_json === null ? undefined : (JSON.parse(row.session_outcome_json) as JsonValue),
      );
      return {
        seq: row.seq,
        sessionId: session,
        recordId: row.record_id,
        status: row.status,
        ...(value !== undefined ? { value } : {}),
        ...(row.provider_session_id !== null ? { externalId: row.provider_session_id } : {}),
        ...(row.request_json !== null ? { request: JSON.parse(row.request_json) as JsonValue } : {}),
      };
    });
  }
}

/**
 * A record's conversational value — the projection `close()` used to bake into the write.
 *
 * The PAYLOAD WINS when it already is a conversation. A record-mode core answers with the whole
 * `LlmOutput` — messages plus `thinking`, `toolCalls`, `toolResults` — and replacing that with a
 * bare `{ messages }` would discard exactly what record mode was turned on to keep. The reported
 * outcome is for a payload that is NOT a conversation: a delegated agent answering with text, a
 * value-mode prompt core whose payload was projected away inside the call, a scripted fake.
 */
function projectValue(result: JsonValue | undefined, sessionOutcome: JsonValue | undefined): JsonValue | undefined {
  const payload = result as { value?: { messages?: unknown } } | undefined;
  if (payload?.value?.messages !== undefined) return result;
  const reported = (sessionOutcome as { messages?: JsonValue[] } | undefined)?.messages;
  if (reported !== undefined) return { value: { messages: reported } };
  return result;
}

/** A record's messages: upstream's `defaultMessagesOf`, over a stored record rather than a live one. */
export function messagesOfRecord(value: JsonValue | undefined): JsonValue[] {
  const messages = (value as { value?: { messages?: JsonValue[] } } | undefined)?.value?.messages;
  return Array.isArray(messages) ? messages : [];
}

/**
 * An ERRORED settle's result, with the streamed partial folded in when the settle brought nothing
 * better — see the call site in `close()`.
 *
 * "Nothing better" is checked on BOTH channels `projectValue` reads: a result already carrying
 * `value.messages` is the authoritative conversation, and a session outcome carrying `messages` will
 * win the projection anyway — folding the partial under either would shadow or duplicate the real
 * thing. Only when neither has the turns does the partial's early copy become the record's, which is
 * exactly the interrupted/crashed case it was streamed for.
 */
/** A message's role, for the alignment check below. `undefined` for anything that is not one. */
function roleOf(message: JsonValue | undefined): string | undefined {
  const m = message as { role?: unknown } | undefined;
  return m !== null && typeof m === "object" && typeof m.role === "string" ? m.role : undefined;
}

/**
 * The settled result, wearing the per-turn clocks the stream measured — see the call site in `close()`.
 *
 * `messageTimes` is a parallel array over the record's messages (`at`, `startedAt`, `thoughtMs`),
 * stamped by the live-turn log as deltas arrived and written into the open row by every partial
 * flush. The settle overwrites that row with the provider's own result, which has no clocks in it at
 * all — so on a successful call the numbers were measured, persisted, and then thrown away one
 * statement later. "Thought for 12 s" worked while you watched and vanished when you came back.
 *
 * The alignment is a SUFFIX, not an index-for-index match: the stream only sees the turns the call
 * produced, while the settled record also holds the messages it was called WITH. So the partial's
 * `p` stamps line up with the last `p` of the settled `s`, and the array is padded at the front with
 * blanks — which `turnsOf` reads as "this turn was not timed", the same as an old record.
 *
 * Checked by ROLE before it is believed. A transport that streams something other than a suffix of
 * what it settles would otherwise label one turn with another's duration, which is worse than no
 * label; a mismatch drops the whole carry rather than guessing at an offset.
 */
function carryMessageTimes(settledResult: JsonValue | undefined, existingJson: string | null): JsonValue | undefined {
  if (existingJson === null || settledResult === undefined) return settledResult;
  const settled = settledResult as { value?: { messages?: unknown; messageTimes?: unknown } };
  // A result that already carries its own is authoritative — nothing to add.
  if (settled?.value?.messageTimes !== undefined) return settledResult;
  const messages = settled?.value?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return settledResult;
  let partial: { value?: { messages?: unknown; messageTimes?: unknown } } | null;
  try {
    partial = JSON.parse(existingJson) as typeof partial;
  } catch {
    return settledResult;
  }
  const times = partial?.value?.messageTimes;
  const streamed = partial?.value?.messages;
  if (!Array.isArray(times) || !Array.isArray(streamed) || times.length !== streamed.length) return settledResult;
  const offset = messages.length - streamed.length;
  if (offset < 0) return settledResult;
  for (const [i, message] of streamed.entries()) {
    if (roleOf(message as JsonValue) !== roleOf(messages[i + offset] as JsonValue)) return settledResult;
  }
  return {
    ...(settledResult as object),
    value: { ...(settled.value as object), messageTimes: [...Array.from({ length: offset }, () => ({})), ...times] },
  } as JsonValue;
}

function preservePartial(
  settledResult: JsonValue | undefined,
  sessionOutcome: { messages?: unknown } | undefined,
  existingJson: string | null,
  requestJson: string | null,
): JsonValue | undefined {
  const settled = settledResult as { value?: { messages?: unknown } } | undefined;
  if (settled?.value?.messages !== undefined) return settledResult;
  if (sessionOutcome?.messages !== undefined) return settledResult;
  // Through `withOpening` even though `insertRecord` normally put the question there already: a row
  // opened before that existed, or one whose only flush raced ahead of it, still settles correctly.
  const partial = withOpening(parsed<JsonValue>(existingJson) ?? {}, requestJson) as {
    value?: { messages?: JsonValue[]; messageTimes?: JsonValue; sidechains?: JsonValue; partial?: JsonValue };
  };
  const messages = Array.isArray(partial.value?.messages) ? partial.value.messages : [];
  // Worth keeping when there is ANY evidence of what happened — the question, the finished turns, or
  // the tails of the one being written when it died.
  if (messages.length === 0 && partial.value?.partial === undefined) return settledResult;
  return {
    ...((settledResult ?? {}) as object),
    value: {
      ...((settled?.value ?? {}) as object),
      messages,
      ...(partial.value?.messageTimes !== undefined ? { messageTimes: partial.value.messageTimes } : {}),
      ...(partial.value?.sidechains !== undefined ? { sidechains: partial.value.sidechains } : {}),
      ...(partial.value?.partial !== undefined ? { partial: partial.value.partial } : {}),
    },
  } as JsonValue;
}

/**
 * A record value with the call's own question in front of its messages, if it is not there already.
 *
 * The one place the splice is spelled out, used by all three writers — the row's birth
 * (`insertRecord`), every flush into it (`streamPartial`), and its settle (`preservePartial`) — so a
 * record carries the same shape at every instant of its life rather than acquiring it at one of them.
 */
function withOpening(value: JsonValue, requestJson: string | null): JsonValue {
  const held = value as { value?: { messages?: JsonValue[]; messageTimes?: JsonValue } } | null;
  const messages = Array.isArray(held?.value?.messages) ? held.value.messages : [];
  const opening = openingMessage(requestJson, messages);
  if (opening.length === 0) return value;
  const times = held?.value?.messageTimes;
  return {
    ...((value ?? {}) as object),
    value: {
      ...((held?.value ?? {}) as object),
      messages: [...opening, ...messages],
      // Padded by however many messages went in front, because `messageTimes` is a parallel array
      // over `messages` and a shift of one labels every turn with its neighbour's duration.
      ...(Array.isArray(times) ? { messageTimes: [...opening.map(() => ({})), ...times] } : {}),
    },
  } as JsonValue;
}

/**
 * The message a cut-off call was MADE with, as the turn it is — the other half of what an interrupted
 * record has to hold, and the half that used to be lost.
 *
 * A record's messages are the delta the call contributed, and for a call that settled that delta
 * opens with the question: the provider echoes it back as part of the exchange. A call that was
 * stopped has no provider answer, so all that survives is what the transport STREAMED — and a
 * transport streams what the model produced, which the question never was. The record was therefore
 * a different shape depending on how the call ended, and every reader after it had to compensate:
 * the transcript by splicing the question back at display time (and getting it wrong for an agent,
 * whose tool results are user-role messages), and provider replay not at all — a resumed conversation
 * was handed an answer with no question in front of it.
 *
 * So it is spliced HERE, once, where the record is written. `request_json` has held it since the
 * record was opened. Reading `user` off the request is the one op-shaped assumption in this file
 * besides `{value:{messages}}` itself, and it is narrow: anything without a non-empty `user` string —
 * a function op, a gate, a pre-dispatch failure with no prompt — contributes nothing and is untouched.
 *
 * Skipped when the stream already opens with exactly this message, compared by CONTENT rather than by
 * role: "is there a user turn here" is the test that mistook a tool result for a question.
 */
function openingMessage(requestJson: string | null, streamed: readonly JsonValue[]): JsonValue[] {
  const asked = parsed<{ user?: unknown }>(requestJson)?.user;
  if (typeof asked !== "string" || asked.trim() === "") return [];
  const first = streamed[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role === "user" && first.content === asked) return [];
  return [{ role: "user", content: asked }];
}

/**
 * Splice the question into every interrupted record written before {@link openingMessage} existed —
 * the one-shot half of that fix, for rows already on disk (migration 7).
 *
 * Narrowed to records that FAILED and hold their messages on the result: a settled call's delta
 * already opens with the question, and a record whose messages live on the session-outcome channel
 * would be SHADOWED rather than repaired, because `projectValue` prefers the result when it has
 * messages. Naturally idempotent — a second pass finds the question already in front and does
 * nothing — so a half-finished upgrade is re-runnable.
 */
export function repairInterruptedRecords(db: JairaDb): number {
  const rows = db
    .prepare(
      `SELECT id, result_json, request_json, session_outcome_json FROM operation_records
        WHERE status = 'failed' AND request_json IS NOT NULL`,
    )
    .all() as Array<{ id: number; result_json: string | null; request_json: string; session_outcome_json: string | null }>;
  const update = db.prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`);
  let repaired = 0;
  for (const row of rows) {
    if (parsed<{ messages?: unknown }>(row.session_outcome_json)?.messages !== undefined) continue;
    const result = parsed<{ value?: { messages?: JsonValue[]; messageTimes?: JsonValue[] } }>(row.result_json);
    if (row.result_json !== null && result === undefined) continue; // unreadable: leave it exactly as it is
    const messages = Array.isArray(result?.value?.messages) ? result.value.messages : [];
    const opening = openingMessage(row.request_json, messages);
    if (opening.length === 0) continue;
    const times = result?.value?.messageTimes;
    update.run(
      JSON.stringify({
        ...(result ?? {}),
        value: {
          ...(result?.value ?? {}),
          messages: [...opening, ...messages],
          ...(Array.isArray(times) ? { messageTimes: [...opening.map(() => ({})), ...times] } : {}),
        },
      }),
      row.id,
    );
    repaired += 1;
  }
  return repaired;
}

/** JSON from a column, or `undefined` — a malformed blob is a row to leave alone, not a throw. */
function parsed<T>(json: string | null): T | undefined {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}
