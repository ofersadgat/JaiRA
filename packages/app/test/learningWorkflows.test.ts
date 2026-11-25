/**
 * Workflows that learn from corrections (decision 0029), against a real project and the shipped layer.
 *
 * - A conversation that is a PROGRAM — `session`, a loop over `input()` — is talked to through the
 *   same channel as any conversation: a typed message is the answer to its `input()`, and its next call
 *   is the reply, recorded in the same conversation.
 * - `improve/lesson` turns a lesson into whole files, has them reviewed (or not, as `approval` says),
 *   and JaiRA writes them: only where a lesson may write, re-validated, and recorded as a lesson file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalModulePath, initProject, userModules, type Project } from "@jaira/persistence";
import { moduleHash } from "@declarative-ai/hw";
import type { PushMessage } from "@jaira/shared";
import type { FakeRule } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { createImproveHost, formatLesson, lessonSlug, parseLesson, writablePath } from "../../service/src/improveHost";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-learn-"));
  initProject(dir, testHome());
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const finished = (taskId: string) => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId);

describe("a conversation that is a program (decision 0029 §2)", { timeout: 60_000 }, () => {
  it("takes a typed message as its input()'s answer, and replies in the same conversation", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "hello there", output: "hi!" },
        { promptIncludes: "second message", output: "got it" },
      ],
    });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    const sent = await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    expect(sent).toMatchObject({ program: true });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const history = service.sessionHistory({ taskId });
    // Both replies are turns of ONE conversation: the second continued where the first ended.
    expect(new Set(history.map((h) => (h as { sessionId?: string }).sessionId)).size).toBe(1);
    // Waiting for the next message is not something waiting on the person.
    expect(service.pendingInteractions().filter((p) => p.taskId === taskId)).toEqual([]);
  });
});

describe("a program conversation in the Chat view (decision 0029 §2)", { timeout: 60_000 }, () => {
  const parked = (taskId: string) =>
    (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } }).session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);

  it("reads back as ONE thread, and every message is a point it can be taken back to and edited at", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    const fake = [
      { promptIncludes: "hello there", output: "hi" },
      { promptIncludes: "second message", output: "second reply" },
      { promptIncludes: "another try", output: "another reply" },
      { promptIncludes: "edited try", output: "edited reply" },
    ];
    const said = () => service.chatThread({ taskId })!.session.turns.map((t) => t.text);
    await service.startTask({ taskId, fake });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2 && parked(taskId), "the second reply", 20_000);

    const thread = service.chatThread({ taskId })!;
    expect(thread.session.turns.map((t) => `${t.role}: ${t.text ?? ""}`)).toEqual(["user: hello there", "assistant: hi", "user: second message", "assistant: second reply"]);
    // The composer addresses the conversation, and its plan is the reply's.
    expect(service.chatPlan({ taskId, instanceId: thread.instanceId })).not.toBeNull();
    // The opening message is the run's; the second is a point it can be taken back to.
    expect(thread.opening).toBeDefined();
    expect(thread.points).toHaveLength(1);
    expect(thread.points[0]!.seq).toBeDefined();

    // Taken back to before the second message — a state rewind, to the `input()` that took it: the
    // program waits for that message again, and goes on from there with whatever is said instead.
    await service.rewindTask({ taskId, at: thread.points[0]!.seq!, fake: fake as never });
    await eventually(() => parked(taskId), "the conversation to wait for the message again", 20_000);
    expect(said()).toEqual(["hello there", "hi"]);
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "another try" });
    await eventually(() => said().length >= 4 && parked(taskId), "the new reply", 20_000);
    expect(said()).toEqual(["hello there", "hi", "another try", "another reply"]);
    // Still ONE conversation: the reply after the rewind continues the chain the first one began.
    expect(new Set(service.sessionHistory({ taskId }).map((h) => h.sessionId)).size).toBe(1);

    // Edited: the same rewind, and the edit is the answer.
    const point = service.chatThread({ taskId })!.points[0]!;
    await service.sendChatMessage({ taskId, instanceId: thread.instanceId, message: "edited try", branchAt: point.at, fake: fake as never });
    await eventually(() => said().includes("edited reply") && parked(taskId), "the edited message's reply", 20_000);
    expect(said()).toEqual(["hello there", "hi", "edited try", "edited reply"]);

    // Taken back to before the OPENING message, it is gone, as any conversation cut there is.
    await service.rewindTask({ taskId, at: service.chatThread({ taskId })!.opening!.seq });
    expect(service.listTasks().some((t) => t.taskId === taskId)).toBe(false);
  });
});

describe("stopping and forking a program conversation (decision 0029 §2)", { timeout: 60_000 }, () => {
  const parked = (taskId: string) =>
    (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } }).session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);
  const said = (taskId: string) => service.chatThread({ taskId })!.session.turns.map((t) => t.text);
  const inFlight = (taskId: string) =>
    (service as unknown as { session(): { liveCalls: { ofTask(id: string): unknown[] } } }).session().liveCalls.ofTask(taskId).length > 0;

  for (const transport of ["interrupt", "cancel"] as const) {
    it(`stops a reply in flight, and the conversation waits for the next message — a transport that can only ${transport}`, async () => {
      const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
      const fake = [
        { promptIncludes: "hello there", output: "hi" },
        { promptIncludes: "a long question", output: "a long answer", hold: transport },
        { promptIncludes: "next one", output: "next answer" },
      ];
      await service.startTask({ taskId, fake: fake as never });
      await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
      await service.sendChatMessage({ taskId, instanceId: "", message: "a long question" });
      await eventually(() => inFlight(taskId), "the reply to be in flight", 20_000);
      expect(service.cancelChatTurn({ taskId })).toEqual({ canceled: true });
      // The program goes on: it waits for the next message, and is still the one conversation.
      await eventually(() => parked(taskId), "the conversation to wait again", 20_000);
      // Its run lives on; the conversation reads idle, as its stopped reply left it — stopped, not failed.
      expect((service as unknown as { session(): { project: Project } }).session().project.runtime.get(taskId)?.status).toBe("running");
      expect(service.taskDetail(taskId).status).toBe("completed");
      await service.sendChatMessage({ taskId, instanceId: "", message: "next one" });
      await eventually(() => said(taskId).includes("next answer") && parked(taskId), "the next reply", 20_000);
      const turns = said(taskId);
      expect(turns.slice(0, 2)).toEqual(["hello there", "hi"]);
      expect(turns.slice(-2)).toEqual(["next one", "next answer"]);
      // Ended early, a reply keeps what it said; canceled, it said nothing the thread keeps.
      if (transport === "interrupt") expect(turns).toContain("a long answer");
      service.cancelTask(taskId);
    });
  }

  it("forks at a message: the copy takes a new message there, and the conversation it came from goes on as it was", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    const fake = [
      { promptIncludes: "hello there", output: "hi" },
      { promptIncludes: "second message", output: "second reply" },
      { promptIncludes: "a different turn", output: "a different reply" },
    ];
    await service.startTask({ taskId, fake: fake as never });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2 && parked(taskId), "the second reply", 20_000);
    const point = service.chatThread({ taskId })!.points[0]!;
    const fork = await service.forkTask({ taskId, at: point.seq!, message: "a different turn", fake: fake as never });
    expect(fork.taskId).not.toBe(taskId);
    await eventually(() => (service.chatThread({ taskId: fork.taskId })?.session.turns.length ?? 0) >= 4 && parked(fork.taskId), "the fork's reply", 20_000);
    expect(said(fork.taskId)).toEqual(["hello there", "hi", "a different turn", "a different reply"]);
    expect(said(taskId)).toEqual(["hello there", "hi", "second message", "second reply"]);
    expect(parked(taskId)).toBe(true);
    service.cancelTask(taskId);
    service.cancelTask(fork.taskId);
  });
});

describe("a running conversation taking an improved session at its input() (decision 0029 §3)", { timeout: 60_000 }, () => {
  const SHIPPED = join(__dirname, "..", "..", "shared", "builtin", "workflows", "session.ts");
  /** The project's own `session`: the shipped one with its reply prompt changed — what a lesson writes. */
  const editSession = (approve: boolean): void => {
    const shipped = readFileSync(SHIPPED, "utf8");
    const edited = shipped.replace(/prompt: text,(\s+)system: SYSTEM,/, 'prompt: "EDITED: " + text,$1system: SYSTEM,');
    expect(edited).not.toBe(shipped);
    const file = join(dir, ".jaira", "workflows", "session.ts");
    mkdirSync(join(dir, ".jaira", "workflows"), { recursive: true });
    writeFileSync(file, edited, "utf8");
    if (approve) userModules()!.approvals.approve(canonicalModulePath(file), moduleHash(edited));
  };
  type Entry = { type: string; stateId?: string; version?: string; at?: string; childKey?: string };
  const journal = (taskId: string): Entry[] =>
    (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as Entry);
  /** The conversation's root, and each version of it it switched to. */
  const roots = (taskId: string): string[] =>
    journal(taskId).filter((e) => e.type === "instance.entered" && /^session(@v[0-9a-f]+)?$/.test(e.stateId ?? "")).map((e) => e.stateId!);
  const RULES = [
    { promptIncludes: "hello there", output: "hi" },
    { promptIncludes: "EDITED: second message", output: "an edited reply" },
    { promptIncludes: "second message", output: "the old reply" },
  ];

  it("switches at the wait for the next message, journaled, and the next reply runs the edited code", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    // Nothing changed yet, so nothing was taken: the same content is never a "newer version".
    expect(journal(taskId).some((e) => e.type === "version.adopted")).toBe(false);
    editSession(true);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const adopted = journal(taskId).filter((e) => e.type === "version.adopted");
    // Taken at the root's own state boundary — the input() the message answered — not at a call.
    expect(adopted).toEqual([expect.objectContaining({ stateId: "session", at: "input", version: expect.stringMatching(/^session@v[0-9a-f]+$/) })]);
    expect(roots(taskId)).toEqual(["session", adopted[0]!.version]);
    // The second reply is a turn of the same conversation, made by the new version's code.
    const history = service.sessionHistory({ taskId });
    expect(new Set(history.map((h) => h.sessionId)).size).toBe(1);
    const events = journal(taskId) as Array<Entry & { operation?: { prompt?: string } }>;
    expect(JSON.stringify(events)).toContain("an edited reply");
    expect(JSON.stringify(events)).not.toContain("the old reply");
  });

  it("keeps the version it took when the app closes and opens again: the resumed conversation loads it and waits for the next message", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    editSession(true);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const parked = () =>
      (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } })
        .session()
        .hub.list()
        .some((r) => r.component === "input" && r.taskId === taskId);
    await eventually(parked, "the conversation to wait for its next message", 20_000);
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    // The app resumes a conversation that was waiting on the person. Its history holds turns that ran
    // under the version it took, and the load reads them — none is "unreadable" — so it waits again.
    // (No message is sent: a run the app resumes on its own has no scripted model, and a test must
    // never reach a real one.)
    await eventually(parked, "the resumed conversation to wait for its next message", 20_000);
    const refused = pushes.filter((m) => m.type === "log:entry" && /could not resume|cannot be resumed/.test((m as { entry: { message: string } }).entry.message));
    expect(refused).toEqual([]);
    expect(roots(taskId)).toEqual(["session", expect.stringMatching(/^session@v[0-9a-f]+$/)]);
    service.cancelTask(taskId);
  });

  it("takes it after a rewind too: the resumed conversation switches from the wait it was taken back to", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const point = service.chatThread({ taskId })!.points[0]!;
    await service.rewindTask({ taskId, at: point.seq!, fake: RULES as never });
    const parked = () =>
      (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } }).session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);
    await eventually(parked, "the conversation to wait for the message again", 20_000);
    editSession(true);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => JSON.stringify(journal(taskId)).includes("an edited reply"), "the edited code's reply", 20_000);
    expect(journal(taskId).filter((e) => e.type === "version.adopted")).toEqual([expect.objectContaining({ stateId: "session", at: "input" })]);
    expect(JSON.stringify(journal(taskId))).not.toContain("the old reply");
    service.cancelTask(taskId);
  });

  it("takes changed INSTRUCTIONS the same way: pinned with the run, a change to them is a newer version", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    writeFileSync(join(dir, ".jaira", "instructions.md"), "Answer in French.\n", "utf8");
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    expect(journal(taskId).filter((e) => e.type === "version.adopted")).toEqual([expect.objectContaining({ stateId: "session", at: "input" })]);
    // The reply after the switch was made with the instructions pinned into the version it took.
    const reply = (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as unknown as { type: string; op?: string; operationId?: string; stateId?: string }).filter((e) => e.type === "operation.completed" && e.op === "prompt" && /^session@v[0-9a-f]+\/call_0$/.test(e.stateId ?? "")).at(-1)!;
    const { sessionStoreFor } = await import("@jaira/persistence");
    const request = sessionStoreFor((service as unknown as { session(): { project: Project } }).session().project, { taskId }).record(reply.operationId!)!.request as { config?: Record<string, unknown> };
    expect(String(request.config?.["standing"] ?? "")).toContain("Answer in French.");
    service.cancelTask(taskId);
  });

  it("waits for a person to approve the edited code before a running conversation takes it", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    editSession(false);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    expect(journal(taskId).some((e) => e.type === "version.adopted")).toBe(false);
    expect(roots(taskId)).toEqual(["session"]);
    expect(JSON.stringify(journal(taskId))).toContain("the old reply");
  });
});

