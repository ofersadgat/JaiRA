/**
 * The phone is told about a conversation only when it sent the conversation's latest message (the
 * person, 2026-11-26: "if the phone was the input for the last turn, it should get notified. if the
 * desktop was the input, the phone shouldnt get notified").
 */
import { describe, expect, it } from "vitest";
import type { PushMessage } from "@jaira/shared";
import { DeviceAttention, TurnSenders } from "../src/deviceAttention";

/** A conversation `t-chat` with a task `t-child` under it. */
function world() {
  const senders = new TurnSenders();
  const parents: Record<string, string> = { "t-child": "t-chat" };
  const router = new DeviceAttention((_project, taskId) => {
    for (let id: string | undefined = taskId; id !== undefined; id = parents[id]) {
      const deviceId = senders.deviceOf(id);
      if (deviceId !== undefined) return { deviceId, conversationId: id, title: "Fix the picker" };
    }
    return undefined;
  });
  return { senders, router };
}

const input = (taskId: string): PushMessage => ({ type: "interaction:requested", pending: { requestId: `in-${taskId}`, taskId, project: "/p", component: "input", inputs: {} } }) as never;
const question = (taskId: string, extra: Record<string, unknown> = {}): PushMessage =>
  ({ type: "question:requested", pending: { requestId: "q1", taskId, project: "/p", at: 1, questions: [{ question: "Which branch?", options: [] }], ...extra } }) as never;

describe("telling a device", () => {
  it("tells the phone that sent the latest message when its conversation replies", () => {
    const { senders, router } = world();
    senders.fromDevice("t-chat", "phone-1");
    expect(router.route(input("t-chat"))).toEqual({
      deviceId: "phone-1",
      push: { type: "attention:device", kind: "replied", taskId: "t-chat", project: "/p", title: "Fix the picker", body: "Replied. It is waiting for your next message." },
    });
  });

  it("tells nobody once the desktop sent the latest message", () => {
    const { senders, router } = world();
    senders.fromDevice("t-chat", "phone-1");
    senders.fromHere("t-chat");
    expect(router.route(input("t-chat"))).toBeUndefined();
    expect(router.route(question("t-chat"))).toBeUndefined();
  });

  it("tells it of a question asked under the conversation, about the conversation, and takes it back when answered", () => {
    const { senders, router } = world();
    senders.fromDevice("t-chat", "phone-1");
    expect(router.route(question("t-child"))).toMatchObject({ deviceId: "phone-1", push: { kind: "asking", taskId: "t-chat", body: "Which branch?", requestId: "q1" } });
    expect(router.route({ type: "question:resolved", requestId: "q1" })).toMatchObject({ deviceId: "phone-1", push: { kind: "resolved", requestId: "q1" } });
    expect(router.route({ type: "question:resolved", requestId: "q1" })).toBeUndefined();
  });

  it("does not take a task's own wait under the conversation for a reply, nor a recovered ask for news", () => {
    const { senders, router } = world();
    senders.fromDevice("t-chat", "phone-1");
    expect(router.route(input("t-child"))).toBeUndefined();
    expect(router.route(question("t-chat", { recovered: true }))).toBeUndefined();
  });

  it("tells it of a failure, not of a completion", () => {
    const { senders, router } = world();
    senders.fromDevice("t-chat", "phone-1");
    expect(router.route({ type: "run:finished", taskId: "t-child", status: "failed", project: "/p" })).toMatchObject({ push: { kind: "failed", taskId: "t-chat", body: "A task it started failed." } });
    expect(router.route({ type: "run:finished", taskId: "t-child", status: "completed", project: "/p" })).toBeUndefined();
  });
});
