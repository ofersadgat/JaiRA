/**
 * FAST-FORWARD, with Skip (decision 0005 §4, step 7), end to end through the real service.
 *
 * A task stopped at the first state of a spine is sent to a later one. No transition is handed to
 * anybody: the task is given a conversation (grafted onto its own root) and resumed, and its spine
 * walks it forward. What makes that a fast-forward is who answers on the way — the CONTROLLING
 * CONVERSATION, through `answer_question`, each answer journaled `jaira.answered` with `settled_by: control`
 * and its confidence — and what it never touches: an approval-shaped gate stays the person's.
 *
 * The conversation's answers are scripted (`fake`): the host asks it outside any run, as a follow-up
 * round is asked, and a headless test has to answer from the script or reach for a provider.
 *
 * Pinned here, one test each:
 *
 *  - the answer path: questions answered for you, marked, drawn with their confidence;
 *  - `autopilot.askBelow`: under it, the question waits for the person as it would have;
 *  - the APPROVAL exclusion: `confirm_action` is never offered, and `answer_question` refuses it by name;
 *  - arrival ends the mode: the target's own question is the person's;
 *  - a failure on the way ends it too;
 *  - Skip mid-state: the jump is journaled BEFORE the interrupt, and the run does not walk on;
 *  - `settled_by` survives a restart, and the resumed run does not ask the answered gate again;
 *  - the MODE survives a restart (journaled `jaira.fastForward` / `jaira.fastForwardEnded`): a crash's
 *    Resume and a close's next open both take it up, the approval is still never offered, and a Stop
 *    ends it for good;
 *  - "Answer it yourself" rewinds to the answer, ends the mode, and the person is asked;
 *  - the stale inbox: a skip withdraws what an interrupted agent asked (`SkipWithdrawals`).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteEventLog } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { EngineEvent } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";
import { ANSWERED_EVENT, FAST_FORWARD_ENDED_EVENT, FAST_FORWARD_EVENT, LEFT_EVENT, type InstanceNode, type PendingInteraction, type TaskConnectResult } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { SkipWithdrawals } from "../src/main/fastForward";

const DECISION = { decision: { schema: { type: "string" } } };

/** A chooser — a QUESTION the conversation may answer. */
const pick = (name: string): JsonValue => ({
  label: name,
  outputs: DECISION,
  operation: { kind: "function", function: "choose_option", args: { prompt: `Pick for ${name}`, options: ["go", "stop"] } },
});
/** A confirmation — APPROVAL-shaped: never offered to the conversation. */
const confirm = (name: string): JsonValue => ({
  label: name,
  outputs: { confirmed: { schema: { type: "boolean" } } },
  operation: { kind: "function", function: "confirm_action", args: { prompt: `Publish ${name}?` } },
});

function files(): Record<string, JsonValue> {
  return {
    // a → b → c → d → e. `c` is the approval. `e` is where the work is sent.
    ff: {
      label: "Forward",
      children: { a: { state: "ff/a" }, b: { state: "ff/b" }, c: { state: "ff/c" }, d: { state: "ff/d" }, e: { state: "ff/e" } },
      sequence: ["a", "b", "c", "d", "e"],
    },
    "ff/a": pick("a"),
    "ff/b": pick("b"),
    "ff/c": confirm("c"),
    "ff/d": pick("d"),
    "ff/e": pick("e"),
    // A spine whose middle state is a MODEL CALL — what a failure on the way is made of.
    work: {
      label: "Work",
      children: { a: { state: "ff/a" }, w: { state: "work/w" }, z: { state: "ff/e" } },
      sequence: ["a", "w", "z"],
    },
    "work/w": {
      label: "w",
      environment: { kind: "prompt", model: "worker" },
      outputs: { note: { schema: { type: "string" }, binding: ".operation.output.note" } },
      operation: { prompt: "Do the work.", output: { note: { schema: { type: "string" } } } },
    },
    // The conversation a fast-forward grafts on — the shape `chat/control` ships as.
    "conv/standin": {
      label: "Talk",
      inputs: { opening: { schema: { type: "string" }, description: "What the person did, in a sentence." } },
      operation: { kind: "prompt", prompt: "{{.inputs.opening}}" },
    },
  };
}

