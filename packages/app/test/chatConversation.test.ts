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
import { AppService } from "../src/main/service";
import { CHAT_AGENT, CHAT_ASSISTANT, chatWorkflowFiles, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-convo-"));
  const paths = initProject(dir);
  // The states the Chat view installs, written into the PROJECT rather than into the machine's
  // shared root: a test must not write to `~/.jaira`, and the loader searches the project first — so
  // this exercises the same ids through the same resolution the view's install lands in.
  for (const [stateId, state] of Object.entries(chatWorkflowFiles())) {
    const file = join(paths.workflowsDir, `${stateId}.json`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  }
  pushes = [];
  service = new AppService({ publish: (m) => pushes.push(m) });
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
async function started(message: string, workflow = CHAT_ASSISTANT): Promise<string> {
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
    expect(task?.workflow).toBe(CHAT_ASSISTANT);
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
    const { taskId } = service.createTask({ title: "unsent", workflow: CHAT_AGENT, inputs: { message: "hi" } });
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
    const plan = service.chatStartPlan({ stateId: CHAT_AGENT });
    expect(plan.from).toBe(CHAT_AGENT);
    expect(plan.settings.tools).toEqual(["bash", "read_file", "write_file"]);
    expect(plan.origin.tools).toBe("inherited");
    expect(plan.settings.permissions).toMatchObject({ profile: "full", default: "ask" });
    // Nothing is in flight before anything has started, and the machine's offer is still an offer.
    expect(plan.live).toBe("idle");
    expect(plan.available.tools.map((t) => t.name)).toContain("bash");
  });

  it("folds a pick over the file, and says it was a pick", () => {
    const plan = service.chatStartPlan({ stateId: CHAT_AGENT, overrides: { model: "anthropic/claude-sonnet-5", tools: [] } });
    expect(plan.settings.model).toBe("anthropic/claude-sonnet-5");
    expect(plan.origin.model).toBe("override");
    // `[]` is a real answer — "no tools" — and it must survive as one rather than reading as absent.
    expect(plan.settings.tools).toEqual([]);
    expect(plan.origin.tools).toBe("override");
  });

  it("answers for a state nobody has installed yet — the view writes its files on the first send", () => {
    const plan = service.chatStartPlan({ stateId: "chat/not-installed" });
    expect(plan.from).toBeUndefined();
    expect(plan.origin).toMatchObject({ model: "unset", tools: "unset", permissions: "unset" });
  });

  it("runs the first message under what was picked, pinned as the run's own snapshot", async () => {
    const { taskId } = service.createTask({ title: "picked", workflow: CHAT_AGENT, inputs: { message: "hi" } });
    await service.startTask({ taskId, overrides: { tools: [], model: "fake/model" }, fake: REPLY("answered") });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
    // Read back through the plan the composer would show for the NEXT message: the settings a reply
    // inherits are the ones the run actually executed under, which is the whole point of pinning them.
    const thread = service.chatThread({ taskId })!;
    const plan = service.chatPlan({ taskId, instanceId: thread.instanceId })!;
    expect(plan.settings.tools).toEqual([]);
    expect(plan.settings.model).toBe("fake/model");
    // And the authored file is untouched — a pick for one conversation is not an edit of what a
    // conversation IS.
    const state = JSON.parse(readFileSync(join(initProject(dir).workflowsDir, `${CHAT_AGENT}.json`), "utf8")) as {
      environment: { tools: string[] };
    };
    expect(state.environment.tools).toEqual(["bash", "read_file", "write_file"]);
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

describe("stopping a turn", () => {
  it("says plainly that there was nothing to stop", async () => {
    const taskId = await started("one");
    // The honest answer between turns, and the one the button needs: `false` is not a failure, it is
    // a turn that landed before the click did.
    expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: false });
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