describe("a message's own settings in a program (decision 0029 §2)", { timeout: 60_000 }, () => {
  const journalOf = (taskId: string) =>
    (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as { type: string; stateId?: string; field?: string; value?: unknown });

  it("runs a message on the model the composer chose for it, and the next on the defaults when it chose none", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "hello there", output: "hi" },
        { promptIncludes: "second message", output: "fancy" },
        { promptIncludes: "third message", output: "plain" },
      ],
    });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message", overrides: { model: "anthropic/fancy-model" } });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "third message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 3, "the third reply", 20_000);
    // One settled model per message: none chosen, the composer's choice, none chosen — an unchosen one is
    // left out of the call, so the router's default answers it.
    const models = journalOf(taskId).filter((e) => e.type === "value.settled" && e.field?.endsWith("config.model"));
    expect(models.map((e) => e.value)).toEqual([undefined, "anthropic/fancy-model", undefined]);
  });
});

describe("the conversation the Chat view starts is the program (decision 0021, 0029 §2)", { timeout: 60_000 }, () => {
  it("starts session as a loop over input(), the first message on the model the composer chose", async () => {
    expect(service.chatStartPlan({})).toBeDefined();
    const workflow = (service as unknown as { session(): { project: Project } }).session().project.config.conversations.workflow;
    expect(workflow).toBe("session");
    const { taskId } = service.createTask({ title: "Talk", workflow, conversation: true, inputs: { message: "hello there" } });
    await service.startTask({
      taskId,
      overrides: { model: "anthropic/first-choice" },
      fake: [
        { promptIncludes: "The person's message:", output: { verdict: "none", lesson: "", quote: "" } },
        { promptIncludes: "hello there", output: "hi" },
        { promptIncludes: "second message", output: "still here" },
      ],
    });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const events = (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as { type: string; field?: string; value?: unknown });
    expect(events.filter((e) => e.type === "value.settled" && e.field?.endsWith("config.model")).map((e) => e.value)[0]).toBe("anthropic/first-choice");
    // Its composer reads the session's own set, which every call inherits from the program's root.
    const plan = service.chatPlan({ taskId, instanceId: "" })!;
    expect(plan.origin.tools).toBe("inherited");
    expect(plan.effective.permissions).toBe("ask first");
  });
});

