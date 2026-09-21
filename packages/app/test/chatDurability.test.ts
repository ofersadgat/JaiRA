/**
 * A conversation does not lose what was said in it — every way it used to.
 *
 * The other two chat tests are about what the feature DOES. This one is adversarial: it enumerates
 * the ways a thread could come back shorter than it was, and pins each closed. They are here rather
 * than scattered because they are one claim — "under no circumstances does a chat clear" — and a
 * claim like that is only as good as the list of circumstances somebody tried.
 *
 * The list, and why each one is reachable:
 *
 *  1. **A turn is stopped.** The abort lands as a failure, and a failure that named no position was
 *     invisible to the projection the thread is found by — so the next message collided with the
 *     record the stopped one was holding and forked away from it.
 *  2. **A turn's process dies mid-call.** Same invisibility, arrived at differently: no terminal
 *     event at all. The run around it has ALREADY ENDED WELL, because a conversation outlives its
 *     run, so the recovery pass that exists for crashed runs did not look at it.
 *  3. **The task is re-run.** A thread is read from the task's latest run, and a second run starts a
 *     second conversation beside the first rather than adding to it.
 *  4. **Two messages are in flight at once.** Now possible: a message can be sent mid-turn.
 *  5. **A read answers nothing.** Whatever the reason, the view must not take it as an answer about
 *     the conversation.
 *
 * Every case asserts on the WHOLE transcript rather than on a length or a flag, because "shorter
 * than it was" is the failure and only the full list can show it did not happen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, SqliteSessionStore } from "@jaira/persistence";
import { chatInstanceIdOf } from "@jaira/runtime";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { kept } from "../src/renderer/chatPane";
import { CHAT_ASSISTANT, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-durable-"));
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

const REPLY = (text: string): Array<{ output: string }> => [{ output: text }];
const STOPPED = [{ error: "stopped" }];

/** Start a conversation the way the view does: create the task with the message, then run it. */
async function started(message: string): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_ASSISTANT, inputs: { message } });
  await service.startTask({ taskId, fake: REPLY("first answer") });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
  return taskId;
}

/** The whole transcript as `role: text` — the only shape that can show a turn went missing. */
function said(taskId: string): string[] {
  const thread = service.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

/** Which conversation the thread is being read from — a fork mints a new id, and that is the tell. */
const branchOf = (taskId: string): string => service.chatThread({ taskId })!.session.sessionId;

/** The project behind the open service — for the tests that have to act like a crash. */
function projectOf(): { db: never; events: { recorder(t: string): { record(e: unknown, at: number): void } } } {
  const sessions = (service as never as { sessions: Map<string, { project: unknown }> }).sessions;
  return [...sessions.values()][0]!.project as never;
}

describe("1. a turn that was stopped", () => {
  it("loses nothing, and the conversation goes on in the same branch", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const branch = thread.session.sessionId;

    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: STOPPED });
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") });

    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "user: three",
      "assistant: third answer",
    ]);
    expect(branchOf(taskId)).toBe(branch);
  });

  it("survives being stopped over and over", async () => {
    // Once is a fixed bug; three times in a row is the claim that the fix does not merely move the
    // collision one position along. Each stopped turn claims a position of its own, and each one has
    // to be visible for the next to be computed past it.
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    for (const message of ["two", "three", "four"]) {
      await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message, fake: STOPPED });
    }
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "five", fake: REPLY("fifth answer") });

    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "user: three",
      "user: four",
      "user: five",
      "assistant: fifth answer",
    ]);
  });

  it("keeps the OPENING message, where there is nothing else on screen to keep", async () => {
    // The worst version: the first message IS the run, so a thread that cannot find the stopped turn
    // has nothing at all to show, and the view reads as a conversation nobody ever had.
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_ASSISTANT, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: STOPPED });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to end");

    expect(service.chatThread({ taskId })).not.toBeNull();
    expect(said(taskId)).toEqual(["user: one"]);

    // …and it can still be continued afterwards, which is the point of keeping it.
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
    expect(said(taskId)).toEqual(["user: one", "user: two", "assistant: second answer"]);
  });
});

