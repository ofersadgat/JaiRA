/**
 * The subagents the agent's stream never carries, read off their own files while they run.
 *
 * ✅ OBSERVED (claude 2.1.287, 2026-11-12): the stream carries a subagent's turns, tagged with the
 * call that spawned it, only for an agent the MAIN thread started. An agent a subagent starts
 * (`spawn_depth` 2 and deeper) never streams a message. It shows as a `task_started` event, one
 * `task_progress` per tool it uses, and a `task_notification` when it ends. Its whole conversation is
 * written as it goes to `<project folder>/<session>/subagents/agent-<task_id>.jsonl`, the file the
 * close's capture reads.
 *
 * So a conversation whose main thread handed its work to a background agent, which handed it on to
 * one that does it, showed none of that work while it ran: no calls, and the approvals those calls
 * asked for loose in the main thread, because the call that asked was nowhere to be found (t-wdxyhs1w6w,
 * 2026-11-12: "I see 95 notes, a deny by in built rules, and two approves, but none of the tools that
 * were run including the ones i was asked permission about").
 *
 * This follows each such agent's file from the `task_started` that names it to the
 * `task_notification` that ends it, and hands every finished turn on as the stream would have: a
 * `message` entry tagged with the spawning call, which is how a streamed subagent's turn arrives.
 * Everything downstream (the live log's chains, the doorway, an approval's caller) is the path a
 * streamed subagent already takes.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectsDir, encodeSessionCwd } from "@declarative-ai/agents-api";
import type { JsonValue } from "@declarative-ai/json";

/** How often a followed file is looked at. A finished turn shows within this; an approval reads at once (`readNow`). */
const POLL_MS = 500;

/** What a followed file hands on: one message entry, as the stream would have sent it. */
export type ChainFeed = (entry: JsonValue) => void;

interface Followed {
  path: string;
  /** The call that spawned the agent: the chain its turns go on. */
  call: string;
  feed: ChainFeed;
  /** Bytes read so far. A partial last line waits for its newline. */
  offset: number;
  rest: string;
  /** The first line is the agent's prompt, which the spawning call already shows. */
  seenFirst: boolean;
}

/** The raw provider line a stream event entry carries, when it is one: `{kind:"event", event:{type:"provider_event", payload}}`. */
function providerLineOf(entry: JsonValue | undefined): Record<string, unknown> | undefined {
  const rec = entry as { kind?: unknown; event?: { type?: unknown; payload?: unknown } } | null | undefined;
  if (rec === null || rec === undefined || typeof rec !== "object" || rec.kind !== "event") return undefined;
  const event = rec.event;
  if (event === null || typeof event !== "object") return undefined;
  const line = event.type === "provider_event" ? event.payload : event;
  return line !== null && typeof line === "object" && !Array.isArray(line) ? (line as Record<string, unknown>) : undefined;
}

/**
 * A `task_started` for an agent whose turns the stream will not carry: a subagent's own subagent.
 * `spawn_depth` 1 is an agent the main thread started, and its turns stream.
 */
