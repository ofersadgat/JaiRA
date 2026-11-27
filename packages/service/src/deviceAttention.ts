/**
 * What a phone is told while its app is in the background (the person, 2026-11-26: the phone is
 * notified "only if the phone is the thing that queued the session. i.e. if the phone was the input for
 * the last turn, it should get notified. if the desktop was the input, the phone shouldnt").
 *
 * The engine remembers which paired device sent each conversation's latest message (`TurnSenders`):
 * a message from a device marks it, one from anyone else — the desktop's window, a command — clears it.
 * A push about the conversation, or about a task under it (an approval its agent wants, a question, a
 * failure), is then sent to that device alone as `attention:device`, and the phone's app shows it as a
 * local notification while it is alive. Nothing leaves the machine but to that device.
 */
import type { PushMessage } from "@jaira/shared";

/** Who sent each conversation's latest message, when it was a paired device. In memory: news, not record. */
export class TurnSenders {
  private readonly senders = new Map<string, string>();

  /** The person wrote here, from this machine (or anything that is not a paired device). */
  fromHere(taskId: string): void {
    this.senders.delete(taskId);
  }

  /** A paired device wrote the conversation's latest message. */
  fromDevice(taskId: string, deviceId: string): void {
    this.senders.set(taskId, deviceId);
  }

  deviceOf(taskId: string): string | undefined {
    return this.senders.get(taskId);
  }

  get empty(): boolean {
    return this.senders.size === 0;
  }
}

/** The device that sent the latest message of the conversation a task is in, and that conversation. */
export interface DeviceTarget {
  deviceId: string;
  conversationId: string;
  title: string;
}

export type DeviceAttentionPush = Extract<PushMessage, { type: "attention:device" }>;

/** A conversation's wait for its next message (the engine's `INPUT_FUNCTION`). */
const INPUT_COMPONENT = "input";

/**
 * Turns the engine's pushes into what one device is told. `targetOf` finds the device for a task (its
 * own or an ancestor conversation's latest sender); asks are remembered by request so their answer —
 * from anywhere — takes the notification back.
 */
export class DeviceAttention {
  private readonly asked = new Map<string, { deviceId: string; conversationId: string; project?: string }>();

  constructor(private readonly targetOf: (project: string | undefined, taskId: string) => DeviceTarget | undefined) {}

  route(message: PushMessage): { deviceId: string; push: DeviceAttentionPush } | undefined {
    switch (message.type) {
      case "question:requested": {
        const p = message.pending;
        if (p.recovered === true || p.taskId === undefined) return undefined;
        return this.ask(p.requestId, p.project, p.taskId, "asking", p.questions[0]?.question ?? "It has a question for you.");
      }
      case "approval:requested": {
        const p = message.pending;
        if (p.recovered === true || p.taskId === undefined) return undefined;
        return this.ask(p.requestId, p.project, p.taskId, "asking", `It wants to use ${p.tool}${p.command !== undefined ? `: ${p.command}` : ""}`);
      }
      case "interaction:requested": {
        const p = message.pending;
        if (p.offline !== undefined) return undefined;
        if (p.component === INPUT_COMPONENT) {
          const target = this.targetOf(p.project, p.taskId);
          // Its own wait, not a task's under it: the conversation answered the device's message.
          if (target === undefined || target.conversationId !== p.taskId) return undefined;
          return { deviceId: target.deviceId, push: { type: "attention:device", kind: "replied", taskId: target.conversationId, project: p.project, title: target.title, body: "Replied. It is waiting for your next message." } };
        }
        return this.ask(p.requestId, p.project, p.taskId, "asking", `It needs your input (${p.component}).`);
      }
      case "question:resolved":
      case "approval:resolved":
      case "interaction:resolved": {
        const was = this.asked.get(message.requestId);
        if (was === undefined) return undefined;
        this.asked.delete(message.requestId);
        return { deviceId: was.deviceId, push: { type: "attention:device", kind: "resolved", taskId: was.conversationId, ...(was.project !== undefined ? { project: was.project } : {}), title: "", body: "", requestId: message.requestId } };
      }
      case "run:finished": {
        if (message.status !== "failed") return undefined;
        const target = this.targetOf(message.project, message.taskId);
        if (target === undefined) return undefined;
        const own = target.conversationId === message.taskId;
        return {
          deviceId: target.deviceId,
          push: { type: "attention:device", kind: "failed", taskId: target.conversationId, ...(message.project !== undefined ? { project: message.project } : {}), title: target.title, body: own ? "It failed." : "A task it started failed." },
        };
      }
      default:
        return undefined;
    }
  }

  private ask(requestId: string, project: string, taskId: string, kind: "asking", body: string): { deviceId: string; push: DeviceAttentionPush } | undefined {
    const target = this.targetOf(project, taskId);
    if (target === undefined) return undefined;
    this.asked.set(requestId, { deviceId: target.deviceId, conversationId: target.conversationId, project });
    return { deviceId: target.deviceId, push: { type: "attention:device", kind, taskId: target.conversationId, project, title: target.title, body: clip(body), requestId } };
  }
}

function clip(text: string, max = 180): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}