/** The conversation's answers, by question — and one it is not sure of. */
const answers = (b: { confidence: number } = { confidence: 0.86 }): JsonValue => [
  { promptIncludes: "Pick for a", output: { answer: { decision: "go" }, confidence: 0.91, reason: "they said go" } },
  { promptIncludes: "Pick for b", output: { answer: { decision: "go" }, confidence: b.confidence, reason: "it follows from a" } },
  { promptIncludes: "Pick for d", output: { answer: { decision: "go" }, confidence: 0.9 } },
  // If the mode did NOT end on arrival, the target would be answered from this — the test says it is not.
  { promptIncludes: "Pick for e", output: { answer: { decision: "stop" }, confidence: 0.99 } },
  // If an approval were ever offered, it would be answered from this — the test says it never is.
  { promptIncludes: "Publish c", output: { answer: { confirmed: true }, confidence: 0.99 } },
  { model: "worker", output: { note: "done" } },
];

let dir: string;
let service: AppService;
/** Services left for dead by a simulated crash — closed at the end, never before. */
let abandoned: AppService[] = [];
const seen = new Set<string>();

async function openService(): Promise<void> {
  service = new AppService({ baseDir: testHome(), publish: () => undefined, connectConversation: "conv/standin" });
  await service.open(dir);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-ffwd-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  seen.clear();
  await openService();
});

afterEach(async () => {
  for (const dead of abandoned) await dead.close().catch(() => undefined);
  abandoned = [];
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
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

function read<T>(fn: (project: ReturnType<typeof openProject>) => T): T {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return fn(project);
  } finally {
    project.close();
  }
}
const statusOf = (taskId: string): string | undefined => read((p) => p.runtime.get(taskId)?.status);
const rows = (taskId: string) => read((p) => new SqliteEventLog(p.db).list(taskId));
const journal = (taskId: string): EngineEvent[] => rows(taskId).map((row) => row.event);

/** `[child key, outcome]` for every ended child, in journal order. */
function ended(taskId: string): Array<[string, string]> {
  const events = journal(taskId);
  const keyOf = new Map<string, string>();
  for (const e of events) if (e.type === "instance.entered" && e.childKey !== undefined) keyOf.set(e.instanceId, e.childKey);
  return events
    .filter((e): e is Extract<EngineEvent, { type: "instance.terminated" }> => e.type === "instance.terminated" && keyOf.has(e.instanceId))
    .map((e) => [keyOf.get(e.instanceId)!, e.outcome]);
}
const entered = (taskId: string): string[] => journal(taskId).flatMap((e) => (e.type === "instance.entered" && e.childKey !== undefined ? [e.childKey] : []));

const promptOf = (gate: PendingInteraction): string => String((gate.inputs as { prompt?: string }).prompt ?? "");
const pendingFor = (taskId: string): PendingInteraction[] => service.pendingInteractions().filter((p) => p.taskId === taskId);
/** The next gate nobody has looked at yet, left parked. */
async function nextGate(taskId: string): Promise<PendingInteraction> {
  await until(() => pendingFor(taskId).some((p) => !seen.has(p.requestId)), "the next gate");
  const gate = pendingFor(taskId).find((p) => !seen.has(p.requestId))!;
  seen.add(gate.requestId);
  return gate;
}

/** A task of `workflow` that asked its first question and was STOPPED there — standing, not running. */
async function stoppedAtFirst(workflow = "ff", fake?: JsonValue): Promise<string> {
  const { taskId } = service.createTask({ title: "Pause and stop", workflow });
  await service.startTask({ taskId, ...(fake !== undefined ? { fake } : {}) });
  const first = await nextGate(taskId);
  expect(promptOf(first)).toBe("Pick for a");
  service.cancelTask(taskId);
  await until(() => statusOf(taskId) === "canceled", "the stop");
  seen.clear();
  return taskId;
}

const ok = (result: TaskConnectResult): Extract<TaskConnectResult, { ok: true }> => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result;
};

