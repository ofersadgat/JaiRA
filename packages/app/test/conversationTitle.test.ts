/**
 * A conversation is named by the engine while its first turn runs (`titleConversation`), because the
 * agent never names it: Claude Code writes no `ai-title` into a headless session, so the window's
 * wait for one (`agentTitleOf`) never ended for any conversation JaiRA started.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { shippedLayer, testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-title-"));
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

const MESSAGE = "I want to be able to open artifacts in a side panel as well. Please mock 16 designs for how to do this";
/** The title model's answer, then the run's own reply for everything else. */
const NAMED = [{ model: "simple", output: { title: "Side panel for artifacts" } }, { output: "first answer" }];

const titleOfTask = (taskId: string): string | undefined => service.listTasks().find((t) => t.taskId === taskId)?.title;

/** Create the conversation the way the Chat view does — named after its first line — and run it. */
async function started(fake: unknown[], title = titleOf(MESSAGE)): Promise<string> {
  const { taskId } = service.createTask({ title, workflow: CHAT_SESSION, inputs: { message: MESSAGE }, conversation: true });
  await service.startTask({ taskId, fake: fake as never });
  await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the opening run to finish");
  return taskId;
}

describe("a conversation's name", () => {
  it("is the model's, once its first turn is under way", async () => {
    const taskId = await started(NAMED);
    await until(() => titleOfTask(taskId) === "Side panel for artifacts", "the conversation to be named");
    // The window hears it the way it hears a rename: the lists are read again.
    expect(pushes.some((m) => m.type === "store:invalidate" && m.scope === "tasks")).toBe(true);
  });

  it("is left alone when a person named it", async () => {
    const taskId = await started(NAMED, "My own name");
    await new Promise((r) => setTimeout(r, 100));
    expect(titleOfTask(taskId)).toBe("My own name");
  });

  it("stays the birth name when the call has no answer — a script that never names the title model", async () => {
    const taskId = await started([{ output: "first answer" }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(titleOfTask(taskId)).toBe(titleOf(MESSAGE));
  });

  it("stays the birth name when the call fails", async () => {
    const taskId = await started([{ model: "simple", error: "no model" }, { output: "first answer" }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(titleOfTask(taskId)).toBe(titleOf(MESSAGE));
  });

  it("is not asked for a task that is not a conversation", async () => {
    const { taskId } = service.createTask({ title: titleOf(MESSAGE), workflow: CHAT_SESSION, inputs: { message: MESSAGE } });
    await service.startTask({ taskId, fake: NAMED as never });
    await until(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
    await new Promise((r) => setTimeout(r, 100));
    expect(titleOfTask(taskId)).toBe(titleOf(MESSAGE));
  });
});
