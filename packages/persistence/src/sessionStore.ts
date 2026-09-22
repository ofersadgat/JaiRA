/**
 * Conversations that outlive the process (SESSIONS.md §9) — and, since CHANGESETS.md §5.1, the
 * operation record store those conversations are a PROJECTION of.
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
 *  - **`operation_records`** — one row per DISPATCH, keyed by the hash of the scoped request
 *    (Identity and Resume step 2 — the scope `(instance_id, sequence)` never repeats, so the id is
 *    the primary key and the old `attempt` column had nothing left to say): `request_json` (the
 *    operation as asked), `result_json` / `error_json` (what came back), metrics, the provider's
 *    session handle, and status (`open | completed | failed | interrupted`). EVERY call this store
 *    sees lands here, placed in a conversation or not.
 *  - **`session_positions`** — conversation membership: `(session_id, seq, record_id)`.
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
import { createLogger } from "@declarative-ai/log";
import {
  PositionTaken,
  resolveSessionRef,
  type ForkSource,
  type RecordPartial,
  type RecordRef,
  type RecordStore,
  type RecordStub,
  type ResolvedSession,
  type SessionRequest,
  type SessionStore,
  type StoredRecord,
} from "@declarative-ai/exec";
import { entriesOfMessages } from "@declarative-ai/llm";
import { uuidv7 } from "@declarative-ai/hw";
import type { JairaDb } from "./db";
import { dehydrate, hydrate, release } from "./blobStore";
import { messagesOfRecord } from "./recordMessages";
export { messagesOfRecord } from "./recordMessages";
import type { ConversationLog, RecordRow, SessionRow } from "./conversationFile";

/** `<id>@<position>` — the ref spelling upstream uses, restated because both halves must agree. */
const join = (id: string, seq: number): string => `${id}@${seq}`;

/**
 * A record's EFFECTIVE position — landed when present, asked otherwise (Identity and Resume §03).
 *
 * The one rule every reader of a conversation applies: the ask is immutable in `request_json`, and
 * the landed columns carry the single thing the outcome can change — where the call demonstrably
 * ran. Written once because it appears in every session read, and two spellings of a COALESCE pair
 * is how a branch's transcript and its trunk's come to disagree about the same row.
 */
export const EFFECTIVE_SESSION = `COALESCE(landed_session_id, session_id)`;
export const EFFECTIVE_SEQ = `COALESCE(landed_seq, session_seq)`;

/**
 * Whether a thrown UNIQUE violation is the `op_position` claim index refusing a seat.
 *
 * SQLite names the COLUMNS in the message, not the index, so this is the spelling the claim
 * actually produces — distinct from the primary key's `operation_records.id`, which is the
 * same-identity re-dispatch `insertRecord` answers by reopening.
 */
function isSeatConflict(e: unknown): boolean {
  const message = String((e as Error).message);
  return message.includes("UNIQUE") && message.includes("operation_records.session_id");
}

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
   * `result_json` stayed NULL until the settle; streamed partials (see {@link SqliteSessionStore.update})
   * end that, so every reader that cares whether a turn HAPPENED must ask this field, never the value.
   */
  status: "open" | "completed" | "failed" | "interrupted";
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
 * Which TASK a store's conversations belong to.
 *
 * What the scope does NOW (migration 16): it stamps the RECORDS (`task_id` on every row, which is
 * what pruning and per-task reads key on), and it scopes the NAME ALIASES — an authored
 * `session: "planning"` resolves through `session_names(task_id, name)` to an assigned session id,
 * so a resumed machine's `planning` IS the conversation it created before it stopped.
 *
 * It does not namespace session ids: ids are assigned — minted once, opaque, never parsed
 * (Identity and Resume §01).
 */
export interface SessionScope {
  taskId?: string;
}

