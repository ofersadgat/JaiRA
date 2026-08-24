/**
 * Shadow tables — how a file-backed concern reaches the runtime unchanged (DESIGN §4.4).
 *
 * The design says the file is the truth and the table is an index replayed from it. This is the
 * table half: for every concern whose storage mode is `file` or `both`, a `TEMP` table of the same
 * name is created in the connection, and SQLite's name resolution does the rest — an unqualified
 * table name resolves to `temp` before `main`, so every query in the codebase reads the replayed
 * copy without one of them being edited. The real table is still reachable as `main.<name>`, which
 * is what the seed below uses and what a diagnostic would.
 *
 * ## The shape is COPIED, never restated
 *
 * The DDL comes out of `sqlite_master`, not out of a constant here. That is the difference between
 * a shadow that tracks migrations and one that silently stops matching after the next `ALTER TABLE`
 * — and this schema has already moved four times under `state_machine_events` alone. Copying the
 * live statement brings the generated columns with it (`session_ref`, `operation_id` recompute on
 * insert into the shadow) and the indexes are re-created from their own `sqlite_master` rows, so the
 * planner sees what it sees today. Verified rather than assumed: an `EXPLAIN QUERY PLAN` against a
 * shadowed table reports the same index.
 *
 * ## Two things are deliberately dropped
 *
 * **Foreign keys.** SQLite resolves a foreign key's parent within the same database, so a `TEMP`
 * child pointing at a `main` parent is not a weaker constraint — it is an error on every insert.
 * They are stripped from the copied DDL, and the honest way to say that is: choosing `file` for a
 * concern gives up the referential integrity SQLite was enforcing for it. Nothing else can be true
 * once half the rows live in a text file that git may have merged.
 *
 * **Nothing else.** Primary keys, uniqueness, defaults and `NOT NULL` all come across, because those
 * are statements about a single row and remain enforceable. `session_positions`'s primary key is the
 * position claim (SESSIONS.md), and it keeps working — per connection rather than across processes,
 * which is exactly the trade §4.4 records and the reason `jobs` may never be file-backed.
 */
import type { JairaDb } from "./db";
import type { JairaStorageConcern, JairaStorageConfig } from "@jaira/shared";

/**
 * Which tables each concern covers.
 *
 * The grouping is the point of concerns existing (DESIGN §4.4): a per-table setting would let
 * someone put `task_runtime` in a file and `runs` in the database, splitting one task's truth across
 * two stores with different durability and different merge behaviour, and nothing would catch it.
 *
 * `sessions` rides with `conversations` because it is the lineage a transcript hangs off — a fork
 * that lost its parent row is a conversation that silently truncates its inherited prefix. `runs`
 * rides with `tasks` for the same reason in the other direction: "what was asked for" and "where
 * each run of it got to" are one answer.
 */
export const CONCERN_TABLES: Record<JairaStorageConcern, readonly string[]> = {
  journal: ["state_machine_events"],
  conversations: ["operation_records", "session_positions", "sessions"],
  tasks: ["task_runtime", "runs"],
  artifacts: ["artifacts"],
};

/** Whether a mode puts the file in charge. `both` does too — it only adds a persisted index. */
export const isFileBacked = (mode: string): boolean => mode === "file" || mode === "both";

/**
 * Whether a mode keeps the index in `main` across a close.
 *
 * `both` writes every replayed row back into the real table when the shadow is built, so the next
 * open can skip the replay. `file` does not — its `main` copy is whatever was there when the
 * concern was switched on, and is never read again.
 */
export const keepsIndex = (mode: string): boolean => mode === "both";

/**
 * What the persisted index was built from, per concern.
 *
 * The staleness question §4.4 deferred, answered the cheap way. A `git pull` moves the files under
 * a persisted index and nothing else notices — so `both` records a FINGERPRINT of the files it
 * replayed, and the next open compares before deciding to trust what is in `main`.
 *
 * Size and mtime per file, not a content hash: the point is to be cheaper than the replay it is
 * avoiding, and a checkout that rewrites a file without changing either of those is not a case git
 * produces. Wrong in the safe direction anyway — a fingerprint that fails to match costs a replay,
 * which is what would have happened without it.
 */