describe("a message's own tools in a program (decision 0029 §2)", { timeout: 60_000 }, () => {
  type Held = { permissionSet?: { entries?: Record<string, unknown> } };
  const liveSets = (taskId: string): Held[] =>
    [...((service as unknown as { session(): { livePermissions: Map<string, Set<Held>> } }).session().livePermissions.get(taskId) ?? [])];

  it("decides the conversation's next calls under the tools a message chose, and keeps them for the ones after", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: [{ promptIncludes: "hello there", output: "hi" }, { promptIncludes: "second message", output: "ok" }] });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    // Nothing picked yet: the run decides each call under what its states declare.
    expect(liveSets(taskId).every((l) => l.permissionSet === undefined)).toBe(true);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message", overrides: { tools: ["read_file", "glob"] } });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    const held = liveSets(taskId);
    expect(held.length).toBeGreaterThan(0);
    // Exactly the two picked are offered: the shell, and every other tool of the session's set, is held
    // back (`offered: false`), the set's own lines still standing for them.
    const offered = Object.entries(held[0]!.permissionSet?.entries ?? {})
      .filter(([, entry]) => (entry as { kind?: string; offered?: boolean }).kind === "tool" && (entry as { offered?: boolean }).offered !== false)
      .map(([name]) => name)
      .sort();
    expect(offered).toEqual(["glob", "read_file"]);
    // Kept on the task: the composer opens on them, and the next message is decided under them too.
    const meta = (service as unknown as { session(): { project: Project } }).session().project.tasks.read(taskId);
    expect(meta.chatSettings).toMatchObject({ tools: ["read_file", "glob"] });
  });
});

