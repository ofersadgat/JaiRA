/**
 * Rewind and fork in a RUN — the Tasks view's two verbs, driven through the service.
 *
 * The fixture is `load.test.ts`'s: root → loop → tick, where `tick` is a question (`confirm_action`)
 * and the loop asks again for as long as the answer is yes. A run that answered yes, yes, no has
 * three ticks. Rewinding to before the second one deletes it and the third, and the resume that
 * follows asks the second question AGAIN — which is what "rewind to a question" means. A fork at
 * the same point is a second task that asks it, while the original keeps its three answers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { InstanceNode, PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

const ROOT = "cut";

function files(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Cut fixture",
      outputs: { last: { schema: { type: "boolean" }, binding: ".children.loop.output.last" } },
      children: { loop: { state: `${ROOT}/loop` } },
      sequence: ["loop"],
    },
    [`${ROOT}/loop`]: {
      label: "Ask until told to stop",
      outputs: { last: { schema: { type: "boolean" }, binding: ".children.tick.output.confirmed" } },
      children: { tick: { state: `${ROOT}/loop/tick` } },
      sequence: ["tick"],
      transitions: [
        {
          to: "tick",
          when: ".run.cursor === 'tick' && .children.tick.output.confirmed === true && .run.iteration < .limits.max_iterations",
        },
        { to: "terminate.success", when: ".run.cursor === 'tick' && .children.tick.output.confirmed === false" },
      ],
      limits: { max_iterations: 5 },
    },
    [`${ROOT}/loop/tick`]: {
      label: "Again?",
      outputs: { confirmed: { schema: { type: "boolean" } } },
      operation: { kind: "function", function: "confirm_action", args: { prompt: "Again?" } },
    },
  };
}

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-runcut-"));
  writeWorkflowFiles(initProject(dir, testHome()).workflowsDir, files());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, label: string, budgetMs = 8000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** yes, yes, no — three ticks, then done. */
async function ranThree(): Promise<string> {
  const { taskId } = service.createTask({ title: "Cut", workflow: ROOT });
  await service.startTask({ taskId, interactions: { confirm_action: [{ confirmed: true }, { confirmed: true }, { confirmed: false }] } });
  await until(() => service.taskDetail(taskId).status === "completed", "the run to finish");
  return taskId;
}

/** The loop's ticks, in the order they were entered. */
function ticks(taskId: string): InstanceNode[] {
  const detail = service.taskDetail(taskId);
  const loop = detail.instances[0]?.children.find((c) => c.childKey === "loop");
  return loop?.children.filter((c) => c.childKey === "tick") ?? [];
}

/** The journal position a tick was entered at. */
function enteredAt(taskId: string, tick: InstanceNode): number {
  const entry = service.taskDetail(taskId).timeline.find((t) => t.type === "instance.entered" && t.instanceId === tick.instanceId);
  if (entry === undefined) throw new Error("the tick's entry is not in the timeline");
  return entry.seq;
}

describe("rewinding a run to before a state", () => {
  it("deletes the state and everything after it, and the resume asks the question again", async () => {
    const taskId = await ranThree();
    const before = ticks(taskId);
    expect(before).toHaveLength(3);

    // Rewind to before the SECOND tick, with the second question now answered "no".
    await service.rewindTask({ taskId, at: enteredAt(taskId, before[1]!), interactions: { confirm_action: [{ confirmed: false }] } });
    await until(() => service.taskDetail(taskId).status === "completed", "the resumed run to finish");

    const after = ticks(taskId);
    // The first tick is the one that ran before; the second is a NEW instance — same state, fresh
    // entry — and there is no third.
    expect(after).toHaveLength(2);
    expect(after[0]!.instanceId).toBe(before[0]!.instanceId);
    expect(after[1]!.instanceId).not.toBe(before[1]!.instanceId);
    expect(after[1]!.status).toBe("completed");
    expect(service.taskDetail(taskId).runs[0]?.outcome).toBe("success");
  });

  it("refuses while the task is running", async () => {
    const { taskId } = service.createTask({ title: "Cut", workflow: ROOT });
    void service.startTask({ taskId });
    await until(() => service.pendingInteractions().some((p) => p.component === "confirm_action"), "the first question");
    const first = ticks(taskId)[0]!;
    await expect(service.rewindTask({ taskId, at: enteredAt(taskId, first) })).rejects.toThrow(/running/);
    service.cancelTask(taskId);
  });
});

describe("forking a run before a state", () => {
  it("is a second task that asks the question again, while the original keeps its answers", async () => {
    const taskId = await ranThree();
    const before = ticks(taskId);

    const fork = await service.forkTask({ taskId, at: enteredAt(taskId, before[1]!), interactions: { confirm_action: [{ confirmed: false }] } });
    expect(fork.taskId).not.toBe(taskId);
    await until(() => service.taskDetail(fork.taskId).status === "completed", "the fork to finish");

    const copied = ticks(fork.taskId);
    expect(copied).toHaveLength(2);
    // Fresh ids throughout: the copied first tick is not the parent's first tick.
    expect(copied[0]!.instanceId).not.toBe(before[0]!.instanceId);
    const detail = service.taskDetail(fork.taskId);
    expect(detail.origin).toMatchObject({ taskId, title: "Cut", label: "before tick" });
    expect(service.listTasks().find((t) => t.taskId === fork.taskId)?.parentTaskId).toBe(taskId);

    // The original: three ticks, untouched, no origin of its own.
    expect(ticks(taskId)).toHaveLength(3);
    expect(service.taskDetail(taskId).origin).toBeUndefined();
    expect(service.taskDetail(taskId).status).toBe("completed");
  });
});
