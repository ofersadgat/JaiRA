/**
 * A conversation as the Chat view has one, driven the way the view drives it.
 *
 * The other chat test (`chatMessage.test.ts`) is about the composer's settings and about sending a
 * message. This is about the view whose whole content is the conversation: a task created from the
 * workflow the Chat view starts — the shipped `session`, a PROGRAM that loops over `input()` (decision
 * 0029 §2) — whose first message is its run's input and whose every message after that is the answer
 * to its `input()`, replied to by the run's next call on the same chain.
 *
 * What it exists to catch is the seam nothing below it can see. Each half works alone — the program
 * loads, `chat:send` answers its wait, a rewind cuts the journal — and the questions here are whether
 * the halves agree: does the thread read back as ONE conversation rather than a stack of last-turns,
 * are the edit points the positions they claim to be, and does an edit actually take back what came
 * after it instead of stacking two answers to two different questions in the same thread.
 *
 * Every model call is scripted (`fake`): the rules a run starts with answer every call it makes.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, type Project } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-convo-"));
  // No state files are written: the conversation SHIPS, in the built-in layer at the end of every
  // project's search path (decision 0006), so an empty project over an empty shared root resolves
  // it — which is the install step's absence, tested by everything below.
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The program waits at its `input()` for the next message — between replies, idle. */
const parked = (taskId: string): boolean =>
  (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
    .session()
    .hub.list()
    .some((r) => r.component === "input" && r.taskId === taskId);

/** The program's replies so far — one per message it answered, whether the call settled or failed. */
const replies = (taskId: string): number => service.sessionHistory({ taskId }).length;

/**
 * What the model answers: each message's own reply, by what it says. First match wins, so a message
 * whose text holds another's comes first.
 */
const SCRIPT: FakeRule[] = [
  { promptIncludes: "two, but better", output: "a better second answer" },
  { promptIncludes: "two again", output: "second again" },
  { promptIncludes: "two, finally", output: "second, finally" },
  { promptIncludes: "one", output: "first answer" },
  { promptIncludes: "two", output: "second answer" },
  { promptIncludes: "three", output: "third answer" },
];

/**
 * Start a conversation the way the view does: create the task with the message, then run it — and
 * wait for its first reply, and for the program to wait for the next message. `improve: false`: these
 * are about the conversation, not the strict look at each message that would be another scripted call.
 */
async function started(message: string, fake: FakeRule[] = SCRIPT): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, conversation: true, inputs: { message, improve: false } });
  await service.startTask({ taskId, fake });
  await eventually(() => replies(taskId) >= 1 && parked(taskId), "the opening reply", 20_000);
  return taskId;
}

/** Send a message and wait for its reply, and for the program to wait again. */
async function send(taskId: string, message: string): Promise<void> {
  const before = replies(taskId);
  await service.sendChatMessage({ taskId, instanceId: service.chatThread({ taskId })!.instanceId, message });
  await eventually(() => replies(taskId) > before && parked(taskId), `the reply to "${message}"`, 20_000);
}

/** The turns of a thread as `role: text`, which is what these assertions are actually about. */
function said(taskId: string): string[] {
  const thread = service.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

describe("a conversation started from the Chat view", { timeout: 60_000 }, () => {
  it("is an ordinary task whose FIRST message is the run", async () => {
    const taskId = await started("What is in this repository? one");
    const [task] = service.listTasks().filter((t) => t.taskId === taskId);
    expect(task?.workflow).toBe(CHAT_SESSION);
    // Waiting for its next message, it reads as its last reply left it — done, not working.
    expect(task?.status).toBe("completed");
    // The message is the prompt, so it is in the transcript as the user's own first turn rather
    // than as an input nobody can read.
    expect(said(taskId)[0]).toBe("user: What is in this repository? one");
    service.cancelTask(taskId);
  });

  it("names itself after what it opened with", () => {
    expect(titleOf("  Explain the session store\nand its two tables ")).toBe("Explain the session store");
    expect(titleOf(`${"x".repeat(80)}`)).toHaveLength(58); // 57 kept, then the ellipsis
    expect(titleOf("   ")).toBe("New conversation");
  });

  it("reads back as ONE thread — every turn of it, in order", async () => {
    const taskId = await started("one");
    await send(taskId, "two");
    await send(taskId, "three");
    // The whole conversation, not the newest call's own contribution — which is what `sessionView`
    // answers, and what a chat panel built on it would have shown three separate panels of.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "assistant: second answer",
      "user: three",
      "assistant: third answer",
    ]);
    // One chain: every reply continued where the one before it ended.
    expect(new Set(service.sessionHistory({ taskId }).map((h) => h.sessionId)).size).toBe(1);
    service.cancelTask(taskId);
  });

  it("offers an edit point for every hand-typed message, and none for the run's own prompt", async () => {
    const taskId = await started("one");
    const first = service.chatThread({ taskId })!;
    // Nothing typed yet: the only message is the run's input, which is not a point to edit at — it
    // can only be CUT before, which is the conversation gone (`opening`).
    expect(first.points).toEqual([]);
    expect(first.opening).toBeDefined();
    await send(taskId, "two");
    const thread = service.chatThread({ taskId })!;
    expect(thread.points).toHaveLength(1);
    // The point names the TURN it starts at, so the caller can put an Edit on the right message,
    // and the journal position a rewind and a fork take.
    expect(thread.session.turns[thread.points[0]!.turn]?.text).toBe("two");
    expect(thread.points[0]!.seq).toBeDefined();
    service.cancelTask(taskId);
  });

  it("keeps the tail on `chat:plan`'s instance, so the composer and the thread address one thing", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    expect(service.chatPlan({ taskId, instanceId: thread.instanceId })).not.toBeNull();
    service.cancelTask(taskId);
  });

  it("answers null for a task that never ran, rather than throwing at being asked", () => {
    const { taskId } = service.createTask({ title: "unsent", workflow: CHAT_SESSION, conversation: true, inputs: { message: "hi" } });
    expect(service.chatThread({ taskId })).toBeNull();
  });
});

