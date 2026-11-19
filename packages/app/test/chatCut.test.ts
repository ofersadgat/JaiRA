/**
 * Rewind and fork in a CONVERSATION — the Chat view's two verbs, driven through the service.
 *
 * `chatConversation.test.ts` covers Edit, which branches and keeps the replaced side. These two do
 * not: a rewind deletes from a message on and the conversation carries on from there with nothing
 * behind a seam; a fork is a second conversation that shares everything up to a message and takes a
 * new one from there, while the original is exactly as it was. Both take the journal position the
 * thread reports for the message (`ChatEditPoint.seq`).
 *
 * The conversation is a PROGRAM — the shipped `session`, a loop over `input()` (decision 0029 §2) —
 * which is the only kind that takes a message after its opening one. A message is the answer to its
 * `input()`; rewound to a message, the program is taken back to the `input()` that took it and waits
 * for that message again; forked at one, the copy waits there and takes the new message as its answer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`. The
  // conversation is the shipped `session` program, resolved from the built-in layer at the end of
  // every project's search path (decision 0006): no state files are written.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-chatcut-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Every reply the conversations below make, by the message it answers. First match wins and a rule
 * matches a message that CONTAINS its words, so the longer messages come first.
 */
const RULES: FakeRule[] = [
  { promptIncludes: "two, again", output: "another second answer" },
  { promptIncludes: "three, differently", output: "a different third answer" },
  { promptIncludes: "one", output: "first answer" },
  { promptIncludes: "two", output: "second answer" },
  { promptIncludes: "three", output: "third answer" },
];

/** Waiting at its `input()` for the next message — where a program conversation stands between replies. */
const parked = (taskId: string): boolean =>
  (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
    .session()
    .hub.list()
    .some((r) => r.component === "input" && r.taskId === taskId);

function said(taskId: string): string[] {
  const thread = service.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

/** Its replies in, and waiting for the next message. */
async function settled(taskId: string, turns: number, what: string): Promise<void> {
  await eventually(() => (service.chatThread({ taskId })?.session.turns.length ?? 0) >= turns && parked(taskId), what, 20_000);
}

async function started(message: string): Promise<string> {
  // A conversation, as the Chat view makes one (`newConversation`).
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, inputs: { message, improve: false }, conversation: true });
  await service.startTask({ taskId, fake: RULES });
  await settled(taskId, 2, "the opening reply");
  return taskId;
}

/** A message, answered: the conversation `turns` long once its reply is in. */
async function send(taskId: string, message: string, turns: number): Promise<void> {
  await service.sendChatMessage({ taskId, instanceId: "", message });
  await settled(taskId, turns, `the reply to '${message}'`);
}

/** Taken back to before a message: the program waits at the `input()` that took it, under `rules`. */
async function rewound(taskId: string, at: number, rules: FakeRule[] = RULES): Promise<void> {
  await service.rewindTask({ taskId, at, fake: rules as never });
  await eventually(() => parked(taskId), "the conversation to wait for the message again", 20_000);
}

/** A conversation three messages long: the opening one, then two typed after it. */
async function threeLong(): Promise<string> {
  const taskId = await started("one");
  await send(taskId, "two", 4);
  await send(taskId, "three", 6);
  return taskId;
}