describe("what the digest says the person did (decision 0029 §8)", { timeout: 60_000 }, () => {
  it("lists the tool calls the person refused", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello there", improve: false } });
    const project = (service as unknown as { session(): { project: Project } }).session().project;
    project.commands.record({ taskId, tool: "shell", command: "git push origin main", decision: "denied", decidedBy: "user", reason: "not to main" });
    project.commands.record({ taskId, tool: "shell", command: "ls", decision: "allowed", decidedBy: "policy" });
    const digest = (await createImproveHost(project).digest({ task: taskId }, undefined)) as { signals: unknown[] };
    expect(digest.signals).toEqual([{ kind: "denied", tool: "shell", command: "git push origin main", reason: "not to main" }]);
  });
});

describe("what the digest says the person did, beyond what they typed (decision 0029 §8)", { timeout: 60_000 }, () => {
  const parked = (taskId: string) =>
    (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string }> } } }).session().hub.list().some((r) => r.component === "input" && r.taskId === taskId);
  const project = () => (service as unknown as { session(): { project: Project } }).session().project;
  const digest = async (taskId: string) => (await createImproveHost(project()).digest({ task: taskId }, undefined)) as { signals: Array<Record<string, unknown>>; inEffect: Record<string, unknown> };

  it("says what a rewind took back, and a message sent into a reply being made", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hello there", improve: false } });
    const fake = [
      { promptIncludes: "hello there", output: "hi" },
      { promptIncludes: "second message", output: "second reply" },
      { promptIncludes: "a long one", output: "a long answer", hold: "interrupt" },
    ];
    await service.startTask({ taskId, fake: fake as never });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2 && parked(taskId), "the second reply", 20_000);
    await service.rewindTask({ taskId, at: service.chatThread({ taskId })!.points[0]!.seq!, fake: fake as never });
    await eventually(() => parked(taskId), "the conversation to wait again", 20_000);
    expect((await digest(taskId)).signals).toContainEqual({ kind: "rewound", taken: ["second message"] });

    await service.sendChatMessage({ taskId, instanceId: "", message: "a long one" });
    const inFlight = () => (service as unknown as { session(): { liveCalls: { ofTask(id: string): unknown[] } } }).session().liveCalls.ofTask(taskId).length > 0;
    await eventually(inFlight, "the reply to be in flight", 20_000);
    // "Send now": joined to the reply in flight — without it, a message sent now is queued (decision 0033 §9).
    expect(await service.sendChatMessage({ taskId, instanceId: "", message: "shorter, please", now: true })).toMatchObject({ steered: true });
    expect((await digest(taskId)).signals).toContainEqual({ kind: "steered", message: "shorter, please" });
    service.cancelTask(taskId);
  });

  it("says which gate the person turned down", async () => {
    mkdirSync(join(dir, ".jaira", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".jaira", "workflows", "ship.json"), JSON.stringify({ label: "Ship", outputs: { confirmed: { schema: { type: "boolean" } } }, operation: { kind: "function", function: "confirm_action", args: { prompt: "Ship it?" } } }));
    const { taskId } = service.createTask({ title: "Ship", workflow: "ship" });
    await service.startTask({ taskId });
    await eventually(() => service.pendingInteractions().some((p) => p.taskId === taskId), "the gate", 20_000);
    service.submitInteraction(service.pendingInteractions().find((p) => p.taskId === taskId)!.requestId, { confirmed: false });
    await eventually(() => finished(taskId), "the run to finish", 20_000);
    expect((await digest(taskId)).signals).toContainEqual(expect.objectContaining({ kind: "gate rejected", component: "confirm_action", state: "ship" }));
  });
});

