/**
 * Schema changes that `CREATE TABLE IF NOT EXISTS` cannot make.
 *
 * `db.ts` applies one `SCHEMA` constant on every open, which handles a NEW table perfectly and a new
 * COLUMN not at all: `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so
 * an added column reaches a fresh database and silently skips every existing one. That is a constraint
 * nobody can hold in their head — "we may only ever add tables" gets violated by accident, and the
 * symptom is a query that works on a new machine and fails on the one that has been running longest.
 *
 * So: `PRAGMA user_version` as the marker, an ordered list, each step applied once, in a transaction.
 *
 * Rules for adding one:
 *
 *  - **Append, never edit.** A shipped migration has already run somewhere; changing it changes only
 *    what a fresh database gets, and the two then disagree forever.
 *  - **Make it idempotent where SQLite lets you** (`IF NOT EXISTS`), so a half-applied step is
 *    recoverable by re-running rather than by hand.
 *  - **`ALTER TABLE ADD COLUMN` may only add a VIRTUAL generated column**, never a `STORED` one —
 *    SQLite rejects the latter outright, because it would have to rewrite every existing row.
 */
import type { JairaDb } from "./db";

export interface Migration {
  /** The `user_version` this step brings the database TO. Sequential from 1. */
  version: number;
  /** What it is for, in the past tense — read by whoever is wondering why their schema moved. */
  note: string;
  sql?: string;
  /**
   * A step SQL cannot express, run after `sql` inside the same transaction.
   *
   * For DATA migrations over stored JSON. SQLite's JSON1 can read a blob but has no prepend, and the
   * contortion that fakes one (`json_group_array` over a `UNION ALL`, ordered by a synthetic column)
   * is both unreadable and reliant on an ordering SQLite does not promise. A function is the honest
   * tool, and it can share the exact predicate the write path uses instead of restating it in SQL.
   */
  run?: (db: JairaDb) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    note: "expose a run's conversation position, so a state can be joined to the transcript it produced",
    // The position rides on the engine's own metrics: `withSessionPosition` reports the position a
    // call ENDED at as `<id>@<seq+1>`, and hw puts those metrics on `operation.completed`. So the
    // journal already carries the join — it was simply not queryable without reading every payload.
    //
    // GENERATED rather than copied: the value is derived from the payload on every read, so it cannot
    // drift from the event it came from. VIRTUAL because `ALTER TABLE` permits nothing else, and
    // because the cost of computing it is a JSON extract on rows a query has already narrowed.
    sql: `
      ALTER TABLE events ADD COLUMN session_ref TEXT
        GENERATED ALWAYS AS (json_extract(payload_json, '$.metrics.sessionRef')) VIRTUAL;
      CREATE INDEX IF NOT EXISTS events_session ON events(session_ref);
    `,
  },
  {
    version: 2,
    note: "keep conversations, which every run has always computed and thrown away",
    // A session is its RECORDS, ordered by `seq` — upstream's model, and why a record holds the whole
    // `LlmOutput` verbatim rather than being shredded into a message table. `sessions` is lineage
    // only: a branch stores what it appended and points at where it left its parent, so a fork of a
    // long conversation costs one row.
    //
    // The primary key on `(session_id, seq)` is not bookkeeping — it IS how a position is claimed, so
    // a second claim is a constraint violation rather than a check with a race in it.
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        parent     TEXT REFERENCES sessions(id),
        cursor     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_records (
        session_id   TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        record_id    TEXT NOT NULL,
        task_id      TEXT,
        run_id       INTEGER,
        result_json  TEXT,
        metrics_json TEXT,
        external_id  TEXT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      -- Scoped by SESSION, not global: a record id is <session>:<seq> and a session id is
      -- instance-scoped, so two runs of one workflow mint identical record ids. session_id already
      -- carries the run (see SessionScope), which makes the pair unique and the bare id not.
      CREATE UNIQUE INDEX IF NOT EXISTS operation_records_id ON operation_records(session_id, record_id);
      CREATE INDEX IF NOT EXISTS operation_records_run ON operation_records(task_id, run_id);
    `,
  },
  {
    version: 3,
    note: "keep what a child process printed, so a failed agent says why",
    // A CLI agent that fails prints the reason on stderr, and JaiRA sent that stream to /dev/null —
    // so "the agent exited 1" was the whole story. Stored in flushed chunks rather than per write:
    // a chatty child would otherwise put one synchronous INSERT per data event on the main thread.
    //
    // `dropped` is what was elided BEFORE a chunk. The sink keeps a head and a tail and discards the
    // middle, because the interesting parts of a failing process's output are its first error and its
    // last line, and the middle is repetition.
    sql: `
      CREATE TABLE IF NOT EXISTS job_output (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id     INTEGER NOT NULL,
        stream     TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        chunk      TEXT NOT NULL,
        dropped    INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_output_job ON job_output(job_id, stream, seq);
      ALTER TABLE jobs ADD COLUMN cwd TEXT;
    `,
  },
  {
    version: 4,
    note: "normalised the record schema (CHANGESETS.md §5.1): lifecycle truth and payload truth split into their own tables",
    // Two truths, two tables. The journal records THAT operations ran (`state_machine_events`, the
    // rename of `events`); a payload store records WHAT they returned (`operation_records`, the
    // DESIGN §4.2 table finally taking the name); and conversation membership is its own join
    // (`session_positions`), whose primary key IS the position claim — a duplicate insert is
    // `PositionTaken` → fork, exactly the constraint the old (session_id, seq) key enforced.
    //
    // The old `operation_records` was the conversation TURN store — one row per PLACED call — under
    // a name that DESIGN §4.2 had promised to the per-attempt record. This step resolves the
    // collision by normalising rather than renaming around it: every old turn row becomes an
    // operation record (its rowid carried over as the new primary key, so the two INSERTs below
    // agree without a join key) plus a position row pointing at it.
    //
    // `events` is renamed, not rebuilt: ALTER TABLE keeps the `session_ref` generated column from
    // migration 1. The indexes are re-created under the new name only so a schema dump reads
    // coherently. Note `db.ts` still BOOTSTRAPS a legacy `events` table on every open (migrations
    // 1–3 build on it); `openDb` drops the empty shell again after migrating.
    sql: `
      ALTER TABLE events RENAME TO state_machine_events;
      DROP INDEX IF EXISTS events_task;
      DROP INDEX IF EXISTS events_run;
      DROP INDEX IF EXISTS events_session;
      CREATE INDEX IF NOT EXISTS state_machine_events_task ON state_machine_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS state_machine_events_run ON state_machine_events(run_id, seq);
      CREATE INDEX IF NOT EXISTS state_machine_events_session ON state_machine_events(session_ref);

      ALTER TABLE operation_records RENAME TO conversation_turns_legacy;
      DROP INDEX IF EXISTS operation_records_id;
      DROP INDEX IF EXISTS operation_records_run;

      CREATE TABLE IF NOT EXISTS operation_records (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id            TEXT NOT NULL,
        task_id              TEXT,
        run_id               INTEGER,
        attempt              INTEGER NOT NULL DEFAULT 1,
        status               TEXT NOT NULL DEFAULT 'open',  -- open | completed | failed
        request_json         TEXT,
        result_json          TEXT,
        error_json           TEXT,
        metrics_json         TEXT,
        session_outcome_json TEXT,
        provider_session_id  TEXT,
        started_at           INTEGER NOT NULL,
        ended_at             INTEGER
      );
      CREATE INDEX IF NOT EXISTS operation_records_scope ON operation_records(task_id, run_id, record_id);
      CREATE INDEX IF NOT EXISTS operation_records_run ON operation_records(run_id, id);

      CREATE TABLE IF NOT EXISTS session_positions (
        session_id           TEXT NOT NULL,
        seq                  INTEGER NOT NULL,
        operation_record_id  INTEGER NOT NULL REFERENCES operation_records(id),
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS session_positions_record ON session_positions(operation_record_id);

      INSERT INTO operation_records
        (id, record_id, task_id, run_id, status, result_json, metrics_json, provider_session_id, started_at, ended_at)
        SELECT rowid, record_id, task_id, run_id,
               CASE WHEN ended_at IS NULL THEN 'open' ELSE 'completed' END,
               result_json, metrics_json, external_id, started_at, ended_at
          FROM conversation_turns_legacy;
      INSERT INTO session_positions (session_id, seq, operation_record_id)
        SELECT session_id, seq, rowid FROM conversation_turns_legacy;
      DROP TABLE conversation_turns_legacy;
    `,
  },
  {
    version: 5,
    note: "expose the operation id settled events carry, so a journal row joins its operation record (CHANGESETS.md §10.6)",
    // The same shape as migration 1's session_ref, for the same reason: hw stamps `operationId` on
    // operation.completed/failed — the content hash of the dispatched op, which is exactly the id
    // `withRecord` gives an UNPLACED record — and deriving the column from the payload means it can
    // never drift from the event it came from. Placed calls join through session_ref as before;
    // this closes the other half, and NULL is what every event written before the stamp reads as.
    sql: `
      ALTER TABLE state_machine_events ADD COLUMN operation_id TEXT
        GENERATED ALWAYS AS (json_extract(payload_json, '$.operationId')) VIRTUAL;
      CREATE INDEX IF NOT EXISTS state_machine_events_operation ON state_machine_events(operation_id);
    `,
  },
  {
    version: 6,
    note: "recorded whether an artifact may run its own scripts when shown",
    // A stored column rather than a derived one, because it is not derivable: "may this page run"
    // is a claim the PRODUCING call made, and nothing about the bytes or the media type says it.
    // Deriving it from `format = 'text/html'` would have made every artifact ever written scriptable
    // the day the interactive renderer arrived, including ones written before the question existed.
    //
    // `DEFAULT 0` is what makes that safe for a database that already has rows: everything already in
    // the map predates the claim and is therefore static, which is the answer that takes nothing away.
    sql: `ALTER TABLE artifacts ADD COLUMN interactive INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 7,
    note: "gave every interrupted record the message it was called with, which only a settled one used to keep",
    // A record's messages are the delta its call contributed, and a settled call's delta opens with
    // the question because the provider echoes it. A STOPPED call has no provider answer, so its
    // record held only what the transport streamed — the model's own output — and the question was
    // nowhere in it. Readers compensated at display time and replay did not compensate at all: a
    // resumed conversation was handed an answer with no question in front of it.
    //
    // `openingMessage` splices it at the write. This step brought the rows already on disk up to
    // the same shape — in the `messages` encoding, which no longer exists: a record's conversation
    // is one `entries` array and nothing reads the old shape any more. The version STAYS, because
    // every database that ran it recorded that it did; the work is what is gone.
    run: () => undefined,
  },
  {
    version: 8,
    note: "keyed a conversation position by the record's own id, not by a rowid the database assigns",
    // `session_positions.operation_record_id` pointed at `operation_records.id`, an
    // `INTEGER PRIMARY KEY AUTOINCREMENT`. That is a key the DATABASE mints, and it is the one kind
    // that cannot survive being rebuilt: DESIGN §4.4 has the journal and the conversation store
    // replayed out of files into a temp table, and a replay re-mints every rowid — leaving every
    // position row pointing at the wrong record. Silently, because the ids are all still valid.
    //
    // The stable id was there the whole time. Upstream's `withRecord` stamps `<sessionId>:<seq>` on
    // a record that claims a position and `hashOperation(op)` on one that does not, and both are
    // stable because operations are immutable. What it is NOT is unique on its own: an identical
    // operation dispatched twice hashes identically, which is exactly why `attempt` exists. So the
    // key is the four columns together — and for a PLACED record `record_id` is literally
    // `session_id:seq`, so those rows were carrying a rowid that duplicated the very pair the
    // position table already keys on.
    //
    // The tuple rather than a synthetic string built from it: a delimiter-joined key would have to
    // claim that `record_id` never contains the delimiter, and nothing enforces that. Four columns
    // in a join read worse and assert less.
    //
    // `task_id` and `run_id` are NULLABLE — a store with no scope keys by the bare id — and SQLite
    // treats every NULL in a UNIQUE index as distinct, so unscoped rows are not constrained by it.
    // That is the honest outcome rather than a gap to paper over: an unscoped store is a read of one
    // run that has already been narrowed, and it writes nothing.
    run: (db) => keyPositionsByRecord(db),
  },
  {
    version: 9,
    note: "recorded where a run's own work begins, so a resume's shared prefix is stated rather than guessed",
    // A resumed run replays what an earlier one answered and dispatches from there. Which panels are
    // SHARED and which are this run's own is the whole content of a run-scale fork mark, and until
    // now nothing wrote it down: a reader would have to infer replay from its absences, and the tell
    // it would have to use — a completion carrying no session ref — is also what a FUNCTION op looks
    // like, because that runs no model call either. Two different facts, one appearance.
    //
    // The value is an `InstanceAddress` as JSON, never `addressKey`. That key is a MAP key — its own
    // doc says so — and it joins with `/` and `#`, neither of which is reserved in a child key: a
    // workflow naming a child `a/b` would write a row no parser could read back. `parseSessionRef`
    // already splits on the LAST `@` for exactly this reason. Structure crossing the boundary leaves
    // no delimiter to be wrong about, and hw's own step shape stays the contract.
    //
    // NULL is the ROOT — this run shares nothing. That is what a re-run from the top does, and what
    // every row already on disk gets. It is also the safe direction: it never claims a prefix was
    // carried over when it was not, and claiming that falsely is the failure the mark exists to end.
    // Guarded rather than plain SQL, because SQLite has no `ADD COLUMN IF NOT EXISTS` and this file's
    // own rule is to be idempotent wherever it lets you. Two callers need that: the runner already
    // reasons about two processes racing to migrate one project, and a database whose `user_version`
    // was rewound over a schema that was not — which is how the migration tests build their fixtures
    // — re-runs the step against a table that already has the column.
    run: (db) => addColumn(db, "runs", "forked_at", "TEXT"),
  },
  {
    version: 10,
    note: "a record's big leaves are stored once, by content hash, and referenced",
    // RECORDS.md §8. Deduplicating INSIDE a record got the conversation stored once; this is what
    // deduplicates ACROSS them. The same file read by three passes of a loop was three copies, and
    // a resumed session re-reading its own context was more — the bytes are identical every time and
    // the record has no way to say so.
    //
    // CONTENT-ADDRESSED rather than record-scoped, which is the choice §8 left open. Record-scoped
    // needs no reachability question, but it misses exactly the case that motivated the layer: the
    // repetition is BETWEEN records, not within one. The GC that buys is real and has a home —
    // `prune` already walks runs and deletes what they owned, and an unreferenced blob is the same
    // kind of thing as an orphaned job row.
    //
    // `refs` is a COUNT, not a flag. Two records sharing a blob is the point, so deleting one must
    // not delete the bytes the other still names; a count is the smallest thing that can say which
    // of those two happened.
    sql: `
      CREATE TABLE IF NOT EXISTS blobs (
        hash       TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        refs       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blobs_unreferenced ON blobs(refs) WHERE refs <= 0;
    `,
  },
  {
    version: 11,
    note: "a parked gate outlives the process that parked it, so closing the app is not an answer",
    // An interactive state's request lived in `InteractionHub`'s Map and nowhere else, so quitting
    // rejected it: the workflow took a failure it never asked for, and the question the person was
    // being asked simply vanished. A gate is a place a task SITS — the same thing `on_user_event`
    // says about a wait — and a place has to still be there when you come back.
    //
    // `inputs_json` is the whole request rather than a reference to one, because the journal does
    // not hold the right object: `operation.started` fires before input resolution and carries
    // none, and `instance.entered` carries the STATE's inputs rather than the merged args the
    // function was actually called with. What is stored is what the renderer draws a gate from,
    // which is exactly what the hub handed it live.
    //
    // Rows go when a person ANSWERS, never when the process goes away — see `InteractionStore`.
    // That asymmetry is the whole feature.
    sql: `
      CREATE TABLE IF NOT EXISTS pending_interactions (
        request_id      TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        run_id          INTEGER,
        component       TEXT NOT NULL,
        inputs_json     TEXT NOT NULL,
        about           TEXT,
        subject_project TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_interactions_task ON pending_interactions(task_id);
    `,
  },
  {
    version: 12,
    note: "instance ids became durable strings (UUIDv7), so the journal column stops claiming they are integers",
    // Identity-and-Resume step 1: the engine mints one UUIDv7 per instance instead of a per-run
    // counter, so an id in the journal now survives a resume and joins across runs. The column is
    // retyped by rebuild — SQLite cannot alter a column — and legacy rows come along: a counter id
    // becomes its text, and the retired `-1` sentinel becomes NULL, which is what it always meant.
    // Old payload_json keeps its numeric ids untouched (the journal is append-only); the read path
    // coerces. `artifacts.instance_id` and `task_runtime.root_instance_id` are NOT rebuilt: nothing
    // indexes, orders by, or compares either in SQL, so affinity is enough and the read path coerces.
    run: retypeInstanceIds,
  },
  {
    version: 13,
    note: "a record's id became the hash of the scoped request, so the attempt column has nothing left to disambiguate",
    // Identity-and-Resume step 2: every dispatch carries a scope `(instance_id, sequence)` — the
    // site the request is written at — and the record id is the hash of the scoped request. The
    // scope never repeats (a loop's next iteration is a new instance; a guard's third round is the
    // same site and MEANS the same record), so the id is a primary key on its own and the four-column
    // natural key `(task_id, run_id, record_id, attempt)` retires. `interrupted` joins the status
    // vocabulary in the same step: the recovery sweep stops writing `failed` over a call that was
    // never answered, and a cut call settles under the word for what happened to it.
    //
    // Legacy rows whose content-hash ids collided keep their history: attempt 1 keeps the bare id,
    // and later attempts move to `<id>~~<attempt>` — `~~` because a single `~` legitimately appears
    // inside derived session ids (`planning~compact1:0`) and this suffix must be unmistakable.
    run: keyRecordsByScopedId,
  },
  {
    version: 14,
    note: "a position is an input, so it moved into the request — and the claim learned to let go of the dead",
    // Identity-and-Resume step 3 (first half). "Append at seq 14 of conversation X, resuming handle
    // H" is part of what the call was ASKED to do, exactly as its inputs are — so it lives in
    // `request_json` beside them (`$.session`, next to the `$.scope` the id is folded over), and
    // `session_positions` retires for generated columns over the request. The claim becomes the
    // PARTIAL unique index `op_position`: a seat is held only by a record that is alive and still
    // there — the call failed, was cut, or landed somewhere else, and the seat is free again — so a
    // conflict always means a genuinely live competing claim, which is what makes it safe to read
    // as the fork signal. `landed_session_id`/`landed_seq` replace the old row move: divergence
    // becomes a fact written once on the record, not surgery on a position table.
    //
    // The handle moves onto the SESSION with its provider — it is only ever passed when appending at
    // the head, so "the conversation's current handle" is the right value everywhere a handle is
    // used; a fork starts with NULL rather than inheriting (two branches writing into one remote
    // stream is the failure that prevents). The per-record handle stays: divergence detection
    // compares what we asked to resume against what the call reports it ran in.
    //
    // `session_outcome_json` does not survive inspection (artifact §03): in the ordinary case it
    // held one field that is already a column, and its one earned case — a payload that is NOT a
    // conversation — normalises into `result_json` before the column drops.
    run: foldPositionsIntoRequests,
  },
  {
    version: 15,
    note: "a conversation is named once, and what an author writes is an alias to it",
    // Identity-and-Resume step 3 (second half). Session ids used to be DERIVED — the authored name,
    // or the engine's fresh key, prefixed `task/run/` at the SQL boundary. The prefix stopped two
    // runs' conversations colliding, and stopped the intended continuation with it: a resumed run
    // could not name, extend or branch from a conversation an earlier run created, because the name
    // it would use resolved somewhere else. The session id is ASSIGNED now (minted once, opaque,
    // never parsed), and an authored name reaches it through this table — TASK-scoped, run-free,
    // which is precisely what lets run 3's `planning` be run 1's. task_id is '' for an unscoped
    // store rather than NULL, because a NULL primary-key column would let one name alias twice.
    //
    // No foreign key on session_id, the same soft-reference stance the record tables take: pruning
    // sweeps orphaned aliases rather than being refused by them.
    sql: `
      CREATE TABLE IF NOT EXISTS session_names (
        task_id    TEXT NOT NULL DEFAULT '',
        name       TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (task_id, name)
      );
    `,
  },
  {
    version: 16,
    note: "a task is one machine, so the runs table folded into it and run_id left every row",
    // Identity-and-Resume step 5. The runs table existed because resume RE-RAN: every attempt
    // re-walked the workflow and journaled its own copy, and the attempts had to be told apart.
    // Loading (step 4) ends that — a resumed machine continues under its own ids, a re-run mints a
    // NEW task linked by `parent_task_id` — so a task has exactly one machine and the run row's
    // facts (when it started, how it ended, what it produced) are facts about the TASK. The last
    // run's are folded up; earlier attempts stay in the journal as history, and the machine's root
    // is stamped on `root_instance_id` so a reader never has to guess which parentless entry it is
    // (a legacy re-run's older tree, or a sub-workflow journaling into the same task, also enter
    // parentless).
    run: collapseRunsIntoTasks,
  },
  {
    version: 17,
    note: "a conversation remembers where its remote was cut, and a task remembers where it was forked from",
    // Rewind and fork. A rewound session still has a remote that runs past its rows — the provider
    // cannot truncate a conversation — so `cut_at` names the last message the rows still hold, and
    // the next call copies the remote cut there instead of resuming a tip the rows no longer
    // describe. A forked task copies a prefix of another's journal; `forked_at_seq` is the parent's
    // position it was cut at, `fork_boundary_seq` the copy's own last journaled event, so the seam
    // can be drawn in both journals' coordinates.
    run: (db) => {
      addColumn(db, "sessions", "cut_at", "TEXT");
      addColumn(db, "task_runtime", "forked_at_seq", "INTEGER");
      addColumn(db, "task_runtime", "fork_boundary_seq", "INTEGER");
    },
  },
  {
    version: 18,
    note: "a task remembers the merge requests it opened, and what it has already heard on each",
    // Decision 0004. One row per (task, key): the handle a function returns as data, and the WATCH —
    // the probe cursor, what has been seen, and `settle_at`. `settle_at` is a timestamp and not a
    // timer so that quitting the app neither loses a quiet window nor extends it; `awaiting` is what
    // the poller reads, so nothing parked means nothing polled. Never file-backed: the cursor and the
    // window are facts about THIS machine's conversation with a forge, not about the repository.
    sql: `
      CREATE TABLE IF NOT EXISTS remote_handles (
        task_id         TEXT NOT NULL,
        key             TEXT NOT NULL,
        provider        TEXT NOT NULL,
        host            TEXT NOT NULL,
        project         TEXT NOT NULL,
        remote          TEXT NOT NULL,
        branch          TEXT NOT NULL,
        target          TEXT NOT NULL,
        number          INTEGER,
        url             TEXT,
        pushed_head     TEXT,
        cursor_json     TEXT NOT NULL DEFAULT '{}',
        seen_json       TEXT NOT NULL DEFAULT '[]',
        settle_at       INTEGER,
        settle_after_ms INTEGER,
        awaiting        INTEGER NOT NULL DEFAULT 0,
        request_id      TEXT,
        checked_at      INTEGER,
        last_error      TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (task_id, key)
      );
      CREATE INDEX IF NOT EXISTS remote_handles_awaiting ON remote_handles(awaiting) WHERE awaiting = 1;
    `,
  },
  {
    version: 19,
    note: "a task names the versioned frozen document it runs, when it runs one",
    // Decision 0005 §3. A dynamic workflow — and a real workflow's diverged copy — is a frozen
    // document that may be modified, each modification a new version and each version an ordinary
    // snapshot. The document has an identity outside any task (several tasks stand in one), so a
    // task only NAMES it; `snapshot_hash` stays what it was, the snapshot the task last ran under.
    // Which version each stretch of the journal ran under is in the journal (`workflow.version`).
    run: (db) => addColumn(db, "task_runtime", "document_id", "TEXT"),
  },
];

/**
 * Migration 8's rebuild — see the note there for why the rowid had to go.
 *
 * A function rather than `sql`, and the reason is the second rule in this file's header: make a step
 * idempotent where SQLite lets you. `ALTER TABLE … RENAME` cannot be guarded by `IF NOT EXISTS`, so
 * a step that structurally rebuilds a table runs exactly once or fails loudly — and there is a
 * legitimate caller that re-runs it, since the session-store tests build a database with the current
 * schema and then rewind `user_version` to stand in for an older one. Asking the table what shape it
 * is in is both cheaper and more honest than asking the version marker, which is a claim about the
 * database that anything can rewrite.
 */
function keyPositionsByRecord(db: JairaDb): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('session_positions')`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "record_id")) return; // already this shape

  // Renumber first, because the index below is UNIQUE and a database holding a duplicate would
  // refuse to migrate at all. This is the ordinal `insertRecord` computes anyway — count the rows
  // already in the group, add one — restated over the rows on disk, so for everything written
  // through that path it is a no-op and rowid order IS attempt order.
  //
  // What it repairs is `derive`, which inserted its record with no `attempt` column and therefore
  // always wrote 1. Two derivations of one session id in a run left two rows claiming the first
  // attempt; `derive` counts like everything else now.
  db.exec(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id, run_id, record_id ORDER BY id) AS n
        FROM operation_records
    )
    UPDATE operation_records
       SET attempt = (SELECT n FROM ranked WHERE ranked.id = operation_records.id);

    -- What makes the join well defined. Without it a position row could match two records and fan
    -- out — the failure the rowid was preventing by accident rather than by design.
    CREATE UNIQUE INDEX IF NOT EXISTS operation_records_natural
      ON operation_records(task_id, run_id, record_id, attempt);

    ALTER TABLE session_positions RENAME TO session_positions_by_rowid;
    DROP INDEX IF EXISTS session_positions_record;

    CREATE TABLE session_positions (
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      task_id     TEXT,
      run_id      INTEGER,
      record_id   TEXT NOT NULL,
      attempt     INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS session_positions_record
      ON session_positions(task_id, run_id, record_id, attempt);

    -- An INNER join, so a position whose record is already gone is dropped rather than carried
    -- forward as a row naming nothing. The foreign key made that state unreachable; this is the one
    -- moment it could still be observed, and the answer is to not migrate it.
    INSERT INTO session_positions (session_id, seq, task_id, run_id, record_id, attempt)
      SELECT p.session_id, p.seq, r.task_id, r.run_id, r.record_id, r.attempt
        FROM session_positions_by_rowid p
        JOIN operation_records r ON r.id = p.operation_record_id;

    DROP TABLE session_positions_by_rowid;
  `);
}

