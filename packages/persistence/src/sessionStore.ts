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
  recordId: string;
  value?: JsonValue;
  externalId?: string;
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
        `SELECT id FROM operation_records
          WHERE record_id = ? AND task_id IS ? AND run_id IS ?
          ORDER BY (status = 'open') DESC, id DESC LIMIT 1`,
      )
      .get(id, this.scope.taskId ?? null, this.scope.runId ?? null) as { id: number } | undefined;
    if (row === undefined) return;
    // Stored VERBATIM — the result as it settled, the session outcome as reported. What a record
    // MEANS as a conversation turn is the read side's question now (projectValue), which is what
    // "the payload-wins projection moves to the read side" (§5.1) says.
    const error = (settled.result as { error?: unknown } | undefined)?.error;
    this.db
      .prepare(
        `UPDATE operation_records
            SET result_json = ?, error_json = ?, metrics_json = ?, session_outcome_json = ?,
                provider_session_id = COALESCE(?, provider_session_id),
                status = ?, ended_at = ?
          WHERE id = ?`,
      )
      .run(
        settled.result === undefined ? null : JSON.stringify(settled.result),
        error === undefined ? null : JSON.stringify(error),
        settled.metrics === undefined ? null : JSON.stringify(settled.metrics),
        settled.sessionOutcome === undefined ? null : JSON.stringify(settled.sessionOutcome),
        settled.sessionOutcome?.providerSessionId ?? null,
        error === undefined ? "completed" : "failed",
        Date.now(),
        row.id,
      );
  }

  bySession(session: string, upTo?: number): StoredRecord[] {
    return this.rowsOf(session, upTo).map((row) => ({
      id: row.recordId,
      source: undefined as never,
      startMs: 0,
      ...(row.value !== undefined ? { result: row.value as never } : {}),
    }));
  }

  // --- Reads the app adds ------------------------------------------------------

  /** One conversation's records, oldest first — lineage included, exactly as `messages` walks it. */
  transcript(ref: string): Array<{ seq: number; recordId: string; value?: JsonValue; externalId?: string }> {
    const [id, seq] = split(ref);
    const out: Array<{ seq: number; recordId: string; value?: JsonValue; externalId?: string }> = [];
    for (const [branch, bound] of this.chain(id, seq ?? this.head(id))) {
      const start = this.cursorOf(branch);
      for (const row of this.rowsOf(branch)) {
        if (row.seq >= start && row.seq < bound) out.push(row);
      }
    }
    return out;
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

  // --- Internals ---------------------------------------------------------------

  /** Stamp the per-attempt row. The request is pinned here — nothing recomputes it (§5.3). */
  private insertRecord(stub: RecordStub): number | bigint {
    const attempt = this.db
      .prepare(`SELECT COUNT(*) AS n FROM operation_records WHERE record_id = ? AND task_id IS ? AND run_id IS ?`)
      .get(stub.id, this.scope.taskId ?? null, this.scope.runId ?? null) as { n: number };
    const info = this.db
      .prepare(
        `INSERT INTO operation_records (record_id, task_id, run_id, attempt, status, request_json, started_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        stub.id,
        this.scope.taskId ?? null,
        this.scope.runId ?? null,
        attempt.n + 1,
        stub.source === undefined ? null : JSON.stringify(stub.source),
        stub.startMs ?? Date.now(),
      );
    return info.lastInsertRowid;
  }

  /** Walk the lineage, taking each ancestor's records below the cursor its child took. */
  private materialize(id: string, upTo: number): JsonValue[] {
    const out: JsonValue[] = [];
    for (const row of this.transcript(join(id, upTo))) out.push(...messagesOfRecord(row.value));
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
        `SELECT p.seq AS seq, r.record_id AS record_id, r.result_json AS result_json,
                r.session_outcome_json AS session_outcome_json, r.provider_session_id AS provider_session_id
           FROM session_positions p JOIN operation_records r ON r.id = p.operation_record_id
          WHERE p.session_id = ? ${upTo === undefined ? "" : "AND p.seq < ?"} ORDER BY p.seq`,
      )
      .all(...(upTo === undefined ? [this.k(session)] : [this.k(session), upTo])) as Array<{
      seq: number;
      record_id: string;
      result_json: string | null;
      session_outcome_json: string | null;
      provider_session_id: string | null;
    }>;
    return rows.map((row) => {
      const value = projectValue(
        row.result_json === null ? undefined : (JSON.parse(row.result_json) as JsonValue),
        row.session_outcome_json === null ? undefined : (JSON.parse(row.session_outcome_json) as JsonValue),
      );
      return {
        seq: row.seq,
        recordId: row.record_id,
        ...(value !== undefined ? { value } : {}),
        ...(row.provider_session_id !== null ? { externalId: row.provider_session_id } : {}),
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
