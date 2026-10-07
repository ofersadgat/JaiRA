/**
 * Replicas of other machines' workspaces (decision 0013 §6).
 *
 * A task has one owner — the engine whose workspace made it — and only the owner writes it. An engine
 * serving a window keeps a copy of every paired machine's tasks in its own database, owned there by
 * the remote workspace's id (see `workspace.ts`), with the files that go with them (task files,
 * snapshots) under `<base>/remote/<machine>/<workspace>/`, laid out as a workspace so the ordinary
 * views read it. This module is both halves of the exchange, and knows nothing of how it travels:
 *
 *  - **The owner** answers "what changed since what I hold" ({@link exportChanges}): per task, a
 *    version that moves when anything the window shows of it moves, and when it has, the task's rows —
 *    its journal only from where the replica stopped, unless a rewind took rows out from under it.
 *    Big strings stay behind as blob hashes; the replica asks for the ones it lacks ({@link readBlobs}).
 *  - **The replica** lays each bundle over what it had ({@link importTask}), re-minting journal
 *    numbers as they land and remembering the map, and drops a task the owner no longer lists — a
 *    delete the person made there ({@link removeReplicaTask}).
 *
 * A prune on the owner is not a delete (ruling 11): a task the owner still lists whose whole history
 * is gone keeps its history here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { JsonValue } from "@declarative-ai/json";
import type { JairaDb } from "./db";
import { release } from "./blobStore";
import type { Project } from "./project";
import { writableColumns } from "./fileStorage";
import { ownerOf, OWNED_BY } from "./workspace";

type Row = Record<string, unknown>;

/** What a replica holds of one task, as it tells the owner. */
export interface ReplicaKnown {
  /** The owner's version when it was last copied. */
  v: string;
  /** The last of the owner's journal numbers it holds. */
  seq: number;
  /** How many of the owner's journal rows it holds — a rewind on the owner makes the two disagree. */
  events: number;
}

/** One task, as the owner sends it. */
export interface TaskBundle {
  taskId: string;
  version: string;
  /** The task file. */
  meta?: JsonValue;
  runtime: Row;
  /** The owner's journal rows, `seq` in the owner's numbers. */
  events: Row[];
  /** Whether {@link events} is the whole journal, or only what follows the replica's `seq`. */
  full: boolean;
  records: Row[];
  sessions: Row[];
  sessionNames: Row[];
  artifacts: Row[];
  commands: Row[];
  interactions: Row[];
  /** Every blob the records name. */
  blobs: string[];
  /** The snapshot the task runs under, when it has one. */
  snapshot?: string;
}

/** One answer to "what changed". */
export interface ReplicaPage {
  /** The owner's workspace id. */
  workspace: string;
  /** Every task the owner has now — what the replica does not find here was deleted there. */
  present: string[];
  tasks: TaskBundle[];
  /** More changed tasks than fitted: ask again. */
  more: boolean;
}

// --- the owner --------------------------------------------------------------------------------------

/** A version of everything the window shows of a task: any change to any of it moves this. */
export function taskVersion(project: Project, taskId: string): string {
  const row = project.db
    .prepare(
      `SELECT
         (SELECT updated_at || ':' || status FROM task_runtime WHERE task_id = :t) AS runtime,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(seq), 0) FROM state_machine_events WHERE task_id = :t) AS journal,
         (SELECT COUNT(*) || ':' || COALESCE(SUM(LENGTH(result_json)), 0) || ':' || COALESCE(MAX(COALESCE(ended_at, started_at)), 0)
                 || ':' || COALESCE(SUM(status = 'open'), 0) FROM operation_records WHERE task_id = :t) AS records,
         (SELECT COUNT(*) FROM pending_interactions WHERE task_id = :t) AS gates,
         (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), 0) FROM artifacts WHERE task_id = :t) AS artifacts,
         (SELECT COUNT(*) FROM session_names WHERE task_id = :t) AS names`,
    )
    .get({ t: taskId }) as Record<string, string | number | null>;
  let file = "";
  try {
    const stat = statSync(join(project.paths.tasksDir, `${taskId}.json`));
    file = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    // No file: a task whose file went missing still has rows worth copying.
  }
  return [row["runtime"], row["journal"], row["records"], row["gates"], row["artifacts"], row["names"], file].join("|");
}

