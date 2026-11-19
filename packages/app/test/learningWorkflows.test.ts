/**
 * Workflows that learn from corrections (decision 0029), against a real project and the shipped layer.
 *
 * - A conversation that is a PROGRAM — `chat/program`, a loop over `input()` — is talked to through the
 *   same channel as any conversation: a typed message is the answer to its `input()`, and its next call
 *   is the reply, recorded in the same conversation.
 * - `improve/lesson` turns a lesson into whole files, has them reviewed (or not, as `approval` says),
 *   and JaiRA writes them: only where a lesson may write, re-validated, and recorded as a lesson file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalModulePath, initProject, userModules, type Project } from "@jaira/persistence";
import { moduleHash } from "@declarative-ai/hw";
import type { PushMessage } from "@jaira/shared";
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
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
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

describe("a running conversation taking an improved chat/turn (decision 0029 §3)", { timeout: 60_000 }, () => {
  const SHIPPED_TURN = join(__dirname, "..", "..", "shared", "builtin", "workflows", "chat", "turn.ts");
  /** The project's own `chat/turn`: the shipped one with its reply prompt changed — what a lesson writes. */
  const editTurn = (approve: boolean): void => {
    const edited = readFileSync(SHIPPED_TURN, "utf8").replace('llm({ prompt: text,', 'llm({ prompt: "EDITED: " + text,');
    const file = join(dir, ".jaira", "workflows", "chat", "turn.ts");
    mkdirSync(join(dir, ".jaira", "workflows", "chat"), { recursive: true });
    writeFileSync(file, edited, "utf8");
    if (approve) userModules()!.approvals.approve(canonicalModulePath(file), moduleHash(edited));
  };
  const journal = (taskId: string) =>
    (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as { type: string; stateId?: string; version?: string });
  const RULES = [
    { promptIncludes: "hello there", output: "hi" },
    { promptIncludes: "EDITED: second message", output: "an edited reply" },
    { promptIncludes: "second message", output: "the old reply" },
  ];

  it("takes it at the next message, journaled, and runs nothing new before the edit", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    // Nothing changed yet, so nothing was taken: the same content is never a "newer version".
    expect(journal(taskId).some((e) => e.type === "version.adopted")).toBe(false);
    editTurn(true);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => journal(taskId).some((e) => e.type === "instance.entered" && /^chat\/turn@v[0-9a-f]+$/.test(e.stateId ?? "")), "the edited turn to be entered", 20_000);
    const adopted = journal(taskId).filter((e) => e.type === "version.adopted");
    expect(adopted).toEqual([expect.objectContaining({ stateId: "chat/turn", version: expect.stringMatching(/^chat\/turn@v[0-9a-f]+$/) })]);
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
  });

  it("keeps the version it took when the app closes and opens again: the resumed conversation loads it and waits for the next message", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    editTurn(true);
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
    const turns = journal(taskId).filter((e) => e.type === "instance.entered" && /^chat\/turn(@v[0-9a-f]+)?$/.test(e.stateId ?? "")).map((e) => e.stateId!);
    expect(turns).toEqual(["chat/turn", expect.stringMatching(/^chat\/turn@v[0-9a-f]+$/)]);
    service.cancelTask(taskId);
  });

  it("waits for a person to approve the edited code before a running conversation takes it", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
    await service.startTask({ taskId, fake: RULES });
    await eventually(() => service.sessionHistory({ taskId }).length >= 1, "the first reply", 20_000);
    editTurn(false);
    await service.sendChatMessage({ taskId, instanceId: "", message: "second message" });
    await eventually(() => service.sessionHistory({ taskId }).length >= 2, "the second reply", 20_000);
    expect(journal(taskId).some((e) => e.type === "version.adopted")).toBe(false);
    expect(journal(taskId).filter((e) => e.type === "instance.entered" && /^chat\/turn(@v[0-9a-f]+)?$/.test(e.stateId ?? "")).map((e) => e.stateId)).toEqual(["chat/turn", "chat/turn"]);
  });
});

