/**
 * Workflows that learn from corrections (decision 0029), against a real project and the shipped layer.
 *
 * - A conversation that is a PROGRAM — `chat/program`, a loop over `input()` — is talked to through the
 *   same channel as any conversation: a typed message is the answer to its `input()`, and its next call
 *   is the reply, recorded in the same conversation.
 * - `improve/lesson` turns a lesson into whole files, has them reviewed (or not, as `approval` says),
 *   and JaiRA writes them: only where a lesson may write, re-validated, and recorded as a lesson file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { eventually, shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { formatLesson, lessonSlug, parseLesson, writablePath } from "../../service/src/improveHost";

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