/**
 * Migration 12's rebuild — see the note there.
 *
 * Guarded by the column's DECLARED TYPE rather than the version marker, the same reasoning as
 * `keyPositionsByRecord`: a fresh database bootstraps the table with `instance_id TEXT` already
 * (db.ts), so by the time this step runs there may be nothing to do, and the table itself is the
 * only honest witness of which shape it is in.
 */
function retypeInstanceIds(db: JairaDb): void {
  const column = db
    .prepare(`SELECT type FROM pragma_table_info('state_machine_events') WHERE name = 'instance_id'`)
    .get() as { type: string } | undefined;
  if (column === undefined || column.type.toUpperCase() === "TEXT") return; // already this shape

  db.exec(`
    ALTER TABLE state_machine_events RENAME TO state_machine_events_numeric;
    DROP INDEX IF EXISTS state_machine_events_task;
    DROP INDEX IF EXISTS state_machine_events_run;
    DROP INDEX IF EXISTS state_machine_events_session;
    DROP INDEX IF EXISTS state_machine_events_operation;

    -- The post-migration-5 shape, with both generated columns declared inline: a rebuild has no
    -- ALTER steps to lean on, so the columns migrations 1 and 5 added are part of the CREATE.
    CREATE TABLE state_machine_events (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT NOT NULL,
      run_id       INTEGER NOT NULL REFERENCES runs(id),
      instance_id  TEXT,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      session_ref  TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.metrics.sessionRef')) VIRTUAL,
      operation_id TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.operationId')) VIRTUAL
    );

    INSERT INTO state_machine_events (seq, task_id, run_id, instance_id, type, payload_json, created_at)
      SELECT seq, task_id, run_id,
             CASE WHEN instance_id IS NULL OR instance_id = -1 THEN NULL ELSE CAST(instance_id AS TEXT) END,
             type, payload_json, created_at
        FROM state_machine_events_numeric;
    DROP TABLE state_machine_events_numeric;

    CREATE INDEX IF NOT EXISTS state_machine_events_task ON state_machine_events(task_id, seq);
    CREATE INDEX IF NOT EXISTS state_machine_events_run ON state_machine_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS state_machine_events_session ON state_machine_events(session_ref);
    CREATE INDEX IF NOT EXISTS state_machine_events_operation ON state_machine_events(operation_id);
  `);
}

