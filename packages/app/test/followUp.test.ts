/**
 * Follow-up questions run INSIDE the gate (runtime `followUp.ts`, `AppService.followUp`).
 *
 * A person answers a multi-part chooser and ticks "the model may ask follow-up questions". The gate
 * on screen goes away, a model is asked what the answers opened, and the same call is parked again
 * with those questions — a second request, a second row, the one engine promise. What the state
 * finally gets is every round's answers in one `answers`, which the next state reads as its input.
 * That last read is the proof: the engine never saw two calls, and the follow-up's answer arrived
 * in the same result as the original questions'.
 *
 * Driven headlessly through the real service, with the model scripted (`fake`): the loop's own call
 * is made by the host outside the run, and it has to answer from the run's script or a test of it
 * would reach for a provider.
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

const ROOT = "followup";

/** A chooser with follow-ups on offer, and a gate after it that reads what the chooser answered. */
function files(): Record<string, JsonValue> {
  return {
    [ROOT]: {
      label: "Follow-up fixture",
      inputs: { issue: { schema: { type: "string" }, default: "Update the side panel." } },
      outputs: { last: { schema: { type: "string" }, binding: ".children.after.output.decision" } },
      children: {
        ask: { state: `${ROOT}/ask`, inputs: { issue: ".inputs.issue" } },
        after: { state: `${ROOT}/after`, inputs: { answers: ".children.ask.output.answers" } },
      },
      sequence: ["ask", "after"],
    },
    [`${ROOT}/ask`]: {
      label: "Ask",
      inputs: { issue: { schema: { type: "string" }, description: "Context for the follow-up model." } },
      outputs: { answers: { schema: { type: "object" } } },
      operation: {
        kind: "function",
        function: "choose_option",
        args: {
          prompt: "The draft could not settle these.",
          follow_up: true,
          questions: [{ name: "sort", question: "Where does a stopped conversation sort?", options: ["above", "below"], default: "below" }],
        },
      },
    },
    [`${ROOT}/after`]: {
      label: "After",
      inputs: { answers: { schema: { type: "object" } } },
      outputs: { decision: { schema: { type: "string" } } },
      operation: { kind: "function", function: "choose_option", args: { prompt: "done?", options: ["yes"] } },
    },
  };
}

/** The scripted model: one follow-up the first time it is asked, nothing the second. */
const SCRIPT: JsonValue = [
  {
    promptIncludes: "follow-up questions",
    output: {
      questions: [
        {
          name: "grouping",
          question: "Group by workflow?",
          options: [{ value: "yes" }, { value: "no", description: "one flat list" }],
          default: "yes",
          custom: true,
          optional: true,
        },
        // A name already asked: dropped, never a second `sort`.
        { name: "sort", question: "again?", options: ["a", "b"] },
      ],
    },
  },
  { promptIncludes: "follow-up questions", output: { questions: [] } },
];

let dir: string;
let service: AppService;
let pushes: PushMessage[];
const seen = new Set<string>();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-follow-up-"));
  const { workflowsDir } = initProject(dir, testHome());
  writeWorkflowFiles(workflowsDir, files());
  pushes = [];
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

async function nextGate(): Promise<ReturnType<AppService["pendingInteractions"]>[number]> {
  await until(() => service.pendingInteractions().some((p) => !seen.has(p.requestId)), "the next gate");
  const gate = service.pendingInteractions().find((p) => !seen.has(p.requestId))!;
  seen.add(gate.requestId);
  return gate;
}

async function start(fake: JsonValue = SCRIPT): Promise<string> {
  const { taskId } = service.createTask({ title: "Follow-ups", workflow: ROOT });
  await service.startTask({ taskId, fake });
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

describe("a chooser that offers follow-up questions", () => {
  it("asks the model, parks the follow-ups as a second round, and hands the next state every round's answers", async () => {
    const taskId = await start();
    const first = await nextGate();
    expect(first.config?.component).toBe("choose_option");
    expect(first.config).toMatchObject({ followUp: true });

    service.submitInteraction(first.requestId, { answers: { sort: "below" }, follow_up: true });
    // The answered question is gone at once — nothing on screen offers it a second time — and the
    // round the model asked for takes its place under a new id.
    expect(service.pendingInteractions().map((p) => p.requestId)).not.toContain(first.requestId);
    const second = await nextGate();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.taskId).toBe(taskId);
    expect(second.config?.component).toBe("choose_option");
    const questions = (second.config as { questions?: { name: string }[] }).questions ?? [];
    expect(questions.map((q) => q.name)).toEqual(["grouping"]);
    // The loop's bookkeeping rides on the request, where a durable row and a later round read it.
    expect(second.inputs["prior_answers"]).toEqual({ sort: "below" });
    expect(second.inputs["follow_up_round"]).toBe(2);
    // The context the model reads is still there for the next round.
    expect(second.inputs["issue"]).toBe("Update the side panel.");
    // A durable row for the new round, and none for the answered one.
    const project = openProject(dir, { baseDir: testHome() });
    try {
      expect(project.interactions.list().map((r) => r.requestId)).toEqual([second.requestId]);
    } finally {
      project.close();
    }

    // Asked again with the box ticked: the script has nothing more to ask, so the gate settles.
    service.submitInteraction(second.requestId, { answers: { grouping: "yes" }, follow_up: true });
    const after = await nextGate();
    expect(after.config?.prompt).toBe("done?");
    // ONE result for the state: both rounds' answers, and nothing about the loop.
    expect(after.inputs["answers"]).toEqual({ sort: "below", grouping: "yes" });

    service.submitInteraction(after.requestId, { decision: "yes" });
    await until(() => pushes.some((p) => p.type === "run:finished"), "the run to finish");
    expect(statusOf(taskId)).toBe("completed");
    expect(service.pendingInteractions()).toHaveLength(0);
  });

  it("settles on the click when the box is not ticked, with only that round's answers", async () => {
    await start();
    const first = await nextGate();
    service.submitInteraction(first.requestId, { answers: { sort: "above" }, follow_up: false });
    const after = await nextGate();
    expect(after.config?.prompt).toBe("done?");
    expect(after.inputs["answers"]).toEqual({ sort: "above" });
  });

  it("settles with the answers given when the model cannot be asked", async () => {
    // A script with nothing for the follow-up call: the call fails, and the failure is not the
    // person's problem — their answers stand and the run goes on.
    await start([]);
    const first = await nextGate();
    service.submitInteraction(first.requestId, { answers: { sort: "below" }, follow_up: true });
    const after = await nextGate();
    expect(after.config?.prompt).toBe("done?");
    expect(after.inputs["answers"]).toEqual({ sort: "below" });
  });
});
