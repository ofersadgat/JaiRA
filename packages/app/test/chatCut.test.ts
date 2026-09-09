/**
 * Rewind and fork in a CONVERSATION — the Chat view's two verbs, driven through the service.
 *
 * `chatConversation.test.ts` covers Edit, which branches and keeps the replaced side. These two do
 * not: a rewind deletes from a message on and the conversation carries on from there with nothing
 * behind a seam; a fork is a second conversation that shares everything up to a message and takes a
 * new one from there, while the original is exactly as it was. Both take the journal position the
 * thread reports for the message (`ChatEditPoint.seq`).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { CHAT_ASSISTANT, chatWorkflowFiles, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-chatcut-"));
  const paths = initProject(dir, testHome());
  for (const [stateId, state] of Object.entries(chatWorkflowFiles())) {
    const file = join(paths.workflowsDir, `${stateId}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  }
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

const REPLY = (text: string): Array<{ output: string }> => [{ output: text }];

async function started(message: string): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_ASSISTANT, inputs: { message } });
  await service.startTask({ taskId, fake: REPLY("first answer") });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
  return taskId;
}

function said(taskId: string): string[] {
  const thread = service.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

/** A conversation three messages long: the opening run, then two typed turns. */
async function threeLong(): Promise<string> {
  const taskId = await started("one");
  const thread = service.chatThread({ taskId })!;
  await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
  await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });
  return taskId;
}

describe("rewinding a conversation", () => {
  it("deletes the message and everything after it, and the next message goes where it stood", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;
    // Every typed message names the journal position its turn begins at.
    expect(before.points.map((p) => typeof p.seq)).toEqual(["number", "number"]);

    await service.rewindTask({ taskId, at: before.points[0]!.seq! });
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer"]);
    // No seam: nothing was kept to be reached.
    const after = service.chatThread({ taskId })!;
    expect(after.forks).toBeUndefined();
    expect(after.points).toEqual([]);
    // The machine had finished before any of the deleted turns; it stands as it did.
    expect(service.taskDetail(taskId).status).toBe("completed");

    await service.sendChatMessage({ taskId, instanceId: after.instanceId, message: "two, again", fake: REPLY("another second answer") });
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two, again", "assistant: another second answer"]);
  });

  it("can cut the last message alone", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;
    await service.rewindTask({ taskId, at: before.points[1]!.seq! });
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer"]);
  });
});

describe("forking a conversation", () => {
  it("is a second conversation that shares everything up to the message and takes a new one from there", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;

    const fork = await service.forkTask({ taskId, at: before.points[1]!.seq!, message: "three, differently", fake: REPLY("a different third answer") });
    expect(fork.taskId).not.toBe(taskId);
    await until(() => (service.chatThread({ taskId: fork.taskId })?.session.turns.length ?? 0) >= 6, "the fork's first reply");
    expect(said(fork.taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "assistant: second answer",
      "user: three, differently",
      "assistant: a different third answer",
    ]);
    // It knows where it came from, in words the seam can draw.
    const thread = service.chatThread({ taskId: fork.taskId })!;
    expect(thread.origin).toMatchObject({ taskId, title: titleOf("one"), label: "before message 3" });
    expect(thread.origin!.boundary).toBeGreaterThan(0);
    // Listed as its own conversation, filed under its parent.
    const listed = service.listTasks().find((t) => t.taskId === fork.taskId)!;
    expect(listed.parentTaskId).toBe(taskId);
    expect(listed.origin?.label).toBe("before message 3");
    expect(listed.status).toBe("completed");

    // The original is exactly as it was.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "assistant: second answer",
      "user: three",
      "assistant: third answer",
    ]);
    expect(service.chatThread({ taskId })!.origin).toBeUndefined();
  });
});
