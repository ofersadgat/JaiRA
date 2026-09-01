/**
 * Tasks and artifacts as files, and the `both` staleness check (DESIGN §4.4).
 *
 * These two concerns needed no dialect and no new fold — what they needed was one identity written
 * down. `runs.id` is `AUTOINCREMENT` and, unlike the journal's `seq`, it is REFERENCED: by the
 * journal, the command log, the jobs table and every conversation position. A replay that re-minted
 * it would leave all of those pointing at the wrong run, silently. That is the first test here.
 *
 * The second half is `both` — the mode that keeps its index across a close. It shipped with no
 * staleness check at all and a `git pull` under it left the two disagreeing; a fingerprint of the
 * files closes that, and the tests below are the three outcomes it now chooses between.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { initProject, openProject, type Project } from "../src/project";
import { fingerprintOf, rowFileFor, rowFiles } from "../src/rowFile";
import { createTask } from "../src/lifecycle";

let dir: string;
let baseDir: string;
const open: Project[] = [];

const track = (p: Project): Project => {
  open.push(p);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-rows-"));
  baseDir = join(dir, "base");
  mkdirSync(join(dir, "repo"), { recursive: true });
  initProject(join(dir, "repo"), testHome());
});

afterEach(() => {
  for (const p of open.splice(0)) p.close();
  rmSync(dir, { recursive: true, force: true });
});

const systemDir = (...parts: string[]): string => join(dir, "repo", ".jaira", "system", ...parts);

function project(over: Record<string, string>): Project {
  writeFileSync(join(dir, "repo", ".jaira", "settings.json"), JSON.stringify({ storage: over }), "utf8");
  return track(openProject(join(dir, "repo"), { baseDir }));
}

const dropDb = (): void => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(systemDir(`jaira.db${suffix}`), { force: true });
};

describe("tasks as files", () => {
  it("survives the database being thrown away, the machine's outcome included", () => {
    const first = project({ tasks: "file" });
    createTask(first, { id: "t-1", title: "the task", workflow: "w" });
    first.runtime.beginTask("t-1", "hash-1", 1_000);
    first.runtime.setStatus("t-1", "running", 1_001);
    first.runtime.endTask("t-1", "success", 1_002);
    // Settled before closing, or recovery would mark it `interrupted` on the next open — which is
    // correct behaviour and a different test (below).
    first.runtime.setStatus("t-1", "completed", 1_003);
    first.close();
    open.pop();
    dropDb();

    const second = project({ tasks: "file" });
    expect(second.runtime.get("t-1")).toMatchObject({
      status: "completed",
      branch: undefined,
      outcome: "success",
      snapshotHash: "hash-1",
    });
  });

  it("keeps the LAST state of a row, not the first", () => {
    const p = project({ tasks: "file" });
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    p.runtime.setStatus("t-1", "running", 2);
    p.runtime.setStatus("t-1", "completed", 3);
    p.close();
    open.pop();

    // Three lines for one row — queued, running, completed — and the third is what it is.
    const lines = readFileSync(rowFileFor(systemDir("taskRows"), "t-1"), "utf8").trimEnd().split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    dropDb();
    expect(project({ tasks: "file" }).runtime.get("t-1")?.status).toBe("completed");
  });

  it("records the interruption recovery does at OPEN, or a crashed task never settles", () => {
    // Recovery is a write, and one that happens during the open itself. A file-backed task whose
    // interruption was never appended would come back `running` on every open, forever.
    const p = project({ tasks: "file" });
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    p.runtime.beginTask("t-1", "h", 1);
    p.runtime.setStatus("t-1", "running", 2);
    p.close();
    open.pop();

    expect(project({ tasks: "file" }).recovered).toEqual(["t-1"]);
    open.pop()?.close();
    dropDb();
    expect(project({ tasks: "file" }).runtime.get("t-1")?.status).toBe("interrupted");
  });
});

describe("artifacts as files", () => {
  it("survives the database being thrown away, and keeps the upsert's last word", () => {
    const p = project({ artifacts: "file" });
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    const base = { taskId: "t-1", logicalPath: "docs/plan.md", hash: "h1", bytes: 3, createdAt: 5 };
    p.artifacts.put({ ...base, content: "one" });
    p.artifacts.put({ ...base, content: "two", hash: "h2", bytes: 3 });
    p.close();
    open.pop();
    dropDb();

    // Keyed by `(task_id, logical_path)` — the pair its own upsert conflicts on — so the second
    // write replaces the first rather than accumulating beside it.
    const reopened = project({ artifacts: "file" });
    expect(reopened.artifacts.list("t-1")).toMatchObject([{ logicalPath: "docs/plan.md", content: "two", hash: "h2" }]);
  });
});

describe("`both` — the index that survives a close", () => {
  const write = (p: Project): void => {
    createTask(p, { id: "t-1", title: "one", workflow: "w" });
    p.runtime.beginTask("t-1", "h", 1);
  };

  it("reuses the persisted index when the files have not moved", () => {
    // First open has no files at all, so it SEEDS — there is no index to persist yet.
    const first = project({ tasks: "both" });
    write(first);
    first.close();
    open.pop();

    // Second: the files exist now, so it replays — and under `both` writes the result back to
    // `main` with a fingerprint of what it was built from.
    const second = project({ tasks: "both" });
    expect(second.storage.replayed).toMatchObject({ tasks: expect.any(Number) as unknown as number });
    second.close();
    open.pop();

    // Third: same files, matching fingerprint, no replay.
    const third = project({ tasks: "both" });
    expect(third.storage.reused).toEqual(["tasks"]);
    expect(third.storage.replayed).toEqual({});
    expect(third.runtime.get("t-1")?.status).toBe("queued");
  });

  it("replays instead when a file moved underneath it — the `git pull` case", () => {
    const first = project({ tasks: "both" });
    write(first);
    first.close();
    open.pop();
    // The open that actually persists an index, so there is one for the pull to invalidate.
    project({ tasks: "both" });
    open.pop()?.close();

    // What a pull looks like from here: the file is not what the index was built from.
    const file = rowFileFor(systemDir("taskRows"), "t-1");
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        JSON.stringify({
          table: "task_runtime",
          timestamp: "2026-01-01T00:00:00.000Z",
          row: { task_id: "t-1", status: "completed", created_at: 1, updated_at: 9 },
        }) +
        "\n",
      "utf8",
    );

    const second = project({ tasks: "both" });
    expect(second.storage.reused).toEqual([]);
    expect(second.storage.replayed).toMatchObject({ tasks: expect.any(Number) as unknown as number });
    expect(second.runtime.get("t-1")?.status).toBe("completed");
  });

  it("does not persist an index under `file`, which is what makes the two modes different", () => {
    const first = project({ tasks: "file" });
    write(first);
    first.close();
    open.pop();

    const second = project({ tasks: "file" });
    expect(second.storage.reused).toEqual([]);
    expect(second.storage.replayed).toMatchObject({ tasks: expect.any(Number) as unknown as number });
  });
});

describe("fingerprintOf", () => {
  it("is undefined for nothing on disk, so 'no files' stays one case rather than two", () => {
    expect(fingerprintOf([])).toBeUndefined();
    expect(fingerprintOf(rowFiles(join(dir, "nowhere")))).toBeUndefined();
  });

  it("changes when a file's size or its mtime does", () => {
    const file = join(dir, "a.jsonl");
    writeFileSync(file, "one\n", "utf8");
    const before = fingerprintOf([file]);

    writeFileSync(file, "one\ntwo\n", "utf8");
    expect(fingerprintOf([file])).not.toBe(before);

    // Size alone is not the whole of it — a same-length rewrite still moves the clock, which is the
    // case a checkout produces.
    const sameLength = fingerprintOf([file]);
    utimesSync(file, new Date(0), new Date(0));
    expect(fingerprintOf([file])).not.toBe(sameLength);
  });

  it("survives a file that vanished between the listing and the stat", () => {
    expect(fingerprintOf([join(dir, "gone.jsonl")])).toBeTypeOf("string");
  });
});

describe("system/ is committed now", () => {
  it("ignores the database and the logs, and nothing else", () => {
    // The inversion DESIGN §4.4 argues for: once a concern's truth is a JSONL git can merge, there
    // is nothing derived left to hide, and hiding it would defeat choosing files at all.
    const patterns = readFileSync(join(dir, "repo", ".jaira", ".gitignore"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l !== "" && !l.startsWith("#"));

    expect(patterns).toEqual([
      "system/jaira.db",
      "system/jaira.db-wal",
      "system/jaira.db-shm",
      "system/logs/",
      // Machine-local trust, and the one thing under `system/` that must never travel: syncing an
      // approval would let one compromised disk confer trust on the rest (SPEC §7.5.5).
      "system/approvals.local.json",
      ".env.local",
    ]);
    expect(existsSync(join(dir, "repo", ".jaira", ".gitignore"))).toBe(true);
  });
});