const INDEX_TABLE = `CREATE TABLE IF NOT EXISTS storage_index (
  concern     TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  built_at    INTEGER NOT NULL
)`;

export function readFingerprint(db: JairaDb, concern: JairaStorageConcern): string | undefined {
  db.exec(INDEX_TABLE);
  const row = db.prepare(`SELECT fingerprint FROM storage_index WHERE concern = ?`).get(concern) as
    | { fingerprint: string }
    | undefined;
  return row?.fingerprint;
}

export function writeFingerprint(db: JairaDb, concern: JairaStorageConcern, fingerprint: string, at: number): void {
  db.exec(INDEX_TABLE);
  db.prepare(`INSERT OR REPLACE INTO storage_index (concern, fingerprint, built_at) VALUES (?, ?, ?)`).run(
    concern,
    fingerprint,
    at,
  );
}

/** Every table a storage configuration puts behind a shadow, in creation order. */
export function shadowedTables(storage: JairaStorageConfig): string[] {
  const out: string[] = [];
  for (const [concern, tables] of Object.entries(CONCERN_TABLES) as Array<[JairaStorageConcern, readonly string[]]>) {
    if (isFileBacked(storage[concern])) out.push(...tables);
  }
  return out;
}

/**
 * A column list a caller may INSERT into — generated columns excluded.
 *
 * `pragma_table_info` omits them and `pragma_table_xinfo` reports them with a non-zero `hidden`;
 * this wants the former, because writing to a generated column is an error rather than a no-op. It
 * is also why a seed cannot be `INSERT … SELECT *`.
 */
export function writableColumns(db: JairaDb, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map((c) => c.name);
}