function rows(db: JairaDb, table: string, where: string, params: unknown[]): Row[] {
  const columns = writableColumns(db, table).map((c) => `"${c}"`).join(", ");
  return db.prepare(`SELECT ${columns} FROM "${table}" WHERE ${where}`).all(...params) as Row[];
}

/** The blob hashes a stored JSON value names. */
function blobsIn(text: unknown, into: Set<string>): void {
  if (typeof text !== "string" || !text.includes('"$blob"')) return;
  for (const match of text.matchAll(/"\$blob"\s*:\s*"([0-9a-f]{64})"/g)) into.add(match[1]!);
}

/** One task's rows, its journal from where the replica stopped. */
export function exportTask(project: Project, taskId: string, known?: ReplicaKnown): TaskBundle | undefined {
  const db = project.db;
  const runtime = rows(db, "task_runtime", "task_id = ?", [taskId])[0];
  if (runtime === undefined) return undefined;
  // Incremental only when the replica's journal is still a prefix of this one: a rewind removes rows
  // below its `seq`, and then only the whole journal says what is left.
  const kept = known === undefined ? -1 : (db.prepare(`SELECT COUNT(*) AS n FROM state_machine_events WHERE task_id = ? AND seq <= ?`).get(taskId, known.seq) as { n: number }).n;
  const full = known === undefined || kept !== known.events;
  const events = rows(db, "state_machine_events", full ? "task_id = ? ORDER BY seq" : "task_id = ? AND seq > ? ORDER BY seq", full ? [taskId] : [taskId, known!.seq]);
  const records = rows(db, "operation_records", "task_id = ?", [taskId]);
  const blobs = new Set<string>();
  for (const record of records) {
    blobsIn(record["request_json"], blobs);
    blobsIn(record["result_json"], blobs);
  }
  const sessions = rows(
    db,
    "sessions",
    `id IN (
       WITH RECURSIVE lineage(id) AS (
         SELECT session_id FROM operation_records WHERE session_id IS NOT NULL AND task_id = :t
         UNION SELECT landed_session_id FROM operation_records WHERE landed_session_id IS NOT NULL AND task_id = :t
         UNION SELECT session_id FROM session_names WHERE task_id = :t
         UNION SELECT s.parent FROM sessions s JOIN lineage ON s.id = lineage.id WHERE s.parent IS NOT NULL
       ) SELECT id FROM lineage)`,
    [{ t: taskId }],
  );
  let meta: JsonValue | undefined;
  try {
    meta = JSON.parse(readFileSync(join(project.paths.tasksDir, `${taskId}.json`), "utf8")) as JsonValue;
  } catch {
    meta = undefined;
  }
  const snapshot = typeof runtime["snapshot_hash"] === "string" ? (runtime["snapshot_hash"] as string) : undefined;
  return {
    taskId,
    version: taskVersion(project, taskId),
    ...(meta !== undefined ? { meta } : {}),
    runtime,
    events,
    full,
    records,
    sessions,
    sessionNames: rows(db, "session_names", "task_id = ?", [taskId]),
    artifacts: rows(db, "artifacts", "task_id = ?", [taskId]).map(({ id: _id, ...rest }) => rest),
    commands: rows(db, "command_log", "task_id = ?", [taskId]).map(({ id: _id, ...rest }) => rest),
    interactions: rows(db, "pending_interactions", "task_id = ?", [taskId]),
    blobs: [...blobs],
    ...(snapshot !== undefined ? { snapshot } : {}),
  };
}

/**
 * What changed since what the replica holds, a page at a time: bundles until `budget` characters of
 * JSON or `limit` tasks, whichever comes first, and `more` when some were left for the next ask.
 */
