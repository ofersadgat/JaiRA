/**
 * Resume, end to end: a task that stopped picks up where it was instead of starting over.
 *
 * The assertion that carries the whole feature is not "it finished" — a plain re-run finishes too.
 * It is that the operations the first run completed are NOT PUT AGAIN. Every gate here counts how
 * many times it was offered, because an operation offered twice is an operation that ran twice, and
 * for anything with side effects that is the failure resume exists to avoid.
 *
 * The two shapes a stop takes are both here, and they are the reason the strip has two verbs:
 * `interrupted` leaves instances live and has somewhere to continue; `failed` leaves nothing live at
 * all, because the failure terminated every instance on the way out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { AppService } from "../src/main/service";

const ROOT = "resume";

/**
 * Three gates in a sequence, each threading its answer into the next.
 *
 * The dataflow is what serialises them (SPEC §10.4) — a sequence is a cursor, not a barrier — so
 * "the second gate is offered" is proof the first one's answer was in hand.
 */
function files(): Record<string, JsonValue> {
  const gate = (previous?: string): JsonValue => ({
    label: "Gate",
    ...(previous !== undefined ? { inputs: { previous: { schema: { type: "boolean" } } } } : {}),
    outputs: { confirmed: { schema: { type: "boolean" } } },
    operation: { kind: "function", function: "confirm_action", args: { prompt: "go?" } },
  });
  return {
    [ROOT]: {
      label: "Resume fixture",
      outputs: { last: { schema: { type: "boolean" }, binding: ".children.c.output.confirmed" } },
      children: {
        a: { state: `${ROOT}/a` },
        b: { state: `${ROOT}/b`, inputs: { previous: ".children.a.output.confirmed" } },
        c: { state: `${ROOT}/c`, inputs: { previous: ".children.b.output.confirmed" } },
      },
      sequence: ["a", "b", "c"],
    },
    [`${ROOT}/a`]: gate(),
    [`${ROOT}/b`]: gate("previous"),
    [`${ROOT}/c`]: gate("previous"),
  };
}

