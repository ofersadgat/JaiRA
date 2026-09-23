/**
 * The host's own journal rows (decision 0005), read back.
 *
 *  - `jaira.answered` of kind `question` — an agent's `AskUserQuestion` the control conversation
 *    answered — lands on the instance it names as `answeredQuestions`, one mark per row, each with the
 *    question texts that pick its block out of the agent's transcript. The gate's `settledBy` is
 *    unchanged beside it.
 *  - `jaira.moved` — what a `start_task` / `move_task` did — is a `moved` turn at the conversation's
 *    root, carrying the tool note's own words, so the rail can draw it as a row.
 *  - The durable half of a fast-forward, a held move and a finished task's reopening (`hostRows.ts`,
 *    decision 0005's Open list, closed 2026-09-22). Each reader is a fold over the rows IN ORDER — an
 *    opening row is open until a closing row follows it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import {
  ANSWERED_EVENT,
  FAST_FORWARD_ENDED_EVENT,
  FAST_FORWARD_EVENT,
  MOVE_DROPPED_EVENT,
  MOVE_HELD_EVENT,
  MOVED_EVENT,
  REOPENED_EVENT,
  type AnsweredEvent,
  type FastForwardEvent,
  type MovedEvent,
} from "@jaira/shared";
import { initProject, openProject, type Project } from "../src/project";
import { conversationView } from "../src/conversation";
import { createTask, hasJournalHistory } from "../src/lifecycle";
import { forkTask, rewindTask as cutTaskJournal } from "../src/cut";
import { heldMoves, journalRowsThrough, openFastForward, recordHostRow, reopenedAfter, seqAtJournalRow } from "../src/hostRows";
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

const answered = (instanceId: string, toolCallId: string | undefined, confidence: number): AnsweredEvent => ({
  type: ANSWERED_EVENT,
  requestId: `q-${confidence}`,
  kind: "question",
  instanceId,
  ...(toolCallId !== undefined ? { toolCallId } : {}),
  byTaskId: "t-conv",
  settled_by: { via: "control", confidence },
});

describe("an agent's questions answered for the person", () => {
  it("lands every question row on its instance, with the call it answered and the state's entry to rewind to", () => {
    const taskId = createTask(project, { title: "Pause and stop", workflow: "w" }).id;
    record(taskId, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      { type: "instance.entered", instanceId: "i-draft", stateId: "w/draft", childKey: "draft", parentInstanceId: "i-root", inputs: {} },
      { type: "operation.started", instanceId: "i-draft", stateId: "w/draft", op: "prompt" },
      answered("i-draft", "toolu_way", 0.86),
      answered("i-draft", "toolu_far", 0.7),
    ]);
    const draft = taskRun(project, taskId).instances[0]!.children[0]!;
    const entry = project.events.list(taskId).find((row) => row.event.type === "instance.entered" && row.event.instanceId === "i-draft")!.seq;
    expect(draft.answeredQuestions).toEqual([
      { via: "control", confidence: 0.86, byTaskId: "t-conv", at: entry, toolCallId: "toolu_way" },
      { via: "control", confidence: 0.7, byTaskId: "t-conv", at: entry, toolCallId: "toolu_far" },
    ]);
    // The instance-wide mark a GATE reads is the first row, as it was.
    expect(draft.settledBy).toMatchObject({ confidence: 0.86, at: entry });
    expect(draft.settledBy?.toolCallId).toBeUndefined();
  });

  it("keeps a row that names no call, with none — the transcript draws it nowhere", () => {
    const taskId = createTask(project, { title: "Older", workflow: "w" }).id;
    record(taskId, [
      { type: "instance.entered", instanceId: "i-root", stateId: "w", inputs: {} },
      answered("i-root", undefined, 0.5),
    ]);
    const root = taskRun(project, taskId).instances[0]!;
    expect(root.answeredQuestions).toHaveLength(1);
    expect(root.answeredQuestions![0]!.toolCallId).toBeUndefined();
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

const engine = (taskId: string, event: Record<string, unknown>): void => project.events.recorder(taskId).record(event as unknown as EngineEvent, Date.now());
const start = (target: string): FastForwardEvent => ({ type: FAST_FORWARD_EVENT, controlTaskId: "t-c", target, targetLabel: target, to: target, path: [], through: [], startedAt: 1 });

describe("openFastForward", () => {
  it("is the newest start with no end after it — and a cut that takes the end away opens it again", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    expect(openFastForward(project, id)).toBeUndefined();
    recordHostRow(project, id, start("x"));
    engine(id, { type: "instance.entered", instanceId: "r", stateId: "w", inputs: {} });
    expect(openFastForward(project, id)).toMatchObject({ row: { target: "x" }, since: [{ type: "instance.entered" }] });
    recordHostRow(project, id, { type: FAST_FORWARD_ENDED_EVENT, end: "stopped" });
    expect(openFastForward(project, id)).toBeUndefined();
    // A second fast-forward is a new start; the newest one is what is open.
    recordHostRow(project, id, start("y"));
    expect(openFastForward(project, id)?.row.target).toBe("y");
    const end = project.events.list(id).at(-1)!.seq + 1;
    recordHostRow(project, id, { type: FAST_FORWARD_ENDED_EVENT, end: "arrived" });
    cutTaskJournal(project, id, end);
    expect(openFastForward(project, id)?.row.target).toBe("y");
  });

  it("is not the machine having said something: a task whose journal holds only a start still starts fresh", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    recordHostRow(project, id, start("x"));
    expect(hasJournalHistory(project, id)).toBe(false);
    engine(id, { type: "instance.entered", instanceId: "r", stateId: "w", inputs: {} });
    expect(hasJournalHistory(project, id)).toBe(true);
  });
});

describe("heldMoves", () => {
  it("keeps the latest hold per instance, and a directed transition, a drop or a replacement ends it", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    engine(id, { type: "instance.entered", instanceId: "root", stateId: "w", inputs: {} });
    engine(id, { type: "instance.entered", instanceId: "sub", parentInstanceId: "root", childKey: "s", stateId: "w/s", inputs: {} });
    recordHostRow(project, id, { type: MOVE_HELD_EVENT, to: "b", by: "person" });
    recordHostRow(project, id, { type: MOVE_HELD_EVENT, under: "sub", to: "y", by: "control", path: ["z"] });
    expect(heldMoves(project, id).map((m) => m.to)).toEqual(["b", "y"]);
    // The latest move wins.
    recordHostRow(project, id, { type: MOVE_HELD_EVENT, to: "c", by: "person" });
    expect(heldMoves(project, id).map((m) => m.to)).toEqual(["y", "c"]);
    // A RULE's transition on the root is not the move being taken.
    engine(id, { type: "transition.taken", instanceId: "root", stateId: "w", to: "c", index: 1, iteration: 0 });
    expect(heldMoves(project, id).map((m) => m.to)).toEqual(["y", "c"]);
    // A directed one is — and names the root by its id, which a hold naming no instance means.
    engine(id, { type: "transition.taken", instanceId: "root", stateId: "w", to: "c", index: 2, iteration: 0, by: "person" });
    expect(heldMoves(project, id).map((m) => m.to)).toEqual(["y"]);
    recordHostRow(project, id, { type: MOVE_DROPPED_EVENT, under: "sub", reason: "stopped" });
    expect(heldMoves(project, id)).toEqual([]);
  });
});

describe("a place in the journal that outlives the seq", () => {
  it("counts rows up to a seq and reads the count back", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    const other = createTask(project, { title: "U", workflow: "w" });
    engine(id, { type: "instance.entered", instanceId: "r", stateId: "w", inputs: {} });
    engine(other.id, { type: "instance.entered", instanceId: "q", stateId: "w", inputs: {} });
    engine(id, { type: "instance.terminated", instanceId: "r", stateId: "w", outcome: "success" });
    const last = project.events.list(id).at(-1)!.seq;
    expect(journalRowsThrough(project, id, last)).toBe(2);
    expect(seqAtJournalRow(project, id, 2)).toBe(last);
    expect(seqAtJournalRow(project, id, 0)).toBe(0);
  });

  it("finds the reopening a cut at a seq takes away", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    engine(id, { type: "instance.entered", instanceId: "r", stateId: "w", inputs: {} });
    const cut = project.events.list(id).at(-1)!.seq + 1;
    recordHostRow(project, id, { type: REOPENED_EVENT, status: "completed", outcome: "success", endedAt: 5, outputsJson: '{"a":1}' });
    expect(reopenedAfter(project, id, cut)).toMatchObject({ outputsJson: '{"a":1}', endedAt: 5 });
    expect(reopenedAfter(project, id, cut + 1)).toBeUndefined();
  });
});

describe("a copy of the journal", () => {
  it("does not inherit what a process was doing with the task it was copied from", () => {
    const { id } = createTask(project, { title: "T", workflow: "w" });
    project.runtime.beginTask(id, "snap", Date.now());
    engine(id, { type: "instance.entered", instanceId: "r", stateId: "w", inputs: {} });
    recordHostRow(project, id, start("x"));
    recordHostRow(project, id, { type: MOVE_HELD_EVENT, to: "b", by: "person" });
    engine(id, { type: "instance.entered", instanceId: "c1", parentInstanceId: "r", childKey: "a", stateId: "w/a", inputs: {} });
    const copy = forkTask(project, id, project.events.list(id).at(-1)!.seq, { standing: "startable" });
    const types = project.events.list(copy.taskId).map((row) => row.type as string);
    expect(types).toEqual(["instance.entered"]);
    expect(openFastForward(project, copy.taskId)).toBeUndefined();
    expect(heldMoves(project, copy.taskId)).toEqual([]);
  });
});