describe("noticing a correction (decision 0029 §6)", { timeout: 60_000 }, () => {
  it("starts improve/lesson on its own when a message clearly corrects the conversation", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "write a haiku", approval: "auto" } });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "The person's message:", output: { verdict: "clear", lesson: "Never use emojis", quote: "no emojis, ever" } },
        { promptIncludes: "write a haiku", output: "leaves fall 🍂" },
        { promptIncludes: "no emojis, ever", output: "leaves fall" },
      ],
    });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "no emojis, ever" });
    await eventually(() => service.listTasks().some((t) => t.workflow === "improve/lesson"), "the improver to be started", 20_000);
    const started = service.listTasks().find((t) => t.workflow === "improve/lesson")!;
    expect(started.title).toBe("Lesson: Never use emojis");
  });

  // The person, 2026-11-23: "a parent task should not count as stopped when it has a non terminal child.
  // the parent task should be in the waiting state which lets me know that it has something that needs to be done".
  it("leaves the conversation waiting while the lesson it started asks the person, and counts the lesson through it", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "write a limerick" } });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "## The lesson", output: { lesson: true, rule: "Never use exclamation marks", lever: "instructions", target: "instructions", why: "A preference.", summary: "One line.", files: [{ path: "instructions.md", content: "No exclamation marks.\n" }] } },
        { promptIncludes: "The person's message:", output: { verdict: "clear", lesson: "Never use exclamation marks", quote: "no exclamation marks" } },
        { promptIncludes: "write a limerick", output: "there once was a cat!" },
        { promptIncludes: "no exclamation marks", output: "there once was a cat." },
      ],
    });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "no exclamation marks" });
    const lesson = () => service.listTasks().find((t) => t.workflow === "improve/lesson" && t.origin?.taskId === taskId);
    await eventually(() => lesson() !== undefined && service.pendingInteractions().some((p) => p.taskId === lesson()!.taskId && p.component === "choose_option"), "the lesson to ask", 30_000);
    const child = lesson()!;
    expect(child.origin).toMatchObject({ kind: "started", taskId });

    // Idle at its input(), but not stopped: the lesson under it is open, and asks.
    await eventually(() => service.listTasks().find((t) => t.taskId === taskId)?.status === "running", "the conversation to read as running", 20_000);
    const summary = service.listProjects().find((p) => p.kind === "user")!;
    expect(summary.live).toContainEqual(expect.objectContaining({ taskId, kind: "waiting" }));
    // The lesson is drawn inside the conversation, so it is counted through it — never on its own.
    expect(summary.live?.some((t) => t.taskId === child.taskId)).toBe(false);
    expect(summary.ended.some((t) => t.taskId === child.taskId)).toBe(false);
    expect(summary.waiting).toBe(1);

    // Answered, the lesson ends, and the conversation is idle again — its last reply's status.
    const gate = service.pendingInteractions().find((p) => p.taskId === child.taskId && p.component === "choose_option")!;
    service.submitInteraction(gate.requestId, { decision: "discard" });
    await eventually(() => finished(child.taskId), "the lesson to finish", 20_000);
    await eventually(() => service.listTasks().find((t) => t.taskId === taskId)?.status === "completed", "the conversation to read as idle", 20_000);
    expect(service.listProjects().find((p) => p.kind === "user")).toMatchObject({ waiting: 0 });
    // The lesson moved, so the conversation is news too: its clock is held to the lesson's, here and in
    // its project's ended row ("if a child task updates, it should also mark the parent as unseen").
    const ended = service.listTasks().find((t) => t.taskId === child.taskId)!;
    const talk = service.listTasks().find((t) => t.taskId === taskId)!;
    expect(talk.childAt).toBeGreaterThanOrEqual(ended.updatedAt);
    expect(service.listProjects().find((p) => p.kind === "user")!.ended.find((t) => t.taskId === taskId)?.updatedAt).toBeGreaterThanOrEqual(ended.updatedAt);
    service.cancelTask(taskId);
  });

  // The person, 2026-11-24: "the state of a nested task affecting the color of the parent task ring".
  it("leaves a task waiting while a task under it is interrupted, and working while one runs, whatever its own row says", () => {
    const { project } = (service as unknown as { session(): { project: Project } }).session();
    const parent = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "hi", improve: false } });
    const child = service.createTask({ title: "Review", workflow: "improve/conversation", inputs: { context: { task: parent.taskId } } });
    project.tasks.write({ ...project.tasks.read(child.taskId)!, origin: { kind: "started", taskId: parent.taskId } } as Parameters<typeof project.tasks.write>[0]);
    project.runtime.setStatus(parent.taskId, "completed", 1000);
    const summary = () => service.listProjects().find((p) => p.kind === "user")!;

    project.runtime.setStatus(child.taskId, "interrupted", 2000);
    expect(summary().live).toContainEqual({ taskId: parent.taskId, kind: "waiting", since: 2000 });
    expect(summary().waiting).toBe(1);
    project.runtime.setStatus(child.taskId, "running", 3000);
    expect(summary().live).toContainEqual({ taskId: parent.taskId, kind: "running", since: 3000 });
    project.runtime.setStatus(child.taskId, "completed", 4000);
    expect(summary().live?.some((t) => t.taskId === parent.taskId)).toBe(false);
    expect(summary().waiting).toBe(0);
  });
});

