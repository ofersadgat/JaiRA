/**
 * A conversation does not lose what was said in it — every way it used to.
 *
 * The other two chat tests are about what the feature DOES. This one is adversarial: it enumerates
 * the ways a thread could come back shorter than it was, and pins each closed. They are here rather
 * than scattered because they are one claim — "under no circumstances does a chat clear" — and a
 * claim like that is only as good as the list of circumstances somebody tried.
 *
 * The conversation that takes messages is a PROGRAM — the shipped `session`, a loop over `input()`
 * (decision 0029 §2): a message is the answer to its `input()`, and the reply is the run's next call.
 * Sections 1b and 2b, and the cut-off note in 6, lay out by hand instead what a stopped or cut chat
 * turn left in the journal and the record store — the turn on the chat instance beside the run of a
 * conversation of ONE prompt (`jsonConversation`) — and read it back. The list, and why each one is
 * reachable:
 *
 *  1. **A reply is stopped.** Its message has to stay, with what the reply had said by then, and the
 *     next message has to go on in the same conversation rather than fork away from it. And what a
 *     stopped turn had already streamed is part of the conversation (1b).
 *  2. **A turn's process dies mid-call.** No terminal event at all — and the next message's turn,
 *     starting beside the one that died, took it and its own message off the screen (2b).
 *  3. **The task is re-run.** A thread is read from the task's latest run, and a second run starts a
 *     second conversation beside the first rather than adding to it.
 *  5. **A read answers nothing.** Whatever the reason, the view must not take it as an answer about
 *     the conversation.
 *  6. **The app closes while a reply is going.** The reply has to be stopped and settled while there
 *     is still a database to settle it in.
 *
 * Every case asserts on the WHOLE transcript rather than on a length or a flag, because "shorter
 * than it was" is the failure and only the full list can show it did not happen. Every model call is
 * scripted (`fake`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, openProject, SqliteSessionStore } from "@jaira/persistence";
import { chatInstanceIdOf, type FakeRule } from "@jaira/runtime";
import { CUT_OFF_EVENT, type PushMessage } from "@jaira/shared";
import { eventually, jsonConversation, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { kept } from "../src/renderer/chatThreadModel";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let workflowsDir: string;
let service: AppService;
let pushes: PushMessage[];
/** Services a test let go of the way a dying process does — see `crashAndReopen`. */
let abandoned: AppService[];

beforeEach(() => {
  abandoned = [];
  // What really ships, not the empty layer the suite's setup registers — see `shippedLayer`.
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-durable-"));
  // No state files are written: the conversation SHIPS, in the built-in layer at the end of every
  // project's search path (decision 0006), so an empty project over an empty shared root resolves
  // it — which is the install step's absence, tested by everything below.
  workflowsDir = initProject(dir, testHome()).workflowsDir;
  pushes = [];
  // Opened by each test, over the conversation it is about — see `opened`.
  service = undefined as never;
});

afterEach(async () => {
  await service?.close();
  for (const gone of abandoned) await gone.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

/** The service, open on the project — over a conversation of one prompt when `onePrompt` says so. */
async function opened(options: { onePrompt?: boolean } = {}): Promise<void> {
  // A conversation of one prompt: for the tests that lay out a chat turn's leftovers (see `jsonConversation`).
  if (options.onePrompt === true) jsonConversation(workflowsDir);
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
}

const REPLY = (text: string): Array<{ output: string }> => [{ output: text }];
const STOPPED = [{ error: "stopped" }];
const ONE: FakeRule = { promptIncludes: "one", output: "first answer" };

/** A conversation of one prompt, started the way the view does: create the task with the message, then run it. */
async function started(message: string): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf(message), workflow: CHAT_SESSION, inputs: { message } });
  await service.startTask({ taskId, fake: REPLY("first answer") });
  await eventually(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish", 8000);
  return taskId;
}

