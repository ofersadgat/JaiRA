/**
 * FAST-FORWARD, with Skip (decision 0005 §4, step 7), end to end through the real service.
 *
 * A task stopped at the first state of a spine is sent to a later one. No transition is handed to
 * anybody: the task is given a conversation (grafted onto its own root) and resumed, and its spine
 * walks it forward. What makes that a fast-forward is who answers on the way — the CONTROLLING
 * CONVERSATION, through `answer`, each answer journaled `jaira.answered` with `settled_by: control`
 * and its confidence — and what it never touches: an approval-shaped gate stays the person's.
 *
 * The conversation's answers are scripted (`fake`): the host asks it outside any run, as a follow-up
 * round is asked, and a headless test has to answer from the script or reach for a provider.
 *
 * Pinned here, one test each:
 *
 *  - the answer path: questions answered for you, marked, drawn with their confidence;
 *  - `autopilot.askBelow`: under it, the question waits for the person as it would have;
 *  - the APPROVAL exclusion: `confirm_action` is never offered, and `answer` refuses it by name;
 *  - arrival ends the mode: the target's own question is the person's;
 *  - a failure on the way ends it too;
 *  - Skip mid-state: the jump is journaled BEFORE the interrupt, and the run does not walk on;
 *  - `settled_by` survives a restart, and the resumed run does not ask the answered gate again;
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
import { ANSWERED_EVENT, type InstanceNode, type PendingInteraction, type TaskConnectResult } from "@jaira/shared";
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

  it("can never be handed an approval: `answer` refuses `confirm_action` by component, and journals nothing", async () => {
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
    expect(said).toEqual({ ok: false, reason: "'confirm_action' is an approval, not a question — it is the person's to give, and `answer` cannot reach it" });
    expect(answeredRows(taskId)).toHaveLength(2); // a and b, and nothing for c
    expect(pendingFor(taskId).map(promptOf)).toEqual(["Publish c?"]);
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
    // The mode belonged to the process that is gone: nothing answers for the person any more.
    expect(service.taskDetail(taskId).fastForward).toBeUndefined();
  });

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
  });
});

describe("the stale inbox — what an interrupted agent asked is withdrawn by the skip", () => {
  const entry = (instanceId: string, parent: string, childKey: string): EngineEvent => ({ type: "instance.entered", instanceId, parentInstanceId: parent, childKey, stateId: childKey, inputs: {} }) as never;
  const started = (instanceId: string): EngineEvent => ({ type: "operation.started", instanceId, stateId: "s", op: "prompt" }) as never;
  const skipped = (instanceId: string): EngineEvent => ({ type: "instance.terminated", instanceId, stateId: "s", outcome: "skipped" }) as never;

  it("withdraws when every agent still running was inside what was skipped", () => {
    const w = new SkipWithdrawals();
    w.note(entry("i2", "i1", "ux"));
    w.note(entry("i3", "i2", "item"));
    w.note(started("i3"));
    expect(w.note(skipped("i2"))).toEqual({ withdraw: true, blockedBy: [] });
  });

  it("keeps them when an agent OUTSIDE the skipped subtree is still running — whose they are cannot be told", () => {
    const w = new SkipWithdrawals();
    w.note(entry("i2", "i1", "ux"));
    w.note(entry("i4", "i1", "side"));
    w.note(started("i2"));
    w.note(started("i4"));
    expect(w.note(skipped("i2"))).toEqual({ withdraw: false, blockedBy: ["i4"] });
  });

  it("says nothing for a member that never ran, and knows a RESUMED run's loaded parents from the journal", () => {
    const w = new SkipWithdrawals([entry("i2", "i1", "ux"), entry("i3", "i2", "item")]);
    expect(w.note(skipped("i9"))).toBeUndefined();
    // Re-dispatched after a resume: no entry this time, and still known to be inside `ux`.
    w.note(started("i3"));
    expect(w.note(skipped("i2"))).toEqual({ withdraw: true, blockedBy: [] });
  });

  it("clears a skipped task's parked approval and question from the inbox, through the service", async () => {
    const taskId = await stoppedAtFirst();
    ok(await service.connectTask({ taskId, target: "ff/e", fake: answers() }));
    await nextGate(taskId); // at `c`
    // What an agent inside the running state would have parked: an approval and a question.
    const open = (service as unknown as { session(p?: string): { approvals: { approver(c: { taskId?: string }): (r: unknown) => Promise<unknown> }; questions: { asker(c: { taskId?: string }): (r: unknown) => Promise<unknown> } } }).session();
    const approved = open.approvals.approver({ taskId })({ tool: "bash", input: { command: "git push" }, sessionId: "s" });
    const asked = open.questions.asker({ taskId })({ questions: [{ question: "Which way?", options: [{ label: "left" }, { label: "right" }] }], sessionId: "s" });
    await until(() => service.pendingApprovals().some((p) => p.taskId === taskId) && service.pendingQuestions().some((p) => p.taskId === taskId), "the agent's asks");
    // The skip ends `c` — and with a prompt call running inside it, its asks go with it.
    const inside = nodeByKey(taskId, "c")!;
    (service as unknown as { withdrawSkipped(o: unknown, t: string, v: { withdraw: boolean; blockedBy: string[] }): void }).withdrawSkipped(open, taskId, { withdraw: true, blockedBy: [] });
    expect(inside).toBeDefined();
    await expect(approved).resolves.toEqual({ decision: "deny", scope: "once" });
    await expect(asked).resolves.toBeUndefined();
    expect(service.pendingApprovals().filter((p) => p.taskId === taskId)).toEqual([]);
    expect(service.pendingQuestions().filter((p) => p.taskId === taskId)).toEqual([]);
  });
});