describe("reviewing a conversation at its end (decision 0029 §6)", { timeout: 60_000 }, () => {
  it("finds the lessons, proposes a change for each, and applies them on one review", async () => {
    const talk = service.createTask({ title: "Talk", workflow: "session", inputs: { message: "hello", improve: false } });
    await service.startTask({ taskId: talk.taskId, fake: [{ promptIncludes: "hello", output: "bonjour" }] });
    await eventually(() => service.sessionHistory({ taskId: talk.taskId }).length >= 1, "the reply", 20_000);
    const { taskId } = service.createTask({ title: "Review", workflow: "improve/conversation", inputs: { context: { task: talk.taskId } } });
    await service.startTask({
      taskId,
      fake: [
        { promptIncludes: "## The lesson", output: { lesson: true, rule: "Answer in French", lever: "instructions", target: "instructions", why: "A preference.", summary: "One line.", files: [{ path: "instructions.md", content: "Answer in French.\n" }] } },
        { promptIncludes: "## Lessons on record", output: { lessons: [{ lesson: "Always answer in French", quote: "bonjour" }] } },
      ],
      interactions: { choose_option: [{ decision: "apply" }] },
    });
    await eventually(() => finished(taskId), "the review to finish", 30_000);
    expect(readFileSync(join(dir, ".jaira", "instructions.md"), "utf8")).toBe("Answer in French.\n");
    expect(existsSync(join(dir, ".jaira", "lessons", "answer-in-french.md"))).toBe(true);
  });
});

describe("ending a conversation, and leaving it idle (decision 0029 §2, §6)", { timeout: 60_000 }, () => {
  const parked = (taskId: string, prompt?: string) =>
    (service as unknown as { session(): { hub: { list(): Array<{ component: string; taskId?: string; inputs: { prompt?: string } }> } } })
      .session()
      .hub.list()
      .some((r) => r.component === "input" && r.taskId === taskId && (prompt === undefined || r.inputs.prompt === prompt));
  const meta = (taskId: string) => (service as unknown as { session(): { project: Project } }).session().project.tasks.read(taskId);
  // First match wins, and the review's and the check's prompts carry the conversation: theirs go first.
  const RULES: FakeRule[] = [
    { promptIncludes: "## Lessons on record", output: { lessons: [] } },
    { promptIncludes: "The person's message:", output: { verdict: "maybe", lesson: "Keep poems short", quote: "shorter" } },
    { promptIncludes: "write a haiku", output: "leaves fall slowly down" },
    { promptIncludes: "shorter", output: "leaves fall" },
    { promptIncludes: "one more", output: "snow" },
  ];

  it("End answers its input() null, and the review of the whole conversation is handed what the strict check thought might be a correction", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "write a haiku" } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "shorter" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2 && parked(taskId), "the second reply", 20_000);
    // Waiting for its next message: what the Chat list offers End for — and IDLE, not a run working or
    // asking: its row reads as its last reply ended, and its project counts nothing waiting on the person.
    expect(service.listTasks().find((t) => t.taskId === taskId)).toMatchObject({ waitsForMessage: true, status: "completed" });
    expect(service.listTasks().find((t) => t.taskId === taskId)?.answering).toBeUndefined();
    expect(service.listProjects().find((p) => p.kind === "user")).toMatchObject({ running: 0, waiting: 0, live: [] });
    expect(await service.endConversation({ taskId })).toEqual({ ended: true });
    await eventually(() => finished(taskId), "the conversation to end", 20_000);
    const review = service.listTasks().find((t) => t.workflow === "improve/conversation")!;
    expect(review.origin).toMatchObject({ kind: "started", taskId });
    expect((meta(review.taskId).inputs as { context: { maybes: unknown } }).context.maybes).toEqual([{ lesson: "Keep poems short", quote: "shorter" }]);
    // Its calls are answered by the conversation's own script: a scripted run never reaches a model.
    await eventually(() => finished(review.taskId), "the review to finish", 20_000);
    expect(service.listTasks().find((t) => t.taskId === review.taskId)?.status).toBe("completed");
    // Ended, it waits for nothing.
    expect(service.listTasks().find((t) => t.taskId === taskId)?.waitsForMessage).toBeUndefined();
    expect(await service.endConversation({ taskId })).toEqual({ ended: false });
  });

  it("reads as failed while it waits, when its last reply failed — and goes on waiting for the next message", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "write a haiku", improve: false } });
    await service.startTask({ taskId, fake: [{ promptIncludes: "write a haiku", error: "the model is down" }] });
    await eventually(() => parked(taskId), "the wait after the failed reply", 20_000);
    expect(service.listTasks().find((t) => t.taskId === taskId)).toMatchObject({ status: "failed", waitsForMessage: true });
    service.cancelTask(taskId);
  });

  it("stays scripted when the app opens again: the resumed run answers from the script it was started with", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "write a haiku", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    // Resumed by the open, waiting again — on the script, not on a model (checked without a call).
    await eventually(() => parked(taskId), "the resumed conversation to wait", 20_000);
    const session = (service as unknown as { session(): { fakeRules: Map<string, unknown[]>; project: Project } }).session();
    expect(session.fakeRules.get(taskId)).toHaveLength(RULES.length);
    expect(session.project.tasks.read(taskId).title).toBe("Talk");
    service.cancelTask(taskId);
  });

  it("takes an ended conversation up again where it ended when the person writes in it — an ordinary rewind to that wait", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "session", conversation: true, inputs: { message: "write a haiku", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1 && parked(taskId), "the first reply", 20_000);
    await service.endConversation({ taskId });
    await eventually(() => finished(taskId), "the conversation to end", 20_000);
    await service.sendChatMessage({ taskId, instanceId: "", message: "one more", fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2 && parked(taskId), "the reply after it ended", 20_000);
    expect(service.chatThread({ taskId })!.session.turns.map((t) => t.text)).toEqual(["write a haiku", "leaves fall slowly down", "one more", "snow"]);
    service.cancelTask(taskId);
  });

  /** A project's own program that waits `idle` seconds for a message, then waits again — named so a test can tell the two apart. */
  const writeWaits = (idle: number): void => {
    const code = `import { input } from "@declarative-ai/hw/script";
export default async function waits(): Promise<string> {
  const first = await input({ prompt: "first wait", idle: ${idle} });
  if (first === null || first.idle !== true) return "answered";
  const after = await input({ prompt: "after idle" });
  return after === null || after.idle === true ? "ended" : after.text;
}
`;
    const file = join(dir, ".jaira", "workflows", "waits.ts");
    mkdirSync(join(dir, ".jaira", "workflows"), { recursive: true });
    writeFileSync(file, code, "utf8");
    userModules()!.approvals.approve(canonicalModulePath(file), moduleHash(code));
  };

  it("answers a wait { idle: true } once its idle stretch has passed with no message", async () => {
    writeWaits(0.3);
    const { taskId } = service.createTask({ title: "Waits", workflow: "waits" });
    await service.startTask({ taskId, fake: [] });
    await eventually(() => parked(taskId, "first wait"), "the first wait", 20_000);
    await eventually(() => parked(taskId, "after idle"), "the wait after the idle stretch", 5_000);
    service.cancelTask(taskId);
  });

  it("counts the stretch from when the wait first asked: time the app spent closed counts", async () => {
    writeWaits(4);
    const { taskId } = service.createTask({ title: "Waits", workflow: "waits" });
    await service.startTask({ taskId, fake: [] });
    await eventually(() => parked(taskId, "first wait"), "the first wait", 20_000);
    await service.close();
    await new Promise((resolve) => setTimeout(resolve, 4_100));
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    const reopened = Date.now();
    await service.open(dir);
    // A stretch counted from the reopen would take four seconds more; this one is already over.
    await eventually(() => parked(taskId, "after idle"), "the wait after the idle stretch", 3_000);
    expect(Date.now() - reopened).toBeLessThan(4_000);
    service.cancelTask(taskId);
  });
});