/** Waiting at its `input()` for the next message — where a program conversation stands between replies. */
const parked = (taskId: string): boolean =>
  (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
    .session()
    .hub.list()
    .some((r) => r.component === "input" && r.taskId === taskId);

/** A reply being made: a call of the conversation's run in flight. */
const inFlight = (taskId: string): boolean =>
  (service as unknown as { session(): { liveCalls: { ofTask(id: string): unknown[] } } }).session().liveCalls.ofTask(taskId).length > 0;

/** The whole transcript as `role: text` — the only shape that can show a turn went missing. */
function said(taskId: string): string[] {
  const thread = service.chatThread({ taskId });
  if (thread === null) throw new Error("this task holds no conversation");
  return thread.session.turns.map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

/** Which conversation the thread is being read from — a fork mints a new id, and that is the tell. */
const branchOf = (taskId: string): string => service.chatThread({ taskId })!.session.sessionId;

/** `turns` long, and waiting for the next message. */
async function settled(taskId: string, turns: number, what: string): Promise<void> {
  await eventually(() => (service.chatThread({ taskId })?.session.turns.length ?? 0) >= turns && parked(taskId) && !inFlight(taskId), what, 20_000);
}

/** A PROGRAM conversation, as the Chat view starts one, opened with "one" under `rules` — its reply in, and waiting for the next message. */
async function talking(rules: FakeRule[], options: { replied?: boolean } = {}): Promise<string> {
  const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, conversation: true, inputs: { message: "one", improve: false } });
  await service.startTask({ taskId, fake: rules as never });
  if (options.replied !== false) await settled(taskId, 2, "the opening reply");
  return taskId;
}

/** A message whose reply is held in flight — or, with none, the reply already going — stopped from the composer: the program goes on to wait. */
async function stopped(taskId: string, message?: string): Promise<void> {
  if (message !== undefined) await service.sendChatMessage({ taskId, instanceId: "", message });
  await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
  expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: true });
  await eventually(() => parked(taskId) && !inFlight(taskId), "the conversation to wait again", 20_000);
}

/**
 * Stop the service the way a dying PROCESS does, and open the project again.
 *
 * Deliberately not `service.close()`, which stops the reply and settles it — the opposite of a crash.
 * Abandoning the service leaves on disk what a killed process leaves: the run's row `running`, the
 * reply's call started and never settled, its record `open`. The heartbeat is the one thing an
 * abandoned service in this process keeps alive, so the claim is staled and re-owned by hand — the
 * very thing that stops when a process dies (see `resume.test.ts`).
 */
async function crashAndReopen(taskId: string): Promise<string[]> {
  abandoned.push(service);
  const project = openProject(dir, { baseDir: testHome() });
  try {
    project.db.prepare(`UPDATE jobs SET heartbeat_at = 0, owner_token = owner_token || ':dead' WHERE task_id = ? AND ended_at IS NULL`).run(taskId);
  } finally {
    project.close();
  }
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  return (await service.open(dir)).recovered;
}

/** The project behind the open service — for the tests that lay out a turn's leftovers by hand. */
function projectOf(): { db: never; events: { recorder(t: string): { record(e: unknown, at: number): void } } } {
  const sessions = (service as never as { sessions: Map<string, { project: unknown }> }).sessions;
  return [...sessions.values()][0]!.project as never;
}