describe("a message's own settings in a program (decision 0029 §2)", { timeout: 60_000 }, () => {
  const journalOf = (taskId: string) =>
    (service as unknown as { session(): { project: Project } }).session().project.events.list(taskId).map((row) => row.event as { type: string; stateId?: string; field?: string; value?: unknown });

  it("runs a message on the model the composer chose for it, and the next on the defaults when it chose none", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
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

describe("choosing chat/program as the conversation the Chat view starts (decision 0021, 0029 §2)", { timeout: 60_000 }, () => {
  it("starts a new conversation as the program when the settings say so, with the first message's model", async () => {
    await service.close();
    writeFileSync(join(dir, ".jaira", "settings.json"), JSON.stringify({ conversations: { workflow: "chat/program" } }), "utf8");
    service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m) });
    await service.open(dir);
    // What the composer shows before the first message: a plan, never a refusal, for a root with no one prompt.
    expect(service.chatStartPlan({})).toBeDefined();
    const workflow = (service as unknown as { session(): { project: Project } }).session().project.config.conversations.workflow;
    expect(workflow).toBe("chat/program");
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
  });
});

describe("what the digest says the person did (decision 0029 §8)", { timeout: 60_000 }, () => {
  it("lists the tool calls the person refused", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello there", improve: false } });
    const project = (service as unknown as { session(): { project: Project } }).session().project;
    project.commands.record({ taskId, tool: "shell", command: "git push origin main", decision: "denied", decidedBy: "user", reason: "not to main" });
    project.commands.record({ taskId, tool: "shell", command: "ls", decision: "allowed", decidedBy: "policy" });
    const digest = (await createImproveHost(project).digest({ task: taskId }, undefined)) as { signals: unknown[] };
    expect(digest.signals).toEqual([{ kind: "denied", tool: "shell", command: "git push origin main", reason: "not to main" }]);
  });
});

describe("noticing a correction (decision 0029 §6)", { timeout: 60_000 }, () => {
  it("starts improve/lesson on its own when a message clearly corrects the conversation", async () => {
    const { taskId } = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "write a haiku", approval: "auto" } });
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
});

describe("reviewing a conversation at its end (decision 0029 §6)", { timeout: 60_000 }, () => {
  it("finds the lessons, proposes a change for each, and applies them on one review", async () => {
    const talk = service.createTask({ title: "Talk", workflow: "chat/program", inputs: { message: "hello", improve: false } });
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

  it("applies a change under approval: auto — JaiRA writes it and records the lesson", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "chat/program", approval: "auto" } });
    await service.startTask({ taskId, fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }] });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(readFileSync(join(dir, ".jaira", "instructions.md"), "utf8")).toBe("Answer in French.\n");
    const lesson = parseLesson(readFileSync(join(dir, ".jaira", "lessons", "answer-in-french.md"), "utf8"));
    expect(lesson.front).toMatchObject({ rule: "Answer in French", lever: "instructions", scope: "project", status: "applied" });
    expect(lesson.front.occurrences).toHaveLength(1);
  });

  it("asks the person first under approval: propose, and writes only once they apply", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "Always answer in French", workflow: "chat/program" } });
    await service.startTask({
      taskId,
      fake: [{ promptIncludes: "## The lesson", output: plan([{ path: "instructions.md", content: "Answer in French.\n" }]) }],
      interactions: { choose_option: [{ decision: "apply" }] },
    });
    await eventually(() => finished(taskId), "the improver to finish", 30_000);
    expect(existsSync(join(dir, ".jaira", "instructions.md"))).toBe(true);
  });

  it("refuses a path a lesson may not write, and writes nothing", async () => {
    const { taskId } = service.createTask({ title: "Learn", workflow: "improve/lesson", inputs: { lesson: "x", workflow: "chat/program", approval: "auto" } });
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
    expect(writablePath("workflows/chat/program.ts")).toBe("workflows/chat/program.ts");
    for (const bad of ["../x", "/etc/passwd", "settings.json", "system/sync.json", "workflows/../settings.json", "skills/"]) expect(writablePath(bad)).toBeUndefined();
  });

  it("writes a lesson file it can read back", () => {
    const text = formatLesson({ rule: "Run the tests", occurrences: [{ date: "2026-11-18" }] }, "Because they broke twice.");
    expect(parseLesson(text)).toEqual({ front: { rule: "Run the tests", occurrences: [{ date: "2026-11-18" }] }, body: "Because they broke twice." });
    expect(lessonSlug("Never push to main!")).toBe("never-push-to-main");
  });
});