let dir: string;
let workflowsDir: string;
let service: AppService;
let pushes: PushMessage[];
/** How many times a gate has been PUT — the count that says whether an operation re-ran. */
let offered: number;
/** Services left for dead by {@link crash}, closed at the end so the temp dir can go. */
let abandoned: AppService[];
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-resume-"));
  workflowsDir = initProject(dir).workflowsDir;
  writeWorkflowFiles(workflowsDir, files());
  pushes = [];
  offered = 0;
  abandoned = [];
  seen.clear();
  service = new AppService({ publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  // The abandoned ones first, and forgivingly: they are holding a run that will never be answered,
  // and what they do on the way out is not what any of these tests is about.
  for (const dead of abandoned) await dead.close().catch(() => undefined);
  await service.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Wait for a gate that has not been answered yet, count it, and answer it. */
async function answer(confirmed = true): Promise<void> {
  await until(() => service.pendingInteractions().some((p) => !seen.has(p.requestId)), "the next gate");
  const gate = service.pendingInteractions().find((p) => !seen.has(p.requestId))!;
  seen.add(gate.requestId);
  offered += 1;
  service.submitInteraction(gate.requestId, { confirmed });
}

/** Wait for a gate to be offered without answering it — where a crash would catch the run. */
async function parked(): Promise<void> {
  await until(() => service.pendingInteractions().some((p) => !seen.has(p.requestId)), "the next gate");
}

/**
 * Stop the run the way a dying PROCESS does, and open the project again.
 *
 * Deliberately not `service.close()`. A graceful close aborts the run, which terminates every live
 * instance and settles the task `canceled` — a clean ending, and the exact opposite of the thing
 * being simulated. Abandoning the service instead leaves on disk precisely what a killed process
 * leaves: the row still `running`, instances entered and never terminated, the in-flight call's
 * record still `open`.
 *
 * The one thing abandonment cannot fake is the HEARTBEAT: recovery asks `jobs.liveRunJob` whether
 * some process still holds the task, and this one does, because it is still in this process. So the
 * claim is staled by hand — which is not a cheat but the very thing that stops when a process dies,
 * and the only signal by which the next open could ever tell. With it stale, `recoverInterrupted`
 * finds the task the way it finds a real crash, and the `interrupted` status here is earned.
 */
async function crashAndReopen(taskId: string): Promise<void> {
  abandoned.push(service);
  const project = openProject(dir);
  try {
    project.db.prepare(`UPDATE jobs SET heartbeat_at = 0 WHERE task_id = ? AND ended_at IS NULL`).run(taskId);
  } finally {
    project.close();
  }
  service = new AppService({ publish: (m) => pushes.push(m) });
  const { recovered } = await service.open(dir);
  expect(recovered).toEqual([taskId]);
  // Request ids are a per-hub counter (`ui-1`, `ui-2`, …), so a fresh service starts the id space
  // over. Without this the resumed run's first gate arrives as `ui-1` — the id the crashed run gave
  // its FIRST gate — and reads as one already answered.
  seen.clear();
}

async function start(): Promise<string> {
  const { taskId } = service.createTask({ title: "Resume", workflow: ROOT });
  await service.startTask({ taskId });
  return taskId;
}

function statusOf(taskId: string): string {
  const project = openProject(dir);
  try {
    return project.runtime.get(taskId)!.status;
  } finally {
    project.close();
  }
}

describe("resuming an interrupted task", () => {
  it("continues from the frontier and does not put an answered gate again", async () => {
    const taskId = await start();
    await answer(); // a
    await answer(); // b
    await parked(); // c — offered, never answered: this is where the process dies
    await crashAndReopen(taskId);
    expect(statusOf(taskId)).toBe("interrupted");

    // Two gates answered before the crash; the third was in flight.
    expect(offered).toBe(2);

    const plan = service.resumable(taskId);
    expect(plan.kind).toBe("continue");
    expect(plan.replayed).toBe(2);
    expect(plan.frontier).toEqual([{ stateId: `${ROOT}/c`, stopped: "mid-operation" }]);

    pushes = [];
    await service.resumeTask({ taskId });
    await answer(); // c, for real — the only gate this run has to put
    await until(() => pushes.some((p) => p.type === "run:finished"), "the resumed run to finish");

    expect(statusOf(taskId)).toBe("completed");
    // THREE in total across both runs — `a` and `b` were taken from the record, not re-asked. A
    // plain re-run would read 5 here.
    expect(offered).toBe(3);
  }, 30000);

  it("opens a new run rather than reopening the old one", async () => {
    // The task keeps its id — resuming is something a task does to itself — but the attempt is its
    // own row, so the history still reads as two attempts and neither is rewritten.
    const taskId = await start();
    await answer();
    await parked();
    await crashAndReopen(taskId);
    await service.resumeTask({ taskId });
    await answer();
    await answer();
    await until(() => pushes.some((p) => p.type === "run:finished"), "the resumed run to finish");

    const project = openProject(dir);
    try {
      const runs = project.runtime.listRuns(taskId);
      expect(runs.length).toBe(2);
      expect(runs[0]!.outcome).toBe("interrupted");
      expect(runs[1]!.outcome).toBe("success");
    } finally {
      project.close();
    }
  }, 30000);
});

describe("what the strip is told", () => {
  it("calls a failed task a RETRY — nothing is live to continue", async () => {
    // The failure terminates every instance on the way out, so a failed run has no frontier at all.
    // That is the fact behind the second verb: there is nowhere to pick up, only a state to re-run.
    const bad = files();
    (bad[`${ROOT}/b`] as Record<string, JsonValue>)["outputs"] = {
      confirmed: { schema: { type: "boolean" } },
      // `confirm_action` never produces this, so `b` fails its own output contract.
      missing: { schema: { type: "string" } },
    };
    writeWorkflowFiles(workflowsDir, bad);

    const taskId = await start();
    await answer(); // a
    await answer(); // b — settles, then fails its outputs
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to end");
    expect(statusOf(taskId)).toBe("failed");

    const plan = service.resumable(taskId);
    expect(plan.kind).toBe("retry");
    expect(plan.frontier).toEqual([]);
    // `a` completed and is kept; `b`'s record settled failed, so it is not an answer and will run.
    expect(plan.replayed).toBe(1);
  }, 30000);

  it("gives a STOPPED task a plan, keeping what it finished before someone pressed stop", async () => {
    // The case this whole thing is about. A stop used to end the task's lifecycle, so `resumable`
    // returned "none" before it had looked at the record — and the strip offered a fresh copy of a
    // task whose history was intact. A stop is an interruption; the only difference from a crash is
    // who caused it, which says nothing about what is left to pick up.
    const taskId = await start();
    await answer(); // a
    await answer(); // b
    await parked(); // c — offered, and stopped while it waits
    service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the task to settle as stopped");

    const plan = service.resumable(taskId);
    expect(plan.kind).not.toBe("none");
    // The two answered gates are kept. Re-running from the top would put them again.
    expect(plan.replayed).toBe(2);
  }, 30000);

  it("says there is nothing to resume for a task that never ran", async () => {
    const { taskId } = service.createTask({ title: "Fresh", workflow: ROOT });
    expect(service.resumable(taskId)).toMatchObject({ kind: "none", replayed: 0, frontier: [] });
  });

  it("refuses to resume a completed task, and says so in the log as a WARNING", async () => {
    const taskId = await start();
    await answer();
    await answer();
    await answer();
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");
    await expect(service.resumeTask({ taskId })).rejects.toThrow(/completed and cannot be resumed/);

    // Logged where the decision was MADE, not generically at the boundary — which is the only place
    // that knows this is the service declining rather than the service breaking. `warn`, therefore:
    // something did not happen, and the reason is that the code checked and said no.
    const entry = service.listLogs({ source: "run" }).filter((e) => e.taskId === taskId).at(-1);
    expect(entry).toMatchObject({ level: "warn", source: "run" });
    expect(entry?.message).toContain("cannot be resumed");
  }, 30000);

  it("writes down what a resume is about to skip", async () => {
    const taskId = await start();
    await answer();
    await parked();
    await crashAndReopen(taskId);
    await service.resumeTask({ taskId });

    // The number that matters is the one nothing else reports: how much was taken from the record
    // rather than run again. Without it a resumed run reads in the log exactly like an ordinary one.
    const line = service.listLogs({ source: "run" }).find((e) => e.taskId === taskId && e.message.startsWith("resuming"));
    expect(line).toMatchObject({ level: "info", source: "run" });
    expect(line?.message).toContain("1 operation(s) replayed");
    expect(line?.message).toContain(`re-entering ${ROOT}/b`);
  }, 30000);
});

/**
 * A workflow that talks to a model, which is what the strip is actually looking at in practice.
 *
 * Every fixture above is an interactive gate, and a gate is an UNPLACED call — its record is keyed
 * by the operation's content hash. A prompt or agent call takes a seat in a conversation and its
 * record is keyed by that seat instead. An index that cannot read the second kind reports every such
 * operation unreadable, `resumable` answers `none`, and the strip quietly falls back to "Start
 * again" on the one kind of workflow anybody runs. That is a bug this file could not see, so it
 * gets a case here.
 */
const PROMPTED = "prompted";

function promptFiles(): Record<string, JsonValue> {
  const leaf = (name: string): JsonValue => ({
    label: name,
    outputs: { text: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: `say ${name}`, config: { model: "fake/model" } },
  });
  return {
    [PROMPTED]: {
      label: "Two calls in one conversation",
      environment: { session: "main" },
      outputs: { last: { schema: { type: "string" }, binding: ".children.b.output.text" } },
      children: { a: { state: `${PROMPTED}/a` }, b: { state: `${PROMPTED}/b` } },
      sequence: ["a", "b"],
    },
    [`${PROMPTED}/a`]: leaf("a"),
    [`${PROMPTED}/b`]: leaf("b"),
  };
}

describe("a workflow whose calls take a seat in a conversation", () => {
  it("offers a real plan, not the fallback, when the second call failed", async () => {
    writeWorkflowFiles(workflowsDir, promptFiles());
    const { taskId } = service.createTask({ title: "Prompted", workflow: PROMPTED });
    await service.startTask({
      // Rules match first to last: `b` fails, everything else answers.
      taskId,
      fake: [{ promptIncludes: "say b", error: "the model refused" }, { output: { text: "hi" } }] as never,
    });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to end");
    expect(statusOf(taskId)).toBe("failed");

    const plan = service.resumable(taskId);
    // `none` here is the symptom to guard against: it is what makes the strip say "Start again" —
    // a fork's wording — about a task whose first call is sitting in the record, readable.
    expect(plan.kind).toBe("retry");
    expect(plan.blocked).toBeUndefined();
    expect(plan.replayed).toBe(1);
  }, 30000);
});