/** Strip inline `REFERENCES parent(col)` — see the header on why a temp child cannot keep them. */
function withoutForeignKeys(ddl: string): string {
  return ddl.replace(/\s+REFERENCES\s+[\w"`[\]]+\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+[A-Z ]+)*/gi, "");
}

/**
 * Put one table behind a `TEMP` copy of itself.
 *
 * Idempotent: a name already shadowed in this connection is left alone, so the caller may ask twice
 * without checking. Returns false when there was nothing to shadow — a table the schema does not
 * have, which is what a concern naming a table a future migration removes would look like.
 */
export function shadowTable(db: JairaDb, table: string): boolean {
  const already = db.prepare(`SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?`).get(table);
  if (already !== undefined) return true;
  const row = db.prepare(`SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?`).get(table) as
    | { sql: string | null }
    | undefined;
  if (row?.sql == null) return false;
  db.exec(withoutForeignKeys(row.sql.replace(/^CREATE\s+TABLE/i, "CREATE TEMP TABLE")));
  // The indexes are re-created by their own statements, so a shadowed table is as fast to query as
  // the one it stands in front of. They land in `temp` automatically because their table does, and
  // an index name may repeat across databases — the two schemas are separate namespaces.
  const indexes = db
    .prepare(`SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
    .all(table) as Array<{ sql: string }>;
  for (const index of indexes) db.exec(index.sql);
  return true;
}

/**
 * Copy `main`'s rows into the shadow — what happens when a concern is file-backed and has no file.
 *
 * This is not a stopgap, it is the FLIP path and it stays correct once the writer exists: turning a
 * concern from `db` to `file` has to start from the rows already in the database, or the first open
 * after the change would look like the history had been deleted. A file present means the file wins
 * and this is not called.
 *
 * Rowids come across explicitly rather than being re-minted, so a seed changes no identity. A replay
 * from a FILE is the case that cannot promise that, which is why nothing points at a rowid any more
 * (migration 8).
 */
export function seedFromMain(db: JairaDb, table: string): number {
  const columns = writableColumns(db, table)
    .map((c) => `"${c}"`)
    .join(", ");
  if (columns.length === 0) return 0;
  const info = db.prepare(`INSERT INTO temp."${table}" (${columns}) SELECT ${columns} FROM main."${table}"`).run();
  return Number(info.changes);
}

/**
 * Where a file-backed concern's rows come from.
 *
 * `undefined` means there is nothing on disk — not "no rows", which is a different and much more
 * consequential answer. An empty journal directory says the files are the truth and this project has
 * no history; a MISSING one says the concern has just been switched on and the history is still in
 * the database, and the shadow must be seeded from `main` or the first open after the change looks
 * like a deletion.
 */
export type ReplaySource = () => number | undefined;

/**
 * What a concern's files look like right now, for `both` to compare against.
 *
 * `undefined` means the same thing it means for a {@link ReplaySource}: nothing on disk.
 */
export type Fingerprint = () => string | undefined;

/** What one call to {@link applyStorage} did, for a caller that reports or tests it. */
export interface ShadowReport {
  /** Tables now standing in front of their `main` counterpart, in creation order. */
  shadowed: string[];
  /** Rows copied out of `main` per table — the flip path, taken only when no file supplied them. */
  seeded: Record<string, number>;
  /** Rows replayed from disk, per concern. */
  replayed: Partial<Record<JairaStorageConcern, number>>;
  /** Concerns whose persisted index matched the files, so the replay was skipped — `both` only. */
  reused: JairaStorageConcern[];
}

/**
 * Shadow every table a storage configuration puts in a file, and seed each from `main`.
 *
 * Called once per connection, at open, before anything reads. A configuration that names no
 * file-backed concern does nothing at all and costs one object walk — which is the common case and
 * the default.
 *
 * Three outcomes per file-backed concern, in the order they are tried:
 *
 *  1. **Reuse** — `both`, and the persisted index was built from exactly these files. Skip the
 *     replay and seed the shadow from `main`.
 *  2. **Replay** — there are files. They are the truth, and under `both` the result is written back
 *     to `main` with a fingerprint so (1) can happen next time.
 *  3. **Seed** — there are no files at all. The concern has just been switched on and the history is
 *     still in the database; starting anywhere else would look like a deletion.
 */
export function applyStorage(
  db: JairaDb,
  storage: JairaStorageConfig,
  sources: Partial<Record<JairaStorageConcern, ReplaySource>> = {},
  fingerprints: Partial<Record<JairaStorageConcern, Fingerprint>> = {},
  now: () => number = Date.now,
): ShadowReport {
  const report: ShadowReport = { shadowed: [], seeded: {}, replayed: {}, reused: [] };
  for (const [concern, tables] of Object.entries(CONCERN_TABLES) as Array<[JairaStorageConcern, readonly string[]]>) {
    if (!isFileBacked(storage[concern])) continue;
    const shadowed = tables.filter((table) => shadowTable(db, table));
    report.shadowed.push(...shadowed);

    // `both`: skip the replay when `main` was built from exactly these files. The fingerprint is
    // what makes that safe — without one, a `git pull` under a persisted index leaves the two
    // disagreeing and nothing notices, which is the gap §4.4 shipped with and this closes.
    const fingerprint = fingerprints[concern]?.();
    if (keepsIndex(storage[concern]) && fingerprint !== undefined && readFingerprint(db, concern) === fingerprint) {
      for (const table of shadowed) seedFromMain(db, table);
      report.reused.push(concern);
      continue;
    }

    // The source next, because a file that exists IS the truth and seeding over it would put the
    // database's version of history in front of the one on disk.
    const replayed = sources[concern]?.();
    if (replayed !== undefined) {
      report.replayed[concern] = replayed;
      // The persisted half of `both`: write the replayed rows back so the next open can reuse them,
      // and record what they were built from. `file` skips this — its `main` copy is whatever was
      // there when the concern was switched on and is never read again.
      if (keepsIndex(storage[concern]) && fingerprint !== undefined) {
        // Emptied CHILDREN FIRST and refilled parents first, because `main` still has its foreign
        // keys — only the shadow drops them. `runs.task_id` references `task_runtime`, so deleting
        // in concern order would take the parent out from under its rows.
        for (const table of [...shadowed].reverse()) db.prepare(`DELETE FROM main."${table}"`).run();
        for (const table of shadowed) {
          const columns = writableColumns(db, table)
            .map((c) => `"${c}"`)
            .join(", ");
          if (columns.length > 0) {
            db.prepare(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM temp."${table}"`).run();
          }
        }
        writeFingerprint(db, concern, fingerprint, now());
      }
      continue;
    }
    for (const table of shadowed) report.seeded[table] = seedFromMain(db, table);
  }
  return report;
}
