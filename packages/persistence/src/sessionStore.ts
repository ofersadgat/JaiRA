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
import { entriesOfMessages } from "@declarative-ai/llm";
import type { JairaDb } from "./db";
import { dehydrate, hydrate, release } from "./blobStore";
import { messagesOfRecord } from "./recordMessages";
export { messagesOfRecord } from "./recordMessages";
import type { ConversationLog, PositionRow, RecordRow, SessionRow } from "./conversationFile";

/** `<id>@<position>` — the ref spelling upstream uses, restated because both halves must agree. */
const join = (id: string, seq: number): string => `${id}@${seq}`;

/**
 * How a position finds its record: the record's OWN key, never the rowid the database assigned.
 *
 * `IS` rather than `=` on the two scope columns, because both are nullable — an unscoped store keys
 * by the bare id — and `= NULL` is never true. Written once because it appears in every read that
 * crosses the two tables, and four columns silently mistyped in one of them is a join that quietly
 * returns nothing.
 *
 * Uniqueness of the tuple is enforced by `operation_records_natural` (migration 8), which is what
 * makes this a lookup rather than a fan-out.
 */
export const ON_RECORD = `r.record_id = p.record_id AND r.attempt = p.attempt
                   AND r.task_id IS p.task_id AND r.run_id IS p.run_id`;

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

/**
 * A session name as it is actually STORED — namespaced by the run that made it.
 *
 * Exported because two readers need it and a second copy of the rule is a join that silently returns
 * nothing: the store keys every row this way, and the replay index has to resolve a journal's
 * `sessionRef` (which carries the bare authored name) to the same string. A fork carries its lineage
 * in the name (`main[0:14]/b`), so prefixing is all there is to it either way.
 */
export function scopedSessionId(scope: SessionScope, id: string): string {
  const { taskId, runId } = scope;
  return taskId === undefined && runId === undefined ? id : `${taskId ?? ""}/${runId ?? ""}/${id}`;
}

/**
 * One call a run made, as everything outside the store reads it.
 *
 * The whole of what was asked and what came back: `request` carries the callee AND its arguments
 * with their RESOLVED values (an operation's `input.<slot>.binding.json` is the value the engine
 * settled on), and `result` carries what it returned. Between them they are a complete account of
 * one call without needing the workflow file open beside them.
 *
 * `status` is separate from `error` on purpose. A call can be `failed` with no error payload — a run
 * killed mid-flight leaves exactly that — and a reader that inferred failure from a missing result
 * would report a call still in flight as one that went wrong.
 */
export interface RecordedCall {
  recordId: string;
  status: string;
  request?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
  startedAt?: number;
  endedAt?: number;
}

