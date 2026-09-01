/**
 * Shadow tables — the read half of DESIGN §4.4.
 *
 * The claim the whole design rests on is that a file-backed concern reaches the runtime with NO
 * query edited: a `TEMP` table of the same name is created, and SQLite resolves an unqualified name
 * to `temp` before `main`. That claim is cheap to state and easy to get subtly wrong — a generated
 * column that stops being generated, an index that does not come across, a foreign key that turns
 * every insert into an error — so each half of it is pinned here rather than assumed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, parseConfig, type JairaStorageConfig } from "@jaira/shared";
import { openDb, type JairaDb } from "../src/db";
import { applyStorage, CONCERN_TABLES, seedFromMain, shadowTable, shadowedTables, writableColumns } from "../src/shadow";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-shadow-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const storageOf = (over: Partial<JairaStorageConfig>): JairaStorageConfig => ({ ...defaultConfig().storage, ...over });

/** A run to hang journal rows off — `state_machine_events.run_id` names one. */
function seedRun(): number {
  db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES ('t1','running',1,1)`).run();
  const info = db.prepare(`INSERT INTO runs (task_id, snapshot_hash, started_at) VALUES ('t1','h',1)`).run();
  return Number(info.lastInsertRowid);
}

const event = (runId: number, payload: object): void =>
  void db
    .prepare(
      `INSERT INTO state_machine_events (task_id, run_id, type, payload_json, created_at)
       VALUES ('t1', ?, 'operation.completed', ?, 1)`,
    )
    .run(runId, JSON.stringify(payload));

describe("what a shadow stands in front of", () => {
  it("serves an unqualified read while main stays reachable — the claim every query rests on", () => {
    const runId = seedRun();
    event(runId, { operationId: "in-main" });
    shadowTable(db, "state_machine_events");
    event(runId, { operationId: "in-shadow" });

    // Not one query in the codebase says `temp.` — this is why they do not have to.
    expect(db.prepare(`SELECT payload_json FROM state_machine_events`).all()).toEqual([
      { payload_json: JSON.stringify({ operationId: "in-shadow" }) },
    ]);
    // And the real table is still there, which is what the seed reads and what a diagnostic would.
    expect(db.prepare(`SELECT payload_json FROM main.state_machine_events`).all()).toEqual([
      { payload_json: JSON.stringify({ operationId: "in-main" }) },
    ]);
  });

  it("brings the generated columns, which is what lets a join keep working", () => {
    // `operation_id` and `session_ref` are `GENERATED ALWAYS AS (json_extract(payload_json, …))`.
    // Copied as declarations rather than as values, so they recompute on insert into the shadow —
    // and the two indexes over them mean the same thing they did.
    const runId = seedRun();
    shadowTable(db, "state_machine_events");
    event(runId, { operationId: "op-7" });

    expect(db.prepare(`SELECT operation_id FROM state_machine_events WHERE operation_id = 'op-7'`).all()).toEqual([
      { operation_id: "op-7" },
    ]);
  });

  it("brings the indexes, so a shadowed table is not a table scan", () => {
    seedRun();
    shadowTable(db, "state_machine_events");
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM state_machine_events WHERE task_id = 't1'`)
      .all() as Array<{ detail: string }>;

    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX state_machine_events_task/);
  });

  it("drops the foreign keys, because a temp child cannot resolve a main parent", () => {
    // Not a weaker constraint — an error on every insert. SQLite looks for the parent in the child's
    // own database, so `state_machine_events.run_id REFERENCES runs(id)` would look for `temp.runs`.
    // The honest reading: choosing `file` for a concern gives up the referential integrity SQLite
    // was enforcing for it, which nothing could preserve once half the rows live in a merged file.
    shadowTable(db, "state_machine_events");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => event(4242, { operationId: "no such run" })).not.toThrow();
  });

  it("keeps every constraint that is about one row", () => {
    // Primary keys, uniqueness, NOT NULL and defaults all survive — they remain enforceable, and
    // the `op_position` partial index over `operation_records` IS the position claim now
    // (migration 14 folded positions into the request).
    shadowTable(db, "operation_records");
    const claim = (id: string, seq: number): void =>
      void db
        .prepare(
          `INSERT INTO operation_records (id, task_id, run_id, status, request_json, started_at)
           VALUES (?, 't1', 1, 'open', ?, 1)`,
        )
        .run(id, JSON.stringify({ session: { id: "conv", seq } }));
    claim("r:0", 0);
    expect(() => claim("r:0b", 0)).toThrow(/UNIQUE/);
    claim("r:1", 1);
  });

  it("is idempotent, so a caller may ask twice without checking", () => {
    expect(shadowTable(db, "artifacts")).toBe(true);
    expect(shadowTable(db, "artifacts")).toBe(true);
    // False, not a throw: a name the schema does not have is what a concern naming a table some
    // future migration removed would look like.
    expect(shadowTable(db, "no_such_table")).toBe(false);
  });
});

describe("seeding from main — the flip path", () => {
  it("copies the rows already in the database, identities included", () => {
    // Turning a concern from `db` to `file` has to start from what is already there, or the first
    // open after the change looks like the history was deleted.
    const runId = seedRun();
    event(runId, { operationId: "a" });
    event(runId, { operationId: "b" });
    shadowTable(db, "state_machine_events");

    expect(seedFromMain(db, "state_machine_events")).toBe(2);
    // `seq` is carried explicitly rather than re-minted, so a seed changes no identity. A replay
    // from a FILE is the case that cannot promise that — which is why nothing points at a rowid.
    expect(db.prepare(`SELECT seq, operation_id FROM state_machine_events ORDER BY seq`).all()).toEqual([
      { seq: 1, operation_id: "a" },
      { seq: 2, operation_id: "b" },
    ]);
  });

  it("excludes generated columns, which cannot be written to", () => {
    // The reason a seed is not `INSERT … SELECT *`: `SELECT *` includes them and the INSERT is then
    // an error, so the column list comes from `pragma_table_info`, which omits them.
    expect(writableColumns(db, "state_machine_events")).not.toContain("operation_id");
    expect(writableColumns(db, "state_machine_events")).toContain("payload_json");
  });
});

describe("applyStorage", () => {
  it("does nothing at all when everything is in the database, which is the default", () => {
    expect(applyStorage(db, defaultConfig().storage)).toEqual({ shadowed: [], seeded: {}, replayed: {}, reused: [] });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM temp.sqlite_master`).get()).toEqual({ n: 0 });
  });

  it("shadows a concern's whole table group, not one table of it", () => {
    // The grouping is the point of concerns: `task_runtime` in a file and `runs` in the database
    // would split one task's truth across two stores with different durability.
    expect(shadowedTables(storageOf({ tasks: "file" }))).toEqual([...CONCERN_TABLES.tasks]);
    expect(shadowedTables(storageOf({ conversations: "both" }))).toEqual([...CONCERN_TABLES.conversations]);
  });

  it("treats `both` as file-backed, because it is the same truth plus a persisted index", () => {
    expect(applyStorage(db, storageOf({ artifacts: "both" })).shadowed).toEqual(["artifacts"]);
  });

  it("reports what it shadowed and what it carried over", () => {
    const runId = seedRun();
    event(runId, { operationId: "carried" });

    const report = applyStorage(db, parseConfig({ storage: { journal: "file" } }).storage);
    expect(report.shadowed).toEqual(["state_machine_events"]);
    expect(report.seeded).toEqual({ state_machine_events: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM state_machine_events`).get()).toEqual({ n: 1 });
  });
});