describe("1. a reply that was stopped", { timeout: 60_000 }, () => {
  beforeEach(() => opened());

  for (const transport of ["interrupt", "cancel"] as const) {
    it(`loses nothing, and the conversation goes on in the same branch — on a transport that can only ${transport}`, async () => {
      const taskId = await talking([
        ONE,
        { promptIncludes: "two", output: "second answer, cut short", hold: transport },
        { promptIncludes: "three", output: "third answer" },
      ]);
      const branch = branchOf(taskId);

      await stopped(taskId, "two");
      await service.sendChatMessage({ taskId, instanceId: "", message: "three" });
      await eventually(() => said(taskId).includes("assistant: third answer") && parked(taskId), "the reply to 'three'", 20_000);

      expect(said(taskId)).toEqual([
        "user: one",
        "assistant: first answer",
        "user: two",
        // Ended early, a reply keeps what it said; canceled, it said nothing.
        ...(transport === "interrupt" ? ["assistant: second answer, cut short"] : []),
        "user: three",
        "assistant: third answer",
      ]);
      expect(branchOf(taskId)).toBe(branch);
    });
  }

  it("survives being stopped over and over", async () => {
    // Once is a fixed bug; three times in a row is the claim that the fix does not merely move the
    // collision one position along. Each stopped reply claims a position of its own, and each one has
    // to be visible for the next to be computed past it.
    const taskId = await talking([
      ONE,
      ...["two", "three", "four"].map((message): FakeRule => ({ promptIncludes: message, output: `answer to ${message}`, hold: "cancel" })),
      { promptIncludes: "five", output: "fifth answer" },
    ]);
    for (const message of ["two", "three", "four"]) await stopped(taskId, message);
    await service.sendChatMessage({ taskId, instanceId: "", message: "five" });
    await eventually(() => said(taskId).includes("assistant: fifth answer") && parked(taskId), "the reply to 'five'", 20_000);

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
    // The worst version: the first message IS the run's input, so a thread that cannot find the
    // stopped reply has nothing at all to show, and the view reads as a conversation nobody ever had.
    const taskId = await talking(
      [
        { promptIncludes: "one", output: "first answer", hold: "cancel" },
        { promptIncludes: "two", output: "second answer" },
      ],
      { replied: false },
    );
    await stopped(taskId);

    expect(service.chatThread({ taskId })).not.toBeNull();
    expect(said(taskId)).toEqual(["user: one"]);

    // …and it can still be continued afterwards, which is the point of keeping it.
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    await eventually(() => said(taskId).includes("assistant: second answer") && parked(taskId), "the reply to 'two'", 20_000);
    expect(said(taskId)).toEqual(["user: one", "user: two", "assistant: second answer"]);
  });
});

describe("1b. what a stopped turn had already SAID", () => {
  beforeEach(() => opened({ onePrompt: true }));

  /**
   * A turn that was streaming when it was stopped, laid out as a stopped chat turn of a conversation
   * of one prompt was left: the record with the partial its flush wrote, the cancelled settle over it,
   * and the journal saying where it happened. `streamed` is what the transport had produced by then —
   * which never includes the question, because a transport streams what the MODEL said.
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
    const where = { instanceId: chatInstanceIdOf(thread.instanceId), stateId: CHAT_SESSION };
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

describe("2. a reply whose process died", { timeout: 60_000 }, () => {
  beforeEach(() => opened());

  it("keeps its place, so the next message appends instead of forking away from it", async () => {
    const taskId = await talking([
      ONE,
      { promptIncludes: "the message it died on", output: "an answer that never came", hold: "cancel" },
      { promptIncludes: "two", output: "second answer" },
    ]);
    const branch = branchOf(taskId);
    await service.sendChatMessage({ taskId, instanceId: "", message: "the message it died on" });
    await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);

    // Exactly what a kill -9 mid-reply leaves behind: the run `running`, its call started and never
    // settled, the record holding its claimed position open.
    expect(await crashAndReopen(taskId)).toEqual([taskId]);

    // Already visible, before anything else happens — the cut reply's message is part of the conversation.
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: the message it died on"]);

    // Writing again takes the run up where it died: the reply it died in is made again, in its own
    // record at its own place, and then this message is answered.
    const after: FakeRule[] = [{ promptIncludes: "the message it died on", output: "an answer made again" }, { promptIncludes: "two", output: "second answer" }];
    await service.sendChatMessage({ taskId, instanceId: "", message: "two", fake: after as never });
    await eventually(() => said(taskId).includes("assistant: second answer") && parked(taskId), "the reply to 'two'", 20_000);

    // Same branch: a position the projection could not see is a position the next message walks into.
    expect(branchOf(taskId)).toBe(branch);
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      "user: the message it died on",
      "assistant: an answer made again",
      "user: two",
      "assistant: second answer",
    ]);
  });
});

describe("2b. a turn that died, and the next message's turn", () => {
  beforeEach(() => opened({ onePrompt: true }));

  /**
   * A chat on 2026-09-26: a turn was left open by a quit, and the next message's turn started on the
   * same chat instance while it stood. The projection kept one unsettled call per instance, lost the
   * older one, found two records for one start, and answered with nothing — so the moment the new
   * turn began, the thread lost the turn that died AND never showed the one answering, and the
   * person's message went with them ("my message that I sent disappeared").
   */
  it("keeps both, and the messages that opened them, while the second is still answering", async () => {
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const branch = thread.session.sessionId;
    const project = projectOf();
    const recorder = project.events.recorder(taskId);
    const where = { instanceId: chatInstanceIdOf(thread.instanceId), stateId: CHAT_SESSION };
    const store = new SqliteSessionStore(project.db as never, { taskId });
    recorder.record({ type: "instance.entered", ...where, childKey: "ask", parentInstanceId: thread.instanceId, inputs: {} }, Date.now());
    const turn = (seq: number, user: string): void => {
      recorder.record({ type: "operation.started", ...where, op: "prompt" }, Date.now());
      store.append({
        id: `turn-${seq}`,
        source: { kind: "prompt", user, scope: { instanceId: where.instanceId, sequence: seq - 1 } } as never,
        startMs: Date.now(),
        session: { id: branch, seq },
      });
    };

    turn(1, "close it");
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: close it"]);
    turn(2, "are the others based off master?");
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: close it", "user: are the others based off master?"]);
  });
});