describe("a lesson another project learned too (decision 0029 §7)", { timeout: 60_000 }, () => {
  let other: string;
  beforeEach(async () => {
    other = mkdtempSync(join(tmpdir(), "jaira-learn-other-"));
    initProject(other, testHome());
    mkdirSync(join(other, ".jaira", "lessons"), { recursive: true });
    writeFileSync(join(other, ".jaira", "lessons", "answer-in-french.md"), formatLesson({ rule: "Answer in French", lever: "instructions", scope: "project", status: "applied" }, "Asked twice."), "utf8");
    await service.open(other);
  });
  afterEach(() => rmSync(other, { recursive: true, force: true }));

  it("is shown to the review, and the change it proposes is written for every project, in the Shared layer", async () => {
    const name = basename(other);
    const talk = service.createTask({ project: dir, title: "Talk", workflow: "session", inputs: { message: "hello", improve: false } });
    await service.startTask({ project: dir, taskId: talk.taskId, fake: [{ promptIncludes: "hello", output: "bonjour" }] });
    await eventually(() => service.sessionHistory({ project: dir, taskId: talk.taskId }).length >= 1, "the reply", 20_000);
    const { taskId } = service.createTask({ project: dir, title: "Review", workflow: "improve/conversation", inputs: { context: { task: talk.taskId } } });
    await service.startTask({
      project: dir,
      taskId,
      fake: [
        // Written for the Shared layer: the author is told where the change belongs.
        { promptIncludes: "## Where the change belongs", output: { lesson: true, rule: "Answer in French", lever: "instructions", target: "instructions", why: "Everywhere.", summary: "One line.", files: [{ path: "instructions.md", content: "Answer in French.\n" }] } },
        // Only a review that was shown the other project's lessons finds this one there.
        { promptIncludes: `"project": "${name}"`, output: { lessons: [{ lesson: "Always answer in French", quote: "bonjour", elsewhere: name }] } },
      ],
      interactions: { choose_option: [{ decision: "apply" }] },
    });
    await eventually(() => finished(taskId), "the review to finish", 30_000);
    expect(readFileSync(join(testHome(), "instructions.md"), "utf8")).toBe("Answer in French.\n");
    expect(parseLesson(readFileSync(join(testHome(), "lessons", "answer-in-french.md"), "utf8")).front).toMatchObject({ scope: "shared", status: "applied" });
    expect(existsSync(join(dir, ".jaira", "instructions.md"))).toBe(false);
  });
});