/**
 * The composer above the box that STARTS a conversation. It shows the same four settings the thread's
 * does, and it has to answer them before there is a run to read them off — so the plan comes from the
 * state file, and what is picked reaches the first message by riding its run.
 */
describe("the settings of a conversation that has not started yet", { timeout: 60_000 }, () => {
  it("reads them off the workflow file — what the first message would inherit, and from where", () => {
    const plan = service.chatStartPlan({ stateId: CHAT_SESSION });
    // A program's reply holds no settings of its own: they are its root's, and the card says so.
    expect(plan.from).toBe(CHAT_SESSION);
    // The program's own permission set (`meta.environment` on the script), as the lowered list and
    // block a loaded state holds — every call of the run inherits it from the root.
    for (const name of ["read_file", "glob", "grep", "edit", "write_file", "shell", "web_fetch", "web_search", "start_task"]) {
      expect(plan.settings.tools, name).toContain(name);
    }
    expect(plan.origin.tools).toBe("inherited");
    expect(plan.settings.permissions).toMatchObject({ tools: { read_file: "ask", shell: "ask" }, other: "ask", subjects: { shell: "ask" } });
    // Nothing is in flight before anything has started, and the machine's offer is still an offer.
    expect(plan.live).toBe("idle");
    expect(plan.available.tools.map((t) => t.name)).toContain("shell");
  });

  it("folds a pick over the file, and says it was a pick", () => {
    const plan = service.chatStartPlan({ stateId: CHAT_SESSION, overrides: { model: "anthropic/claude-sonnet-5", tools: [] } });
    expect(plan.settings.model).toBe("anthropic/claude-sonnet-5");
    expect(plan.origin.model).toBe("override");
    // `[]` is a real answer — "no tools" — and it must survive as one rather than reading as absent.
    expect(plan.settings.tools).toEqual([]);
    expect(plan.origin.tools).toBe("override");
  });

  it("answers for a state no layer supplies, rather than blanking the composer", () => {
    const plan = service.chatStartPlan({ stateId: "chat/not-installed" });
    expect(plan.from).toBeUndefined();
    expect(plan.origin).toMatchObject({ model: "unset", tools: "unset", permissions: "unset" });
  });

  it("runs the first message under what was picked, and keeps it as the conversation's own", async () => {
    const { taskId } = service.createTask({ title: "picked", workflow: CHAT_SESSION, conversation: true, inputs: { message: "one", improve: false } });
    await service.startTask({ taskId, overrides: { tools: [], model: "fake/model" }, fake: SCRIPT });
    await eventually(() => replies(taskId) >= 1 && parked(taskId), "the opening reply", 20_000);
    // The reply went out on the picked model: the program takes the first message's settings as its
    // `settings` input, as it takes every later message's through `input()`.
    const journal = (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as { type: string; field?: string; value?: unknown });
    expect(journal.filter((e) => e.type === "value.settled" && e.field?.endsWith("config.model")).map((e) => e.value)).toEqual(["fake/model"]);
    // Its calls are decided under the picked tools — none — which hold for the whole run, not the root alone.
    type Held = { permissionSet?: { entries?: Record<string, { kind?: string; offered?: boolean }> } };
    const held = [...((service as unknown as { session(): { livePermissions: Map<string, Set<Held>> } }).session().livePermissions.get(taskId) ?? [])];
    expect(held.some((l) => l.permissionSet !== undefined)).toBe(true);
    for (const live of held) {
      expect(Object.entries(live.permissionSet?.entries ?? {}).filter(([, e]) => e.kind === "tool" && e.offered !== false)).toEqual([]);
    }
    // Kept on the task: what the composer for the NEXT message opens with.
    expect(service.taskDetail(taskId).chatSettings).toEqual({ tools: [], model: "fake/model" });
    // And the authored file is untouched — a pick for one conversation is not an edit of what a
    // conversation IS: the shipped `session` still names its set.
    expect(service.readWorkflow({ stateId: CHAT_SESSION, layer: "system" }).text).toContain('tools: "$/permission-sets/ask-first"');
    service.cancelTask(taskId);
  });
});