describe("3. re-running a task somebody has talked to", { timeout: 60_000 }, () => {
  it("runs a COPY, so the conversation it already had is still there", async () => {
    // A thread is read from the latest run, and a second run in the same task is a second
    // conversation beside the first — every hand-typed message still in the database and nothing in
    // any view leading back to it. Reachable: a conversation that was ended can be run again.
    await opened();
    const taskId = await talking([ONE, { promptIncludes: "two", output: "second answer" }]);
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    await settled(taskId, 4, "the reply to 'two'");
    expect(await service.endConversation({ taskId })).toEqual({ ended: true });
    await eventually(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the conversation to end", 20_000);
    const before = said(taskId);

    const rerun = await service.rerunTask({ taskId, fake: [{ promptIncludes: "one", output: "a fresh start" }] as never });
    await settled(rerun.taskId, 2, "the rerun's opening reply");

    // A different task, and the original is untouched.
    expect(rerun.taskId).not.toBe(taskId);
    expect(said(rerun.taskId)).toEqual(["user: one", "assistant: a fresh start"]);
    expect(said(taskId)).toEqual(before);
    expect(before).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer"]);
    service.cancelTask(rerun.taskId);
  });

  it("mints a task nobody has talked to a fresh machine too, chained back", async () => {
    // A re-run is a new state machine instance unconditionally (Identity and Resume §05) — the
    // one-journal model has no "in place" left: restarting the same task would grow a second tree
    // where its machine lives. The spoken-to distinction stopped mattering the day it stopped
    // being what decided.
    await opened({ onePrompt: true });
    const { taskId } = service.createTask({ title: titleOf("one"), workflow: CHAT_SESSION, inputs: { message: "one" } });
    await service.startTask({ taskId, fake: STOPPED });
    await eventually(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to end", 8000);

    const rerun = await service.rerunTask({ taskId, fake: REPLY("second try") });
    expect(rerun.taskId).not.toBe(taskId);
    expect(service.listTasks().find((t) => t.taskId === rerun.taskId)?.parentTaskId).toBe(taskId);
  });
});

describe("4. messages that arrive together", { timeout: 60_000 }, () => {
  beforeEach(() => opened());

  it("keeps both, in one conversation, with everything said before them", async () => {
    // Two sends that find the conversation waiting at the same `input()`: one answers it, and the
    // other must not be dropped as an answer to a question already answered — it is kept for the next
    // `input()`, which the program reaches once the first reply is in.
    const taskId = await talking([ONE, { promptIncludes: "two", output: "second answer" }, { promptIncludes: "three", output: "third answer" }]);
    const branch = branchOf(taskId);

    const [a, b] = await Promise.all([
      service.sendChatMessage({ taskId, instanceId: "", message: "two" }),
      service.sendChatMessage({ taskId, instanceId: "", message: "three" }),
    ]);
    expect(a.failure).toBeUndefined();
    expect(b.failure).toBeUndefined();
    await settled(taskId, 6, "both replies");

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
    const messages = ["two", "three", "four", "five", "six"];
    const taskId = await talking([ONE, ...messages.map((message): FakeRule => ({ promptIncludes: message, output: `answer to ${message}` }))]);
    const branch = branchOf(taskId);

    const sent = await Promise.all(messages.map((message) => service.sendChatMessage({ taskId, instanceId: "", message })));
    expect(sent.map((s) => s.failure)).toEqual(messages.map(() => undefined));
    await settled(taskId, 2 + 2 * messages.length, "every reply");

    // In order, in one conversation, every question with its answer. Order is not incidental: the
    // waits take the messages in the order they were sent, and a transcript that merely CONTAINS
    // everything would also pass while they were answered out of turn.
    expect(said(taskId)).toEqual([
      "user: one",
      "assistant: first answer",
      ...messages.flatMap((message) => [`user: ${message}`, `assistant: answer to ${message}`]),
    ]);
    expect(branchOf(taskId)).toBe(branch);
  });

  it("keeps one sent while a reply is being made, for the wait after it", async () => {
    // Sent into a reply whose transport cannot take it, the message is not lost with the reply: the
    // program's next `input()` is answered with it at once.
    const taskId = await talking([ONE, { promptIncludes: "two", output: "second answer", hold: "cancel" }, { promptIncludes: "three", output: "third answer" }]);
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
    const sent = await service.sendChatMessage({ taskId, instanceId: "", message: "three" });
    expect(sent.steered).toBeUndefined();
    expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: true });
    await eventually(() => said(taskId).includes("assistant: third answer") && parked(taskId), "the reply to 'three'", 20_000);

    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "user: three", "assistant: third answer"]);
  });
});

