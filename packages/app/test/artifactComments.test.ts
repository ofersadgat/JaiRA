/**
 * Comments on a published artifact (decision 0024): a pin on a canvas's artboard, kept beside the
 * versions — never in `canvas.json`, where it would be a person's edit the model's next publish trips
 * over — and, written as a request, sent into the task's conversation as the person's own message.
 *
 * The send is checked at its seam: the conversation a chat task holds is a real one (the shipped chat
 * state, a scripted opening run), and `sendChatMessage` is watched rather than run, since a comment's job
 * ends at handing the conversation the message — what a turn does with it is the chat tests' business.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changesSince, initProject, openProject } from "@jaira/persistence";
import type { PushMessage } from "@jaira/shared";
import { jsonConversation, shippedLayer, testHome } from "@jaira/testing";
import { AppService, commentMessage } from "@jaira/service";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";

let dir: string;
let service: AppService;
let pushes: PushMessage[];

beforeEach(async () => {
  shippedLayer();
  dir = mkdtempSync(join(tmpdir(), "jaira-comments-"));
  // A conversation of one prompt: these are about the chat-turn machinery (see `jsonConversation`).
  jsonConversation(initProject(dir, testHome()).workflowsDir);
  pushes = [];
  service = new AppService({ baseDir: testHome(), watchWorkflows: false, publish: (m) => pushes.push(m) });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A published canvas for `taskId`, written on its own handle, closed again (the service holds the database). */
function publishCanvas(taskId: string): void {
  const project = openProject(dir, { baseDir: testHome() });
  try {
    project.artifacts.publish({
      taskId,
      artifact: "a-1",
      author: "model",
      kind: "canvas",
      type: "design",
      title: "Checkout flow",
      entry: "project/canvas.json",
      changes: { "project/canvas.json": "{}", "project/Checkout.dc.html": "<x-dc></x-dc>" },
      createdAt: 5,
    });
  } finally {
    project.close();
  }
}

const pin = { artifact: "a-1", file: "Checkout.dc.html", x: 120.4, y: 64.6, element: { id: 7, tag: "input", text: "Card number" }, version: 1 };

