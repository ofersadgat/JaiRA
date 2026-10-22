/**
 * A concern kept in files too (DESIGN §4.4, decision 0018 §11): the database is the truth; files are
 * read at open only when they moved since JaiRA last had them, and staged before they are brought in.
 *
 * The staging copy is a `TEMP` table of the same name, which an unqualified name resolves to first —
 * so a replay writes there without a query edited. Its shape is copied, never restated, so each part
 * of that claim is pinned here: a generated column that stops being generated, an index that does not
 * come across, a foreign key that turns every insert into an error.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, parseConfig, type JairaStorageConfig } from "@jaira/shared";
import { openDb, type JairaDb } from "../src/db";
import { applyStorage, keepFingerprints, stageTable, writableColumns, type ConcernFiles } from "../src/fileStorage";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-file-storage-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const storageOf = (over: Partial<JairaStorageConfig>): JairaStorageConfig => ({ ...defaultConfig().storage, ...over });

function seedTask(taskId = "t1", workspace = "w"): void {
  db.prepare(`INSERT INTO task_runtime (task_id, status, created_at, updated_at) VALUES (?,'running',1,1)`).run(taskId);
  db.prepare(`INSERT INTO task_owners (task_id, workspace) VALUES (?, ?)`).run(taskId, workspace);
}

const event = (payload: object, taskId = "t1"): void =>
  void db
    .prepare(`INSERT INTO state_machine_events (task_id, type, payload_json, created_at) VALUES (?, 'operation.completed', ?, 1)`)
    .run(taskId, JSON.stringify(payload));

const ops = (taskId: string): unknown[] =>
  (db.prepare(`SELECT operation_id FROM main.state_machine_events WHERE task_id = ? ORDER BY seq`).all(taskId) as Array<{ operation_id: string }>).map((r) => r.operation_id);

/** A journal's files, in memory: the events each task's file holds, and what writing them does. */
function journalFiles(files: Map<string, string[]>): ConcernFiles {
  return {
    // A folder nothing writes: the ledger finds it as left. The files themselves are in memory.
    dir: join(dir, "no-files-here"),
    replay: () => {
      if (files.size === 0) return undefined;
      let n = 0;
      for (const [taskId, said] of files) for (const operationId of said) (event({ operationId }, taskId), n++);
      return n;
    },
    fingerprint: () => (files.size === 0 ? undefined : JSON.stringify([...files])),
    export: (taskIds) => {
      let n = 0;
      for (const taskId of taskIds) {
        const said = ops(taskId) as string[];
        if (said.length === 0) continue;
        files.set(taskId, said);
        n += said.length;
      }
      return n;
    },
  };
}

