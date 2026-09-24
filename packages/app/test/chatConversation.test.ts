/**
 * A conversation as the Chat view has one, driven the way the view drives it.
 *
 * The other chat test (`chatMessage.test.ts`) is about typing into a RUN — a reader continuing the
 * transcript of a workflow that did something. This is about the view whose whole content is the
 * conversation: a task created from a built-in chat state, whose first message is its run and whose
 * every message after that is a chat turn on the same chain.
 *
 * What it exists to catch is the seam nothing below it can see. Each half works alone — the states
 * load, `chat:send` appends, the store forks — and the questions here are whether the halves agree:
 * does the thread read back as ONE conversation rather than a stack of last-turns, are the edit
 * points the positions they claim to be, and does an edit actually leave the replaced branch behind
 * instead of stacking two answers to two different questions in the same thread.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { CHAT_CONTROL, CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-convo-"));
  // No state files are written: the chat states SHIP, in the built-in layer at the end of every
  // project's search path (decision 0006), so an empty project over an empty shared root resolves
  // them — which is the install step's absence, tested by everything below.
  initProject(dir, testHome());
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

/** Whatever the model is asked, it answers this — a conversation needs a reply, not a right one. */
const REPLY = (text: string): Array<{ output: string }> => [{ output: text }];

/** Start a conversation the way the view does: create the task with the message, then run it. */
async function started(message: string, workflow = CHAT_SESSION): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow, inputs: { message } });
  await service.startTask({ taskId, fake: REPLY("first answer") });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
  return taskId;
}

/** The turns of a thread as `role: text`, which is what these assertions are actually about. */
function said(taskId: string, service_: AppService = service): string[] {
  const thread = service_.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

describe("a conversation started from the Chat view", () => {
  it("is an ordinary task whose FIRST message is the run", async () => {
    const taskId = await started("What is in this repository?");
    const [task] = service.listTasks().filter((t) => t.taskId === taskId);
    expect(task?.workflow).toBe(CHAT_SESSION);
    expect(task?.status).toBe("completed");
    // The message is the prompt, so it is in the transcript as the user's own first turn rather
    // than as an input nobody can read.
    expect(said(taskId)[0]).toBe("user: What is in this repository?");
  });

  it("names itself after what it opened with", () => {
    expect(titleOf("  Explain the session store\nand its two tables ")).toBe("Explain the session store");
    expect(titleOf(`${"x".repeat(80)}`)).toHaveLength(58); // 57 kept, then the ellipsis
    expect(titleOf("   ")).toBe("New conversation");
  });

  it("reads back as ONE thread — every turn of it, in order", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });
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
  });

  it("offers an edit point for every hand-typed message, and none for the run's own prompt", async () => {
    const taskId = await started("one");
    const first = service.chatThread({ taskId })!;
    // Nothing typed yet: the only turn is the run's, which is not a message anybody can replace.
    expect(first.points).toEqual([]);
    await service.sendChatMessage({ taskId, instanceId: first.instanceId, message: "two", fake: REPLY("second answer") });
    const thread = service.chatThread({ taskId })!;
    expect(thread.points).toHaveLength(1);
    // The point names the TURN it starts at, so the caller can put an Edit on the right message.
    expect(thread.session.turns[thread.points[0]!.turn]?.text).toBe("two");
  });

  it("keeps the tail on `chat:plan`'s instance, so the composer and the thread address one thing", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    expect(service.chatPlan({ taskId, instanceId: thread.instanceId })).not.toBeNull();
  });

  it("answers null for a task that never ran, rather than throwing at being asked", () => {
    const { taskId } = service.createTask({ title: "unsent", workflow: CHAT_SESSION, inputs: { message: "hi" } });
    expect(service.chatThread({ taskId })).toBeNull();
  });
});

/**
 * The composer above the box that STARTS a conversation. It shows the same four settings the thread's
 * does, and it has to answer them before there is a run to read them off — so the plan comes from the
 * state file, and what is picked reaches the first message by riding its run.
 */