describe("editing a message", { timeout: 60_000 }, () => {
  it("replaces it — the conversation keeps what came before and drops what came after", async () => {
    const taskId = await started("one");
    await send(taskId, "two");
    await send(taskId, "three");

    const before = service.chatThread({ taskId })!;
    const at = before.points[0]!.at; // the position "two" occupies
    await service.sendChatMessage({ taskId, instanceId: before.instanceId, message: "two, but better", branchAt: at, fake: SCRIPT });
    await eventually(() => said(taskId).includes("assistant: a better second answer") && parked(taskId), "the edited message's reply", 20_000);

    // Everything before the replaced message survives; the message and everything after it do not —
    // an edit is a rewind to the `input()` that took the message, and the edit its answer.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two, but better",
      "assistant: a better second answer",
    ]);
    // Taken back, as a rewind takes what it cuts — not kept as a branch beside the new one (decision
    // 0029 §2), so there is no other side of a split to report.
    expect(service.chatThread({ taskId })!.forks).toBeUndefined();
    service.cancelTask(taskId);
  });

  it("can be edited again — the second edit replaces what the first one sent", async () => {
    const taskId = await started("one");
    await send(taskId, "two");
    const first = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: first.instanceId, message: "two again", branchAt: first.points[0]!.at, fake: SCRIPT });
    await eventually(() => said(taskId).includes("assistant: second again") && parked(taskId), "the first edit's reply", 20_000);
    const second = service.chatThread({ taskId })!;
    // The point is the one on the CURRENT conversation — the message the first edit sent. Sending at
    // it must work, or an edited conversation becomes one that can never be edited again.
    await service.sendChatMessage({ taskId, instanceId: second.instanceId, message: "two, finally", branchAt: second.points[0]!.at, fake: SCRIPT });
    await eventually(() => said(taskId).includes("assistant: second, finally") && parked(taskId), "the second edit's reply", 20_000);
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two, finally",
      "assistant: second, finally",
    ]);
    service.cancelTask(taskId);
  });

  it("refuses a position that names nothing in this conversation, rather than rewinding a stranger's", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await expect(
      service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "nowhere", branchAt: "not-a-session@3", fake: SCRIPT }),
    ).rejects.toThrow(/not a message in this conversation/);
    // Nothing was taken back.
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer"]);
    service.cancelTask(taskId);
  });
});

describe("a reply in flight", { timeout: 60_000 }, () => {
  it("narrates itself to the window, the way a run does", async () => {
    // The reply is a call of the program's run, so it streams and settles as one: the window hears
    // the deltas while it runs and the journal events when it settles — and the second is what
    // retires the live tail, since the renderer drops it on exactly these events.
    const taskId = await started("one");
    pushes.length = 0;
    await send(taskId, "two");

    const events = pushes.filter((m) => m.type === "engine:event" && m.taskId === taskId);
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((m) => (m as { event: { type?: string } }).event.type);
    expect(types).toContain("operation.started");
    expect(types).toContain("operation.completed");
    service.cancelTask(taskId);
  });
});

