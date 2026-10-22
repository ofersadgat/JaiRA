/**
 * A concern kept in files too (DESIGN §4.4, as decision 0018 §11 settled it): the DATABASE is the
 * truth while JaiRA runs, and the files are its export — appended to as each change is saved (the
 * journal's line just before its row, a task's, an artifact's and a conversation's just after, read
 * back from the table), never read back while running. The files are why a concern is kept in them: a
 * project checked into git wants files, because git cannot merge SQLite.
 *
 * What is read from them is read at open, and only when they changed since JaiRA last had them — a
 * `git pull`, a clone, a crash before a close:
 *
 *  - **Current** — the files are as JaiRA left them (their fingerprint is the one recorded at the
 *    last close or import): nothing is read; the database already holds what they say.
 *  - **Import** — they moved: they are replayed into `TEMP` staging tables, and each task they speak
 *    for has its rows in the database replaced by theirs. Tasks they do not mention are left alone.
 *    The staging tables are dropped before anything else reads.
 *  - **Export** — there are none: the concern was just put in files; or they are stale: it was in the
 *    database alone for a while, and they missed what was written then. Its files are written from the
 *    database, so they hold everything it does.
 *
 * At a close the files' fingerprint is recorded — so the next open trusts the database — only if every
 * file is as JaiRA left it (`fileLedger.ts`): one something else changed while JaiRA ran, a `git pull`,
 * leaves the fingerprint as it was, and the next open reads the files in.
 *
 * `"both"` — a persisted index beside a file truth — is retired: read as `"file"`, which is what it
 * now means.
 *
 * Watching the files while JaiRA runs, to read a `git pull` in as it lands, is separate work.
 */
import type { JairaDb } from "./db";
import { folderAsLeft, noteFolder } from "./fileLedger";
import type { JairaStorageConcern, JairaStorageConfig } from "@jaira/shared";

/**
 * Which tables each concern covers.
 *
 * The grouping is the point of concerns existing (DESIGN §4.4): a per-table setting would let
 * someone put `task_runtime` in a file and `runs` in the database, splitting one task's truth across
 * two stores with different durability and different merge behaviour, and nothing would catch it.
 *
 * `sessions` rides with `conversations` because it is the lineage a transcript hangs off — a fork
 * that lost its parent row is a conversation that silently truncates its inherited prefix.
 */
export const CONCERN_TABLES: Record<JairaStorageConcern, readonly string[]> = {
  journal: ["state_machine_events"],
  conversations: ["operation_records", "sessions", "session_names"],
  tasks: ["task_runtime"],
  artifacts: ["artifacts"],
};

/** Whether a mode keeps the concern in files too. `"both"`, retired, is read as `"file"`. */
export const isFileBacked = (mode: string): boolean => mode === "file" || mode === "both";

/**
 * What the files were when JaiRA last had them, per workspace and concern: size and mtime per file
 * (`fingerprintOf`), recorded at an import and at a close.
 */
const INDEX_TABLE = `CREATE TABLE IF NOT EXISTS storage_index (
  workspace   TEXT NOT NULL,
  concern     TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  built_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace, concern)
)`;

export function readFingerprint(db: JairaDb, workspace: string, concern: JairaStorageConcern): string | undefined {
  db.exec(INDEX_TABLE);
  const row = db.prepare(`SELECT fingerprint FROM storage_index WHERE workspace = ? AND concern = ?`).get(workspace, concern) as
    | { fingerprint: string }
    | undefined;
  return row?.fingerprint;
}

export function writeFingerprint(db: JairaDb, workspace: string, concern: JairaStorageConcern, fingerprint: string, at: number): void {
  db.exec(INDEX_TABLE);
  db.prepare(`INSERT OR REPLACE INTO storage_index (workspace, concern, fingerprint, built_at) VALUES (?, ?, ?, ?)`).run(
    workspace,
    concern,
    fingerprint,
    at,
  );
}

/**
 * Which of a concern table's rows are this workspace's (decision 0013 §4) — the database holds every
 * workspace's. A table keyed by task asks the task's owner; `sessions`, which carries no task, is the
 * lineage this workspace's records hang off, ancestors included.
 */