/**
 * Migration 13's rebuild — see the note there.
 *
 * Guarded by the table's own shape (does `operation_records` still have an `attempt` column?)
 * rather than the version marker, for the reason `keyPositionsByRecord` gives: the session-store
 * tests rewind `user_version` to stand in for an older database, and the table is the only honest
 * witness of which shape it is in.
 */
function keyRecordsByScopedId(db: JairaDb): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('operation_records')`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "attempt")) return; // already this shape

  db.exec(`
    ALTER TABLE operation_records RENAME TO operation_records_by_attempt;
    DROP INDEX IF EXISTS operation_records_natural;
    DROP INDEX IF EXISTS operation_records_scope;
    DROP INDEX IF EXISTS operation_records_run;

    CREATE TABLE operation_records (
      id                   TEXT PRIMARY KEY,              -- hash of the SCOPED request
      task_id              TEXT,
      run_id               INTEGER,
      status               TEXT NOT NULL DEFAULT 'open',  -- open | completed | failed | interrupted
      request_json         TEXT,
      result_json          TEXT,
      error_json           TEXT,
      metrics_json         TEXT,
      session_outcome_json TEXT,
      provider_session_id  TEXT,
      started_at           INTEGER NOT NULL,
      ended_at             INTEGER
    );
    CREATE INDEX IF NOT EXISTS operation_records_scope ON operation_records(task_id, run_id, id);
    CREATE INDEX IF NOT EXISTS operation_records_run ON operation_records(run_id, started_at);

    -- A legacy content-hash id repeats WITHIN a run (attempts) and ACROSS runs (each run's attempt
    -- 1), and the new primary key is global — so per content id, exactly one row keeps the bare id:
    -- the globally newest (max old rowid), which is what the old ORDER BY attempt DESC reads called
    -- "what happened". Every other row moves to '<id>~~<old rowid>' — unique by construction, and
    -- readable back to dispatch order, which is what a legacy journal pairing walks.
    INSERT INTO operation_records
      (id, task_id, run_id, status, request_json, result_json, error_json, metrics_json,
       session_outcome_json, provider_session_id, started_at, ended_at)
      SELECT CASE WHEN o.id = (SELECT MAX(m.id) FROM operation_records_by_attempt m WHERE m.record_id = o.record_id)
                  THEN o.record_id ELSE o.record_id || '~~' || o.id END,
             o.task_id, o.run_id, o.status, o.request_json, o.result_json, o.error_json, o.metrics_json,
             o.session_outcome_json, o.provider_session_id, o.started_at, o.ended_at
        FROM operation_records_by_attempt o ORDER BY o.id;

    ALTER TABLE session_positions RENAME TO session_positions_by_attempt;
    DROP INDEX IF EXISTS session_positions_record;

    CREATE TABLE session_positions (
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      task_id     TEXT,
      run_id      INTEGER,
      record_id   TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS session_positions_record ON session_positions(task_id, run_id, record_id);

    -- An INNER join, the same choice migration 8 made: a position whose record is gone is dropped
    -- rather than carried forward naming nothing.
    INSERT INTO session_positions (session_id, seq, task_id, run_id, record_id)
      SELECT p.session_id, p.seq, p.task_id, p.run_id,
             CASE WHEN r.id = (SELECT MAX(m.id) FROM operation_records_by_attempt m WHERE m.record_id = r.record_id)
                  THEN r.record_id ELSE r.record_id || '~~' || r.id END
        FROM session_positions_by_attempt p
        JOIN operation_records_by_attempt r
          ON r.record_id = p.record_id AND r.attempt = p.attempt AND r.task_id IS p.task_id AND r.run_id IS p.run_id;
    DROP TABLE session_positions_by_attempt;
    DROP TABLE operation_records_by_attempt;
  `);
}

/**
 * Migration 14's fold — see the note there. Guarded by the table's own shape, per the house rule.
 */
function foldPositionsIntoRequests(db: JairaDb): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('operation_records')`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "session_id")) return; // already this shape

  // The conversation's remote identity, on the conversation — guarded per column, because the
  // session-store tests rewind `user_version` against a database whose sessions table already has
  // them (this file's own second rule, restated for a table another guard does not cover).
  addColumn(db, "sessions", "provider", "TEXT");
  addColumn(db, "sessions", "provider_session_id", "TEXT");

  db.exec(`
    -- Settle-time divergence: NULL unless the call demonstrably ran somewhere other than it claimed.
    ALTER TABLE operation_records ADD COLUMN landed_session_id TEXT;
    ALTER TABLE operation_records ADD COLUMN landed_seq INTEGER;

    -- The ask's own context, surfaced from the request — VIRTUAL, per this file's third rule.
    ALTER TABLE operation_records ADD COLUMN instance_id TEXT
      GENERATED ALWAYS AS (json_extract(request_json, '$.scope.instanceId')) VIRTUAL;
    ALTER TABLE operation_records ADD COLUMN sequence INTEGER
      GENERATED ALWAYS AS (json_extract(request_json, '$.scope.sequence')) VIRTUAL;
    ALTER TABLE operation_records ADD COLUMN session_id TEXT
      GENERATED ALWAYS AS (json_extract(request_json, '$.session.id')) VIRTUAL;
    ALTER TABLE operation_records ADD COLUMN session_seq INTEGER
      GENERATED ALWAYS AS (json_extract(request_json, '$.session.seq')) VIRTUAL;

    -- Every position a record ever claimed, folded into its own request. The old table's PRIMARY
    -- KEY guaranteed one row per seat, so this cannot fan out.
    UPDATE operation_records
       SET request_json = json_set(COALESCE(request_json, '{}'),
                                   '$.session', json_object('id', p.session_id, 'seq', p.seq))
      FROM session_positions p
     WHERE operation_records.id = p.record_id
       AND operation_records.task_id IS p.task_id AND operation_records.run_id IS p.run_id;
    DROP TABLE session_positions;

    -- THE CLAIM. Unique over live seats only: a failed, interrupted or landed row keeps its row —
    -- evidence, and ordered history at that seat — and stops holding the position. A partial index
    -- only serves a query whose WHERE implies its own, so the READ index beside it is deliberate:
    -- conversation reads want every row at a seat (the dead ones are history a viewer still sees),
    -- and repeating the claim predicate in every read is the trap the second index removes.
    CREATE UNIQUE INDEX IF NOT EXISTS op_position
      ON operation_records(session_id, session_seq)
      WHERE status IN ('open', 'completed') AND landed_session_id IS NULL;
    CREATE INDEX IF NOT EXISTS operation_records_session ON operation_records(session_id, session_seq);

    UPDATE sessions
       SET provider_session_id = (SELECT r.provider_session_id FROM operation_records r
                                   WHERE r.session_id = sessions.id AND r.provider_session_id IS NOT NULL
                                   ORDER BY r.session_seq DESC LIMIT 1);

    -- The one case session_outcome_json earned — a payload that is not a conversation — normalises
    -- into the result before the column goes: the reported turns land as a SIBLING of the value
    -- ('$.messages'), never over it, because '$.value' is the op's OUTPUT — what a replay answers
    -- with — and the conversation is a second fact about the same call. projectValue turns the
    -- sibling into entries at read, exactly as it did the old column.
    UPDATE operation_records
       SET result_json = json_set(COALESCE(result_json, '{}'),
                                  '$.messages', json_extract(session_outcome_json, '$.messages'))
     WHERE session_outcome_json IS NOT NULL
       AND json_extract(session_outcome_json, '$.messages') IS NOT NULL
       AND json_extract(result_json, '$.value.entries') IS NULL;
    ALTER TABLE operation_records DROP COLUMN session_outcome_json;
  `);
}