describe("the settings of a conversation that has not started yet", () => {
  it("reads them off the state file — what the first message would inherit, and from where", () => {
    const plan = service.chatStartPlan({ stateId: CHAT_SESSION });
    expect(plan.from).toBe(CHAT_SESSION);
    // The file's permission set, as the lowered list and block a loaded state holds.
    for (const name of ["read_file", "glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search", "start_task"]) {
      expect(plan.settings.tools, name).toContain(name);
    }
    expect(plan.origin.tools).toBe("inherited");
    expect(plan.settings.permissions).toMatchObject({ tools: { read_file: "ask", bash: "ask" }, other: "ask", subjects: { bash: "ask" } });
    // Nothing is in flight before anything has started, and the machine's offer is still an offer.
    expect(plan.live).toBe("idle");
    expect(plan.available.tools.map((t) => t.name)).toContain("bash");
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

  it("runs the first message under what was picked, pinned as the run's own snapshot", async () => {
    const { taskId } = service.createTask({ title: "picked", workflow: CHAT_SESSION, inputs: { message: "hi" } });
    await service.startTask({ taskId, overrides: { tools: [], model: "fake/model" }, fake: REPLY("answered") });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
    // Read back through the plan the composer would show for the NEXT message: the settings a reply
    // inherits are the ones the run actually executed under, which is the whole point of pinning them.
    const thread = service.chatThread({ taskId })!;
    const plan = service.chatPlan({ taskId, instanceId: thread.instanceId })!;
    expect(plan.settings.tools).toEqual([]);
    expect(plan.settings.model).toBe("fake/model");
    // And the authored file is untouched — a pick for one conversation is not an edit of what a
    // conversation IS. The SHIPPED file, since nothing installs a copy (decision 0006) — and no copy
    // appeared because of the pick.
    const state = JSON.parse(service.readWorkflow({ stateId: CHAT_SESSION, layer: "system" }).text) as {
      operation: { tools: string };
    };
    expect(service.readWorkflow({ stateId: CHAT_SESSION, layer: "project" }).exists).toBe(false);
    expect(state.operation.tools).toBe("$/permission-sets/chat/ask-first");
  });
});

describe("editing a message", () => {
  it("replaces it — the branch keeps what came before and drops what came after", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });

    const before = service.chatThread({ taskId })!;
    const at = before.points[0]!.at; // the position "two" occupies
    await service.sendChatMessage({
      taskId,
      instanceId: before.instanceId,
      message: "two, but better",
      branchAt: at,
      fake: REPLY("a better second answer"),
    });

    // Everything before the replaced message survives; the message and everything after it do not.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two, but better",
      "assistant: a better second answer",
    ]);
  });

  it("says WHERE the conversation split, and what it said down the other side", async () => {
    // A fork is not a deletion, and the thread coming back shorter is indistinguishable from one on
    // screen. What the branch left behind is intact in the record and was reachable from nowhere —
    // so it is reported, from the seam onward, in the same shape as the turns it sits beside.
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });

    const before = service.chatThread({ taskId })!;
    expect(before.forks).toBeUndefined(); // nothing has split yet, and nothing is paid for
    await service.sendChatMessage({
      taskId,
      instanceId: before.instanceId,
      message: "two, but better",
      branchAt: before.points[0]!.at,
      fake: REPLY("a better second answer"),
    });

    const after = service.chatThread({ taskId })!;
    expect(after.forks).toHaveLength(1);
    const [fork] = after.forks!;
    // The seam sits where the two sides stop agreeing: everything above turn 2 is common ground.
    expect(fork!.turn).toBe(2);
    expect(after.session.turns.slice(0, fork!.turn).map((t) => `${t.role}: ${t.text ?? ""}`)).toEqual([
      "user: one",
      "assistant: first answer",
    ]);
    // And the other side is whole — the replaced message AND everything that followed it.
    expect(fork!.left).toHaveLength(1);
    expect(fork!.left[0]!.turns.map((t) => `${t.role}: ${t.text ?? ""}`)).toEqual([
      "user: two",
      "assistant: second answer",
      "user: three",
      "assistant: third answer",
    ]);
  });

  it("can be edited again — the second edit forks the branch the first one made", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second") });
    const first = service.chatThread({ taskId })!;
    await service.sendChatMessage({
      taskId,
      instanceId: first.instanceId,
      message: "two again",
      branchAt: first.points[0]!.at,
      fake: REPLY("second again"),
    });
    const second = service.chatThread({ taskId })!;
    // The point is the one on the CURRENT chain — which is in the branch, under an id the original
    // conversation never had. Sending at it must work, or an edited conversation becomes one that
    // can never be edited again.
    await service.sendChatMessage({
      taskId,
      instanceId: second.instanceId,
      message: "two, finally",
      branchAt: second.points[0]!.at,
      fake: REPLY("second, finally"),
    });
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two, finally",
      "assistant: second, finally",
    ]);
  });

  it("refuses a position that names nothing in this conversation, rather than forking a stranger's", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    await expect(
      service.sendChatMessage({
        taskId,
        instanceId: thread.instanceId,
        message: "nowhere",
        branchAt: "not-a-session@3",
        fake: REPLY("never sent"),
      }),
    ).rejects.toThrow(/not a message in this conversation/);
  });
});