interface CallRow {
  record_id: string;
  status: string;
  request_json: string | null;
  result_json: string | null;
  error_json: string | null;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * One row, as a {@link RecordedCall}. Absent columns stay absent rather than becoming `null`.
 *
 * HYDRATED here, which is the only place a record leaves the store — a caller never sees a
 * `{"$blob"}` reference, and never has to know the layer exists (RECORDS.md §8).
 */
function recordedCallOf(db: JairaDb, row: CallRow): RecordedCall {
  return {
    recordId: row.record_id,
    status: row.status,
    ...(row.request_json !== null ? { request: hydrate(db, JSON.parse(row.request_json) as JsonValue) as JsonValue } : {}),
    ...(row.result_json !== null ? { result: hydrate(db, JSON.parse(row.result_json) as JsonValue) as JsonValue } : {}),
    ...(row.error_json !== null ? { error: JSON.parse(row.error_json) as JsonValue } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}

export class SqliteSessionStore implements SessionStore<JsonValue>, RecordStore {
  private minted = 0;

  /**
   * `log` is present only when `config.storage.conversations` puts them in files (DESIGN §4.4), and
   * `sessionStoreFor` is the constructor that decides — building one by hand with a db and a scope
   * gets a store that writes to the table only, which is what every read-side caller wants and what
   * a write-side one must not accidentally get. That is the whole reason the helper exists.
   */
  constructor(
    private readonly db: JairaDb,
    private readonly scope: SessionScope = {},
    private readonly log?: ConversationLog,
  ) {}

  // --- the file half ------------------------------------------------------------
  //
  // Every one of these re-READS the row it just wrote and appends that, rather than reconstructing
  // what it thinks it wrote. One extra SELECT per write, and in exchange the file cannot drift from
  // the table by a field somebody forgot to mirror — which, with thirteen columns and five writers,
  // is not a hypothetical.

  private logRecordRow(rowid: number | bigint): void {
    if (this.log === undefined) return;
    const row = this.db
      .prepare(
        `SELECT record_id, task_id, run_id, attempt, status, request_json, result_json, error_json,
                metrics_json, session_outcome_json, provider_session_id, started_at, ended_at
           FROM operation_records WHERE id = ?`,
      )
      .get(rowid) as RecordRow | undefined;
    if (row !== undefined) this.log.append({ kind: "record", row });
  }

  private logPosition(sessionKey: string, seq: number): void {
    if (this.log === undefined) return;
    const row = this.db
      .prepare(`SELECT session_id, seq, task_id, run_id, record_id, attempt FROM session_positions WHERE session_id = ? AND seq = ?`)
      .get(sessionKey, seq) as PositionRow | undefined;
    if (row !== undefined) this.log.append({ kind: "position", row });
  }

  private logSession(sessionKey: string): void {
    if (this.log === undefined) return;
    const row = this.db.prepare(`SELECT id, parent, cursor, created_at FROM sessions WHERE id = ?`).get(sessionKey) as
      | SessionRow
      | undefined;
    if (row !== undefined) this.log.append({ kind: "session", row });
  }

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
      this.logRecordRow(this.insertRecord(stub).rowid);
      return;
    }
    this.branch(at.id, { cursor: this.cursorOf(at.id) });
    try {
      // One transaction: the record and its position claim land together, so a lost race leaves no
      // orphaned record behind the PositionTaken it reports.
      let placed!: { recordId: string; attempt: number; rowid: number | bigint };
      this.db
        .transaction(() => {
          placed = this.insertRecord(stub);
          this.db
            .prepare(
              `INSERT INTO session_positions (session_id, seq, task_id, run_id, record_id, attempt)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(this.k(at.id), at.seq, this.scope.taskId ?? null, this.scope.runId ?? null, placed.recordId, placed.attempt);
        })
        .immediate();
      // AFTER the transaction, and only once it committed: the claim is what decides whether this
      // call owns the position at all, so appending before it would put a turn in the file for a
      // call that went on to fork instead.
      this.logSession(this.k(at.id));
      this.logRecordRow(placed.rowid);
      this.logPosition(this.k(at.id), at.seq);
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
        : carryTurnTiming(settled.result as JsonValue, row.result_json);
    this.db
      .prepare(
        `UPDATE operation_records
            SET result_json = ?, error_json = ?, metrics_json = ?, session_outcome_json = ?,
                provider_session_id = COALESCE(?, provider_session_id),
                status = ?, ended_at = ?
          WHERE id = ?`,
      )
      .run(
        result === undefined ? null : JSON.stringify(dehydrate(this.db, result)),
        error === undefined ? null : JSON.stringify(error),
        settled.metrics === undefined ? null : JSON.stringify(settled.metrics),
        settled.sessionOutcome === undefined ? null : JSON.stringify(withoutDuplicateTurns(settled.sessionOutcome, result)),
        settled.sessionOutcome?.providerSessionId ?? null,
        error === undefined ? "completed" : "failed",
        Date.now(),
        row.id,
      );
    // The settled state, appended whole. Last line wins on replay, so the `open` line this
    // supersedes needs no rewriting — which is the property that lets the format stay append-only.
    this.logRecordRow(row.id);
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
           JOIN operation_records r ON ${ON_RECORD}
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
    // A partial is a real state of the record, so it is appended like any other. A run that streams
    // ten flushes writes ten lines and replays as the tenth: the file grows, and it never has to be
    // rewritten in place — which is the trade the append-only format is making.
    this.logRecordRow(row.id);
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

  /**
   * Where a conversation CAME FROM — the other direction from {@link forks}, and the one a run asks.
   *
   * `forks` answers "walking down to here, what did the path not take", which is the question a chat
   * thread has: it holds one materialized conversation and wants to know where it divided. A run
   * holds the branches themselves — a retried state's second attempt is its own session, drawn as
   * its own panel — and its question is the reverse: given this conversation, whose continuation is
   * it, and from which position.
   *
   * The row has held the answer since the store was written (`parent`, `cursor`); nothing until now
   * could read it without being inside this class. Absent means a root — most sessions, and nothing
   * is paid for until one branches.
   */
  lineageOf(id: string): { parent: string; at: number } | undefined {
    const branch = this.branchOf(id);
    return branch?.parent === undefined ? undefined : { parent: branch.parent, at: branch.cursor };
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
  record(recordId: string): RecordedCall | undefined {
    const row = this.db
      .prepare(
        `SELECT record_id, status, request_json, result_json, error_json, started_at, ended_at
           FROM operation_records
          WHERE record_id = ? AND task_id IS ? AND run_id IS ?
          ORDER BY attempt DESC, id DESC LIMIT 1`,
      )
      .get(recordId, this.scope.taskId ?? null, this.scope.runId ?? null) as CallRow | undefined;
    return row === undefined ? undefined : recordedCallOf(this.db, row);
  }

  /**
   * Every call this run made, oldest first — what a derivation reads and what a gate's own request
   * is recovered from.
   *
   * Scoped by the store's own `(taskId, runId)`, which is the index `operation_records_scope`
   * already covers, so this is a range scan rather than a table walk.
   *
   * ⚠️ ONE ROW PER RECORD, the latest attempt. A retried call writes a second row with the same
   * `record_id` and a higher `attempt` (see the note on {@link record}), and a list that returned
   * both would show the same call twice with different answers — which is precisely the shape a
   * reader would mistake for two calls. The earlier attempts are still in the table for anyone who
   * wants the history; this is the answer to "what happened", which is the last one.
   */
  records(): RecordedCall[] {
    const rows = this.db
      .prepare(
        `SELECT record_id, status, request_json, result_json, error_json, started_at, ended_at
           FROM operation_records r
          WHERE task_id IS ? AND run_id IS ?
            AND attempt = (SELECT MAX(attempt) FROM operation_records a
                            WHERE a.record_id = r.record_id AND a.task_id IS r.task_id AND a.run_id IS r.run_id)
          ORDER BY started_at, id`,
      )
      .all(this.scope.taskId ?? null, this.scope.runId ?? null) as CallRow[];
    return rows.map((row) => recordedCallOf(this.db, row));
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
   * recovery finds nothing and re-reads no files. `capturedAt` is what says so: the fold leaves no
   * field of its own any more — the captured lines ARE the entries now — so the record states when
   * it happened rather than being recognized by a leftover.
   */
  recoverable(taskId: string): Array<{ id: number; providerSessionId: string; startedAt: number }> {
    return this.db
      .prepare(
        `SELECT id, provider_session_id, started_at FROM operation_records
          WHERE task_id = ? AND status = 'failed' AND provider_session_id IS NOT NULL
            AND (result_json IS NULL OR result_json NOT LIKE '%"capturedAt"%')`,
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
   * The FOLD itself is the caller's: merging a captured file into a payload's entries is the
   * runtime's rule (`foldIntoEntries`) and this package must not import the runtime, so `fold` is
   * handed the record's current value and answers with the folded one. A row whose payload is not
   * record-shaped (a scripted value, a bare string) is left alone rather than wrapped in a shape
   * nothing reads.
   */
  foldNativeCapture(recordRowId: number, fold: (value: Record<string, JsonValue>) => Record<string, JsonValue>): void {
    const row = this.db.prepare(`SELECT result_json FROM operation_records WHERE id = ?`).get(recordRowId) as
      | { result_json: string | null }
      | undefined;
    if (row === undefined) return;
    const existing = row.result_json === null ? {} : (hydrate(this.db, JSON.parse(row.result_json) as JsonValue) as { value?: unknown });
    const value = existing.value;
    if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) return;
    const merged = { ...existing, value: fold((value ?? {}) as Record<string, JsonValue>) };
    this.db
      .prepare(`UPDATE operation_records SET result_json = ? WHERE id = ?`)
      .run(JSON.stringify(dehydrate(this.db, merged as JsonValue)), recordRowId);
    // A recovered capture is a change to the record like any other — and one that arrives long after
    // the run, which is exactly when a file that missed it would be the version anybody reads.
    this.logRecordRow(recordRowId);
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
  private insertRecord(stub: RecordStub): { recordId: string; attempt: number; rowid: number | bigint } {
    const attempt = this.attemptFor(stub.id);
    const request = stub.source === undefined ? null : JSON.stringify(stub.source);
    const opening = openingMessage(request, []);
    // Through `withOpening`, so the splice is spelled out in ONE place and a record is born in the
    // same shape it will settle in — one conversation array, whatever writes it next.
    const born = opening.length === 0 ? null : JSON.stringify(withOpening({} as JsonValue, request));
    const info = this.db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, request_json, result_json, started_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        stub.id,
        this.scope.taskId ?? null,
        this.scope.runId ?? null,
        attempt,
        request,
        born,
        stub.startMs ?? Date.now(),
      );
    // The KEY, not the rowid. A caller that needs to point at this record — a position claim — must
    // point at something a replay reproduces, and `lastInsertRowid` is precisely what it does not
    // (migration 8). The rowid rides along anyway, for the one caller that only needs to re-read
    // the row it just wrote in THIS connection — which is a different question from identity.
    return { recordId: stub.id, attempt, rowid: info.lastInsertRowid };
  }

  /**
   * Which attempt this record id is up to, within the scope.
   *
   * Counted rather than tracked: a retry reuses the id, and the row already on disk is the only
   * thing that knows how many came before — including ones written by a previous process. It is
   * also the half of the natural key that makes it a key, since a content id repeats whenever the
   * same operation is dispatched twice.
   */
  private attemptFor(recordId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM operation_records WHERE record_id = ? AND task_id IS ? AND run_id IS ?`)
      .get(recordId, this.scope.taskId ?? null, this.scope.runId ?? null) as { n: number };
    return row.n + 1;
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
    const recordId = `${derived}:0`;
    let rowid!: number | bigint;
    this.db
      .transaction(() => {
        // The attempt is COUNTED here as it is everywhere else. It used to be left to default to 1,
        // which was invisible until the natural key became a key: `minted` restarts with the store,
        // so two derivations of one session id inside a run both claimed the first attempt.
        const attempt = this.attemptFor(recordId);
        const info = this.db
          .prepare(
            `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, result_json, started_at, ended_at)
             VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
          )
          .run(
            recordId,
            this.scope.taskId ?? null,
            this.scope.runId ?? null,
            attempt,
            // A compaction or a resync is a record like any other, so it holds its turns the one way
            // a record holds turns: as entries. The caller hands over messages because that is what a
            // summary IS at the point it is written; the shape it is stored in is not the caller's.
            JSON.stringify({
              value: { entries: entriesOfMessages(messages as never, { provider: "unknown", at: new Date(0).toISOString() }) },
            }),
            Date.now(),
            Date.now(),
          );
        this.db
          .prepare(
            `INSERT OR REPLACE INTO session_positions (session_id, seq, task_id, run_id, record_id, attempt)
             VALUES (?, 0, ?, ?, ?, ?)`,
          )
          .run(this.k(derived), this.scope.taskId ?? null, this.scope.runId ?? null, recordId, attempt);
        rowid = info.lastInsertRowid;
      })
      .immediate();
    this.logSession(this.k(derived));
    this.logRecordRow(rowid);
    this.logPosition(this.k(derived), 0);
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
    return scopedSessionId(this.scope, id);
  }

  private branch(id: string, branch: Branch): void {
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO sessions (id, parent, cursor, created_at) VALUES (?, ?, ?, ?)`)
      .run(this.k(id), branch.parent === undefined ? null : this.k(branch.parent), branch.cursor, Date.now());
    // Only when it actually inserted. `OR IGNORE` means most calls are no-ops — `resolve` re-asserts
    // a branch on every turn — and appending each of those would write a line per model call for a
    // row that has not changed since the conversation began.
    if (info.changes > 0) this.logSession(this.k(id));
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
           FROM session_positions p JOIN operation_records r ON ${ON_RECORD}
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
        row.result_json === null ? undefined : (hydrate(this.db, JSON.parse(row.result_json) as JsonValue) as JsonValue),
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
 * `LlmOutput` — its `entries`, which carry the reasoning and the tool trace as well as the turns —
 * and replacing that with a bare `{ messages }` would discard exactly what record mode was turned
 * on to keep. The reported outcome is for a payload that is NOT a conversation: a delegated agent
 * answering with text, a value-mode prompt core whose payload was projected away inside the call, a
 * scripted fake.
 */
function projectValue(result: JsonValue | undefined, sessionOutcome: JsonValue | undefined): JsonValue | undefined {
  const payload = result as { value?: { entries?: unknown } } | undefined;
  if (payload?.value?.entries !== undefined) return result;
  const reported = (sessionOutcome as { messages?: JsonValue[] } | undefined)?.messages;
  // Turned into entries HERE rather than stored as a second conversation shape: an executor whose
  // payload is not a conversation still reports one, and `entries` is the only encoding this store
  // hands out. `provider: "unknown"` because the outcome does not say, and the timestamp is the
  // projection's, not a fact about when anything was said.
  if (reported !== undefined) {
    const entries = entriesOfMessages(reported as never, { provider: "unknown", at: new Date(0).toISOString() });
    return { value: { entries: entries as unknown as JsonValue } } as JsonValue;
  }
  return result;
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
/** Main-chain, finished message entries with their positions — what the two sides align on. */
function mainMessageEntries(entries: readonly JsonValue[]): Array<{ index: number; entry: Record<string, JsonValue> }> {
  const out: Array<{ index: number; entry: Record<string, JsonValue> }> = [];
  for (const [index, raw] of entries.entries()) {
    const entry = raw as Record<string, JsonValue> | null;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry["kind"] !== "message" || entry["sidechain"] !== undefined || entry["partial"] === true) continue;
    out.push({ index, entry });
  }
  return out;
}

/**
 * The settled result, wearing the clocks the stream measured — see the call site in `close()`.
 *
 * A turn's clocks are the numbers only a streaming consumer can take: when its first fragment
 * appeared, and how long the model spent thinking before it began answering. The settle overwrites
 * the row with the provider's own result, which has none of them — so they were measured, persisted,
 * and thrown away one statement later. "Thought for 12 s" worked while you watched and vanished when
 * you came back.
 *
 * They ride ON each entry (`timing`), so this MERGES rather than padding a parallel array. What
 * still needs aligning is which turn is which: the stream sees only the turns the call produced,
 * while the settle also holds the messages it was called with, so the streamed run matches a SUFFIX
 * of the settled one. Checked by role before it is believed — a transport that streams something
 * other than a suffix of what it settles would label one turn with another's duration, which is
 * worse than no label, so a mismatch drops the whole carry rather than guessing at an offset.
 */
function carryTurnTiming(settledResult: JsonValue | undefined, existingJson: string | null): JsonValue | undefined {
  if (existingJson === null || settledResult === undefined) return settledResult;
  const settled = settledResult as { value?: { entries?: JsonValue[] } };
  if (!Array.isArray(settled.value?.entries)) return settledResult;
  let streamed: { value?: { entries?: JsonValue[] } } | null;
  try {
    streamed = JSON.parse(existingJson) as typeof streamed;
  } catch {
    return settledResult;
  }
  const partialEntries = streamed?.value?.entries;
  if (!Array.isArray(partialEntries)) return settledResult;
  const settledMain = mainMessageEntries(settled.value.entries);
  const streamedMain = mainMessageEntries(partialEntries);
  if (streamedMain.length === 0) return settledResult;
  const offset = settledMain.length - streamedMain.length;
  if (offset < 0) return settledResult;
  for (const [i, streamedEntry] of streamedMain.entries()) {
    if (streamedEntry.entry["role"] !== settledMain[i + offset]!.entry["role"]) return settledResult;
  }
  const merged = [...settled.value.entries];
  let carried = false;
  for (const [i, streamedEntry] of streamedMain.entries()) {
    const timing = streamedEntry.entry["timing"];
    if (timing === undefined) continue;
    const target = settledMain[i + offset]!;
    // Never over an existing one: a transport that measured its own turns is authoritative.
    if (target.entry["timing"] !== undefined) continue;
    merged[target.index] = { ...target.entry, timing } as JsonValue;
    carried = true;
  }
  if (!carried) return settledResult;
  return { ...(settledResult as object), value: { ...(settled.value as object), entries: merged } } as JsonValue;
}

function preservePartial(
  settledResult: JsonValue | undefined,
  sessionOutcome: { messages?: unknown } | undefined,
  existingJson: string | null,
  requestJson: string | null,
): JsonValue | undefined {
  const settled = settledResult as { value?: { entries?: unknown } } | undefined;
  if (settled?.value?.entries !== undefined) return settledResult;
  if (sessionOutcome?.messages !== undefined) return settledResult;
  // Through `withOpening` even though `insertRecord` normally put the question there already: a row
  // opened before that existed, or one whose only flush raced ahead of it, still settles correctly.
  const partial = withOpening(parsed<JsonValue>(existingJson) ?? {}, requestJson) as { value?: { entries?: JsonValue[] } };
  // One array holds everything worth keeping — the question, the finished turns, and the one that
  // was being written when the call died — so there is nothing to fold in from a second channel.
  const entries = Array.isArray(partial.value?.entries) ? partial.value.entries : [];
  if (entries.length === 0) return settledResult;
  return {
    ...((settledResult ?? {}) as object),
    value: { ...((settled?.value ?? {}) as object), entries },
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
  const held = value as { value?: { entries?: JsonValue[] } } | null;
  const entries = Array.isArray(held?.value?.entries) ? held.value.entries : [];
  const opening = openingMessage(requestJson, messagesOfRecord(value));
  if (opening.length === 0) return value;
  const asked = opening[0] as { role: string; content: JsonValue };
  // `provider: "unknown"` because nobody produced it: this turn is the host stating what it asked,
  // which is exactly what a settled record's own spliced opening says about itself.
  const entry = { kind: "message", role: asked.role, content: asked.content, provider: "unknown" } as JsonValue;
  return {
    ...((value ?? {}) as object),
    value: { ...((held?.value ?? {}) as object), entries: [entry, ...entries] },
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


/** JSON from a column, or `undefined` — a malformed blob is a row to leave alone, not a throw. */
function parsed<T>(json: string | null): T | undefined {
  if (json === null) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

/**
 * The session outcome with its `messages` dropped when the RESULT already holds the conversation.
 *
 * Measured before this: one 894 KB record kept `result_json.value.messages` and
 * `session_outcome_json.messages` and they were byte-identical, sha for sha — 269,008 bytes each,
 * about 2.5 MB across one run of the `feature` workflow. Two writes of one fact, and a reader had no
 * rule for which to believe.
 *
 * The outcome's copy is the one that goes, because the payload's is the authoritative one:
 * `projectValue` already prefers it, and everything derived from a record — the wire history, the
 * tool trace, the reasoning — is projected from the payload's entries. What stays is
 * `providerSessionId`, which is the outcome's own fact and exists nowhere else.
 *
 * A payload that is NOT a conversation keeps the outcome whole: a value-mode core whose payload was
 * projected away inside the call, a delegated agent answering with bare text, a scripted fake. There
 * the outcome's turns are the only turns there are.
 */
function withoutDuplicateTurns<T extends object>(outcome: T, result: JsonValue | undefined): T {
  const carriesConversation = (result as { value?: { entries?: unknown } } | undefined)?.value?.entries !== undefined;
  if (!carriesConversation) return outcome;
  const { messages: _duplicated, ...rest } = outcome as T & { messages?: unknown };
  return rest as T;
}