/**
 * Migration 16's collapse — see the note there. Guarded by the runs table's existence, per the
 * house rule: the table is the only honest witness of which shape the database is in.
 */
function collapseRunsIntoTasks(db: JairaDb): void {
  // The COLUMN is the witness, not the runs table: the bootstrap recreates an empty `runs` shell on
  // every open (openDb drops it again), and the session-store tests rewind `user_version` against a
  // database already in the new shape — where re-running the fold would read columns that are gone.
  const hasRunColumn =
    (
      db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('state_machine_events') WHERE name = 'run_id'`).get() as {
        n: number;
      }
    ).n > 0;
  if (!hasRunColumn) return; // already this shape

  // The re-run chain: a task minted as another's re-run points back at it. Guarded per column
  // because the bootstrap schema will eventually declare it.
  addColumn(db, "task_runtime", "parent_task_id", "TEXT");
  // The last run's lifecycle facts, now the task's own.
  addColumn(db, "task_runtime", "started_at", "INTEGER");
  addColumn(db, "task_runtime", "ended_at", "INTEGER");
  addColumn(db, "task_runtime", "outcome", "TEXT");
  addColumn(db, "task_runtime", "outputs_json", "TEXT");
  addColumn(db, "task_runtime", "failure_json", "TEXT");

  db.exec(`
    UPDATE task_runtime SET
      started_at   = (SELECT r.started_at   FROM runs r WHERE r.task_id = task_runtime.task_id ORDER BY r.id DESC LIMIT 1),
      ended_at     = (SELECT r.ended_at     FROM runs r WHERE r.task_id = task_runtime.task_id ORDER BY r.id DESC LIMIT 1),
      outcome      = (SELECT r.outcome      FROM runs r WHERE r.task_id = task_runtime.task_id ORDER BY r.id DESC LIMIT 1),
      outputs_json = (SELECT r.outputs_json FROM runs r WHERE r.task_id = task_runtime.task_id ORDER BY r.id DESC LIMIT 1),
      failure_json = (SELECT r.failure_json FROM runs r WHERE r.task_id = task_runtime.task_id ORDER BY r.id DESC LIMIT 1);

    -- The machine's root, stamped while run boundaries still exist to read: the LAST run's first
    -- parentless entry. This is the one fact run_id carried that the journal alone cannot restate —
    -- an old-style re-run grew a second tree, and only the newest is the task's machine.
    UPDATE task_runtime SET root_instance_id = COALESCE(
      (SELECT e.instance_id FROM state_machine_events e
        WHERE e.task_id = task_runtime.task_id
          AND e.run_id = (SELECT MAX(r.id) FROM runs r WHERE r.task_id = task_runtime.task_id)
          AND e.type = 'instance.entered'
          AND json_extract(e.payload_json, '$.parentInstanceId') IS NULL
        ORDER BY e.seq LIMIT 1),
      root_instance_id);

    DROP INDEX IF EXISTS state_machine_events_run;
    ALTER TABLE state_machine_events DROP COLUMN run_id;

    DROP INDEX IF EXISTS operation_records_scope;
    DROP INDEX IF EXISTS operation_records_run;
    ALTER TABLE operation_records DROP COLUMN run_id;
    CREATE INDEX IF NOT EXISTS operation_records_scope ON operation_records(task_id, id);

    DROP INDEX IF EXISTS command_log_run;
    ALTER TABLE command_log DROP COLUMN run_id;
    ALTER TABLE jobs DROP COLUMN run_id;
    ALTER TABLE artifacts DROP COLUMN run_id;
    ALTER TABLE pending_interactions DROP COLUMN run_id;

    DROP TABLE runs;
  `);
}

/**
 * `ALTER TABLE ... ADD COLUMN`, but only when it is missing.
 *
 * SQLite has no `IF NOT EXISTS` for a column, and `duplicate column name` is thrown out of
 * `openProject` — so a step that cannot be re-run is a step that turns a rewound version, or a lost
 * race between two processes, into a project that will not open.
 *
 * The name is interpolated and must therefore never come from input; every caller is a literal in
 * this file, which is the same rule the `user_version` write below follows.
 */
function addColumn(db: JairaDb, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
}

/**
 * Bring one database up to date. Called on every open, and a no-op once it is.
 *
 * Each step runs in its own transaction with the version bump inside it, so an interrupted upgrade
 * leaves the database at the last version that fully applied rather than part-way through one.
 */
export function migrate(db: JairaDb, migrations: readonly Migration[] = MIGRATIONS): number {
  let at = read(db);
  for (const migration of migrations) {
    if (migration.version <= at) continue;
    // IMMEDIATE, and the version is re-read INSIDE. JaiRA runs several processes against one project by
    // design (DESIGN §4.2a) — the app open while a CLI run starts is the ordinary case — and a deferred
    // transaction takes its write lock only at the first statement. Two processes would both read the
    // old version, both begin, and the loser would apply an already-applied step: `duplicate column
    // name`, thrown out of `openProject`.
    db.transaction(() => {
      if (read(db) >= migration.version) return; // the other process got here first
      if (migration.sql !== undefined) db.exec(migration.sql);
      migration.run?.(db);
      // Interpolated because SQLite does not accept a parameter in a PRAGMA. Safe by construction:
      // the value is a number from this file, never from input.
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
    at = Math.max(at, migration.version);
  }
  return read(db);
}

const read = (db: JairaDb): number => Number((db.pragma("user_version", { simple: true }) as number | bigint) ?? 0);