describe("6. the app closing while a reply is going", { timeout: 60_000 }, () => {
  /**
   * A quit on 2026-09-26: a reply waiting on an approval was aborted and the database closed in the
   * same breath, so its settle threw "The database connection is not open", its record stayed open,
   * and its agent — killed only once the reply got round to it — outlived the app.
   */
  it("stops the reply and WAITS for it to settle before the database closes", async () => {
    await opened();
    const taskId = await talking([ONE, { promptIncludes: "two", output: "second answer", hold: "cancel" }]);
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);

    await service.close();

    // Settled while there was a database to settle it in: the reply's record ended as the stop ended
    // it — not left `open`, for the next open to settle as a process that died (`interrupted`) — every
    // instance the run entered terminated in the journal, and the run not left `running`.
    const project = openProject(dir, { baseDir: testHome() });
    try {
      const records = project.db
        .prepare(`SELECT status, error_json FROM operation_records WHERE task_id = ? ORDER BY started_at, rowid`)
        .all(taskId) as Array<{ status: string; error_json: string | null }>;
      expect(records.filter((r) => r.status === "open" || r.status === "interrupted")).toEqual([]);
      expect(records.at(-1)?.status).toBe("failed");
      expect(JSON.parse(records.at(-1)?.error_json ?? "{}")).toMatchObject({ classification: "canceled" });
      const journal = project.events.list(taskId);
      const terminated = new Set(journal.filter((row) => row.type === "instance.terminated").map((row) => row.instanceId));
      expect(journal.filter((row) => row.type === "instance.entered" && !terminated.has(row.instanceId))).toEqual([]);
      expect(project.runtime.get(taskId)?.status).not.toBe("running");
    } finally {
      project.close();
    }
    expect(pushes.filter((m) => m.type === "log:entry" && /not open/.test((m as { entry: { message: string } }).entry.message))).toEqual([]);
  });

  it("says so in the thread, at the next open, after the last thing the turn said", async () => {
    await opened({ onePrompt: true });
    const taskId = await started("one");
    const thread = service.chatThread({ taskId })!;
    const project = projectOf();
    const where = { instanceId: chatInstanceIdOf(thread.instanceId), stateId: CHAT_SESSION };
    const recorder = project.events.recorder(taskId);
    recorder.record({ type: "instance.entered", ...where, childKey: "ask", parentInstanceId: thread.instanceId, inputs: {} }, Date.now());
    recorder.record({ type: "operation.started", ...where, op: "prompt" }, Date.now());
    new SqliteSessionStore(project.db as never, { taskId }).append({
      id: "cut",
      source: { kind: "prompt", user: "the message it was cut on", scope: { instanceId: where.instanceId, sequence: 0 } } as never,
      startMs: Date.now(),
      session: { id: thread.session.sessionId, seq: 1 },
    });
    // Still open, so still nothing to say: it could be answering.
    expect(service.chatThread({ taskId })!.session.providerEvents?.some((e) => (e.event as { type?: string }).type === CUT_OFF_EVENT) ?? false).toBe(false);

    // The app goes away with the record open; the next open settles it as the process that ended it.
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    const after = service.chatThread({ taskId })!;
    expect(after.session.turns.map((t) => `${t.role}: ${t.text ?? ""}`)).toEqual(["user: one", "assistant: first answer", "user: the message it was cut on"]);
    expect(after.session.providerEvents?.filter((e) => (e.event as { type?: string }).type === CUT_OFF_EVENT)).toEqual([{ index: 3, event: { type: CUT_OFF_EVENT } }]);
  });

  it("tells the window a conversation's reply is over, however it ended", async () => {
    // The window retires a reply's live tail on the call's own terminal event — pushed as the run's
    // events are — so a reply that ends badly has to say so as surely as one that lands.
    await opened();
    const taskId = await talking([
      ONE,
      { promptIncludes: "two", output: "second answer", hold: "cancel" },
      { promptIncludes: "three", error: "the model is down" },
    ]);
    const ended = (): string[] =>
      pushes
        .filter((m) => m.type === "engine:event" && m.taskId === taskId)
        .map((m) => (m as { event: { type?: string; op?: string } }).event)
        .filter((e) => e.op === "prompt" && (e.type === "operation.completed" || e.type === "operation.failed"))
        .map((e) => e.type!);

    pushes.length = 0;
    await stopped(taskId, "two");
    expect(ended()).toEqual(["operation.failed"]);

    pushes.length = 0;
    await service.sendChatMessage({ taskId, instanceId: "", message: "three" });
    await eventually(() => ended().length > 0 && parked(taskId), "the failed reply to end", 20_000);
    expect(ended()).toEqual(["operation.failed"]);
    expect(service.listTasks().find((t) => t.taskId === taskId)?.answering).toBeUndefined();
  });
});

describe("6b. the conversation going on after the app closed mid-reply", { timeout: 60_000 }, () => {
  it("keeps the message the reply was cut on, and makes that reply again, when the conversation goes on at the next open", async () => {
    await opened();
    const taskId = await talking([ONE, { promptIncludes: "two", output: "second answer", hold: "cancel" }, { promptIncludes: "three", output: "third answer" }]);
    await service.sendChatMessage({ taskId, instanceId: "", message: "two" });
    await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two"]);

    // The conversation goes on where the close cut it: the reply to "two" is made again, then "three" answered.
    const after: FakeRule[] = [{ promptIncludes: "two", output: "second answer" }, { promptIncludes: "three", output: "third answer" }];
    await service.sendChatMessage({ taskId, instanceId: "", message: "three", fake: after as never });
    await eventually(() => said(taskId).includes("assistant: third answer") && parked(taskId), "the reply to 'three'", 20_000);
    expect(said(taskId)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer", "user: three", "assistant: third answer"]);
    service.cancelTask(taskId);
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