describe("stopping a reply", { timeout: 60_000 }, () => {
  it("says plainly that there was nothing to stop", async () => {
    const taskId = await started("one");
    // The honest answer between replies, and the one the button needs: `false` is not a failure, it
    // is a reply that landed before the click did.
    expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: false });
    service.cancelTask(taskId);
  });

  /**
   * What a reply that ends badly leaves behind — which is what pressing stop on a transport that can
   * only cancel produces, minus the timing. The program catches it and waits for the next message.
   */
  it("keeps the OPENING message too, when the very first reply is the one that ends badly", async () => {
    // With nothing recorded before it, a thread that cannot find the failed call has nothing at all
    // to show, and the view reads as a conversation that was never had.
    const taskId = await started("one", [{ error: "stopped" }]);
    expect(service.chatThread({ taskId })).not.toBeNull();
    expect(said(taskId)).toEqual(["user: one"]);
    service.cancelTask(taskId);
  });

  it("keeps what was typed, and the conversation carries on where it left off", async () => {
    // A reply to "two" that ends badly: the program catches it and goes on AFTER it (SCRIPTS.md §9 —
    // the failed call hands back where its conversation ended), so "two" stays in the conversation.
    const taskId = await started("one", [{ promptIncludes: "one", output: "first answer" }, { promptIncludes: "two", error: "stopped" }, { promptIncludes: "three", output: "third answer" }]);
    const branch = service.chatThread({ taskId })!.session.sessionId;
    await send(taskId, "two");
    // The message somebody typed is still there. It lives in the record's request — the answer is
    // what a transport streams, so a failed reply has no other trace of the question.
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two"]);

    await send(taskId, "three");
    // One conversation, not a branch of it, and the reply to "three" read "two" too.
    expect(service.chatThread({ taskId })!.session.sessionId).toBe(branch);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "user: three", "assistant: third answer"]);
    service.cancelTask(taskId);
  });
});

describe("naming a conversation", { timeout: 60_000 }, () => {
  it("renames the task, and the list says so", async () => {
    const taskId = await started("one");
    const renamed = service.renameTask({ taskId, title: "The repository tour" });
    expect(renamed.title).toBe("The repository tour");
    expect(service.listTasks().find((t) => t.taskId === taskId)?.title).toBe("The repository tour");
    service.cancelTask(taskId);
  });

  it("refuses a name that is not one", async () => {
    const taskId = await started("one");
    expect(() => service.renameTask({ taskId, title: "   " })).toThrow(/needs a title/);
    service.cancelTask(taskId);
  });
});

describe("finding files to mention", () => {
  it("matches a path by subsequence, the way a file picker does", () => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "service.ts"), "x", "utf8");
    writeFileSync(join(dir, "src", "deep", "widget.ts"), "x", "utf8");
    expect(service.findFiles({ query: "srvc" }).paths).toContain("src/service.ts");
    expect(service.findFiles({ query: "widget" }).paths).toEqual(["src/deep/widget.ts"]);
  });

  it("does not walk into the directories nobody means by `@`", () => {
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "x", "utf8");
    mkdirSync(join(dir, ".git", "refs"), { recursive: true });
    writeFileSync(join(dir, ".git", "refs", "head.js"), "x", "utf8");
    const paths = service.findFiles({ query: "js" }).paths;
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("returns the shallowest matches first — where a person's own files are", () => {
    mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(dir, "note.md"), "x", "utf8");
    writeFileSync(join(dir, "a", "b", "c", "note.md"), "x", "utf8");
    expect(service.findFiles({ query: "note" }).paths[0]).toBe("note.md");
  });
});

/**
 * The list the ROOT's "All conversations" row draws — every project's threads, stamped.
 *
 * A cross-project list is the one thing that cannot be assembled from the open project's tasks, and
 * the row that draws it is one click from the sidebar now. What it needs of the channel is exactly
 * two things: only conversations come back, and every row can say whose it is — a row that cannot
 * name its project cannot be opened (SHELL.md §2.4).
 */
describe("every project's conversations", () => {
  it("returns the chat tasks, stamped with the project holding them", () => {
    const chat = service.createTask({ title: "a thread", workflow: CHAT_SESSION, conversation: true, inputs: { message: "hi" } });
    service.createTask({ title: "a run", workflow: "feature/plan", inputs: { issue: "x" } });

    const all = service.listAllTasks({ workflows: [CHAT_SESSION] });
    expect(all.map((t) => t.taskId)).toEqual([chat.taskId]);
    // The stamp, which is what makes the row openable — `openConversation` reads the thread out of
    // the database this names, rather than out of whichever project happens to be focused.
    expect(all[0]?.project).toBe(dir);
  });

  it("asked for nothing in particular, answers with everything", () => {
    service.createTask({ title: "a thread", workflow: CHAT_SESSION, conversation: true, inputs: { message: "hi" } });
    service.createTask({ title: "a run", workflow: "feature/plan", inputs: { issue: "x" } });
    expect(service.listAllTasks({}).length).toBe(2);
  });
});