const log = createLogger("jaira.persistence.sessions");

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

  private logRecordRow(recordId: string): void {
    if (this.log === undefined) return;
    const row = this.db
      .prepare(
        `SELECT id AS record_id, task_id, status, request_json, result_json, error_json,
                metrics_json, provider_session_id, landed_session_id, landed_seq, started_at, ended_at
           FROM operation_records WHERE id = ?`,
      )
      .get(recordId) as RecordRow | undefined;
    if (row !== undefined) this.log.append({ kind: "record", row });
  }

  private logSession(sessionKey: string): void {
    if (this.log === undefined) return;
    const row = this.db
      .prepare(`SELECT id, parent, cursor, provider, provider_session_id, cut_at, created_at FROM sessions WHERE id = ?`)
      .get(sessionKey) as SessionRow | undefined;
    if (row !== undefined) this.log.append({ kind: "session", row });
  }

  /** A record or a session that is GONE — the append-only file's way of saying so (see `cut.ts`). */
  private logTombstone(row: { record_id?: string; session_id?: string; task_id?: string | null }): void {
    this.log?.append({ kind: "tombstone", row: { ...(this.scope.taskId !== undefined ? { task_id: this.scope.taskId } : {}), ...row } });
  }

  // --- SessionStore ------------------------------------------------------------

  resolve(request: SessionRequest): ResolvedSession<JsonValue> {
    const asked = request.ref !== undefined ? split(request.ref) : undefined;
    // What the caller WROTE resolves to the session's own id here — an authored name or the
    // engine's fresh key is an ALIAS, task-scoped and run-free, which is what lets a resumed run's
    // `planning` be the conversation an earlier run created (Identity and Resume §01/§07 step 3).
    // Everything below this line speaks real session ids.
    let id = asked !== undefined ? this.sessionIdOf(asked[0]) : this.mint(request.seed);
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
    // AT THE HEAD ONLY, and never on a fork. A handle names a conversation at the point it has
    // reached, so offering one for an earlier position would offer a resume that continues from the
    // remote's tip — a turn this caller never saw, in front of its prompt. A fork inherits none for
    // the same reason from the other side: two branches sharing one remote session would be two
    // conversations writing into the same place.
    //
    // The SESSION'S OWN column holds the complete resume identity: the opaque provider handle and
    // its owning provider. A row carrying only one of the two is not one — see `sessionHandle`.
    const atHead = mode === "append" && seq === this.head(id);
    const own = atHead ? this.sessionHandle(id) : undefined;
    // A REWOUND conversation (migration 17, `cutSession`) has a remote that runs past its rows — the
    // provider cannot truncate a conversation — so its own handle is a COPY SOURCE cut at the last
    // message the rows still hold, never a resume target: resuming it would put the next turn after
    // turns this conversation no longer has. The settle at head stamps the copy's new handle and
    // clears the cut (`stampSessionHandle`), and the conversation is ordinary again.
    const cut = own !== undefined ? this.cutOf(id) : undefined;
    // Nothing of our own to resume, but an ancestor has a remote: that is a branch POINT, not an
    // append target. Offered as `forkFrom` so only an adapter that can copy a session server-side
    // acts on it — see `ResolvedSession.forkFrom`.
    const forkFrom =
      own === undefined
        ? this.ancestorHandle(id)
        : cut !== undefined
          ? { handle: own.handle, provider: own.provider, at: cut }
          : undefined;
    return resolveSessionRef<JsonValue>(join(id, seq), {
      mode,
      at: { id, seq },
      ...(own !== undefined && cut === undefined ? { providerSessionId: own.handle, provider: own.provider } : {}),
      ...(forkFrom !== undefined ? { forkFrom } : {}),
      // Carried so a FORK does not need the original request back — see `ResolvedSession.seed`.
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      messages: async () => this.materialize(id, seq),
    });
  }

  fork(ref: string, seed?: string): string {
    const [name, seq] = split(ref);
    const id = this.existingSessionOf(name) ?? name;
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
    const [name, seq] = split(ref);
    const id = this.existingSessionOf(name) ?? name;
    return this.materialize(id, seq ?? this.readHead(id));
  }

  compact(ref: string, messages: readonly JsonValue[]): string {
    return this.derive(ref, "compact", messages);
  }

  resync(ref: string, messages: readonly JsonValue[]): string {
    return this.derive(ref, "resync", messages);
  }

  // --- RecordStore -------------------------------------------------------------

  append(stub: RecordStub): RecordRef {
    // EVERY record lands in operation_records — placed or not (CHANGESETS.md §5.2). A position is an
    // INPUT now: "append at seq N of conversation X" sits in `request_json.session` beside the rest
    // of the ask, and the claim is the `op_position` partial unique index over the generated columns
    // — one insert, one refusal, no second table.
    const at = stub.session;
    if (at !== undefined) this.branch(at.id, { cursor: this.cursorOf(at.id) });
    try {
      this.insertRecord(stub);
    } catch (e) {
      // The claim index refusing is the FORK SIGNAL: a seat is held only by a record that is alive
      // and still there, so a conflict always means a genuinely live competing claim. The store's
      // own reopen path throws this too, when a re-dispatch finds its seat taken while it was dead.
      if (at !== undefined && isSeatConflict(e)) throw new PositionTaken(at.id, at.seq);
      throw e;
    }
    if (at !== undefined) this.logSession(at.id);
    this.logRecordRow(stub.id);
    return { id: stub.id };
  }

  finish(ref: RecordRef, settled: Pick<StoredRecord, "result" | "metrics" | "sessionOutcome">): void {
    // Before the row is settled, so the comparison reads the lineage as it stood when this call was
    // claimed. A run with no live view never calls `update`, so this is the only correction it gets.
    this.correctLineage(ref, settled.sessionOutcome?.providerSessionId);
    // By ID, scoped. The id is the hash of the scoped request (migration 13) — unique by
    // construction — so the `attempt` half this lookup used to need, and the "which of two open
    // rows is closing" guessing before that, have nothing left to answer.
    const row = this.db
      .prepare(
        `SELECT id, result_json, request_json FROM operation_records
          WHERE id = ? AND task_id IS ?`,
      )
      .get(ref.id, this.scope.taskId ?? null) as
      | { id: string; result_json: string | null; request_json: string | null }
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
    const folded =
      error !== undefined
        ? preservePartial(settled.result as JsonValue, settled.sessionOutcome, row.result_json, row.request_json)
        : carryTurnTiming(settled.result as JsonValue, row.result_json);
    // The outcome's one earned case — a payload that is NOT a conversation — normalises into the
    // result at the WRITE now (Identity and Resume §03 deleted `session_outcome_json`): the turns
    // land as a SIBLING of the value (`$.messages`), never over it, because `$.value` is the op's
    // output — what a replay answers with — and the conversation is a second fact about the same
    // call. `projectValue` turns the sibling into entries at read, exactly as it did the old column.
    const reported = (settled.sessionOutcome as { messages?: unknown } | undefined)?.messages;
    const carriesConversation = (folded as { value?: { entries?: unknown } } | undefined)?.value?.entries !== undefined;
    const result =
      reported !== undefined && !carriesConversation
        ? ({ ...((folded ?? {}) as object), messages: reported } as JsonValue)
        : folded;
    this.db
      .prepare(
        `UPDATE operation_records
            SET result_json = ?, error_json = ?, metrics_json = ?,
                provider_session_id = COALESCE(?, provider_session_id),
                status = ?, ended_at = ?
          WHERE id = ?`,
      )
      .run(
        result === undefined ? null : JSON.stringify(dehydrate(this.db, result)),
        error === undefined ? null : JSON.stringify(error),
        settled.metrics === undefined ? null : JSON.stringify(settled.metrics),
        settled.sessionOutcome?.providerSessionId ?? null,
        // `interrupted` is its own word (Identity and Resume §03): the call was cut — by a stop, or
        // by the process dying under it — and its partial may already exist in the remote stream,
        // which is the promise `failed` does not make. The executor classifies; this maps.
        error === undefined ? "completed" : (error as { classification?: string }).classification === "interrupted" ? "interrupted" : "failed",
        Date.now(),
        row.id,
      );
    // The conversation's remote identity, kept on the SESSION — the handle is only ever passed when
    // appending at the head, so the newest reported pair is the right value everywhere a handle is
    // used. With its provider, because a bare handle is meaningless.
    this.stampSessionHandle(ref, settled.sessionOutcome?.providerSessionId, settled.sessionOutcome?.provider);
    // The settled state, appended whole. Last line wins on replay, so the `open` line this
    // supersedes needs no rewriting — which is the property that lets the format stay append-only.
    this.logRecordRow(row.id);
  }

  /**
   * Write the handle a call reported onto the conversation it actually ran in — at the head only.
   *
   * A handle names a conversation at the point it has reached, so a record that is not the newest
   * thing in its session must not move the session's handle: the value there already describes a
   * later turn. A fork starts with NULL and earns its own (`branchFrom` writes no handle), which is
   * the invariant that keeps two branches out of one remote stream.
   */
  private stampSessionHandle(ref: RecordRef, handle: string | undefined, provider: string | undefined): void {
    // The PAIR or nothing (Identity and Resume §03). A handle whose owner is unnamed cannot be
    // resumed against — the same string on two providers names two different conversations, so a
    // consumer offered one has no way to tell whether it may use it — and stamping it anyway wrote a
    // resume target that reads as usable and is not. The call's transcript is still recorded; only
    // the remote identity is withheld, and the next call replays the prefix instead.
    if (handle === undefined || provider === undefined) return;
    const pos = this.positionOf(ref);
    if (pos === undefined) return;
    // "Nothing LIVE beyond it" rather than "exactly the head": an interrupted settle releases its
    // own seat, and its handle is still the conversation's newest remote fact — the very thing a
    // resume continues from.
    if (pos.seq + 1 < this.head(pos.id)) return;
    // The cut goes with it: a handle reported at the head is the remote the rows now describe,
    // whether it is the copy a cut asked for or the same conversation carried on.
    this.db
      .prepare(`UPDATE sessions SET provider_session_id = ?, provider = ?, cut_at = NULL WHERE id = ?`)
      .run(handle, provider, pos.id);
    this.logSession(pos.id);
  }

  /**
   * Cut a conversation at a seat: every row at or after it goes, and so does every branch that left
   * it at or after that point — a branch's prefix IS those rows, and a branch of a tail nobody can
   * read any more is a conversation nobody can have (see `cut.ts`, rewind).
   *
   * What the conversation is left holding is then stamped as its remote identity: the last kept
   * row's handle, marked as CUT at the last kept message — the provider still has the deleted
   * turns, so the next call copies the remote up to that message rather than resuming it. A
   * conversation whose entries carry no message ids cannot say where to cut, and drops its handle
   * instead: the next call replays the prefix, which is slower and exactly right.
   *
   * Returns the record ids removed, seated on this conversation and its dropped branches alike.
   */
  cutSession(sessionId: string, seq: number): string[] {
    const id = this.existingSessionOf(sessionId) ?? sessionId;
    const removed: string[] = [];
    this.db.transaction(() => {
      this.dropBranchesFrom(id, seq, removed);
      removed.push(...this.deleteRowsFrom(id, seq));
      if (removed.length === 0) return;
      const handle = this.handleAt(id, seq);
      const provider = this.providerOf(id);
      const cut = this.messageIdAt(id, seq);
      // The pair or nothing, as everywhere: a handle whose cut cannot be named is one the next call
      // must not resume, and one without a provider is no identity at all.
      const kept = handle !== undefined && provider !== undefined && cut !== undefined;
      this.db
        .prepare(`UPDATE sessions SET provider_session_id = ?, provider = ?, cut_at = ? WHERE id = ?`)
        .run(kept ? handle : null, provider ?? null, kept ? cut : null, id);
      this.logSession(id);
    })();
    return removed;
  }

  /**
   * Delete records by id, wherever they sit — the half of a rewind `cutSession` cannot reach: a call
   * that claimed no seat (a function op, a computed call) has no conversation to be cut from.
   */
  dropRecords(recordIds: readonly string[]): number {
    let dropped = 0;
    this.db.transaction(() => {
      for (const recordId of recordIds) dropped += this.deleteRecord(recordId) ? 1 : 0;
    })();
    return dropped;
  }

  private deleteRecord(recordId: string): boolean {
    const row = this.db
      .prepare(`SELECT id, task_id, result_json, request_json FROM operation_records WHERE id = ?`)
      .get(recordId) as { id: string; task_id: string | null; result_json: string | null; request_json: string | null } | undefined;
    if (row === undefined) return false;
    // The bytes a record referenced are let go while there is still something to read them off —
    // the same order `prune` keeps, for the same reference count.
    for (const text of [row.result_json, row.request_json]) {
      if (text !== null) release(this.db, JSON.parse(text) as JsonValue);
    }
    this.db.prepare(`DELETE FROM operation_records WHERE id = ?`).run(row.id);
    this.logTombstone({ record_id: row.id, task_id: row.task_id });
    return true;
  }

  /** Every row at or after a seat on one conversation, by effective position — deleted, ids returned. */
  private deleteRowsFrom(id: string, seq: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM operation_records
          WHERE COALESCE(landed_session_id, session_id) = ? AND COALESCE(landed_seq, session_seq) >= ?`,
      )
      .all(id, seq) as Array<{ id: string }>;
    const removed: string[] = [];
    for (const row of rows) if (this.deleteRecord(row.id)) removed.push(row.id);
    return removed;
  }

  /** Every branch that left `parent` at or after `cursor`, whole — rows, names, lineage row, recursively. */
  private dropBranchesFrom(parent: string, cursor: number, removed: string[]): void {
    const children = this.db
      .prepare(`SELECT id FROM sessions WHERE parent = ? AND cursor >= ?`)
      .all(parent, cursor) as Array<{ id: string }>;
    for (const child of children) {
      this.dropBranchesFrom(child.id, 0, removed);
      removed.push(...this.deleteRowsFrom(child.id, 0));
      this.db.prepare(`DELETE FROM session_names WHERE session_id = ?`).run(child.id);
      this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(child.id);
      this.logTombstone({ session_id: child.id });
    }
  }

  /** Where a rewound conversation's remote is to be cut, when it is one — see {@link cutSession}. */
  private cutOf(id: string): string | undefined {
    const row = this.db.prepare(`SELECT cut_at FROM sessions WHERE id = ?`).get(id) as { cut_at: string | null } | undefined;
    return row?.cut_at ?? undefined;
  }

  private providerOf(id: string): string | undefined {
    const row = this.db.prepare(`SELECT provider FROM sessions WHERE id = ?`).get(id) as { provider: string | null } | undefined;
    return row?.provider ?? undefined;
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
  /**
   * Where a record sits NOW — see {@link RecordStore.positionOf}.
   *
   * Not where it was claimed: {@link SqliteSessionStore.correctLineage} moves a record whose call
   * turned out to have run somewhere else, and the layer that claimed the position is the one thing
   * that has to be told, because what it reports as the call's ending position is what everything
   * downstream continues from.
   */
  positionOf(ref: RecordRef): { id: string; seq: number } | undefined {
    // LANDED when present, ASKED otherwise — the reader's rule everywhere now. The ask is immutable
    // (it sits in the request); the landed columns carry the one thing the outcome can change.
    const row = this.db
      .prepare(
        `SELECT COALESCE(landed_session_id, session_id) AS session_id,
                COALESCE(landed_seq, session_seq) AS seq
           FROM operation_records WHERE id = ? AND task_id IS ?`,
      )
      .get(ref.id, this.scope.taskId ?? null) as
      | { session_id: string | null; seq: number | null }
      | undefined;
    if (row === undefined || row.session_id === null || row.seq === null) return undefined;
    return { id: row.session_id, seq: row.seq };
  }

  /**
   * Move a record onto a branch when the call reports a remote it was not given.
   *
   * `resolve` hands over the handle the conversation currently sits on and ASSUMES the call will
   * append to it. Whether that handle is usable is not a fact this store has — a different provider,
   * a remote that compacted itself server-side, an adapter that branched on its own — so it assumes
   * the ordinary case rather than guarding against ones it cannot see. What comes back settles it: a
   * different handle means this call did not run in the conversation its record was claimed in.
   *
   * The correction is a BRANCH at that position. The trunk keeps meaning what every existing ref into
   * it meant, and the record travels to a lineage whose handle is the remote actually used — so the
   * next `handleAt` on either one answers truthfully instead of offering a handle that has moved on.
   *
   * Called from `update` as well as `finish`: the handle rides nearly every envelope, so a call that
   * dies mid-stream is already on the right branch rather than sitting in a trunk it never joined.
   * Idempotent by construction — once moved, the record's own position is the branch's, and the
   * expected handle there is the one it reported.
   */
  private correctLineage(ref: RecordRef, reported: string | undefined): void {
    if (reported === undefined) return; // nothing said; nothing to check against
    const pos = this.db
      .prepare(
        `SELECT COALESCE(landed_session_id, session_id) AS session_id, COALESCE(landed_seq, session_seq) AS seq
           FROM operation_records WHERE id = ? AND task_id IS ?`,
      )
      .get(ref.id, this.scope.taskId ?? null) as
      | { session_id: string | null; seq: number | null }
      | undefined;
    if (pos === undefined || pos.session_id === null || pos.seq === null) return; // unplaced: no lineage to be wrong about
    const trunk = pos.session_id;
    const expected = this.handleAt(trunk, pos.seq);
    if (expected === undefined || expected === reported) return;
    // A CUT conversation asked for a copy (see `resolve`), and a copy's new handle is the answer it
    // asked for — not a divergence. The stamp at settle clears the cut and takes the handle.
    if (this.cutOf(trunk) !== undefined) return;

    // SAID, as well as done. The landed columns and the branch land in the journal below, which is
    // the durable account — but a provider that quietly moves a conversation out from under a run
    // reads as ordinary operation unless something says otherwise, and by the time anyone looks at
    // the lineage they are already debugging.
    log.warn(
      `session '${trunk}' diverged at ${pos.seq}: resumed provider session ${expected}, but the call ran in ${reported} — ` +
        `the record points at a branch, so the trunk keeps meaning what every ref into it meant`,
    );
    // DIVERGENCE AS A FACT, not surgery (Identity and Resume §03): the ask stays immutable in the
    // request, the store mints the branch in the sessions tree, and the record POINTS at where the
    // call demonstrably ran — written once. Because a landed row releases its asked seat (the claim
    // index reads `landed_session_id IS NULL`), the trunk's next append claims the position the
    // diverged turn never really occupied, and the trunk's remote stream matches its transcript.
    const branch = this.branchFrom(trunk, pos.seq, "diverged");
    this.db
      .prepare(`UPDATE operation_records SET landed_session_id = ?, landed_seq = ? WHERE id = ?`)
      .run(branch, pos.seq, ref.id);
    this.logSession(branch);
    this.logRecordRow(ref.id);
  }

  /**
   * The record holding a POSITION, as the ref that names it.
   *
   * For a caller that watches a conversation rather than making the call — the live view, which knows
   * where a turn is happening but never saw the `append` that claimed it. Resolved once per position
   * and held: a record's ref outlives its lineage, so a flush addressed this way keeps landing even if
   * the record moves to a branch mid-stream.
   */
  recordAt(at: { id: string; seq: number }): RecordRef | undefined {
    // The LIVE claimant first — a released seat can hold dead history under a reclaimed one, and a
    // flush addressed by position must land in the record that is actually speaking there.
    const row = this.db
      .prepare(
        `SELECT id FROM operation_records
          WHERE COALESCE(landed_session_id, session_id) = ? AND COALESCE(landed_seq, session_seq) = ?
          ORDER BY (status IN ('open', 'completed')) DESC, rowid DESC LIMIT 1`,
      )
      .get(at.id, at.seq) as { id: string } | undefined;
    return row === undefined ? undefined : { id: row.id };
  }

  update(ref: RecordRef, partial: RecordPartial): void {
    const { value, providerSessionId } = partial as { value: JsonValue; providerSessionId?: string };
    // As early as the handle is known — see {@link SqliteSessionStore.correctLineage}.
    this.correctLineage(ref, providerSessionId);
    // The row is found first rather than in a subselect, because the write needs the REQUEST on it:
    // a flush replaces `result_json` wholesale, and the question `insertRecord` put there would go
    // with it — leaving the record correct until the moment the model said something, which is the
    // worst of the three possible times to be wrong.
    const row = this.db
      .prepare(
        `SELECT id, request_json FROM operation_records
          WHERE id = ? AND task_id IS ? AND status = 'open'`,
      )
      .get(ref.id, this.scope.taskId ?? null) as
      | { id: string; request_json: string | null }
      | undefined;
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
    // The session's own handle moves as early as the stream carries one, for the same reason the
    // record's does: a crashed call's conversation must still know its remote. Provider unknown
    // mid-stream; the settle's report fills it.
    this.stampSessionHandle(ref, providerSessionId, undefined);
    // A partial is a real state of the record, so it is appended like any other. A run that streams
    // ten flushes writes ten lines and replays as the tenth: the file grows, and it never has to be
    // rewritten in place — which is the trade the append-only format is making.
    this.logRecordRow(row.id);
  }

  bySession(session: string, upTo?: number): StoredRecord[] {
    return this.rowsOf(this.existingSessionOf(session) ?? session, upTo).map((row) => ({
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
    const [name, seq] = split(ref);
    const id = this.existingSessionOf(name) ?? name;
    const out: Row[] = [];
    for (const [branch, bound] of this.chain(id, seq ?? this.readHead(id))) {
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
    const [name, seq] = split(ref);
    const id = this.existingSessionOf(name) ?? name;
    const chain = this.chain(id, seq ?? this.readHead(id));
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
    const branch = this.branchOf(this.existingSessionOf(id) ?? id);
    return branch?.parent === undefined ? undefined : { parent: branch.parent, at: branch.cursor };
  }

  /** Every branch that left one conversation at one position — see {@link forks}. */
  private branchesFrom(parent: string, cursor: number): string[] {
    return (
      this.db.prepare(`SELECT id FROM sessions WHERE parent = ? AND cursor = ? ORDER BY created_at`).all(parent, cursor) as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  /** One record, by the position it claimed. What a state's `sessionRef` resolves to. */
  at(sessionId: string, seq: number): Row | undefined {
    return this.rowsOf(this.existingSessionOf(sessionId) ?? sessionId).find((row) => row.seq === seq);
  }

  /**
   * A record by its id — how the positionless `db://` form resolves (CHANGESETS.md §10.6, settled):
   * settled `operation.*` events carry this id, and every record is keyed by it, so a journal row
   * leads here whether or not the call ever sat in a conversation. Returns the request too: §5.3
   * puts a gate's changeset in `request_json`, and addressing the record without it would hide the
   * half that design points at.
   */
  record(recordId: string): RecordedCall | undefined {
    const row = this.db
      .prepare(
        `SELECT id AS record_id, status, request_json, result_json, error_json, started_at, ended_at
           FROM operation_records
          WHERE id = ? AND task_id IS ?`,
      )
      .get(recordId, this.scope.taskId ?? null) as CallRow | undefined;
    return row === undefined ? undefined : recordedCallOf(this.db, row);
  }

  /**
   * Every call this run made, oldest first — what a derivation reads and what a gate's own request
   * is recovered from.
   *
   * Scoped by the store's own `taskId`, which is the index `operation_records_scope`
   * already covers, so this is a range scan rather than a table walk.
   *
   * One row per record, by construction now: the id is a primary key, and a retried call reopens
   * its own row instead of writing a second one.
   */
  records(): RecordedCall[] {
    const rows = this.db
      .prepare(
        `SELECT id AS record_id, status, request_json, result_json, error_json, started_at, ended_at
           FROM operation_records
          WHERE task_id IS ?
          ORDER BY started_at, rowid`,
      )
      .all(this.scope.taskId ?? null) as CallRow[];
    return rows.map((row) => recordedCallOf(this.db, row));
  }

  /**
   * Records a crashed run left behind that could still be recovered from the agent's own files.
   *
   * The pair a recovery needs and nothing else: the provider handle (streamed onto the row while
   * the call ran — see {@link SqliteSessionStore.update} — which is the whole reason a call
   * that never reached a close has one) and the start time, which is the cut that keeps a resumed
   * session's earlier lines out.
   *
   * Narrowed to rows that have a handle and no capture yet, so a second open after a successful
   * recovery finds nothing and re-reads no files. `capturedAt` is what says so: the fold leaves no
   * field of its own any more — the captured lines ARE the entries now — so the record states when
   * it happened rather than being recognized by a leftover.
   */
  recoverable(taskId: string): Array<{ id: string; providerSessionId: string; startedAt: number }> {
    // `interrupted` is what the sweep writes.
    return this.db
      .prepare(
        `SELECT id, provider_session_id, started_at FROM operation_records
          WHERE task_id = ? AND status = 'interrupted' AND provider_session_id IS NOT NULL
            AND (result_json IS NULL OR result_json NOT LIKE '%"capturedAt"%')`,
      )
      .all(taskId)
      .map((row) => {
        const r = row as { id: string; provider_session_id: string; started_at: number };
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
  foldNativeCapture(recordRowId: string, fold: (value: Record<string, JsonValue>) => Record<string, JsonValue>): void {
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
   * Stamp the row. The request is pinned here — nothing recomputes it (§5.3).
   *
   * The row is BORN holding the message the call was made with, so a record is the delta it will
   * finally be from its first instant and only ever grows: the question, then the turns as they
   * stream, then the provider's authoritative version of both. That is what lets every reader treat
   * a record the same way whatever state it is in — and the alternative was found the hard way, since
   * a process killed between `open` and the first flush leaves a row that no later write ever reaches.
   *
   * The id is the hash of the SCOPED request, so an insert that conflicts is not a second call — it
   * is THIS call being re-dispatched. A row that never honestly settled (open when the process died,
   * or cut and marked `interrupted`) is REOPENED in place, keeping its streamed partial: the re-run
   * continues into its own record rather than inserting a second ask the remote would see twice
   * (Identity and Resume §08). A row that COMPLETED is refused outright — an identity that settled
   * cannot be asked again, and hitting this is a caller bug, not a race.
   *
   * Returns whether the row was reopened, because `append` needs to know: a reopened record already
   * holds its seat, and re-claiming it would refuse the record its own chair.
   */
  private insertRecord(stub: RecordStub): boolean {
    // The WHOLE ask: the operation, the site it was dispatched from, and the seat it claims — with
    // the handle it was handed to resume. Spliced as sibling keys of the op's own fields (no op has
    // a `scope` or `session` key of its own), so every reader of `request.user` keeps working and
    // the generated columns read `$.scope.*` / `$.session.*` straight off the row. The session id
    // is stored SCOPED, as the position table's rows were — it is the store's key, not the
    // engine's spelling.
    const at = stub.session;
    const ask: Record<string, unknown> = { ...((stub.source ?? {}) as object) };
    if (stub.scope !== undefined) ask["scope"] = stub.scope;
    if (at !== undefined) {
      ask["session"] = {
        id: at.id,
        seq: at.seq,
        ...(at.providerSessionId !== undefined ? { providerSessionId: at.providerSessionId } : {}),
      };
    }
    const request = stub.source === undefined && stub.scope === undefined && at === undefined ? null : JSON.stringify(ask);
    const opening = openingMessage(request, []);
    // Through `withOpening`, so the splice is spelled out in ONE place and a record is born in the
    // same shape it will settle in — one conversation array, whatever writes it next.
    const born = opening.length === 0 ? null : JSON.stringify(withOpening({} as JsonValue, request));
    try {
      this.db
        .prepare(
          `INSERT INTO operation_records (id, task_id, status, request_json, result_json, started_at)
           VALUES (?, ?, 'open', ?, ?, ?)`,
        )
        .run(stub.id, this.scope.taskId ?? null, request, born, stub.startMs ?? Date.now());
      return false;
    } catch (e) {
      const message = String((e as Error).message);
      if (!message.includes("UNIQUE") || isSeatConflict(e)) throw e;
      const existing = this.db
        .prepare(`SELECT status FROM operation_records WHERE id = ?`)
        .get(stub.id) as { status: string } | undefined;
      if (existing === undefined || existing.status === "completed") {
        throw new Error(
          `record '${stub.id}' has already settled — an identical scoped request cannot be dispatched twice`,
        );
      }
      // Reopened, not re-inserted: the partial stays (it may be the only witness to turns already in
      // the remote stream), the error is cleared, and the original started_at keeps naming when this
      // ask was first made. The REQUEST is re-stated as this re-dispatch asked it — the identity
      // cannot have changed (the id hashes the op and the scope, and it matched), but the SEAT can:
      // a forked re-dispatch names a new one, and the claim index reads the seat off `request_json`,
      // so keeping the dead ask would re-enter the OLD seat forever and spend the fork's one retry
      // on the very conflict it was escaping. The UPDATE re-enters the claim index — a seat another
      // live record took while this one was dead refuses here, and `append` reads that refusal as
      // the fork signal, which is §08's degradation: the re-dispatch forks instead of needing a
      // path of its own.
      this.db
        .prepare(`UPDATE operation_records SET status = 'open', ended_at = NULL, error_json = NULL, request_json = ? WHERE id = ?`)
        .run(request, stub.id);
      return true;
    }
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

  /** The conversation's current remote identity, off its own row — NULL for a fork until it earns
   *  one. The PAIR, because a bare handle is meaningless (Identity and Resume §03): the same string
   *  on two providers names two different conversations, and the consumer refuses a foreign one.
   *  Half a pair is therefore no identity at all, and reads as none. */
  private sessionHandle(id: string): { handle: string; provider: string } | undefined {
    const row = this.db.prepare(`SELECT provider_session_id, provider FROM sessions WHERE id = ?`).get(id) as
      | { provider_session_id: string | null; provider: string | null }
      | undefined;
    if (row?.provider_session_id == null || row.provider === null) return undefined;
    return { handle: row.provider_session_id, provider: row.provider };
  }

  /**
   * The handle THIS conversation sits on — its own records only, never its parent's.
   *
   * It used to walk the lineage the way materializing does, and that is right for MESSAGES and wrong
   * for a handle: a branch inherits its parent's turns by reference, but not its remote. A branch that
   * has written nothing has no provider session at all, and the parent's is the point it forked FROM,
   * not somewhere to append.
   */
  private handleAt(id: string, upTo: number): string | undefined {
    for (const row of [...this.rowsOf(id)].reverse()) {
      if (row.seq < upTo && row.externalId !== undefined) return row.externalId;
    }
    return undefined;
  }

  /**
   * The remote a branch could COPY — the nearest handle above it, and only when copying would
   * reproduce this branch's prefix exactly.
   *
   * The provider primitive is "resume this session and fork it", which copies the remote AS IT NOW
   * STANDS; there is no fork-at-a-position anywhere. So a branch whose cursor is behind its parent's
   * head has no fork source at all: copying would hand it turns it never had — in the automatic-fork
   * case, the very turn that took its position. Withheld here rather than checked downstream, because
   * the tip is the store's fact and an executor holding a handle has no way to know it is stale.
   */
  private ancestorHandle(id: string): ForkSource | undefined {
    let branch = this.branchOf(id);
    let at = branch?.parent;
    let bound = branch?.cursor ?? 0;
    while (at !== undefined) {
      const found = this.handleAt(at, bound);
      const provider = this.sessionHandle(at)?.provider;
      // Both halves, for the same reason a resume needs both: an adapter may only copy a session it
      // owns, so a source it cannot attribute is one it must not be offered.
      if (found !== undefined && provider !== undefined) {
        // AT THE TIP, a plain copy reproduces this branch. Behind it, the copy has to be cut — and
        // naming the cut is the store's job, since only it knows which message the branch ends at.
        // A conversation whose entries carry no provider ids cannot be cut, so it offers no source
        // and the caller replays: correct, and the only honest answer.
        if (bound === this.readHead(at)) {
          // …unless the ancestor was itself rewound: its rows end where its remote does not, and a
          // plain copy would hand this branch the very turns the rewind deleted.
          const rewound = this.cutOf(at);
          return { handle: found, provider, ...(rewound !== undefined ? { at: rewound } : {}) };
        }
        const cut = this.messageIdAt(at, bound);
        return cut === undefined ? undefined : { handle: found, provider, at: cut };
      }
      branch = this.branchOf(at);
      if (branch?.parent === undefined) return undefined;
      bound = branch.cursor;
      at = branch.parent;
    }
    return undefined;
  }

  /**
   * The provider's own id for the last message before a position — where a copy would be cut.
   *
   * Read off the ENTRIES a record already holds: the native session capture stamps each one with the
   * agent's `uuid`, so the mapping from "position N" to "the message a fork stops at" needs nothing
   * recorded for it. A conversation whose entries carry none — a plain provider call, an older record
   * — answers `undefined`, and the branch replays instead.
   */
  private messageIdAt(id: string, upTo: number): string | undefined {
    for (const row of [...this.rowsOf(id, upTo)].reverse()) {
      const entries = (row.value as { value?: { entries?: Array<{ uuid?: unknown }> } } | undefined)?.value?.entries;
      if (!Array.isArray(entries)) continue;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const uuid = entries[i]?.uuid;
        if (typeof uuid === "string") return uuid;
      }
    }
    return undefined;
  }

  /**
   * The next position an append would occupy. A branch's own records begin at its cursor.
   *
   * Over LIVE seats only — the claim index's own predicate. A released seat (failed, interrupted,
   * or landed elsewhere) above the last live one is claimable again, which is what lets a retry
   * re-take the position its dead attempt let go of instead of stacking on top of it.
   */
  private head(id: string): number {
    const max = this.db
      .prepare(
        `SELECT MAX(${EFFECTIVE_SEQ}) AS m FROM operation_records
          WHERE ${EFFECTIVE_SESSION} = ? AND status IN ('open', 'completed')`,
      )
      .get(id) as { m: number | null } | undefined;
    return max?.m === null || max?.m === undefined ? this.cursorOf(id) : max.m + 1;
  }

  /**
   * Where READING ends — past the last row of any status, where {@link head} is where APPENDING
   * begins, past the last LIVE one. The two part company exactly at a dead tail: a failed or
   * interrupted call released its seat (an append may take it again), but its turns are history a
   * transcript shows and — because they may exist in the remote stream — history a provider replay
   * must carry too.
   */
  private readHead(id: string): number {
    const max = this.db
      .prepare(`SELECT MAX(${EFFECTIVE_SEQ}) AS m FROM operation_records WHERE ${EFFECTIVE_SESSION} = ?`)
      .get(id) as { m: number | null } | undefined;
    return max?.m === null || max?.m === undefined ? this.cursorOf(id) : max.m + 1;
  }

  private branchFrom(id: string, cursor: number, seed?: string): string {
    const forked = this.mint(seed !== undefined ? `${seed}@${id}:${cursor}` : undefined);
    // `seq` CONTINUES from the cursor, so a position is one integer across a whole lineage.
    this.branch(forked, { parent: id, cursor });
    return forked;
  }

  private derive(ref: string, word: string, messages: readonly JsonValue[]): string {
    const [name] = split(ref);
    const id = this.existingSessionOf(name) ?? name;
    // A distinct conversation, so the origin keeps meaning exactly what every ref into it meant.
    const derived = `${id}~${word}${++this.minted}`;
    this.branch(derived, { cursor: 0 });
    const recordId = `${derived}:0`;
    this.db
      .transaction(() => {
        // OR REPLACE, because `minted` restarts with the store: a second process deriving from the
        // same origin can mint the same name, and the later derivation was always the one the
        // position pointed at — the replace states that instead of leaving an unreachable twin.
        this.db
          .prepare(
            `INSERT OR REPLACE INTO operation_records (id, task_id, status, request_json, result_json, started_at, ended_at)
             VALUES (?, ?, 'completed', ?, ?, ?, ?)`,
          )
          .run(
            recordId,
            this.scope.taskId ?? null,
            // WHAT PRODUCED THIS SEED. Every other record carries the operation it ran; this was the
            // one row in the store with a null request, so a conversation that opened with a summary
            // or a re-read said nothing about where it came from — and a reader looking at a lineage
            // that changed shape had only the shape to go on.
            //
            // Not an operation: no model call is being described, so it does not pretend to be one.
            // `openingMessage` reads `user` off a request and finds none here, which is why this adds
            // provenance without adding a phantom turn.
            // …and its SEAT, inline like every other record's: seat 0 of the conversation it opens.
            JSON.stringify({ kind: "derive", word, from: ref, session: { id: derived, seq: 0 } }),
            // A compaction or a resync is a record like any other, so it holds its turns the one way
            // a record holds turns: as entries. The caller hands over messages because that is what a
            // summary IS at the point it is written; the shape it is stored in is not the caller's.
            JSON.stringify({
              value: { entries: entriesOfMessages(messages as never, { provider: "unknown", at: new Date(0).toISOString() }) },
            }),
            Date.now(),
            Date.now(),
          );
      })
      .immediate();
    this.logSession(derived);
    this.logRecordRow(recordId);
    return join(derived, 1);
  }

  /**
   * The session a REF-part names — the alias resolution every `resolve` goes through.
   *
   * Three answers, in order of authority. A string that already IS a session id (a ref carried
   * through data flow, a position read back off a record) resolves to itself. A name with an alias
   * — task-scoped, run-free — resolves to the session it was first given, which is what makes a
   * resumed run's `planning` the same conversation across runs. A name with neither is NEW: a
   * session is minted (UUIDv7 — assigned, opaque, never parsed) and the name becomes its alias.
   */
  private sessionIdOf(ref: string): string {
    const existing = this.existingSessionOf(ref);
    if (existing !== undefined) return existing;
    const id = uuidv7(Date.now());
    this.db
      .transaction(() => {
        this.db.prepare(`INSERT INTO sessions (id, parent, cursor, created_at) VALUES (?, NULL, 0, ?)`).run(id, Date.now());
        this.db
          .prepare(`INSERT INTO session_names (task_id, name, session_id) VALUES (?, ?, ?)`)
          .run(this.scope.taskId ?? "", ref, id);
      })
      .immediate();
    this.logSession(id);
    this.log?.append({ kind: "name", row: { task_id: this.scope.taskId ?? "", name: ref, session_id: id } });
    return id;
  }

  /**
   * The session a ref-part names, when one exists — {@link sessionIdOf} without the mint, which is
   * what every READ wants: a transcript asked for by an authored name must find the conversation
   * the alias points at, and an unknown name reads as the empty conversation it is rather than
   * minting one as a side effect of looking.
   */
  private existingSessionOf(ref: string): string | undefined {
    if (this.hasSession(ref)) return ref;
    const alias = this.db
      .prepare(`SELECT session_id FROM session_names WHERE task_id = ? AND name = ?`)
      .get(this.scope.taskId ?? "", ref) as { session_id: string } | undefined;
    return alias?.session_id;
  }

  private hasSession(id: string): boolean {
    return this.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(id) !== undefined;
  }

  private mint(seed: string | undefined): string {
    // SEEDED mints stay deterministic — a fork's seed embeds its parent's id, which is unique now,
    // so determinism costs no collisions and keeps "two forks sharing a seed share an id", the
    // property retries lean on. An UNSEEDED mint is assigned: the old counter restarted with the
    // store, which two processes could race.
    return seed !== undefined ? `s_${seed}` : uuidv7(Date.now());
  }

  private branch(id: string, branch: Branch): void {
    const info = this.db
      .prepare(`INSERT OR IGNORE INTO sessions (id, parent, cursor, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, branch.parent === undefined ? null : branch.parent, branch.cursor, Date.now());
    // Only when it actually inserted. `OR IGNORE` means most calls are no-ops — `resolve` re-asserts
    // a branch on every turn — and appending each of those would write a line per model call for a
    // row that has not changed since the conversation began.
    if (info.changes > 0) this.logSession(id);
  }

  private branchOf(id: string): Branch | undefined {
    const row = this.db.prepare(`SELECT parent, cursor FROM sessions WHERE id = ?`).get(id) as
      | { parent: string | null; cursor: number }
      | undefined;
    if (row === undefined) return undefined;
    return { ...(row.parent !== null ? { parent: row.parent } : {}), cursor: row.cursor };
  }

  private cursorOf(id: string): number {
    return this.branchOf(id)?.cursor ?? 0;
  }

  private rowsOf(session: string, upTo?: number): Row[] {
    // By EFFECTIVE position — landed when present, asked otherwise — so a branch's transcript
    // contains the very turn that caused it, and a trunk no longer shows a turn that ran elsewhere.
    // A released seat can hold dead history under a live reclaim, so rows are grouped per seat with
    // the LIVE claimant preferred and the newest dead attempt standing in where nothing is live —
    // which is what keeps a stopped task's interrupted turn on screen.
    const rows = this.db
      .prepare(
        `SELECT COALESCE(landed_seq, session_seq) AS seq, id AS record_id, status, result_json,
                provider_session_id, request_json
           FROM operation_records
          WHERE COALESCE(landed_session_id, session_id) = ? ${upTo === undefined ? "" : "AND COALESCE(landed_seq, session_seq) < ?"}
          ORDER BY COALESCE(landed_seq, session_seq), rowid`,
      )
      .all(...(upTo === undefined ? [session] : [session, upTo])) as Array<{
      seq: number;
      record_id: string;
      status: "open" | "completed" | "failed" | "interrupted";
      result_json: string | null;
      provider_session_id: string | null;
      request_json: string | null;
    }>;
    const seat = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      const holder = seat.get(row.seq);
      const live = row.status === "open" || row.status === "completed";
      const holderLive = holder !== undefined && (holder.status === "open" || holder.status === "completed");
      if (holder === undefined || live || !holderLive) seat.set(row.seq, row);
    }
    return [...seat.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        const value = projectValue(
          row.result_json === null ? undefined : (hydrate(this.db, JSON.parse(row.result_json) as JsonValue) as JsonValue),
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
function projectValue(result: JsonValue | undefined): JsonValue | undefined {
  const payload = result as { value?: { entries?: unknown }; messages?: JsonValue[] } | undefined;
  if (payload?.value?.entries !== undefined) return result;
  // The reported turns ride as a sibling of the value since migration 14 folded the outcome column
  // away — the value is the op's OUTPUT and stays untouched; this is the conversation half.
  const reported = payload?.messages;
  // Turned into entries HERE rather than stored as a second conversation shape: an executor whose
  // payload is not a conversation still reports one, and `entries` is the only encoding this store
  // hands out. `provider: "unknown"` because the report does not say, and the timestamp is the
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
 * (`insertRecord`), every flush into it (`update`), and its settle (`preservePartial`) — so a
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