describe("1b. what a stopped turn had already SAID", () => {
  /**
   * A turn that was streaming when it was stopped, left exactly as `runChatTurn` leaves one: the
   * record with the partial its flush wrote, the cancelled settle over it, and the journal saying
   * where it happened. `streamed` is what the transport had produced by then — which never includes
   * the question, because a transport streams what the MODEL said.
   *
   * Returns the instance the turn ran as, so a test can ask the other panel about it too.
   */
  /** A finished turn, as an entry. */
  const entry = (role: string, content: unknown) => ({ kind: "message", role, content, provider: "unknown" });
  /** The turn that was still being written — the same array, flagged rather than filed elsewhere. */
  const writing = (text: string) => ({
    kind: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    partial: true,
    provider: "unknown",
  });
  function stoppedTurn(taskId: string, asked: string, streamed: Record<string, unknown>): string {
    const thread = service.chatThread({ taskId })!;
    const project = projectOf();
    const store = new SqliteSessionStore(project.db, { taskId });
    const branch = thread.session.sessionId;
    const recorder = project.events.recorder(taskId);
    const where = { instanceId: chatInstanceIdOf(thread.instanceId), stateId: CHAT_ASSISTANT };
    recorder.record({ type: "instance.entered", ...where, childKey: "ask", parentInstanceId: thread.instanceId, inputs: {} }, Date.now());
    recorder.record({ type: "operation.started", ...where, op: "prompt" }, Date.now());
    const ref = store.append({
      id: `${branch}:1`,
      source: { kind: "prompt", user: asked } as never,
      startMs: Date.now(),
      session: { id: branch, seq: 1 },
    });
    store.update(ref, { value: { value: streamed } as never });
    store.finish(ref, { result: { error: { classification: "canceled", reason: "stopped" } } } as never);
    recorder.record(
      {
        type: "operation.failed",
        ...where,
        op: "prompt",
        failure: { classification: "canceled", reason: "stopped" },
        metrics: { durationMs: 1, sessionRef: `${branch}@2` },
      } as never,
      Date.now(),
    );
    return where.instanceId;
  }

  /** An agent's stream: it answered, called a tool, read the result, and was stopped mid-sentence. */
  const TOOL_TRAFFIC = {
    entries: [
      entry("assistant", [{ type: "text", text: "Looking at it now" }]),
      entry("assistant", [{ type: "tool_use", id: "tu1", name: "read_file", input: {} }]),
      entry("user", [{ type: "tool_result", tool_use_id: "tu1", content: "two tables" }]),
      writing("It keeps records, and each one"),
    ],
  };

  it("stays on screen — the half-written answer is part of the conversation", async () => {
    // The other half of "nothing disappears". The message survives (above), and so must the words
    // that had already arrived: they are what the person was reading when they pressed stop. The
    // record keeps them as an entry like any other, flagged `partial` so nothing replays them, and
    // `preservePartial` carries that array through the errored settle.
    const taskId = await started("one");
    stoppedTurn(taskId, "explain the store", { entries: [writing("It keeps records, and each one")] });

    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: explain the store",
      "assistant: It keeps records, and each one",
    ]);
  });

  /**
   * …and it survives an AGENT, whose stream is full of user-role messages that nobody typed.
   *
   * A tool result is carried as a `user` message — that is the provider's wire format, not a quirk —
   * so an agent stopped after fourteen tool calls has fourteen user turns in its record and the
   * question is in none of them. The prepend was guarded on "does this record hold a user turn
   * anywhere", which those satisfy, so the more work an agent did before it was stopped the more
   * certainly its opening message was dropped. The guard is on the FIRST turn now: a record that
   * carries the exchange begins with what provoked it, and a stream begins with the answer.
   */
  it("survives an agent's tool traffic, which is user-role messages nobody typed", async () => {
    const taskId = await started("one");
    stoppedTurn(taskId, "explain the store", TOOL_TRAFFIC);

    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: explain the store",
      "assistant: Looking at it now",
      "assistant: ", // the tool call
      "user: ", // …and its result, which is why the old guard thought the question was here
      "assistant: It keeps records, and each one",
    ]);
  });

  /**
   * …and it is the same conversation through the OTHER panel.
   *
   * Two readers answer two different questions — `chatThread` walks the whole chain, `sessionView`
   * answers what ONE state added to what it was handed — and both are legitimate. What is not
   * legitimate is them disagreeing about whether a turn happened. `sessionView` had grown its own
   * copy of the fold, gained the trailing fragment, and never gained the question, so the transcript
   * beside a run opened on an answer to something that appeared nowhere on the page. One reader now.
   */
  it("is recovered for the run's transcript too, not only the chat's", async () => {
    const taskId = await started("one");
    const instanceId = stoppedTurn(taskId, "explain the store", TOOL_TRAFFIC);

    const view = service.sessionView({ taskId, instanceId });
    // What this state ADDED — so the run's own opening exchange is inherited and correctly absent,
    // and the question this state was called with is correctly present.
    expect(view.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`)).toEqual([
      "user: explain the store",
      "assistant: Looking at it now",
      "assistant: ",
      "user: ",
      "assistant: It keeps records, and each one",
    ]);
    expect(view.empty).toBeUndefined();
  });
});

describe("2. a turn whose process died", () => {
  it("keeps its place, so the next message appends instead of forking away from it", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const branch = thread.session.sessionId;
    const project = projectOf();

    // Exactly what a kill -9 mid-turn leaves behind: the journal says a turn started under the chat
    // child, the record store holds its claimed position, and there is no terminal event for either.
    const recorder = project.events.recorder(taskId);
    const where = { instanceId: chatInstanceIdOf(thread.instanceId), stateId: CHAT_ASSISTANT };
    recorder.record({ type: "instance.entered", ...where, childKey: "ask", parentInstanceId: thread.instanceId, inputs: {} }, Date.now());
    recorder.record({ type: "operation.started", ...where, op: "prompt" }, Date.now());
    new SqliteSessionStore(project.db, { taskId }).append({
      id: `${branch}:1`,
      source: { kind: "prompt", user: "the message it died on" } as never,
      startMs: Date.now(),
      session: { id: branch, seq: 1 },
    });

    // Already visible, before anything else happens — the crashed turn is part of the conversation.
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: the message it died on"]);

    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });

    // Same branch: a position the projection could not see is a position the next message walks into.
    expect(branchOf(taskId)).toBe(branch);
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: the message it died on",
      "user: two",
      "assistant: second answer",
    ]);
  });
});

describe("3. re-running a task somebody has talked to", () => {
  it("runs a COPY, so the conversation it already had is still there", async () => {
    // A thread is read from the latest run, and a second run in the same task is a second
    // conversation beside the first — every hand-typed turn still in the database and nothing in any
    // view leading back to it. Reachable: a stopped opening message leaves the task startable, and
    // you can go on talking to it for another twenty messages.
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_ASSISTANT, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: STOPPED });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to end");
    const thread = service.chatThread({ taskId })!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") });
    const before = said(taskId);

    const rerun = await service.rerunTask({ taskId, fake: REPLY("a fresh start") });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === rerun.taskId), "the rerun to finish");

    // A different task, and the original is untouched.
    expect(rerun.taskId).not.toBe(taskId);
    expect(said(taskId)).toEqual(before);
  });

  it("mints a task nobody has talked to a fresh machine too, chained back", async () => {
    // A re-run is a new state machine instance unconditionally (Identity and Resume §05) — the
    // one-journal model has no "in place" left: restarting the same task would grow a second tree
    // where its machine lives. The spoken-to distinction stopped mattering the day it stopped
    // being what decided.
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_ASSISTANT, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: STOPPED });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to end");

    const rerun = await service.rerunTask({ taskId, fake: REPLY("second try") });
    expect(rerun.taskId).not.toBe(taskId);
    expect(service.listTasks().find((t) => t.taskId === rerun.taskId)?.parentTaskId).toBe(taskId);
  });
});

describe("4. two messages in flight at once", () => {
  it("keeps both, in one conversation, with everything said before them", async () => {
    // What sending mid-turn produces, and it broke two ways at once. The second send ABORTED the
    // first — one abort controller per task, replaced on the way in — so a follow-up killed the reply
    // it was following up on. And both sends read the same conversation end before either had
    // claimed it, so the store branched: two messages, two branches, and a thread that reads one.
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const branch = thread.session.sessionId;

    const [a, b] = await Promise.all([
      service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "two", fake: REPLY("second answer") }),
      service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "three", fake: REPLY("third answer") }),
    ]);
    expect(a.failure).toBeUndefined();
    expect(b.failure).toBeUndefined();

    expect(branchOf(taskId)).toBe(branch);
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "assistant: second answer",
      "user: three",
      "assistant: third answer",
    ]);
  });

  it("keeps all of them when a whole handful arrives at once", async () => {
    // The same claim under pressure. Five sends fired together is not a realistic typing speed; it is
    // the shape of the race, run often enough that a window has to be closed rather than narrowed.
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const messages = ["two", "three", "four", "five", "six"];

    const sent = await Promise.all(
      messages.map((message) =>
        service.sendChatMessage({ taskId, instanceId: thread.instanceId, message, fake: REPLY(`answer to ${message}`) }),
      ),
    );
    expect(sent.map((s) => s.failure)).toEqual(messages.map(() => undefined));

    // In order, in one conversation, every question with its answer. Order is not incidental: the
    // queue is what produces it, and a transcript that merely CONTAINS everything would also pass
    // while five branches were being read as one.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      ...messages.flatMap((message) => [`user: ${message}`, `assistant: answer to ${message}`]),
    ]);
    expect(branchOf(taskId)).toBe(thread.session.sessionId);
  });
});

describe("5. a read that answers nothing", () => {
  it("never replaces a conversation with an empty one", () => {
    // The renderer's rule, which is the last line of defence: whatever main answers, a thread that
    // was on screen stays on screen. `null` from a read is a fact about a fetch — the records are on
    // disk either way, and nothing that was said stops having been said.
    const thread = { taskId: "t", runId: 1, instanceId: "2", session: { turns: [{ role: "user", text: "one" }] }, points: [] } as never;
    expect(kept(thread, null)).toBe(thread);
    expect(kept(null, null)).toBeNull();
    // …and a real answer always wins, or the view would freeze on its first read.
    const next = { ...(thread as object) } as never;
    expect(kept(thread, next)).toBe(next);
  });
});