function nodeByKey(taskId: string, key: string): InstanceNode | undefined {
  const walk = (nodes: readonly InstanceNode[]): InstanceNode | undefined => {
    for (const node of nodes) {
      if (node.childKey === key) return node;
      const deeper = walk(node.children);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return walk(service.taskDetail(taskId).instances);
}

const answeredRows = (taskId: string) => rows(taskId).filter((row) => (row.event as unknown as { type: string }).type === ANSWERED_EVENT);

/** The fast-forward rows of a task's journal, by type, in order. */
const ffRows = (taskId: string): string[] => rows(taskId).map((row) => (row.event as unknown as { type: string }).type).filter((type) => type === FAST_FORWARD_EVENT || type === FAST_FORWARD_ENDED_EVENT);
/** The last fast-forward end row. */
const endRow = (taskId: string): unknown => rows(taskId).map((row) => row.event as unknown as { type: string }).filter((e) => e.type === FAST_FORWARD_ENDED_EVENT).at(-1);

function setAskBelow(value: number): void {
  const file = join(dir, ".jaira", "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...settings, autopilot: { askBelow: value } }, null, 2));
}

describe("fast-forward — the machine runs to the target, and the conversation answers on the way", () => {
  it("answers the questions for you, marks each with its confidence, never offers the approval, and ends on arrival", async () => {
    const taskId = await stoppedAtFirst();
    const connected = ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    expect(connected).toMatchObject({ moved: "fast-forwarding", controlTaskId: taskId, plan: { forward: "fast-forward", move: { direction: "forward", passes: ["b", "c", "d"] } } });
    // The task had no conversation, so it was GIVEN one — grafted onto its own root, a diverged
    // document — and it is its own control: nothing wraps it, and nothing was said to start it.
    expect(read((p) => p.runtime.get(taskId)?.documentId)).toMatch(/^d-/);
    expect(journal(taskId).some((e) => e.type === "operation.started" && e.op === "prompt")).toBe(false);

    // The strip's content, while it runs.
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", targetLabel: "e", through: ["b", "c", "d"], controlTaskId: taskId });

    // `a` and `b` were answered for you; `c` — an approval — waits for the person, unoffered.
    const approval = await nextGate(taskId);
    expect(promptOf(approval)).toBe("Publish c?");
    expect(ended(taskId).slice(-2)).toEqual([
      ["a", "success"],
      ["b", "success"],
    ]);
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Publish c?"]);
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ answered: 2, left: 0, step: 2, at: "c" });

    // Each answer is on the gate it settled, with who and how sure — and where to rewind to.
    const a = nodeByKey(taskId, "a")!;
    const b = nodeByKey(taskId, "b")!;
    expect(a.settledBy).toMatchObject({ via: "control", confidence: 0.91, byTaskId: taskId });
    expect(b.settledBy).toMatchObject({ via: "control", confidence: 0.86, byTaskId: taskId });
    // One `jaira.answered` row each, naming the instance it settled; the rewind point is that
    // instance's ENTRY, ahead of the answer.
    expect(answeredRows(taskId).map((row) => row.instanceId)).toEqual([a.instanceId, b.instanceId]);
    const enteredSeq = (id: string): number => rows(taskId).find((row) => row.type === "instance.entered" && row.instanceId === id)!.seq;
    expect([a.settledBy!.at, b.settledBy!.at]).toEqual([enteredSeq(a.instanceId), enteredSeq(b.instanceId)]);

    // The person answers the approval; `d` is answered for you; ARRIVAL at `e` ends the mode.
    service.submitInteraction(approval.requestId, { confirmed: true });
    const target = await nextGate(taskId);
    expect(promptOf(target)).toBe("Pick for e");
    await settle();
    // The target's question is the PERSON's — the script would have answered it, and did not.
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for e"]);
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(nodeByKey(taskId, "c")!.settledBy).toBeUndefined();
    expect(nodeByKey(taskId, "d")!.settledBy).toMatchObject({ via: "control", confidence: 0.9 });
    expect(nodeByKey(taskId, "e")!.settledBy).toBeUndefined();
  });

  it("leaves a question to the person below autopilot.askBelow — a platform setting, very low by default", async () => {
    setAskBelow(0.5);
    await service.close();
    await openService();
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers({ confidence: 0.3 }) }));
    // `a` at 0.91 is answered; `b` at 0.3 is under 0.5, so it waits — as it would have.
    const b = await nextGate(taskId);
    expect(promptOf(b)).toBe("Pick for b");
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for b"]);
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ answered: 1, left: 1 });
    expect(answeredRows(taskId)).toHaveLength(1);
    // Answered BY THE PERSON, it is not marked.
    service.submitInteraction(b.requestId, { decision: "go" });
    await nextGate(taskId); // c
    expect(nodeByKey(taskId, "b")!.settledBy).toBeUndefined();
  });

  it("can never be handed an approval: `answer_question` refuses `confirm_action` by component, and journals nothing", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    const approval = await nextGate(taskId);
    expect(approval.component).toBe("confirm_action");
    const host = service.workflowHostFor(undefined, taskId);
    // Not among what the task is asking — there is no request id for a model to name…
    const standing = (await host.tasks({})).tasks.find((t) => t.task === taskId)!;
    expect(standing.asking ?? []).toEqual([]);
    // …and named anyway, it is refused by what it IS.
    const said = await host.answer({ request: approval.requestId, value: { confirmed: true }, confidence: 1 });
    expect(said).toEqual({ ok: false, reason: "'confirm_action' is an approval, not a question — it is the person's to give, and `answer_question` cannot reach it" });
    expect(answeredRows(taskId)).toHaveLength(2); // a and b, and nothing for c
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Publish c?"]);
  });

  it("runs a RUNNING task forward when it already has its conversation — nothing is restarted", async () => {
    const taskId = await stoppedAtFirst();
    // First to `c`: given a conversation, `a` and `b` answered on the way, and it arrives at the approval.
    ok(await service.connectTask({ taskId, target: "ff/c", fake: answers() }));
    const approval = await nextGate(taskId);
    expect(promptOf(approval)).toBe("Publish c?");
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    const runs = journal(taskId).filter((e) => e.type === "instance.entered" && e.parentInstanceId === undefined).length;

    // Now, while it is RUNNING and speaks: on to `e`. The mode is registered on the live run.
    const again = ok(await service.connectTask({ taskId, target: "ff/e" }));
    expect(again).toMatchObject({ moved: "fast-forwarding", controlTaskId: taskId });
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", through: ["d"] });
    // The approval it was already asking stays the person's; answered, `d` is answered for you.
    service.submitInteraction(approval.requestId, { confirmed: true });
    expect(promptOf(await nextGate(taskId))).toBe("Pick for e");
    expect(nodeByKey(taskId, "d")!.settledBy).toMatchObject({ via: "control", confidence: 0.9 });
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    // One run of the machine throughout — it was not restarted to be sent on.
    expect(journal(taskId).filter((e) => e.type === "instance.entered" && e.parentInstanceId === undefined).length).toBe(runs);
  });

  it("ends when something on the way FAILS, and says nothing more for the person", async () => {
    const script: JsonValue = [
      { promptIncludes: "Pick for a", output: { answer: { decision: "go" }, confidence: 0.9 } },
      { model: "worker", error: "the model fell over" },
      { promptIncludes: "Pick for e", output: { answer: { decision: "go" }, confidence: 0.9 } },
    ];
    const taskId = await stoppedAtFirst("work", script);
    // `ff/e` is mounted as `z` here: the move is to it, through `w`.
    ok(await service.connectTask({ taskId, target: "ff/e", fake: script }));
    await until(() => statusOf(taskId) === "failed", "the failure");
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(ended(taskId)).toContainEqual(["w", "error"]);
    expect(entered(taskId)).not.toContain("z");
  });
});