describe("rewinding a conversation", { timeout: 60_000 }, () => {
  it("deletes the message and everything after it, and the next message goes where it stood", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;
    // Every typed message names the journal position its turn begins at.
    expect(before.points.map((p) => typeof p.seq)).toEqual(["number", "number"]);

    await rewound(taskId, before.points[0]!.seq!);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer"]);
    // No seam: nothing was kept to be reached.
    const after = service.chatThread({ taskId })!;
    expect(after.forks).toBeUndefined();
    expect(after.points).toEqual([]);
    // Waiting for the message again, as it waited for it the first time: idle, not working.
    expect(service.listTasks().find((t) => t.taskId === taskId)).toMatchObject({ waitsForMessage: true, status: "completed" });

    await send(taskId, "two, again", 4);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two, again", "assistant: another second answer"]);
  });

  it("can cut the last message alone", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;
    await rewound(taskId, before.points[1]!.seq!);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer"]);
  });

  it("takes the message's record with it, so the same words can be sent again — and again", async () => {
    const taskId = await threeLong();
    for (const reply of ["third answer, again", "third answer, once more"]) {
      const thread = service.chatThread({ taskId })!;
      await rewound(taskId, thread.points[1]!.seq!, [{ promptIncludes: "three", output: reply }, ...RULES]);
      await send(taskId, "three", 6);
      expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer", "user: three", `assistant: ${reply}`]);
      expect(service.chatThread({ taskId })!.forks).toBeUndefined();
    }
  });

  it("frees the seat for different words too, with nothing left behind a seam", async () => {
    const taskId = await threeLong();
    const thread = service.chatThread({ taskId })!;
    await rewound(taskId, thread.points[1]!.seq!);
    await send(taskId, "three, differently", 6);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer", "user: three, differently", "assistant: a different third answer"]);
    expect(service.chatThread({ taskId })!.forks).toBeUndefined();
  });

  it("rewinds a message that was itself sent again", async () => {
    const taskId = await threeLong();
    const thread = service.chatThread({ taskId })!;
    await rewound(taskId, thread.points[1]!.seq!, [{ promptIncludes: "three", output: "third answer, again" }, ...RULES]);
    await send(taskId, "three", 6);
    const cutAgain = service.chatThread({ taskId })!.points[1]!.seq!;
    await rewound(taskId, cutAgain);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer"]);
    expect(service.chatThread({ taskId })!.points).toHaveLength(1);
  });
});

describe("rewinding to before the message a conversation opened with", { timeout: 60_000 }, () => {
  it("is offered for the opening message alone, at the run's own entry", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    // Nothing typed after it, so no point to replace or cut at — and still the opening can be cut before.
    expect(thread.points).toEqual([]);
    expect(thread.opening).toMatchObject({ turn: 0 });
    const entered = service.taskDetail(taskId).timeline.find((t) => t.type === "instance.entered")!.seq;
    expect(thread.opening!.seq).toBe(entered);
    // Later messages leave it where it was, and still not among the points.
    const longer = await threeLong();
    const three = service.chatThread({ taskId: longer })!;
    expect(three.opening).toMatchObject({ turn: 0 });
    expect(three.points.map((p) => p.turn)).not.toContain(0);
  });

  it("deletes the conversation, however long it is", async () => {
    const taskId = await threeLong();
    const opening = service.chatThread({ taskId })!.opening!;
    expect(await service.rewindTask({ taskId, at: opening.seq })).toEqual({ taskId, deleted: true });
    expect(service.listTasks().some((t) => t.taskId === taskId)).toBe(false);
  });
});

describe("forking a conversation", { timeout: 60_000 }, () => {
  it("is a second conversation that shares everything up to the message and takes a new one from there", async () => {
    const taskId = await threeLong();
    const before = service.chatThread({ taskId })!;

    const fork = await service.forkTask({ taskId, at: before.points[1]!.seq!, message: "three, differently", fake: RULES as never });
    expect(fork.taskId).not.toBe(taskId);
    await settled(fork.taskId, 6, "the fork's first reply");
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
    // A copy of what was kept: the cut turn is not carried along, seated past the cut.
    expect(thread.forks).toBeUndefined();
    expect(thread.origin!.boundary).toBeGreaterThan(0);
    // Listed as its own conversation, filed under its parent, waiting for its next message.
    const listed = service.listTasks().find((t) => t.taskId === fork.taskId)!;
    expect(listed.parentTaskId).toBe(taskId);
    expect(listed.origin?.label).toBe("before message 3");
    expect(listed).toMatchObject({ status: "completed", waitsForMessage: true });

    // The original is exactly as it was, and still waiting for ITS next message.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "assistant: second answer",
      "user: three",
      "assistant: third answer",
    ]);
    expect(service.chatThread({ taskId })!.origin).toBeUndefined();
    expect(parked(taskId)).toBe(true);
  });
});
