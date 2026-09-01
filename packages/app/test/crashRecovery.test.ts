/**
 * What survives a crash — the whole chain, end to end.
 *
 * A run that dies mid-call leaves three things behind, and each is a step further than the last:
 *
 *  1. the STREAMED PARTIAL in the record's `result_json`, bounded by the last debounced flush;
 *  2. the PROVIDER HANDLE on the same row, streamed there while the call ran — a call that never
 *     reached its close has no other way to name the session it was in;
 *  3. and, because of (2), the agent's OWN session file, which is bounded by nothing at all.
 *
 * The third is what this pins: opening a project discovers the interruption, and the handle plus
 * the run's workspace are enough to fold the agent's full transcript into the record that never got
 * one. The native reader is a seam here for the same reason it is one in `withNativeCapture` — the
 * alternative is a test that lays out an agent's config directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteSessionStore, type Project } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService | undefined;
let pushes: PushMessage[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-crash-"));
  initProject(dir, testHome());
  pushes = [];
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A task caught mid-call: still `running`, its record still `open`, with a partial and a handle. */
function crashedRun(over: { handle?: string | null } = {}): void {
  const project: Project = openProject(dir, { baseDir: testHome() });
  try {
    project.runtime.insert("t-crash", 1000);
    project.runtime.setStatus("t-crash", "running", 1000);
    const runId = project.runtime.beginRun("t-crash", "h", 1000);
    project.db
      .prepare(
        `INSERT INTO operation_records (id, task_id, run_id, status, provider_session_id, result_json, started_at)
         VALUES ('s:0', 't-crash', ?, 'open', ?, ?, 1000)`,
      )
      .run(
        runId,
        over.handle === undefined ? "prov-7" : over.handle,
        JSON.stringify({ value: { messages: [{ role: "assistant", content: "as far as it got" }] } }),
      );
  } finally {
    project.close();
  }
}

/** What the record holds now, read the way a viewer would. */
function recordValue(): { messages?: unknown[]; entries?: unknown[]; capturedAt?: string } {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    const row = project.db.prepare(`SELECT result_json FROM operation_records WHERE task_id = 't-crash'`).get() as {
      result_json: string;
    };
    return (JSON.parse(row.result_json) as { value: { messages?: unknown[]; entries?: unknown[]; capturedAt?: string } }).value;
  } finally {
    project.close();
  }
}

/** Wait for the recovery, which runs unawaited behind `open` so the window is not held up by file I/O. */
async function settled(): Promise<void> {
  for (let i = 0; i < 100 && recordValue().capturedAt === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a crashed run's conversation is recovered at the next open", () => {
  it("settles the abandoned record and folds the agent's own transcript into it", async () => {
    crashedRun();
    const asked: Array<{ id: string; cwd: string; sinceMs?: number }> = [];
    service = new AppService({
      baseDir: testHome(),
      publish: (m) => pushes.push(m),
      watchWorkflows: false,
      captureNative: async (providerSessionId, opts) => {
        asked.push({ id: providerSessionId, cwd: opts.cwd, ...(opts.sinceMs !== undefined ? { sinceMs: opts.sinceMs } : {}) });
        return { nativeLines: [{ index: 0, line: { type: "attachment" } as never }] };
      },
    });
    const { recovered } = await service.open(dir);
    expect(recovered).toEqual(["t-crash"]);
    await settled();

    // Asked with the handle the STREAM put on the row — the whole reason a crashed call is
    // findable — the run's workspace, and the start time that cuts a resumed session's earlier lines.
    expect(asked).toEqual([{ id: "prov-7", cwd: dir, sinceMs: 1000 }]);
    const value = recordValue();
    // The fuller capture joins what the crash had already saved, rather than replacing it. The
    // attachment has no message to annotate, so it becomes an event entry of its own.
    expect(value.messages).toEqual([{ role: "assistant", content: "as far as it got" }]);
    expect(value.entries).toMatchObject([{ kind: "event", event: { type: "attachment" } }]);
    expect(value.capturedAt).toEqual(expect.any(String));
    // …and the row is settled: 'open' must mean "a live process is streaming into this". Settled as
    // `interrupted` — the word for a call the process died under, which a load treats as an active
    // leaf, where `failed` (the call itself answered with an error) it would not re-enter.
    const project = openProject(dir, { baseDir: testHome() });
    try {
      expect(project.db.prepare(`SELECT status FROM operation_records WHERE task_id = 't-crash'`).get()).toEqual({
        status: "interrupted",
      });
    } finally {
      project.close();
    }
  });

  it("keeps the streamed partial when the agent's files are gone", async () => {
    // The capture is an ENRICHMENT; a file pruned since the crash costs the annotation, never the
    // record. What the flush saved is still the answer.
    crashedRun();
    service = new AppService({
      baseDir: testHome(),
      publish: (m) => pushes.push(m),
      watchWorkflows: false,
      captureNative: async () => {
        throw new Error("ENOENT: the agent pruned its session file");
      },
    });
    await service.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recordValue().messages).toEqual([{ role: "assistant", content: "as far as it got" }]);
  });

  it("does not look where there is no handle to look with", async () => {
    crashedRun({ handle: null });
    let asked = 0;
    service = new AppService({
      baseDir: testHome(),
      publish: (m) => pushes.push(m),
      watchWorkflows: false,
      captureNative: async () => {
        asked += 1;
        return {};
      },
    });
    await service.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(0);
  });

  it("re-reads nothing on a second open, having already captured", async () => {
    crashedRun();
    const capture = async (): Promise<{ nativeLines: Array<{ index: number; line: never }> }> => {
      calls += 1;
      return { nativeLines: [{ index: 0, line: { type: "attachment" } as never }] };
    };
    let calls = 0;
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false, captureNative: capture });
    await service.open(dir);
    await settled();
    expect(calls).toBe(1);

    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false, captureNative: capture });
    await service.open(dir);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The task is `interrupted` rather than `running` now, so recovery reports nothing — and even
    // where it did, the row already carries `nativeLines` and is no longer offered.
    expect(calls).toBe(1);
    const project = openProject(dir, { baseDir: testHome() });
    try {
      expect(new SqliteSessionStore(project.db).recoverable("t-crash")).toEqual([]);
    } finally {
      project.close();
    }
  });
});