describe("Skip — the jump is decided before the interrupt, and what is between is recorded", () => {
  it("interrupts the state it is in, steps over the rest, and enters the target — never the next intermediate", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    const approval = await nextGate(taskId); // standing IN `c`, the approval, unanswered
    expect(promptOf(approval)).toBe("Publish c?");

    const skipped = await service.skipFastForward({ taskId });
    expect(skipped.status).toBe("taking");
    const target = await nextGate(taskId);
    expect(promptOf(target)).toBe("Pick for e");
    // `c` interrupted, `d` never entered — both `skipped` — and nothing ran in between.
    expect(ended(taskId).slice(-2)).toEqual([
      ["c", "skipped"],
      ["d", "skipped"],
    ]);
    const after = journal(taskId);
    const jump = after.findIndex((e) => e.type === "transition.taken" && e.to === "e");
    const cut = after.findIndex((e) => e.type === "instance.terminated" && e.outcome === "skipped");
    expect(jump).toBeGreaterThanOrEqual(0);
    // THE INTERRUPT TRAP: the transition is journaled before anything it skipped is ended.
    expect(jump).toBeLessThan(cut);
    expect(after[jump]).toMatchObject({ type: "transition.taken", skip: true, by: "person" });
    // The interrupted gate withdrew itself; the target's question is the person's.
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for e"]);
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    // A second Skip has nothing to skip to.
    await expect(service.skipFastForward({ taskId })).rejects.toThrow(`task '${taskId}' is not being fast-forwarded — there is nothing to skip to`);
  });
});