describe("a staging table", () => {
  it("takes an unqualified write while main stays reachable", () => {
    seedTask();
    event({ operationId: "in-main" });
    stageTable(db, "state_machine_events");
    event({ operationId: "staged" });
    expect(db.prepare(`SELECT payload_json FROM state_machine_events`).all()).toEqual([{ payload_json: JSON.stringify({ operationId: "staged" }) }]);
    expect(db.prepare(`SELECT payload_json FROM main.state_machine_events`).all()).toEqual([{ payload_json: JSON.stringify({ operationId: "in-main" }) }]);
  });

  it("brings the generated columns and the indexes", () => {
    stageTable(db, "state_machine_events");
    event({ operationId: "op-7" });
    expect(db.prepare(`SELECT operation_id FROM state_machine_events WHERE operation_id = 'op-7'`).all()).toEqual([{ operation_id: "op-7" }]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM state_machine_events WHERE task_id = 't1'`).all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/USING INDEX state_machine_events_task/);
  });

  it("drops the foreign keys, whose parents are in main, and keeps every constraint about one row", () => {
    db.prepare(`INSERT INTO sessions (id, cursor, created_at) VALUES ('parent-in-main', 0, 1)`).run();
    stageTable(db, "sessions");
    expect(() => db.prepare(`INSERT INTO sessions (id, parent, cursor, created_at) VALUES ('child', 'parent-in-main', 0, 2)`).run()).not.toThrow();
    stageTable(db, "operation_records");
    const claim = (id: string, seq: number): void =>
      void db.prepare(`INSERT INTO operation_records (id, task_id, status, request_json, started_at) VALUES (?, 't1', 'open', ?, 1)`).run(id, JSON.stringify({ session: { id: "conv", seq } }));
    claim("r:0", 0);
    expect(() => claim("r:0b", 0)).toThrow(/UNIQUE/);
  });

  it("is idempotent, and false for a table the schema does not have", () => {
    expect(stageTable(db, "artifacts")).toBe(true);
    expect(stageTable(db, "artifacts")).toBe(true);
    expect(stageTable(db, "no_such_table")).toBe(false);
  });

  it("lists only columns a caller may write — never a generated one", () => {
    expect(writableColumns(db, "state_machine_events")).not.toContain("operation_id");
    expect(writableColumns(db, "state_machine_events")).toContain("payload_json");
  });
});

describe("applyStorage", () => {
  it("does nothing at all when everything is in the database, which is the default", () => {
    expect(applyStorage(db, "w", defaultConfig().storage)).toEqual({ imported: {}, exported: {}, current: [] });
  });

  it("starts a concern's files from the database when it has none", () => {
    seedTask();
    event({ operationId: "a" });
    event({ operationId: "b" });
    const files = new Map<string, string[]>();
    const report = applyStorage(db, "w", parseConfig({ storage: { journal: "file" } }).storage, { journal: journalFiles(files) });
    expect(report.exported).toEqual({ journal: 2 });
    expect(files.get("t1")).toEqual(["a", "b"]);
    // What it wrote is what JaiRA last had: the next open reads nothing.
    expect(applyStorage(db, "w", storageOf({ journal: "file" }), { journal: journalFiles(files) }).current).toEqual(["journal"]);
  });

  it("reads files that moved, in place of the rows of the tasks they speak for — no other", () => {
    seedTask("t1");
    seedTask("t2");
    seedTask("theirs", "other");
    event({ operationId: "t1-before" }, "t1");
    event({ operationId: "t2-kept" }, "t2");
    event({ operationId: "their-own" }, "theirs");
    const files = new Map<string, string[]>([
      ["t1", ["t1-pulled", "t1-pulled-2"]],
      ["theirs", ["not-ours-to-change"]],
      ["t-new", ["arrived"]],
    ]);
    const report = applyStorage(db, "w", storageOf({ journal: "file" }), { journal: journalFiles(files) });
    expect(report.imported).toEqual({ journal: 4 });
    expect(ops("t1")).toEqual(["t1-pulled", "t1-pulled-2"]);
    expect(ops("t2")).toEqual(["t2-kept"]);
    expect(ops("theirs")).toEqual(["their-own"]);
    // A task the files brought that no workspace had is this one's.
    expect(ops("t-new")).toEqual(["arrived"]);
    expect(db.prepare(`SELECT workspace FROM task_owners WHERE task_id = 't-new'`).get()).toEqual({ workspace: "w" });
    // Nothing is left staged: every read after is of the database.
    expect(db.prepare(`SELECT name FROM temp.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()).toEqual([]);
  });

  it("trusts the database after a close recorded the files as they were", () => {
    seedTask();
    const files = new Map<string, string[]>([["t1", ["from-a-pull"]]]);
    applyStorage(db, "w", storageOf({ journal: "file" }), { journal: journalFiles(files) });
    // While running, the database moved and the writer appended to the file as it does.
    event({ operationId: "written" });
    files.set("t1", ["from-a-pull", "written"]);
    keepFingerprints(db, "w", storageOf({ journal: "file" }), { journal: journalFiles(files) });
    expect(applyStorage(db, "w", storageOf({ journal: "file" }), { journal: journalFiles(files) }).current).toEqual(["journal"]);
    expect(ops("t1")).toEqual(["from-a-pull", "written"]);
  });

  it("reads `both`, retired, as `file`", () => {
    expect(parseConfig({ storage: { journal: "both" } }).storage.journal).toBe("file");
  });
});