describe("comments on a published canvas", () => {
  it("are kept beside the versions, listed oldest first, resolved, opened again and taken away", () => {
    publishCanvas("t-1");
    const first = service.commentOnArtifact({ taskId: "t-1", ...pin, text: "  Show the card brand  ", toClaude: false });
    expect(first.failure).toBeUndefined();
    expect(first.comment).toMatchObject({ taskId: "t-1", artifact: "a-1", file: "Checkout.dc.html", x: 120, y: 65, element: pin.element, version: 1, text: "Show the card brand", toClaude: false });
    expect(first.comment.sentAt).toBeUndefined();
    const second = service.commentOnArtifact({ taskId: "t-1", artifact: "a-1", file: "Checkout.dc.html", x: 0, y: 0, version: 1, text: "Tighter", toClaude: false });

    expect(service.artifactComments({ taskId: "t-1", artifact: "a-1" }).map((c) => c.text)).toEqual(["Show the card brand", "Tighter"]);
    // A comment is no version: the canvas is as the model published it.
    expect(service.artifactVersions({ taskId: "t-1", artifact: "a-1" })).toHaveLength(1);

    service.settleComment({ taskId: "t-1", id: first.comment.id, resolved: true });
    expect(service.artifactComments({ taskId: "t-1", artifact: "a-1" })[0]!.resolvedAt).toEqual(expect.any(Number));
    service.settleComment({ taskId: "t-1", id: first.comment.id, resolved: false });
    expect(service.artifactComments({ taskId: "t-1", artifact: "a-1" })[0]!.resolvedAt).toBeUndefined();
    service.settleComment({ taskId: "t-1", id: second.comment.id, removed: true });
    expect(service.artifactComments({ taskId: "t-1", artifact: "a-1" }).map((c) => c.id)).toEqual([first.comment.id]);
  });

  it("reach the person's other devices through the change log, and leave with their task", async () => {
    const { taskId } = service.createTask({ title: "Design", workflow: CHAT_SESSION, inputs: { message: "Design" } });
    publishCanvas(taskId);
    const { comment } = service.commentOnArtifact({ taskId, ...pin, text: "note", toClaude: false });
    const logged = (): boolean => {
      const project = openProject(dir, { baseDir: testHome() });
      try {
        return changesSince(project.db, 0).some((c) => c.collection === "artifactComment" && c.id === comment.id && !c.deleted);
      } finally {
        project.close();
      }
    };
    expect(logged()).toBe(true);
    await service.deleteTask(taskId);
    expect(service.artifactComments({ taskId, artifact: "a-1" })).toEqual([]);
    expect(logged()).toBe(false);
  });

  it("refuses an empty comment, one on no artboard, and one on an artifact that was never published", () => {
    publishCanvas("t-1");
    expect(() => service.commentOnArtifact({ taskId: "t-1", ...pin, text: "   ", toClaude: false })).toThrow(/cannot be empty/);
    expect(() => service.commentOnArtifact({ taskId: "t-1", ...pin, file: "../canvas.json", text: "x", toClaude: false })).toThrow(/not an artboard/);
    expect(() => service.commentOnArtifact({ taskId: "t-1", ...pin, artifact: "a-9", text: "x", toClaude: false })).toThrow(/no artifact a-9/);
    expect(() => service.settleComment({ taskId: "t-1", id: "c-none", resolved: true })).toThrow(/no comment/);
  });

  it("say so, and keep the comment, when sent to Claude from a task that holds no conversation", () => {
    publishCanvas("t-1");
    const answer = service.commentOnArtifact({ taskId: "t-1", ...pin, text: "Bigger", toClaude: true });
    expect(answer.failure).toMatch(/no conversation/);
    expect(service.artifactComments({ taskId: "t-1", artifact: "a-1" }).map((c) => c.text)).toEqual(["Bigger"]);
  });

  it("go into the task's conversation, sent to Claude, naming the canvas, the artboard, the place and the element", async () => {
    const { taskId } = service.createTask({ title: titleOf("Design a checkout"), workflow: CHAT_SESSION, inputs: { message: "Design a checkout" } });
    await service.startTask({ taskId, fake: [{ output: "Here it is." }] });
    const deadline = Date.now() + 8000;
    while (!pushes.some((m) => m.type === "run:finished" && m.taskId === taskId)) {
      if (Date.now() > deadline) throw new Error("the opening run did not finish");
      await new Promise((r) => setTimeout(r, 5));
    }
    publishCanvas(taskId);
    const host = service.chatThread({ taskId })!.instanceId;
    const send = vi.spyOn(service, "sendChatMessage").mockResolvedValue({ instanceId: host, index: 1 } as Awaited<ReturnType<AppService["sendChatMessage"]>>);

    const answer = service.commentOnArtifact({ taskId, ...pin, text: "Show the card brand once 4 digits are in", toClaude: true });

    expect(answer.failure).toBeUndefined();
    expect(answer.comment.sentAt).toEqual(expect.any(Number));
    expect(send).toHaveBeenCalledTimes(1);
    const [request] = send.mock.calls[0]!;
    expect(request).toMatchObject({ taskId, instanceId: host });
    expect(request.message).toBe(commentMessage(answer.comment, "Checkout flow", `artifact://${taskId}/@a-1`));
    expect(request.message).toContain('project/Checkout.dc.html at (120, 65), on the <input> "Card number" there (element 7 at v1)');
    expect(request.message.endsWith("\n\nShow the card brand once 4 digits are in")).toBe(true);
    expect(service.artifactComments({ taskId, artifact: "a-1" })[0]!.sentAt).toBe(answer.comment.sentAt);
  });
});

describe("what Claude reads for a comment", () => {
  const base = { id: "c-1", taskId: "t-1", artifact: "a-1", file: "Main.dc.html", x: 10, y: 20, version: 3, text: "Make it blue", toClaude: true, createdAt: 1 };

  it("names the canvas by its title and address, the artboard and the place", () => {
    expect(commentMessage(base, "Picker", "artifact://t-1/@a-1")).toBe('A comment on the canvas "Picker" (artifact://t-1/@a-1), on the artboard project/Main.dc.html at (10, 20):\n\nMake it blue');
  });

  it("adds the element, with its own words when it has some, and does without a title", () => {
    expect(commentMessage({ ...base, element: { id: 4, tag: "button", text: "Pay" } }, undefined, "artifact://t-1/@a-1")).toBe(
      'A comment on the canvas artifact://t-1/@a-1, on the artboard project/Main.dc.html at (10, 20), on the <button> "Pay" there (element 4 at v3):\n\nMake it blue',
    );
    expect(commentMessage({ ...base, element: { id: 2, tag: "div" } }, "Picker", "u")).toContain("on the <div> there (element 2 at v3)");
  });
});