export function exportChanges(
  project: Project,
  known: Record<string, ReplicaKnown>,
  opts: {
    limit?: number;
    budget?: number;
    archived?: boolean;
    /** Only these tasks are looked at for changes — a push named them. `present` is still every task. */
    only?: readonly string[];
  } = {},
): ReplicaPage {
  const limit = opts.limit ?? 25;
  const budget = opts.budget ?? 8_000_000;
  // Archived tasks only when the replica copies everything: otherwise one archived here is not in
  // `present`, which is what takes it out of the copy (the person, 2026-09-27).
  const present = project.runtime
    .list()
    .filter((row) => opts.archived !== false || row.status !== "archived")
    .map((row) => row.taskId);
  const tasks: TaskBundle[] = [];
  let used = 0;
  let more = false;
  const looked = opts.only === undefined ? present : present.filter((taskId) => opts.only!.includes(taskId));
  for (const taskId of looked) {
    const held = known[taskId];
    if (held !== undefined && held.v === taskVersion(project, taskId)) continue;
    if (tasks.length >= limit || used >= budget) {
      more = true;
      break;
    }
    const bundle = exportTask(project, taskId, held);
    if (bundle === undefined) continue;
    used += JSON.stringify(bundle).length;
    tasks.push(bundle);
  }
  return { workspace: project.workspace, present, tasks, more };
}

/** The bytes behind some blob hashes, for a replica that lacks them. */
export function readBlobs(db: JairaDb, hashes: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const read = db.prepare(`SELECT content FROM blobs WHERE hash = ?`);
  for (const hash of hashes) {
    const row = read.get(hash) as { content: string } | undefined;
    if (row !== undefined) out[hash] = row.content;
  }
  return out;
}

/** A snapshot's files, base64 by path relative to it — or nothing, when there is no such snapshot. */
export function snapshotFiles(project: Project, hash: string): Record<string, string> {
  if (!/^[0-9a-f]{8,}$/i.test(hash)) return {};
  const root = join(project.paths.snapshotsDir, hash);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path).split(sep).join("/")] = readFileSync(path).toString("base64");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

// --- the replica ------------------------------------------------------------------------------------

/** Where a replica's files go: the layout of a workspace's `.jaira/system/`. */
export interface ReplicaDirs {
  tasksDir: string;
  snapshotsDir: string;
}

/** What this database holds of a remote workspace's tasks, keyed as {@link exportChanges} wants it. */
export function replicaKnown(db: JairaDb, workspace: string): Record<string, ReplicaKnown> {
  const out: Record<string, ReplicaKnown> = {};
  for (const row of db.prepare(`SELECT task_id, version, seq, events FROM replica_versions WHERE workspace = ?`).all(workspace) as Array<{ task_id: string; version: string; seq: number; events: number }>) {
    out[row.task_id] = { v: row.version, seq: row.seq, events: row.events };
  }
  return out;
}

/** The blob hashes of a page this database does not have. */
export function missingBlobs(db: JairaDb, page: Pick<ReplicaPage, "tasks">): string[] {
  const has = db.prepare(`SELECT 1 FROM blobs WHERE hash = ?`);
  return [...new Set(page.tasks.flatMap((t) => t.blobs))].filter((hash) => has.get(hash) === undefined);
}

/** Whether a snapshot's files are already here. */
export function hasSnapshot(dirs: ReplicaDirs, hash: string): boolean {
  return existsSync(join(dirs.snapshotsDir, hash));
}

/** Write a snapshot's files, as {@link snapshotFiles} sent them. */
export function writeSnapshot(dirs: ReplicaDirs, hash: string, files: Record<string, string>): void {
  if (!/^[0-9a-f]{8,}$/i.test(hash)) return;
  const root = join(dirs.snapshotsDir, hash);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    if (!target.startsWith(root + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(content, "base64"));
  }
}

