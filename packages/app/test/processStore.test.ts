/**
 * The window's copy of the engine's processes (decision 0032, "The view"): a task's processes, what a
 * tool call started, the process a terminal is, read once and kept by the pushes; a tree's kept
 * processes known as well; "Tell Claude when it prints…" armed and cancelled through it.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProcessSummary, PushMessage } from "@jaira/shared";
import { ProcessStore } from "../src/renderer/processStore";

function p(key: string, over: Partial<ProcessSummary> = {}): ProcessSummary {
  const pid = Number(key.split("@")[0]);
  return { key, processTaskId: `t-p${pid}-1`, taskId: "t1", machine: "m", pid, startedAt: 1, command: "x", name: "x", origin: "background", startedBy: "session", state: "running", states: [], ports: [], load: [], output: { source: "spawned" }, ...over };
}

function storeWith(answers: Record<string, (request: unknown) => unknown>): { store: ProcessStore; asked: Array<[string, unknown]>; push: (m: PushMessage) => void } {
  const asked: Array<[string, unknown]> = [];
  let listener: ((m: PushMessage) => void) | undefined;
  const store = new ProcessStore({
    invoke: (async (channel: string, request: unknown) => {
      asked.push([channel, request]);
      return answers[channel]?.(request);
    }) as never,
    subscribe: ((fn: (m: PushMessage) => void) => {
      listener = fn;
      return () => undefined;
    }) as never,
  });
  return { store, asked, push: (m) => listener?.(m) };
}

describe("the window's processes", () => {
  it("reads a task's processes once, and finds a call's and a terminal's among them", async () => {
    const bg = p("10@1", { callId: "c1", terminal: "c1" });
    const left = p("11@1", { callId: "c2", origin: "left" });
    const ended = p("12@1", { callId: "c3", state: "exited", endedAt: 5 });
    const { store, asked } = storeWith({ "process:list": () => ({ processes: [ended, bg, left] }) });
    store.ensureSession("t1", "proj");
    store.ensureSession("t1", "proj");
    await vi.waitFor(() => expect(store.ofSession("t1")).toHaveLength(3));
    expect(asked.filter(([c]) => c === "process:list")).toEqual([["process:list", { scope: "session", taskId: "t1", project: "proj" }]]);
    // Live first, then the newest.
    expect(store.ofSession("t1").map((x) => x.key).at(-1)).toBe("12@1");
    expect(store.ofCall("t1", "c2").map((x) => x.key)).toEqual(["11@1"]);
    expect(store.ofTerminal("t1", "c1")?.key).toBe("10@1");
    expect(store.ofTerminal("t1", "c2")).toBeUndefined();
  });

  it("knows a tree's kept processes, and a watched one by its pid", async () => {
    const watched = p("50@1", { origin: "watched", taskId: undefined });
    const child = p("51@1", { processTaskId: undefined, origin: undefined, taskId: undefined });
    const { store } = storeWith({ "process:tree": () => [{ process: watched, children: [{ process: child, children: [] }] }] });
    const nodes = await store.tree({ scope: "user" });
    expect(nodes).toHaveLength(1);
    expect(store.get("50@1")).toBeDefined();
    expect(store.get("51@1")).toBeUndefined();
    expect(store.watchedAt(50)?.key).toBe("50@1");
  });

  it("arms and cancels Tell Claude, keeping what the engine answered", async () => {
    const armed = p("10@1", { tellWhen: { pattern: "ready", armedAt: 1 } });
    const { store, asked } = storeWith({ "process:tellWhen": () => armed, "process:tellCancel": () => p("10@1") });
    await store.tellWhen("10@1", "ready", "proj");
    expect(store.get("10@1")?.tellWhen?.pattern).toBe("ready");
    await store.tellCancel("10@1", "proj");
    expect(store.get("10@1")?.tellWhen).toBeUndefined();
    expect(asked.map(([c]) => c)).toEqual(["process:tellWhen", "process:tellCancel"]);
  });
});