describe("the answers survive, and can be taken back", () => {
  it("keeps settled_by across a restart, and the resumed run does not ask the answered gates again", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // parked at `c`
    const before = { a: nodeByKey(taskId, "a")!.settledBy, b: nodeByKey(taskId, "b")!.settledBy };
    expect(before.a).toBeDefined();

    // A graceful close with the approval parked: the task comes back and asks `c` again — not `a`, not `b`.
    await service.close();
    seen.clear();
    await openService();
    await until(() => pendingFor(taskId).length > 0, "the parked gate to come back");
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Publish c?"]);
    expect(nodeByKey(taskId, "a")!.settledBy).toEqual(before.a);
    expect(nodeByKey(taskId, "b")!.settledBy).toEqual(before.b);
    // The mode survived the close: its start row is open in the journal, and nothing wrote an end.
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", answered: 2, left: 0, step: 2, at: "c" });
    expect(ffRows(taskId)).toEqual([FAST_FORWARD_EVENT]);
  });
});

describe("a restart RESUMES the fast-forward — and it still ends only for the reasons it ends", () => {
  /** Abandon the service the way a dying process does, stale its claim, and open again. */
  async function crashAndReopen(taskId: string): Promise<void> {
    const dead = service;
    const project = openProject(dir, { baseDir: testHome() });
    try {
      project.db.prepare(`UPDATE jobs SET heartbeat_at = 0 WHERE task_id = ? AND ended_at IS NULL`).run(taskId);
    } finally {
      project.close();
    }
    await openService();
    seen.clear();
    abandoned.push(dead);
  }

  it("after a CRASH, Resume takes the mode up: the conversation answers what comes next, the approval is still never offered, and arrival ends it", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // parked at `c`, the approval, with `a` and `b` answered for you
    await crashAndReopen(taskId);
    expect(statusOf(taskId)).toBe("interrupted");
    // Not running, so no mode is live yet: a crash is resumed by a person, never unasked.
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();

    await service.resumeTask({ taskId, fake: answers() });
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", targetLabel: "e", through: ["b", "c", "d"], answered: 2, step: 2, at: "c" });
    // The approval is asked again — of the PERSON. The script would answer it at 0.99 if it were
    // ever offered; it is not, after a resume as before one.
    const approval = await nextGate(taskId);
    expect(promptOf(approval)).toBe("Publish c?");
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Publish c?"]);
    expect(answeredRows(taskId)).toHaveLength(2);
    expect(nodeByKey(taskId, "c")!.settledBy).toBeUndefined();

    // Answered by the person; `d` is answered FOR them by the resumed mode; arrival ends it.
    service.submitInteraction(approval.requestId, { confirmed: true });
    const target = await nextGate(taskId);
    expect(promptOf(target)).toBe("Pick for e");
    await settle();
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for e"]);
    expect(nodeByKey(taskId, "d")!.settledBy).toMatchObject({ via: "control", confidence: 0.9 });
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(ffRows(taskId)).toEqual([FAST_FORWARD_EVENT, FAST_FORWARD_ENDED_EVENT]);
    expect(endRow(taskId)).toMatchObject({ end: "arrived" });
  });

  it("after a CLOSE, the next open resumes the run and the mode unasked — the strip shows, and Skip works", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`
    await service.close();
    seen.clear();
    await openService();
    // The open resumes it unasked, in the background — the recovered gate is on the list before then.
    await (service as unknown as { session(): { resuming: Promise<void> } }).session().resuming;
    await until(() => pendingFor(taskId).length > 0, "the resumed run to ask again");
    expect(statusOf(taskId)).toBe("running");
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", controlTaskId: taskId });

    const skipped = await service.skipFastForward({ taskId });
    expect(skipped.status).toBe("taking");
    expect(promptOf(await nextGate(taskId))).toBe("Pick for e");
    expect(ended(taskId).slice(-2)).toEqual([
      ["c", "skipped"],
      ["d", "skipped"],
    ]);
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(endRow(taskId)).toMatchObject({ end: "skipped" });
  });

  it("a question LEFT to the person stays theirs across a restart — not offered again, and the count goes on from the journal", async () => {
    setAskBelow(0.5);
    await service.close();
    await openService();
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers({ confidence: 0.3 }) }));
    // `a` is answered; `b` at 0.3 is left to the person — and that decision is a journal row.
    const b = await nextGate(taskId);
    expect(promptOf(b)).toBe("Pick for b");
    await until(() => service.taskDetail(taskId).fastForward?.left === 1, "b to be left to the person");
    const leftRows = (): Array<Record<string, unknown>> => rows(taskId).map((row) => row.event as unknown as Record<string, unknown>).filter((e) => e["type"] === LEFT_EVENT);
    const bNode = nodeByKey(taskId, "b")!;
    expect(leftRows()).toEqual([
      expect.objectContaining({ kind: "interaction", under: bNode.instanceId, byTaskId: taskId, key: expect.stringContaining("Pick for b"), requestId: b.requestId }),
    ]);

    // The process dies with `b` parked. Resume parks `b` again under a NEW request id — and this time
    // the conversation would be sure of it (0.99). It is not asked: the question is the person's, as
    // it was before the restart.
    await crashAndReopen(taskId);
    await service.resumeTask({ taskId, fake: answers({ confidence: 0.99 }) });
    const again = await nextGate(taskId);
    expect(promptOf(again)).toBe("Pick for b");
    await settle(300);
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for b"]);
    expect(nodeByKey(taskId, "b")!.settledBy).toBeUndefined();
    expect(answeredRows(taskId)).toHaveLength(1);
    // The strip's count is rebuilt from the rows, and nothing was left twice.
    expect(service.taskDetail(taskId).fastForward).toMatchObject({ target: "ff/e", answered: 1, left: 1 });
    expect(leftRows()).toHaveLength(1);

    // The person answers it; the mode goes on answering what comes after (`c` is an approval, theirs anyway).
    service.submitInteraction(again.requestId, { decision: "go" });
    expect(promptOf(await nextGate(taskId))).toBe("Publish c?");
  });

  it("a STOP ends it for good: the end is written, and a later resume is an ordinary one", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`
    service.cancelTask(taskId);
    await until(() => statusOf(taskId) === "canceled", "the stop");
    expect(endRow(taskId)).toMatchObject({ end: "stopped" });

    await service.close();
    seen.clear();
    await openService();
    await service.resumeTask({ taskId, fake: answers() });
    await nextGate(taskId); // `c` again
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
  });
});