describe("a turn in flight", () => {
  it("narrates itself to the window, the way a run does", async () => {
    // A chat turn published nothing at all: no deltas while it ran, no journal events when it
    // settled. The first is why a reply appeared only once it was finished — while the conversation's
    // OPENING message, which is a run, streamed perfectly — and the second is what retires the live
    // tail, since the renderer drops it on exactly these two events. Both come from one wiring.
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    pushes.length = 0;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });

    const events = pushes.filter((m) => m.type === "engine:event" && m.taskId === taskId);
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((m) => (m as { event: { type?: string } }).event.type);
    expect(types).toContain("operation.started");
    expect(types).toContain("operation.completed");
  });
});

describe("stopping a turn", () => {
  it("says plainly that there was nothing to stop", async () => {
    const taskId = await started("one");
    // The honest answer between turns, and the one the button needs: `false` is not a failure, it is
    // a turn that landed before the click did.
    expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: false });
  });

  /**
   * What a stop leaves behind. Driven with a turn that ENDS BADLY rather than one aborted on a timer,
   * because the two are the same thing to everything downstream — an abort lands in `runChatTurn` as
   * an ordinary failure — and only this way is it a test rather than a race.
   *
   * All three symptoms had one cause: `operation.failed` carried no metrics, so the turn named no
   * position, and the position it was actually holding was handed to the next message. See
   * `runChatTurn`.
   */
  it("keeps the OPENING message too, when the very first turn is the one that ends badly", async () => {
    // The first message of a conversation is the run, so this is the other half of the same story —
    // and the worse half: with nothing recorded before it, a thread that cannot find the turn has
    // nothing at all to show, and the view reads as a conversation that was never had.
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: [{ error: "stopped" }] });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to end");

    expect(service.chatThread({ taskId })).not.toBeNull();
    expect(said(taskId)).toEqual(["user: one"]);
  });

  it("keeps what was typed, and the conversation carries on where it left off", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;

    const stopped = await service.sendChatMessage({
      taskId,
      instanceId: thread.instanceId,
      message: "two",
      fake: [{ error: "stopped" }],
    });
    expect(stopped.failure).toContain("stopped");

    // The message somebody typed is still there. It lives in the record's request — the answer is
    // what a transport streams, so an interrupted turn has no other trace of the question.
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two"]);

    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });

    // One conversation, not a branch of it: a stopped turn that named no position left the next
    // message colliding with the position it held, which forks — onto a branch this reader never
    // looks at, so everything after the stop simply vanished.
    expect(service.chatThread({ taskId })!.session.sessionId).toBe(thread.session.sessionId);
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "user: three",
      "assistant: third answer",
    ]);
  });
});

describe("naming a conversation", () => {
  it("renames the task, and the list says so", async () => {
    const taskId = await started("one");
    const renamed = service.renameTask({ taskId, title: "The repository tour" });
    expect(renamed.title).toBe("The repository tour");
    expect(service.listTasks().find((t) => t.taskId === taskId)?.title).toBe("The repository tour");
  });

  it("refuses a name that is not one", async () => {
    const taskId = await started("one");
    expect(() => service.renameTask({ taskId, title: "   " })).toThrow(/needs a title/);
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
    const chat = service.createTask({ title: "a thread", workflow: CHAT_SESSION, inputs: { message: "hi" } });
    service.createTask({ title: "a run", workflow: "feature/plan", inputs: { issue: "x" } });

    const all = service.listAllTasks({ workflows: [CHAT_SESSION, CHAT_CONTROL] });
    expect(all.map((t) => t.taskId)).toEqual([chat.taskId]);
    // The stamp, which is what makes the row openable — `openConversation` reads the thread out of
    // the database this names, rather than out of whichever project happens to be focused.
    expect(all[0]?.project).toBe(dir);
  });

  it("asked for nothing in particular, answers with everything", () => {
    service.createTask({ title: "a thread", workflow: CHAT_SESSION, inputs: { message: "hi" } });
    service.createTask({ title: "a run", workflow: "feature/plan", inputs: { issue: "x" } });
    expect(service.listAllTasks({}).length).toBe(2);
  });
});
