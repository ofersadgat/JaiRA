/**
 * A gate outlives the process that parked it (DESIGN §7.1, CHANGESETS.md §8.1).
 *
 * The bug these are about: an interactive state's request lived in `InteractionHub`'s Map and
 * nowhere else, so quitting the app rejected it. The workflow took a failure its author never wrote
 * a rule for, and the question somebody was in the middle of reading was gone — from their side,
 * closing the window had answered it.
 *
 * What is asserted here is the pair that makes it durable rather than the storage on its own:
 *
 *  - the question SURVIVES a close, and comes back saying that answering it continues the task;
 *  - answering it does continue the task, and does NOT put the same gate again.
 *
 * The second half is the one with teeth. A resume replays what the earlier run completed and
 * re-dispatches the state it stopped in — which for a gate means re-parking it — so without the
 * seeded answer the person would be asked the same question they had just answered, forever. Every
 * gate here counts how many times it was PUT, for the reason `resume.test.ts` does: an operation
 * offered twice is an operation that ran twice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ROOT = "gates";

/**
 * Two gates in a sequence, the second reading the first's answer.
 *
 * The dataflow is what serialises them (SPEC §10.4), so "the second gate was offered" is proof the
 * first one's answer was in hand — which is what a resumed run has to reproduce from the record.
 */
function files(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Gate fixture",
      outputs: { last: { schema: { type: "string" }, binding: ".children.b.output.decision" } },
      children: {
        a: { state: `${ROOT}/a` },
        b: { state: `${ROOT}/b`, inputs: { previous: ".children.a.output.decision" } },
      },
      sequence: ["a", "b"],
    },
    [`${ROOT}/a`]: {
      label: "First",
      outputs: { decision: { schema: { type: "string" } } },
      operation: {
        kind: "function",
        function: "choose_option",
        args: { prompt: "which way?", options: ["left", "right"] },
      },
    },
    [`${ROOT}/b`]: {
      label: "Second",
      inputs: { previous: { schema: { type: "string" } } },
      outputs: { decision: { schema: { type: "string" } } },
      operation: {
        kind: "function",
        function: "choose_option",
        args: { prompt: "and then?", options: ["stop", "go"] },
      },
    },
  };
}

let dir: string;
let service: AppService;
let pushes: PushMessage[];
/** How many times a gate has been PUT — the count that says whether a question was asked twice. */
let offered: number;
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-gate-durability-"));
  const { workflowsDir } = initProject(dir, testHome());
  writeWorkflowFiles(workflowsDir, files());
  pushes = [];
  offered = 0;
  seen.clear();
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
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

/** Wait for a gate nobody has answered yet, and count it as PUT. */
async function nextGate(): Promise<ReturnType<AppService["pendingInteractions"]>[number]> {
  await until(() => service.pendingInteractions().some((p) => !seen.has(p.requestId)), "the next gate");
  const gate = service.pendingInteractions().find((p) => !seen.has(p.requestId))!;
  seen.add(gate.requestId);
  offered += 1;
  return gate;
}

/**
 * Close the app the way a person does, and open it again.
 *
 * Deliberately the GRACEFUL path — `service.close()`, which is what `before-quit` runs. That is the
 * case the bug was about: not a crash, but quitting, which used to reject every parked gate on the
 * way out. Request ids restart with the hub's counter in a fresh service, so `seen` is cleared for
 * the reason `resume.test.ts` clears it — an id from the dead process is not the same question.
 */
async function quitAndReopen(): Promise<void> {
  await service.close();
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
  seen.clear();
}

async function start(): Promise<string> {
  const { taskId } = service.createTask({ title: "Gates", workflow: ROOT });
  await service.startTask({ taskId });
  return taskId;
}

function statusOf(taskId: string): string {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    return project.runtime.get(taskId)!.status;
  } finally {
    project.close();
  }
}

