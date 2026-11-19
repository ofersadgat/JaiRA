/**
 * What learning measures (decision 0029, "Revisit when"): lesson files read back into each lesson's
 * recurrence, the proposals applied and turned down, corrections per conversation, lessons more than one
 * project learned, and how often running work took a newer version within the pass that offered it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { testHome } from "@jaira/testing";
import { createTask } from "../src/lifecycle";
import { formatLesson, learningMeasures, parseLesson, recordLessonOccurrence } from "../src/lessons";
import { initProject, openProject, type Project } from "../src/project";

let dir: string;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-lessons-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const lesson = (rule: string, lever: string) => ({ rule, lever, target: "session", why: "Because." });
const write = (root: string, name: string, front: Record<string, unknown>): void => {
  mkdirSync(join(root, "lessons"), { recursive: true });
  writeFileSync(join(root, "lessons", name), formatLesson(front as never, "Because."), "utf8");
};

describe("a lesson's occurrences", () => {
  it("records an applied change and a turned-down one, the status applied once any change was", () => {
    const root = project.paths.jairaDir;
    recordLessonOccurrence(root, lesson("Run the tests", "check"), "project", [], { at: 1, date: "2026-11-18", outcome: "declined", comment: "not like that" });
    let front = parseLesson(readFileSync(join(root, "lessons", "run-the-tests.md"), "utf8")).front;
    expect(front).toMatchObject({ status: "declined", changes: [], occurrences: [{ outcome: "declined", comment: "not like that" }] });
    recordLessonOccurrence(root, lesson("Run the tests", "check"), "project", [{ path: "workflows/session.ts", content: "x" }], { at: 2, date: "2026-11-18", outcome: "applied" });
    recordLessonOccurrence(root, lesson("Run the tests", "check"), "project", [], { at: 3, date: "2026-11-19", outcome: "declined", inEffect: true });
    front = parseLesson(readFileSync(join(root, "lessons", "run-the-tests.md"), "utf8")).front;
    expect(front.status).toBe("applied");
    expect(front.changes).toEqual([expect.objectContaining({ file: "workflows/session.ts", at: 2 })]);
    expect((front.occurrences as unknown[]).length).toBe(3);
  });
});

describe("learning measures", () => {
  it("counts recurrence after a fix in effect, and says to revisit when a structural lever keeps failing", () => {
    const talk = createTask(project, { title: "Talk", workflow: "session", startedBy: { by: "chat" } });
    const occurrence = (outcome: string, extra: Record<string, unknown> = {}) => ({ date: "2026-11-18", task: talk.id, outcome, ...extra });
    write(project.paths.jairaDir, "never-push-to-main.md", {
      rule: "Never push to main",
      lever: "permission",
      target: "ask-first",
      status: "applied",
      changes: [{ file: "permission-sets/ask-first.json", hash: "h", date: "2026-11-18" }],
      occurrences: [occurrence("applied"), occurrence("applied", { inEffect: true }), occurrence("declined", { inEffect: true })],
    });
    // Written before occurrences said what became of them: each was an applied change.
    write(project.paths.jairaDir, "answer-in-french.md", { rule: "Answer in French", lever: "instructions", target: "instructions", status: "applied", occurrences: [{ date: "2026-11-01" }] });
    const m = learningMeasures(project);
    const push = m.lessons.find((l) => l.rule === "Never push to main")!;
    expect(push).toMatchObject({ occurrences: 3, applied: 2, declined: 1, recurred: 2, recurredInEffect: 2, structural: true, layer: "project" });
    expect(m.lessons.find((l) => l.rule === "Answer in French")).toMatchObject({ applied: 1, recurred: 0, structural: false });
    expect(m.proposals).toEqual({ applied: 3, declined: 1 });
    expect(m.conversations).toMatchObject({ count: 1, corrections: 3, perConversation: 3, byConversation: [{ task: talk.id, title: "Talk", corrections: 3 }] });
    expect(m.revisit).toEqual([expect.stringMatching(/"Never push to main" came back 2 times after its fix \(permission\) was in effect/)]);
  });

  it("says to revisit when most proposals are turned down, and names the lessons more than one project learned", () => {
    const name = basename(dir);
    write(project.paths.jairaDir, "keep-it-short.md", {
      rule: "Keep it short",
      lever: "instructions",
      target: "instructions",
      status: "declined",
      occurrences: [1, 2, 3, 4].map(() => ({ date: "2026-11-18", outcome: "declined" })),
    });
    write(project.paths.base.baseDir, "use-pnpm.md", {
      rule: "Use pnpm",
      lever: "instructions",
      target: "instructions",
      status: "applied",
      occurrences: [
        { date: "2026-11-18", outcome: "applied", project: "elsewhere" },
        { date: "2026-11-18", outcome: "applied", project: name },
      ],
    });
    const m = learningMeasures(project);
    // The Shared layer's occurrences count for this project only where they name it.
    expect(m.proposals).toEqual({ applied: 1, declined: 4 });
    expect(m.promoted).toEqual([{ rule: "Use pnpm", projects: ["elsewhere", name].sort() }]);
    expect(m.revisit).toEqual([expect.stringMatching(/Most of the improver's proposals were turned down at the review: 4 of 5/)]);
  });

  it("counts a newer version taken within the pass that offered it, and one only taken a message later", () => {
    const run = createTask(project, { title: "Talk", workflow: "session", startedBy: { by: "chat" } });
    const rec = project.events.recorder(run.id);
    let at = 0;
    const record = (event: Record<string, unknown>): void => rec.record(event as unknown as EngineEvent, ++at);
    // Pass 0: v1 offered at a call and turned down there, taken at the wait for the next message.
    record({ type: "version.declined", instanceId: "root", stateId: "session", version: "session@v1", reason: "not at 'call_0'" });
    record({ type: "instance.entered", instanceId: "in-1", stateId: "session/input", childKey: "input", parentInstanceId: "root" });
    record({ type: "version.adopted", instanceId: "root", stateId: "session", version: "session@v1" });
    record({ type: "operation.completed", instanceId: "in-1", stateId: "session/input" });
    // Pass 1: v2 turned down; the message answers the wait before it is taken.
    record({ type: "version.declined", instanceId: "root", stateId: "session", version: "session@v2", reason: "not at 'call_1'" });
    record({ type: "instance.entered", instanceId: "in-2", stateId: "session/input", childKey: "input", parentInstanceId: "root" });
    record({ type: "operation.completed", instanceId: "in-2", stateId: "session/input" });
    // Pass 2: taken now — a pass late.
    record({ type: "version.adopted", instanceId: "root", stateId: "session", version: "session@v2" });
    // v3: offered and never taken.
    record({ type: "version.declined", instanceId: "root", stateId: "session", version: "session@v3", reason: "its inputs are not this run's" });
    expect(learningMeasures(project).handoffs).toEqual({ offered: 3, adopted: 2, withinPass: 1, neverAdopted: 1, declines: 3 });
  });
});