export function ownedRows(table: string): string {
  const owned = `SELECT task_id FROM main.task_owners WHERE workspace = :workspace`;
  if (table !== "sessions") return `task_id IN (${owned})`;
  return `id IN (
    WITH RECURSIVE lineage(id) AS (
      SELECT session_id FROM main.operation_records WHERE session_id IS NOT NULL AND task_id IN (${owned})
      UNION SELECT landed_session_id FROM main.operation_records WHERE landed_session_id IS NOT NULL AND task_id IN (${owned})
      UNION SELECT session_id FROM main.session_names WHERE task_id IN (${owned})
      UNION SELECT s.parent FROM main.sessions s JOIN lineage ON s.id = lineage.id WHERE s.parent IS NOT NULL
    ) SELECT id FROM lineage)`;
}

/**
 * Keys the database mints that an import lets it mint again: one workspace's journal is numbered
 * from one in its staging table, and the shared table already holds every other workspace's numbers.
 */
const MINTED: Record<string, string> = { state_machine_events: "seq", artifacts: "id" };

/**
 * A column list a caller may INSERT into — generated columns excluded (`pragma_table_info` omits
 * them; writing to one is an error).
 */
export function writableColumns(db: JairaDb, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>).map((c) => c.name);
}

/** Strip inline `REFERENCES parent(col)`: SQLite resolves a parent in the child's own database, and the parents are in `main`. */
function withoutForeignKeys(ddl: string): string {
  return ddl.replace(/\s+REFERENCES\s+[\w"`[\]]+\s*\([^)]*\)(\s+ON\s+(DELETE|UPDATE)\s+[A-Z ]+)*/gi, "");
}

/**
 * A `TEMP` staging copy of one table, for an import to replay files into: the same shape — copied
 * from `sqlite_master`, never restated, so it tracks migrations — with its indexes (a replay's upserts
 * conflict on them), without foreign keys and without the change log's triggers (what is logged is
 * the import into `main`). An unqualified name resolves to `temp` first, so a replay writes here
 * without knowing it. Returns false for a table the schema does not have.
 */
export function stageTable(db: JairaDb, table: string): boolean {
  const already = db.prepare(`SELECT 1 FROM temp.sqlite_master WHERE type='table' AND name=?`).get(table);
  if (already !== undefined) return true;
  const row = db.prepare(`SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?`).get(table) as { sql: string | null } | undefined;
  if (row?.sql == null) return false;
  db.exec(withoutForeignKeys(row.sql.replace(/^CREATE\s+TABLE/i, "CREATE TEMP TABLE")));
  const indexes = db.prepare(`SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(table) as Array<{ sql: string }>;
  for (const index of indexes) db.exec(index.sql);
  return true;
}

/** What a concern's fingerprint says when it was in the database alone while its files stood still. */
const STALE = "stale";

/** How one concern's files are read, written and fingerprinted. */
export interface ConcernFiles {
  /** The folder its files are in. */
  dir: string;
  /** Replay the files into the (staged) tables; `undefined` when there are none. */
  replay: () => number | undefined;
  /** What the files are now; `undefined` when there are none. */
  fingerprint: () => string | undefined;
  /** Write these tasks' files afresh from the database, replacing any they had; the rows written. */
  export: (taskIds: readonly string[]) => number;
}

/** What one {@link applyStorage} did, for a caller that reports or tests it. */
export interface StorageReport {
  /** Rows read in from files that moved since JaiRA last had them, per concern. */
  imported: Partial<Record<JairaStorageConcern, number>>;
  /** Rows written out to start a concern's files from the database, per concern. */
  exported: Partial<Record<JairaStorageConcern, number>>;
  /** Concerns whose files were as JaiRA left them: nothing read. */
  current: JairaStorageConcern[];
}

const ownedTasks = (db: JairaDb, workspace: string): string[] =>
  (db.prepare(`SELECT task_id FROM main.task_owners WHERE workspace = ? ORDER BY task_id`).all(workspace) as Array<{ task_id: string }>).map((r) => r.task_id);

/**
 * Bring the database up to every concern's files, at open, before anything reads (see the header).
 * A configuration with every concern in the database does nothing at all — the default.
 */
export function applyStorage(
  db: JairaDb,
  workspace: string,
  storage: JairaStorageConfig,
  files: Partial<Record<JairaStorageConcern, ConcernFiles>> = {},
  now: () => number = Date.now,
): StorageReport {
  const report: StorageReport = { imported: {}, exported: {}, current: [] };
  for (const [concern, tables] of Object.entries(CONCERN_TABLES) as Array<[JairaStorageConcern, readonly string[]]>) {
    const recorded = readFingerprint(db, workspace, concern);
    if (!isFileBacked(storage[concern])) {
      // In the database alone: files it had stop being kept, and are stale when it is put in them again.
      if (recorded !== undefined && recorded !== STALE) writeFingerprint(db, workspace, concern, STALE, now());
      continue;
    }
    const source = files[concern];
    if (source === undefined) continue;
    const fingerprint = source.fingerprint();
    if (fingerprint === undefined || recorded === STALE) {
      // Just put in files, or put in them again: they are written from everything the database holds.
      report.exported[concern] = source.export(ownedTasks(db, workspace));
      const written = source.fingerprint();
      if (written !== undefined) writeFingerprint(db, workspace, concern, written, now());
    } else if (recorded === fingerprint) {
      report.current.push(concern);
    } else {
      report.imported[concern] = importFiles(db, workspace, tables, source);
      writeFingerprint(db, workspace, concern, fingerprint, now());
    }
    // From here the files are as JaiRA leaves them, until something else changes one.
    noteFolder(source.dir);
  }
  return report;
}

/**
 * Replay a concern's files into staging tables, and replace in `main` the rows of every task they
 * speak for — children emptied first, parents filled first. A task no workspace owns yet is this
 * one's; one another workspace owns stays theirs, its rows untouched. `sessions`, which carries no
 * task, takes each session's state as the files have it. Returns the rows replayed.
 */
function importFiles(db: JairaDb, workspace: string, tables: readonly string[], source: ConcernFiles): number {
  const staged = tables.filter((table) => stageTable(db, table));
  let replayed = 0;
  try {
    db.transaction(() => {
      replayed = source.replay() ?? 0;
      const keyed = staged.filter((table) => table !== "sessions");
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS import_tasks (task_id TEXT PRIMARY KEY)`);
      db.exec(`DELETE FROM temp.import_tasks`);
      for (const table of keyed) db.exec(`INSERT OR IGNORE INTO temp.import_tasks SELECT DISTINCT task_id FROM temp."${table}" WHERE task_id IS NOT NULL`);
      db.prepare(`INSERT OR IGNORE INTO main.task_owners (task_id, workspace) SELECT task_id, ? FROM temp.import_tasks`).run(workspace);
      db.prepare(`DELETE FROM temp.import_tasks WHERE task_id NOT IN (SELECT task_id FROM main.task_owners WHERE workspace = ?)`).run(workspace);
      for (const table of [...keyed].reverse()) db.exec(`DELETE FROM main."${table}" WHERE task_id IN (SELECT task_id FROM temp.import_tasks)`);
      for (const table of staged) {
        const columns = writableColumns(db, table)
          .filter((c) => c !== MINTED[table])
          .map((c) => `"${c}"`)
          .join(", ");
        if (columns.length === 0) continue;
        if (table === "sessions") {
          const updates = writableColumns(db, table)
            .filter((c) => c !== "id")
            .map((c) => `"${c}" = excluded."${c}"`)
            .join(", ");
          db.exec(`INSERT INTO main.sessions (${columns}) SELECT ${columns} FROM temp.sessions WHERE true ORDER BY rowid ON CONFLICT(id) DO UPDATE SET ${updates}`);
        } else db.exec(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM temp."${table}" WHERE task_id IN (SELECT task_id FROM temp.import_tasks) ORDER BY rowid`);
      }
    })();
  } finally {
    for (const table of [...staged, "import_tasks"]) db.exec(`DROP TABLE IF EXISTS temp."${table}"`);
  }
  return replayed;
}

/**
 * At a close: record what every concern's files are now, so the next open trusts the database — for
 * each concern whose files are all as JaiRA left them. One that something else changed keeps the
 * fingerprint it had, so the next open reads its files in.
 */
export function keepFingerprints(
  db: JairaDb,
  workspace: string,
  storage: JairaStorageConfig,
  files: Partial<Record<JairaStorageConcern, ConcernFiles>>,
  now: () => number = Date.now,
): void {
  for (const concern of Object.keys(CONCERN_TABLES) as JairaStorageConcern[]) {
    if (!isFileBacked(storage[concern])) continue;
    const source = files[concern];
    if (source === undefined || !folderAsLeft(source.dir)) continue;
    const fingerprint = source.fingerprint();
    if (fingerprint !== undefined) writeFingerprint(db, workspace, concern, fingerprint, now());
  }
}