export function unstreamedAgentOf(entry: JsonValue | undefined): { agentId: string; call: string } | undefined {
  const line = providerLineOf(entry);
  if (line === undefined || line["type"] !== "system" || line["subtype"] !== "task_started") return undefined;
  const depth = line["spawn_depth"];
  if (typeof depth !== "number" || depth < 2) return undefined;
  const agentId = line["task_id"];
  const call = line["tool_use_id"];
  if (typeof agentId !== "string" || typeof call !== "string" || !/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
  return { agentId, call };
}

/** The agent a `task_notification` says has ended. */
function endedAgentOf(entry: JsonValue | undefined): string | undefined {
  const line = providerLineOf(entry);
  if (line === undefined || line["type"] !== "system" || line["subtype"] !== "task_notification") return undefined;
  return typeof line["task_id"] === "string" ? line["task_id"] : undefined;
}

/**
 * A file line as the entry the stream would have sent, or `undefined` for a line that is not a turn.
 * The stream's message entry holds the provider's whole message object as `content`.
 */
export function chainEntryOf(line: unknown, call: string): JsonValue | undefined {
  if (line === null || typeof line !== "object" || Array.isArray(line)) return undefined;
  const rec = line as Record<string, unknown>;
  if (rec["type"] !== "user" && rec["type"] !== "assistant") return undefined;
  const message = rec["message"];
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const role = typeof (message as { role?: unknown }).role === "string" ? (message as { role: string }).role : (rec["type"] as string);
  return { kind: "message", role, content: message as JsonValue, parentToolUseId: call } as JsonValue;
}

/** One task's followed files. */
export class UnstreamedChains {
  private readonly byTask = new Map<string, Map<string, Followed>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly projectsDir: () => string = () => claudeProjectsDir()) {}

  /**
   * Hear one streamed entry of a task's run. A `task_started` for an agent the stream will not carry
   * starts following its file; a `task_notification` reads it to its end and stops.
   */
  heard(taskId: string, entry: JsonValue | undefined, where: { cwd: string; providerSessionId?: string | undefined }, feed: ChainFeed): void {
    const started = unstreamedAgentOf(entry);
    if (started !== undefined) {
      const sessionId = (providerLineOf(entry)?.["session_id"] as string | undefined) ?? where.providerSessionId;
      if (sessionId === undefined || /[/\\]|\.\./.test(sessionId)) return;
      const path = join(this.projectsDir(), encodeSessionCwd(where.cwd), sessionId, "subagents", `agent-${started.agentId}.jsonl`);
      const mine = this.byTask.get(taskId) ?? new Map<string, Followed>();
      if (!mine.has(started.agentId)) mine.set(started.agentId, { path, call: started.call, feed, offset: 0, rest: "", seenFirst: false });
      this.byTask.set(taskId, mine);
      if (!this.timers.has(taskId)) {
        const timer = setInterval(() => this.readNow(taskId), POLL_MS);
        (timer as { unref?: () => void }).unref?.();
        this.timers.set(taskId, timer);
      }
      return;
    }
    const ended = endedAgentOf(entry);
    if (ended === undefined) return;
    const mine = this.byTask.get(taskId);
    const followed = mine?.get(ended);
    if (followed === undefined) return;
    this.read(followed);
    mine!.delete(ended);
    if (mine!.size === 0) this.stop(taskId);
  }

  /**
   * Read every followed file of a task to where it ends now. Asked on a timer, and at once before an
   * approval or a check is put down, so the call that asked is in its chain to be found.
   */
  readNow(taskId: string): void {
    for (const followed of this.byTask.get(taskId)?.values() ?? []) this.read(followed);
  }

  /**
   * Stop following a task's files: its turn or run is over. Not read first: what the live turn held is
   * the record's now, and the close's capture reads the same files whole.
   */
  stop(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(taskId);
    this.byTask.delete(taskId);
  }

  /** Whether any file of the task is being followed. */
  following(taskId: string): boolean {
    return (this.byTask.get(taskId)?.size ?? 0) > 0;
  }

  private read(followed: Followed): void {
    let size: number;
    try {
      size = statSync(followed.path).size;
    } catch {
      return; // not written yet: the agent has said nothing so far
    }
    if (size <= followed.offset) return;
    let text: string;
    try {
      const fd = openSync(followed.path, "r");
      try {
        const buffer = Buffer.alloc(size - followed.offset);
        const got = readSync(fd, buffer, 0, buffer.length, followed.offset);
        followed.offset += got;
        text = followed.rest + buffer.subarray(0, got).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    const lines = text.split("\n");
    // The last piece has no newline yet: the agent is still writing it.
    followed.rest = lines.pop() ?? "";
    for (const raw of lines) {
      if (raw.trim().length === 0) continue;
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      const first = !followed.seenFirst;
      followed.seenFirst = true;
      // The prompt: the spawning call's input already holds it, and a streamed chain never carries it.
      if (first && (line as { type?: unknown }).type === "user" && typeof (line as { message?: { content?: unknown } }).message?.content === "string") continue;
      const entry = chainEntryOf(line, followed.call);
      if (entry === undefined) continue;
      try {
        followed.feed(entry);
      } catch {
        // A feed that throws costs one turn, not the file.
      }
    }
  }
}