describe("the answers can be taken back", () => {

  it("'Answer it yourself' rewinds to the answer: the mode is over, and the person is asked", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`, with `a` and `b` answered for you
    const b = nodeByKey(taskId, "b")!.settledBy!;

    seen.clear();
    await service.answerYourself({ taskId, at: b.at });
    const asked = await nextGate(taskId);
    expect(promptOf(asked)).toBe("Pick for b");
    await settle();
    // Nobody answered it for you this time: the mode ended with the rewind.
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Pick for b"]);
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    // `a`'s answer stands, `b`'s is gone with the cut.
    expect(answeredRows(taskId)).toHaveLength(1);
    expect(nodeByKey(taskId, "a")!.settledBy).toMatchObject({ via: "control" });
    // A rewind is a decision about the task: the drop's Undo went with it.
    expect(service.listTasks().find((t) => t.taskId === taskId)?.undoable).toBeUndefined();
  });
});

describe("the drop's Undo — the fast-forward is the drop's while it runs, and the target is where it landed", () => {
  const undoable = (taskId: string): boolean | undefined => service.listTasks().find((t) => t.taskId === taskId)?.undoable;

  it("is offered on the way and on arrival, and is over once the target settles", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    // On the way: `a` and `b` answered for you, and the person's own answer to `c` is still the way there.
    const approval = await nextGate(taskId);
    expect(promptOf(approval)).toBe("Publish c?");
    expect(undoable(taskId)).toBe(true);
    service.submitInteraction(approval.requestId, { confirmed: true });
    // Arrived: the target is where the drop landed, and standing there is still the drop's.
    const target = await nextGate(taskId);
    expect(promptOf(target)).toBe("Pick for e");
    await settle();
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(endRow(taskId)).toMatchObject({ end: "arrived" });
    expect(undoable(taskId)).toBe(true);
    // The task moves on from it: the target settles, and Undo would throw that away.
    service.submitInteraction(target.requestId, { decision: "go" });
    await until(() => statusOf(taskId) === "completed", "the task to finish");
    expect(undoable(taskId)).toBeUndefined();
    await expect(service.undoConnect({ taskId })).rejects.toThrow(/has moved on since the drop \(the state the drop landed in has settled\)/);
  });

  it("taken back on the way: the run is stopped, the mode and its answers go with the cut, and the pin is put back", async () => {
    const taskId = await stoppedAtFirst();
    const pinned = read((p) => p.runtime.get(taskId)!);
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`, still forwarding
    expect(await service.undoConnect({ taskId })).toEqual({ taskId });
    expect(ffRows(taskId)).toEqual([]);
    expect(answeredRows(taskId)).toEqual([]);
    const back = read((p) => p.runtime.get(taskId)!);
    expect(back.documentId).toBeUndefined();
    expect(back.snapshotHash).toBe(pinned.snapshotHash);
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
    expect(undoable(taskId)).toBeUndefined();
  });

  it("a SKIP is a decision: the Undo is over", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`
    expect(undoable(taskId)).toBe(true);
    await service.skipFastForward({ taskId });
    expect(promptOf(await nextGate(taskId))).toBe("Pick for e");
    expect(undoable(taskId)).toBeUndefined();
  });

  it("a failure on the way is not work of the task's own: Undo stays offered", async () => {
    const script: JsonValue = [
      { promptIncludes: "Pick for a", output: { answer: { decision: "go" }, confidence: 0.9 } },
      { model: "worker", error: "the model fell over" },
    ];
    const taskId = await stoppedAtFirst("work", script);
    ok(await service.connectTask({ taskId, target: "ff/e", fake: script }));
    await until(() => statusOf(taskId) === "failed", "the failure");
    expect(endRow(taskId)).toMatchObject({ end: "failed" });
    expect(undoable(taskId)).toBe(true);
  });
});

describe("the stale inbox — what an interrupted agent asked is withdrawn by the skip", () => {
  const entry = (instanceId: string, parent: string, childKey: string): EngineEvent => ({ type: "instance.entered", instanceId, parentInstanceId: parent, childKey, stateId: childKey, inputs: {} }) as never;
  const skipped = (instanceId: string): EngineEvent => ({ type: "instance.terminated", instanceId, stateId: "s", outcome: "skipped" }) as never;

  it("answers, for a skip, which asking instances are inside what was skipped — the skipped one and all below it", () => {
    const w = new SkipWithdrawals();
    w.note(entry("i2", "i1", "ux"));
    w.note(entry("i3", "i2", "item"));
    w.note(entry("i4", "i1", "side"));
    const inside = w.note(skipped("i2"))!;
    expect([inside("i2"), inside("i3"), inside("i4"), inside("i1"), inside(undefined)]).toEqual([true, true, false, false, false]);
  });

  it("says nothing but a skip, and knows a RESUMED run's loaded parents from the journal", () => {
    const w = new SkipWithdrawals([entry("i2", "i1", "ux"), entry("i3", "i2", "item")]);
    expect(w.note({ type: "instance.terminated", instanceId: "i3", stateId: "s", outcome: "success" } as never)).toBeUndefined();
    // Re-dispatched after a resume: no entry this time, and still known to be inside `ux`.
    expect(w.note(skipped("i2"))!("i3")).toBe(true);
  });

  it("a real Skip withdraws the skipped state's asks and leaves an async sibling's standing", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`
    const c = nodeByKey(taskId, "c")!.instanceId;
    // What agents would have parked, each naming the instance that asked (the engine stamps it): one
    // inside the running state, one in a sibling still running beside it.
    const open = (service as unknown as { session(p?: string): { approvals: { approver(c: { taskId?: string }): (r: unknown) => Promise<unknown> }; questions: { asker(c: { taskId?: string }): (r: unknown) => Promise<unknown> } } }).session();
    const ask = (instanceId: string) => ({
      approved: open.approvals.approver({ taskId })({ tool: "bash", input: { command: "git push" }, sessionId: "s", instanceId }),
      asked: open.questions.asker({ taskId })({ questions: [{ question: `Which way, ${instanceId}?`, options: [{ label: "left" }, { label: "right" }] }], sessionId: "s", instanceId }),
    });
    const skippedAgent = ask(c);
    const sibling = ask("the-async-sibling");
    await until(() => service.pendingApprovals().filter((p) => p.taskId === taskId).length === 2 && service.pendingQuestions().filter((p) => p.taskId === taskId).length === 2, "the agents' asks");

    await service.skipFastForward({ taskId });
    await expect(skippedAgent.approved).resolves.toEqual({ decision: "deny", scope: "once" });
    await expect(skippedAgent.asked).resolves.toBeUndefined();
    // The sibling's are still waiting for their answers.
    expect(service.pendingApprovals().filter((p) => p.taskId === taskId)).toHaveLength(1);
    expect(service.pendingQuestions().filter((p) => p.taskId === taskId).map((p) => p.questions[0]!.question)).toEqual(["Which way, the-async-sibling?"]);
    const pendingApproval = service.pendingApprovals().find((p) => p.taskId === taskId)!;
    const pendingQuestion = service.pendingQuestions().find((p) => p.taskId === taskId)!;
    service.submitApproval(pendingApproval.requestId, "allow");
    service.submitQuestion(pendingQuestion.requestId, { "Which way, the-async-sibling?": "left" });
    await expect(sibling.approved).resolves.toMatchObject({ decision: "allow" });
    await expect(sibling.asked).resolves.toEqual({ "Which way, the-async-sibling?": "left" });
  });
});