describe("a gate parked when the app closes", () => {
  it("is still being asked when the app opens again, and says answering it continues the task", async () => {
    const taskId = await start();
    const before = await nextGate();
    expect(before.component).toBe("choose_option");
    expect(before.resumes).toBeUndefined(); // live: a run is blocked on it

    await quitAndReopen();

    const after = service.pendingInteractions();
    expect(after).toHaveLength(1);
    expect(after[0]!.taskId).toBe(taskId);
    expect(after[0]!.component).toBe("choose_option");
    // The contract is re-parsed from the stored inputs, not stored alongside them — so the question
    // and its options survive as the renderer needs them, not as a blob it has to re-derive.
    expect(after[0]!.config?.prompt).toBe("which way?");
    // The one thing that differs from a live park, and the only thing the renderer needs to know.
    expect(after[0]!.resumes).toBe(true);
  });

  it("continues the task when the recovered gate is answered, without asking it again", async () => {
    const taskId = await start();
    await nextGate(); // the first gate, left unanswered
    await quitAndReopen();
    expect(offered).toBe(1);

    const recovered = service.pendingInteractions()[0]!;
    service.submitInteraction(recovered.requestId, { decision: "left" });

    // The resumed run walks back to the state it stopped in, takes the seeded answer without
    // putting the question again, and carries it into the second gate — which is the one that is
    // offered next. Two puts in total for a two-gate workflow: the whole point.
    const second = await nextGate();
    expect(second.config?.prompt).toBe("and then?");
    expect(second.inputs["previous"]).toBe("left");
    expect(offered).toBe(2);

    // Cleared, because the close in the middle of this test already pushed a `run:finished` for the
    // run it aborted — waiting on the whole log would be waiting on something that already happened.
    pushes = [];
    service.submitInteraction(second.requestId, { decision: "go" });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the resumed run to finish");
    expect(statusOf(taskId)).toBe("completed");
    // Answered means answered: nothing is left on offer.
    expect(service.pendingInteractions()).toHaveLength(0);
  });

  it("holds a recovered gate to the same contract a live one is held to", async () => {
    await start();
    await nextGate();
    await quitAndReopen();
    const recovered = service.pendingInteractions()[0]!;

    // Main re-validates every submission (DESIGN §7.1), and a gate whose engine is not waiting yet
    // is no exception — otherwise "quit first" would be a way past the check.
    expect(() => service.submitInteraction(recovered.requestId, { decision: "sideways" })).toThrow(
      /invalid choose_option response/,
    );
    // Refused, not consumed: the question is still there to answer properly.
    expect(service.pendingInteractions()).toHaveLength(1);
  });

  it("forgets a recovered gate when the task is started again from the top", async () => {
    const taskId = await start();
    await nextGate();
    await quitAndReopen();
    expect(service.pendingInteractions()).toHaveLength(1);

    // The continuing run parks its OWN request for the same state. The row from the dead process
    // would sit beside it as a second copy of one question, answerable only by resuming a task that
    // is already running — so starting clears what it is about to re-ask. Resumed rather than
    // started: a task with history no longer restarts in place (the conversation-preamble guard).
    await service.resumeTask({ taskId });
    const fresh = await nextGate();
    expect(service.pendingInteractions()).toHaveLength(1);
    expect(fresh.resumes).toBeUndefined();
  });

  it("calls the stop a continuation, not a retry — nothing failed and nothing forks", async () => {
    const taskId = await start();
    await nextGate();
    await quitAndReopen();

    // A cancel unwinds the tree on the way out, so every instance is terminated by the time the run
    // settles and NOTHING is live — which used to make the frontier empty for every stopped run and
    // the strip offer "Retry", the word for a state that failed. This one did not fail: it asked a
    // question and the window closed. See `stoppedInside`.
    const plan = service.resumable(taskId);
    expect(plan.kind).toBe("continue");
    expect(plan.frontier).toEqual([{ stateId: `${ROOT}/a`, stopped: "mid-operation" }]);

    // And the state it picks up in is a `function` op, which places no call and therefore claims no
    // conversation position — so re-entering it forks nothing. The run that follows writes one run
    // row, on the same task, and the only session in the record stays the one it started with.
    pushes = [];
    service.submitInteraction(service.pendingInteractions()[0]!.requestId, { decision: "left" });
    const second = await nextGate();
    service.submitInteraction(second.requestId, { decision: "go" });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the resumed run to finish");
    expect(statusOf(taskId)).toBe("completed");
  });

  it("forgets a recovered gate when the task is stopped", async () => {
    const taskId = await start();
    await nextGate();
    await quitAndReopen();
    expect(service.pendingInteractions()).toHaveLength(1);

    // Nothing is running, so there is no park to reject — but saying "stop" is a decision about the
    // question, which is the one thing that ends it. See `InteractionStore.close`.
    service.cancelTask(taskId);
    expect(service.pendingInteractions()).toHaveLength(0);
  });
});
