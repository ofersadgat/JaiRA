/**
 * Following a run through the engine's host (`hostRunTask`, decision 0012 §5): its approvals asked at
 * the terminal and answered there, one refused outright under `--approve deny`, a prompt abandoned when
 * another client answers first, unapproved function files approved before a second start, and the
 * report read from the host once `run:finished` arrives.
 */
import { describe, expect, it } from "vitest";
import type { EngineClient } from "@jaira/service";
import type { PushMessage } from "@jaira/shared";
import { hostRunTask, type EngineIo, type HostGate } from "../src/viaEngine";

interface Script {
  /** Called on each `task:start`; throw to refuse. */
  start?: (attempt: number) => void;
  pendingFunctions?: Array<{ file: string; hash: string; source: string }>;
}

function fakeClient(script: Script = {}): { client: EngineClient; calls: Array<[string, unknown]>; push: (m: PushMessage) => void } {
  const calls: Array<[string, unknown]> = [];
  const listeners = new Set<(m: PushMessage) => void>();
  let starts = 0;
  let approved = false;
  const client = {
    host: { kind: "desktop", pid: 1, version: "0.1.0", contract: "x", pipe: "p", home: "h", exe: "e", startedAt: 0 },
    limited: false,
    invoke: async (channel: string, request?: unknown) => {
      calls.push([channel, request]);
      switch (channel) {
        case "project:open":
          return { dir: (request as { dir: string }).dir };
        case "task:start":
          starts += 1;
          script.start?.(starts);
          return { taskId: "t-1" };
        case "functions:pending":
          return approved ? [] : (script.pendingFunctions ?? []);
        case "functions:approve":
          approved = true;
          return { approved: 1 };
        case "task:detail":
          return { runs: [{ outcome: "success", outputs: { ok: true }, startedAt: 0, snapshotHash: "s" }] };
        default:
          return null;
      }
    },
    onPush: (listener: (m: PushMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => undefined,
  } as unknown as EngineClient;
  return { client, calls, push: (m) => listeners.forEach((l) => l(m)) };
}

function io(lines: string[] = []): EngineIo & { err: string; out: string; asked: string[] } {
  const self = {
    err: "",
    out: "",
    asked: [] as string[],
    stdout: (t: string) => void (self.out += t),
    stderr: (t: string) => void (self.err += t),
    ask: (question: string, signal?: AbortSignal) =>
      new Promise<string | undefined>((resolve) => {
        self.asked.push(question);
        const line = lines.shift();
        if (line !== undefined) setTimeout(() => resolve(line), 0);
        else signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
  };
  return self;
}

const ASK: HostGate = { deny: false, nonInteractive: false, approveFunctions: false };
const approval = (requestId: string): PushMessage =>
  ({ type: "approval:requested", pending: { requestId, tool: "Bash", command: "rm -rf build", input: {}, taskId: "t-1", project: "/p", at: 0 } }) as unknown as PushMessage;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("a run followed through the host", () => {
  it("asks each approval at the terminal, answers it, and prints the host's report when the run ends", async () => {
    const { client, calls, push } = fakeClient();
    const terminal = io(["y"]);
    const done = hostRunTask(client, "/p", "t-1", {}, ASK, terminal, async () => false);
    await tick();
    push(approval("a-1"));
    await tick();
    expect(terminal.asked[0]).toContain("rm -rf build");
    expect(calls).toContainEqual(["approval:submit", { requestId: "a-1", decision: "allow" }]);
    push({ type: "run:finished", taskId: "t-1", status: "completed" } as PushMessage);
    expect(await done).toBe(0);
    expect(JSON.parse(terminal.out)).toEqual({ taskId: "t-1", status: "completed", outputs: { ok: true } });
  });

  it("refuses at once under --approve deny, and drops a prompt another client answered first", async () => {
    const denied = fakeClient();
    const quiet = io();
    const run = hostRunTask(denied.client, "/p", "t-1", {}, { ...ASK, deny: true }, quiet, async () => false);
    await tick();
    denied.push(approval("a-2"));
    await tick();
    expect(denied.calls).toContainEqual(["approval:submit", { requestId: "a-2", decision: "deny" }]);
    denied.push({ type: "run:finished", taskId: "t-1", status: "failed" } as PushMessage);
    expect(await run).toBe(1);

    const elsewhere = fakeClient();
    const waiting = io();
    const second = hostRunTask(elsewhere.client, "/p", "t-1", {}, ASK, waiting, async () => false);
    await tick();
    elsewhere.push(approval("a-3"));
    await tick();
    elsewhere.push({ type: "approval:resolved", requestId: "a-3", decision: "allow" } as PushMessage);
    await tick();
    expect(waiting.err).toContain("answered elsewhere");
    expect(elsewhere.calls.some(([channel]) => channel === "approval:submit")).toBe(false);
    elsewhere.push({ type: "run:finished", taskId: "t-1", status: "completed" } as PushMessage);
    expect(await second).toBe(0);
  });

  it("approves the function files a start was refused over, then starts again", async () => {
    const { client, calls, push } = fakeClient({
      pendingFunctions: [{ file: "functions/score.ts", hash: "h", source: "export const score = 1;" }],
      start: (attempt) => {
        if (attempt === 1) throw new Error("functions/score.ts has never been approved");
      },
    });
    const terminal = io();
    const done = hostRunTask(client, "/p", "t-1", {}, ASK, terminal, async (pending) => pending.length === 1);
    await tick();
    expect(calls).toContainEqual(["functions:approve", { files: ["functions/score.ts"], project: "/p" }]);
    expect(calls.filter(([channel]) => channel === "task:start")).toHaveLength(2);
    push({ type: "run:finished", taskId: "t-1", status: "completed" } as PushMessage);
    expect(await done).toBe(0);
  });
});