function insert(db: JairaDb, table: string, row: Row, verb = "INSERT"): number | bigint {
  const columns = writableColumns(db, table).filter((c) => c in row);
  if (columns.length === 0) return 0;
  return db
    .prepare(`${verb} INTO main."${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((c) => row[c] as never)).lastInsertRowid;
}

/** Let go of the blobs a task's records here name, before the records go. */
function releaseRecords(db: JairaDb, taskId: string): void {
  for (const row of db.prepare(`SELECT result_json, request_json FROM main.operation_records WHERE task_id = ?`).all(taskId) as Array<{ result_json: string | null; request_json: string | null }>) {
    for (const text of [row.result_json, row.request_json]) if (text !== null) release(db, JSON.parse(text) as JsonValue);
  }
}

/**
 * Lay one bundle over what this database held of the task.
 *
 * `blobs` are the bytes of the hashes it lacked ({@link missingBlobs}). Returns false for a task this
 * database already has under another owner — a local clone ran the same task id — which is left alone.
 */
export function importTask(db: JairaDb, workspace: string, bundle: TaskBundle, blobs: Record<string, string>, dirs: ReplicaDirs, nowMs = Date.now()): boolean {
  const owner = ownerOf(db, bundle.taskId);
  if (owner !== undefined && owner !== workspace) return false;
  const id = bundle.taskId;
  db.transaction(() => {
    // Rows are replaced parent and child alike, in whatever order they come.
    db.pragma("defer_foreign_keys = ON");
    db.prepare(`INSERT OR IGNORE INTO task_owners (task_id, workspace) VALUES (?, ?)`).run(id, workspace);
    const addBlob = db.prepare(`INSERT INTO blobs (hash, content, bytes, refs, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(hash) DO NOTHING`);
    for (const [hash, content] of Object.entries(blobs)) addBlob.run(hash, content, content.length, nowMs);

    const localOf = db.prepare(`SELECT local_seq FROM replica_seqs WHERE workspace = ? AND remote_seq = ?`);
    const mapSeq = (remote: unknown): number | null =>
      typeof remote === "number" ? ((localOf.get(workspace, remote) as { local_seq: number } | undefined)?.local_seq ?? null) : null;

    const held = (db.prepare(`SELECT COUNT(*) AS n FROM main.state_machine_events WHERE task_id = ?`).get(id) as { n: number }).n;
    // The owner pruned it: the task is still there and its whole history is not. Kept here (ruling 11).
    const pruned = bundle.full && bundle.events.length === 0 && bundle.records.length === 0 && held > 0;

    if (bundle.full && !pruned) {
      db.prepare(`DELETE FROM replica_seqs WHERE workspace = ? AND local_seq IN (SELECT seq FROM main.state_machine_events WHERE task_id = ?)`).run(workspace, id);
      db.prepare(`DELETE FROM main.state_machine_events WHERE task_id = ?`).run(id);
    }
    const mapped = db.prepare(`INSERT OR REPLACE INTO replica_seqs (workspace, remote_seq, local_seq) VALUES (?, ?, ?)`);
    for (const event of bundle.events) {
      const { seq, ...rest } = event;
      const local = insert(db, "state_machine_events", rest);
      mapped.run(workspace, seq as number, Number(local));
    }
    // After the journal, so a fork's own boundary maps; its cut names the parent's, copied before it.
    const runtime = { ...bundle.runtime, forked_at_seq: mapSeq(bundle.runtime["forked_at_seq"]), fork_boundary_seq: mapSeq(bundle.runtime["fork_boundary_seq"]) };
    db.prepare(`DELETE FROM main.task_runtime WHERE task_id = ?`).run(id);
    insert(db, "task_runtime", runtime);

    if (!pruned) {
      releaseRecords(db, id);
      db.prepare(`DELETE FROM main.operation_records WHERE task_id = ?`).run(id);
      const retain = db.prepare(`UPDATE blobs SET refs = refs + 1 WHERE hash = ?`);
      for (const record of bundle.records) {
        insert(db, "operation_records", record);
        const named = new Set<string>();
        blobsIn(record["request_json"], named);
        blobsIn(record["result_json"], named);
        for (const hash of named) retain.run(hash);
      }
      db.prepare(`DELETE FROM main.command_log WHERE task_id = ?`).run(id);
      for (const row of bundle.commands) insert(db, "command_log", row);
    }
    for (const session of bundle.sessions) {
      const columns = writableColumns(db, "sessions").filter((c) => c in session);
      db.prepare(
        `INSERT INTO main.sessions (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
         ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== "id").map((c) => `"${c}" = excluded."${c}"`).join(", ")}`,
      ).run(...columns.map((c) => session[c] as never));
    }
    db.prepare(`DELETE FROM main.session_names WHERE task_id = ?`).run(id);
    for (const row of bundle.sessionNames) insert(db, "session_names", row);
    db.prepare(`DELETE FROM main.artifacts WHERE task_id = ?`).run(id);
    for (const row of bundle.artifacts) insert(db, "artifacts", row);
    db.prepare(`DELETE FROM main.pending_interactions WHERE task_id = ?`).run(id);
    for (const row of bundle.interactions) insert(db, "pending_interactions", row);

    const seqs = bundle.events.map((e) => e["seq"] as number);
    const before = bundle.full ? { seq: 0, events: 0 } : (db.prepare(`SELECT seq, events FROM replica_versions WHERE workspace = ? AND task_id = ?`).get(workspace, id) as { seq: number; events: number } | undefined) ?? { seq: 0, events: 0 };
    const after = pruned
      ? { seq: 0, events: 0 }
      : { seq: seqs.length > 0 ? Math.max(before.seq, ...seqs) : before.seq, events: before.events + bundle.events.length };
    db.prepare(
      `INSERT INTO replica_versions (workspace, task_id, version, seq, events, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace, task_id) DO UPDATE SET version = excluded.version, seq = excluded.seq, events = excluded.events, updated_at = excluded.updated_at`,
    ).run(workspace, id, bundle.version, after.seq, after.events, nowMs);
  })();
  if (bundle.meta !== undefined) {
    mkdirSync(dirs.tasksDir, { recursive: true });
    writeFileSync(join(dirs.tasksDir, `${id}.json`), `${JSON.stringify(bundle.meta, null, 2)}\n`, "utf8");
  }
  return true;
}

/** Take a task out of a replica: the owner no longer has it, because a person deleted it there. */
export function removeReplicaTask(db: JairaDb, workspace: string, taskId: string, dirs: ReplicaDirs): void {
  if (ownerOf(db, taskId) !== workspace) return;
  db.transaction(() => {
    db.pragma("defer_foreign_keys = ON");
    releaseRecords(db, taskId);
    db.prepare(`DELETE FROM replica_seqs WHERE workspace = ? AND local_seq IN (SELECT seq FROM main.state_machine_events WHERE task_id = ?)`).run(workspace, taskId);
    for (const table of ["state_machine_events", "operation_records", "session_names", "artifacts", "command_log", "pending_interactions", "task_runtime"]) {
      db.prepare(`DELETE FROM main."${table}" WHERE task_id = ?`).run(taskId);
    }
    db.prepare(`DELETE FROM replica_versions WHERE workspace = ? AND task_id = ?`).run(workspace, taskId);
    db.prepare(`DELETE FROM task_owners WHERE task_id = ?`).run(taskId);
  })();
  rmSync(join(dirs.tasksDir, `${taskId}.json`), { force: true });
}

/** Apply one page: every bundle, then the deletes it implies. Returns the ids it changed. */
export function applyPage(db: JairaDb, page: ReplicaPage, blobs: Record<string, string>, dirs: ReplicaDirs): string[] {
  const changed: string[] = [];
  // Parents first where a fork's cut names its parent's journal: by creation, as the owner made them.
  const ordered = [...page.tasks].sort((a, b) => Number(a.runtime["created_at"] ?? 0) - Number(b.runtime["created_at"] ?? 0));
  for (const bundle of ordered) if (importTask(db, page.workspace, bundle, blobs, dirs)) changed.push(bundle.taskId);
  if (!page.more) {
    const present = new Set(page.present);
    for (const taskId of Object.keys(replicaKnown(db, page.workspace))) {
      if (present.has(taskId)) continue;
      removeReplicaTask(db, page.workspace, taskId, dirs);
      changed.push(taskId);
    }
  }
  return changed;
}

/** Take a whole workspace out of the copies: every task of it, its files, and its registration. */
export function dropReplicaWorkspace(db: JairaDb, workspace: string, dirs: ReplicaDirs): number {
  const tasks = Object.keys(replicaKnown(db, workspace));
  for (const taskId of tasks) removeReplicaTask(db, workspace, taskId, dirs);
  db.prepare(`DELETE FROM replica_seqs WHERE workspace = ?`).run(workspace);
  db.prepare(`DELETE FROM workspaces WHERE id = ? AND machine IS NOT NULL`).run(workspace);
  return tasks.length;
}

/** The tasks a replica holds of a workspace, for a caller that wants to count them. */
export function replicaTasks(db: JairaDb, workspace: string): string[] {
  return (db.prepare(`SELECT task_id FROM task_runtime WHERE ${OWNED_BY}`).all(workspace) as Array<{ task_id: string }>).map((r) => r.task_id);
}