describe("improve/lesson (decision 0029 §5)", { timeout: 60_000 }, () => {
  const plan = (files: Array<{ path: string; content: string }>) => ({
    lesson: true,
    rule: "Answer in French",
    lever: "instructions",
    target: "instructions",
    why: "A general preference belongs in instructions.",
    summary: "Adds one line to the instructions.",
    files,
  });

  it("applies a change under approval: accept — JaiRA writes it and records the lesson", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "session", approval: "accept" } });
    await service.startTask({ taskId, fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }] });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(readFileSync(join(dir, ".jaira", "instructions.md"), "utf8")).toBe("Answer in French.\n");
    const lesson = parseLesson(readFileSync(join(dir, ".jaira", "lessons", "answer-in-french.md"), "utf8"));
    expect(lesson.front).toMatchObject({ rule: "Answer in French", lever: "instructions", scope: "project", status: "applied" });
    expect(lesson.front.occurrences).toHaveLength(1);
  });

  it("asks the person first under approval: propose, and writes only once they apply", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "session" } });
    await service.startTask({
      taskId,
      fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }],
      interactions: { choose_option: [{ decision: "apply" }] },
    });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(existsSync(join(dir, ".jaira", "instructions.md"))).toBe(true);
  });

  // The person, 2026-11-24: "auto: ask the user when unclear". A change never tried on the conversation
  // was not shown to hold, so `auto` puts it to the person rather than writing it.
  it("asks the person under approval: auto when the change was not shown to hold, and writes nothing they turn down", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "session", approval: "auto" } });
    await service.startTask({
      taskId,
      fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }],
      interactions: { choose_option: [{ decision: "discard" }] },
    });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(existsSync(join(dir, ".jaira", "instructions.md"))).toBe(false);
    expect(service.learningMeasures().proposals).toEqual({ applied: 0, declined: 1 });
  });

  it("records a change turned down at the review, with what the person said, and counts it", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "session" } });
    await service.startTask({
      taskId,
      fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }],
      interactions: { choose_option: [{ decision: "discard", comment: "not in this project" }] },
    });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(existsSync(join(dir, ".jaira", "instructions.md"))).toBe(false);
    const front = parseLesson(readFileSync(join(dir, ".jaira", "lessons", "answer-in-french.md"), "utf8")).front;
    expect(front).toMatchObject({ status: "declined", changes: [], occurrences: [{ outcome: "declined", comment: "not in this project" }] });
    expect(service.learningMeasures().proposals).toEqual({ applied: 0, declined: 1 });
  });

  it("says, when a lesson comes back, whether its fix was in effect in the conversation it came back in", async () => {
    const talk = async (said: string): Promise<string> => {
      const { taskId } = service.createTask({ title: "Talk", workflow: "session", inputs: { message: said, improve: false } });
      await service.startTask({ taskId, fake: [{ promptIncludes: said, output: "ok" }] });
      await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the reply", 20_000);
      return taskId;
    };
    const learn = async (context: Record<string, unknown>, content: string): Promise<void> => {
      const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "session", context: context as JsonValue, approval: "accept" } });
      await service.startTask({ taskId, fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content }]) }] });
      await eventually(() => finished(taskId), "the improver to finish", 30_000);
    };
    const before = await talk("first talk");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await learn({}, "Answer in French.\n");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await talk("second talk");
    // Came back where the fix had not reached (its run began before it), then where it had.
    await learn({ task: before }, "Answer in French, always.\n");
    await learn({ task: after }, "Answer ONLY in French.\n");
    const occurrences = parseLesson(readFileSync(join(dir, ".jaira", "lessons", "answer-in-french.md"), "utf8")).front.occurrences as Array<{ inEffect?: boolean }>;
    expect(occurrences.map((o) => o.inEffect)).toEqual([undefined, false, true]);
    expect(service.learningMeasures().lessons[0]).toMatchObject({ recurred: 2, recurredInEffect: 1 });
    service.cancelTask(before);
    service.cancelTask(after);
  });

  it("refuses a path a lesson may not write, and writes nothing", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "x", workflow: "session", approval: "accept" } });
    await service.startTask({ taskId, fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "../outside.txt", content: "no" }]) }] });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(existsSync(join(dir, "outside.txt"))).toBe(false);
    expect(existsSync(join(dir, ".jaira", "lessons"))).toBe(false);
  });
});

describe("the improver's host", () => {
  it("lets a lesson write only its own folders", () => {
    expect(writablePath("instructions.md")).toBe("instructions.md");
    expect(writablePath("skills/logging/SKILL.md")).toBe("skills/logging/SKILL.md");
    expect(writablePath("workflows/session.ts")).toBe("workflows/session.ts");
    for (const bad of ["../x", "/etc/passwd", "settings.json", "system/sync.json", "workflows/../settings.json", "skills/"]) expect(writablePath(bad)).toBeUndefined();
  });

  it("writes a lesson file it can read back", () => {
    const text = formatLesson({ rule: "Run the tests", occurrences: [{ date: "2026-11-18" }] }, "Because they broke twice.");
    expect(parseLesson(text)).toEqual({ front: { rule: "Run the tests", occurrences: [{ date: "2026-11-18" }] }, body: "Because they broke twice." });
    expect(lessonSlug("Never push to main!")).toBe("never-push-to-main");
  });
});
