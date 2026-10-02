/**
 * The schema steps after the baseline (`migrations.ts`), each run against a database in the shape the
 * step before it left — built here by hand, since `SCHEMA` now creates the shape after them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { MIGRATIONS, migrate, read, SCHEMA_BASELINE } from "../src/migrations";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-migrate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("step 25 (decision 0016)", () => {
  it("turns the watcher's checks into pipelines and renames the remote events a task waits on", () => {
    const file = join(dir, "jaira.db");
    // The three tables as the baseline made them.
    const old = new Database(file);
    old.exec(`
      CREATE TABLE repo_watch_cursors (workspace TEXT NOT NULL DEFAULT '', remote TEXT NOT NULL, repository TEXT NOT NULL, cursor_json TEXT NOT NULL DEFAULT '{}', last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace, remote, repository));
      CREATE TABLE repo_watch_seen (workspace TEXT NOT NULL DEFAULT '', remote TEXT NOT NULL, repository TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('merge_request', 'branch', 'checks')), key TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace, remote, repository, kind, key));
      CREATE TABLE event_waits (task_id TEXT NOT NULL, name TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (task_id, name));
      INSERT INTO repo_watch_cursors VALUES ('w', 'origin', 'gitlab.com/a/b', '{"branches":true,"checks":true}', NULL, 1);
      INSERT INTO repo_watch_seen VALUES ('w', 'origin', 'gitlab.com/a/b', 'checks', 'main', '{"sha":"a1","done":false,"since":5}', 1);
      INSERT INTO repo_watch_seen VALUES ('w', 'origin', 'gitlab.com/a/b', 'branch', 'main', '{"head":"a1"}', 1);
      INSERT INTO event_waits VALUES ('t-1', 'git.checks.failed', 1), ('t-1', 'git.merge_request.comments', 1), ('t-2', 'git.push', 1), ('t-2', 'task.finished', 1);
    `);
    old.pragma(`user_version = ${SCHEMA_BASELINE}`);

    expect(migrate(old, MIGRATIONS.filter((step) => step.version === 25))).toBe(25);
    expect(old.prepare(`SELECT kind, key, state_json FROM repo_watch_seen ORDER BY kind`).all()).toEqual([
      { kind: "branch", key: "main", state_json: '{"head":"a1"}' },
      { kind: "pipelines", key: "main", state_json: '{"sha":"a1","done":false,"since":5}' },
    ]);
    expect(JSON.parse((old.prepare(`SELECT cursor_json FROM repo_watch_cursors`).get() as { cursor_json: string }).cursor_json)).toEqual({ branches: true, pipelines: true });
    expect((old.prepare(`SELECT task_id, name FROM event_waits ORDER BY task_id, name`).all() as Array<{ task_id: string; name: string }>).map((row) => `${row.task_id} ${row.name}`)).toEqual([
      "t-1 merge_request.commented",
      "t-1 pipeline.failed",
      "t-2 git.pushed",
      "t-2 task.finished",
    ]);
    // The old kind is no longer a kind.
    expect(() => old.prepare(`INSERT INTO repo_watch_seen VALUES ('w', 'origin', 'x', 'checks', 'k', '{}', 1)`).run()).toThrow(/CHECK constraint/);
    old.close();
  });

  it("is where a new database starts, with the same constraint", () => {
    const db = openDb(join(dir, "fresh.db"));
    expect(read(db)).toBe(Math.max(SCHEMA_BASELINE, ...MIGRATIONS.map((step) => step.version)));
    expect(() => db.prepare(`INSERT INTO repo_watch_seen VALUES ('w', 'origin', 'x', 'checks', 'k', '{}', 1)`).run()).toThrow(/CHECK constraint/);
    db.prepare(`INSERT INTO repo_watch_seen VALUES ('w', 'origin', 'x', 'pipelines', 'k', '{}', 1)`).run();
    db.close();
  });
});
