/**
 * Two host rows a conversation's workflow tools leave in a journal (decision 0005), read back.
 *
 *  - `jaira.answered` of kind `question` — an agent's `AskUserQuestion` the control conversation
 *    answered — lands on the instance it names as `answeredQuestions`, one mark per row, each with the
 *    question texts that pick its block out of the agent's transcript. The gate's `settledBy` is
 *    unchanged beside it.
 *  - `jaira.moved` — what a `start_task` / `move_task` did — is a `moved` turn at the conversation's
 *    root, carrying the tool note's own words, so the rail can draw it as a row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import { ANSWERED_EVENT, MOVED_EVENT, type AnsweredEvent, type MovedEvent } from "@jaira/shared";
import { initProject, openProject, type Project } from "../src/project";
import { conversationView } from "../src/conversation";
import { createTask } from "../src/lifecycle";
import { taskRun } from "../src/views";

let dir: string;
let project: Project;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-hostrows-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(taskId: string, events: unknown[]): void {
  project.runtime.beginTask(taskId, "hash", now);
  const recorder = project.events.recorder(taskId);
  events.forEach((event, i) => recorder.record(event as EngineEvent, now + i));
}

const answered = (instanceId: string, questions: string[] | undefined, confidence: number): AnsweredEvent => ({
  type: ANSWERED_EVENT,
  requestId: `q-${confidence}`,
  kind: "question",
  instanceId,
  ...(questions !== undefined ? { questions } : {}),
  byTaskId: "t-conv",
  settled_by: { via: "control", confidence },
});

describe("an agent's questions answered for the person", () => {
  it("lands every question row on its instance, with the texts it answered and the state's entry to rewind to", () => {
    const taskId = createTask(project, { title: "Pause and stop", workflow: "w" }).id;
    record(taskId, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: "i-draft", stateId: "w/draft", childKey: "draft", parentInstanceId: "i-root", inputs: {} },
      { type: "operation.started", instanceId: "i-draft", stateId: "w/draft", op: "prompt" },
      answered("i-draft", ["Which way?"], 0.86),
      answered("i-draft", ["How far?", "How fast?"], 0.7),
    ]);
    const draft = taskRun(project, taskId).instances[0]!.children[0]!;
    const entry = project.events.list(taskId).find((row) => row.event.type === "instance.entered" && row.event.instanceId === "i-draft")!.seq;
    expect(draft.answeredQuestions).toEqual([
      { via: "control", confidence: 0.86, byTaskId: "t-conv", at: entry, questions: ["Which way?"] },
      { via: "control", confidence: 0.7, byTaskId: "t-conv", at: entry, questions: ["How far?", "How fast?"] },
    ]);
    // The instance-wide mark a GATE reads is the first row, as it was.
    expect(draft.settledBy).toMatchObject({ confidence: 0.86, at: entry });
    expect(draft.settledBy?.questions).toBeUndefined();
  });

  it("keeps a row written before it carried its texts, with no texts — the transcript decides what it can pair", () => {
    const taskId = createTask(project, { title: "Older", workflow: "w" }).id;
    record(taskId, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      answered("i-root", undefined, 0.5),
    ]);
    const root = taskRun(project, taskId).instances[0]!;
    expect(root.answeredQuestions).toHaveLength(1);
    expect(root.answeredQuestions![0]!.questions).toBeUndefined();
  });

  it("puts nothing on a gate's instance — its interaction row is `settledBy` alone", () => {
    const taskId = createTask(project, { title: "A gate", workflow: "w" }).id;
    record(taskId, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { ...answered("i-root", undefined, 0.9), kind: "interaction" },
    ]);
    const root = taskRun(project, taskId).instances[0]!;
    expect(root.settledBy).toMatchObject({ confidence: 0.9 });
    expect(root.answeredQuestions).toBeUndefined();
  });
});

describe("what a conversation's workflow tool did", () => {
  it("is a `moved` turn at the conversation's root, in the tool note's own words", () => {
    const taskId = createTask(project, { title: "let's think about the ux", workflow: "chat/session" }).id;
    const moved: MovedEvent = {
      type: MOVED_EVENT,
      tool: "move_task",
      task: "t-parent",
      outcome: { verb: "adopted into", standsAt: "ux", workflow: "feature", adoptedAs: "product" },
    };
    record(taskId, [{ type: "instance.entered", instanceId: "i-root", stateId: "chat/session", inputs: {} }, moved]);
    const turns = conversationView(project, taskId).turns;
    expect(turns.map((t) => [t.kind, t.path])).toEqual([
      ["entered", ""],
      ["moved", ""],
    ]);
    expect(turns[1]!.moved).toEqual(moved.outcome);
    // A fact about the conversation, not about any state in it: it names no instance.
    expect(turns[1]!.instanceId).toBeUndefined();
  });
});
