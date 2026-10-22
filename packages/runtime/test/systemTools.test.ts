/**
 * The System tools (decision 0019) over a machine that is not this one: what is the same on every
 * operating system — JaiRA's own processes, what `open_app` will not open, a picture's coordinates,
 * the person's Stop, the tools that always ask. `systemWindows.test.ts` runs them on Windows itself.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/exec";
import { TOOL_IMAGES } from "@declarative-ai/json";
import { parsePermissionSet } from "@jaira/shared";
import { compilePolicy } from "../src/policy";
import { createSystemTools, inputStepOf, protectedProcesses, registerSystemTools, treeOf, type DrivingEvent } from "../src/systemTools";
import { gateTools } from "../src/tools";
import type { InputStep, ProcessRow, SystemBackend } from "../src/system/types";
import { newRegistry } from "../src/wiring";

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 12, minute)).toISOString();

/** explorer → JaiRA (the app) → node (the engine, 100) → claude.cmd shim → claude; a tool the agent ran; a stranger. */
const ROWS: ProcessRow[] = [
  { pid: 4, name: "System" },
  { pid: 10, name: "explorer", started: at(0) },
  { pid: 20, parent_pid: 10, name: "JaiRA", started: at(1) },
  { pid: 21, parent_pid: 20, name: "JaiRA", started: at(1) },
  { pid: 100, parent_pid: 20, name: "node", started: at(2) },
  { pid: 110, parent_pid: 100, name: "cmd", started: at(3) },
  { pid: 111, parent_pid: 110, name: "claude", started: at(3) },
  { pid: 112, parent_pid: 111, name: "npm", started: at(4) },
  { pid: 113, parent_pid: 112, name: "node", started: at(4) },
  { pid: 300, name: "notepad", started: at(5) },
  { pid: 301, name: "lsass", started: at(0) },
  // Its parent pid says the engine, but it started before the engine did: the number was reused.
  { pid: 400, parent_pid: 100, name: "stranger", started: at(1) },
  // A launcher nobody protects, which started another of the app's processes.
  { pid: 600, name: "launcher", started: at(0) },
  { pid: 601, parent_pid: 600, name: "JaiRA", started: at(1) },
];

/** A machine that records what it was asked, and answers from ROWS. */
function fakeMachine(): SystemBackend & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const note = <T>(name: string, args: unknown, answer: T): Promise<T> => {
    calls.push([name, args]);
    return Promise.resolve(answer);
  };
  return {
    os: "windows",
    calls,
    readSystem: (about, log) => note("readSystem", { about, log }, { os: { name: "Windows 11 Pro" } } as JsonValue),
    power: (action, delay) => note("power", { action, delay }, { done: action }),
    processes: () => note("processes", null, ROWS),
    stopProcess: (pid, options) => note("stopProcess", { pid, ...options }, { stopped: true, how: "terminated" }),
    services: () => note("services", null, [{ name: "Spooler", status: "running" as const }, { name: "wuauserv", status: "stopped" as const }]),
    controlService: (name, action) => note("controlService", { name, action }, { name, status: "running" as const }),
    software: (kind) => note("software", kind, []),
    installSoftware: (request) => note("installSoftware", request, { exit_code: 0, output: "ok" }),
    readSettings: (request) => note("readSettings", request, {}),
    writeSettings: (request) => note("writeSettings", request, {}),
    readClipboard: () => note("readClipboard", null, { text: "hello", image: { png: new Uint8Array([1, 2, 3]), width: 2, height: 1 } }),
    writeClipboard: (write) => note("writeClipboard", write, undefined),
    windows: () => note("windows", null, [{ window_id: 7, title: "JaiRA", app: "JaiRA", pid: 21, focused: true, minimized: false, bounds: { x: 0, y: 0, width: 10, height: 10 } }]),
    openApp: (request) => note("openApp", request, { ok: true }),
    // A 3840×2160 screen at (1000, 0), handed over scaled to 1568×882.
    screenshot: (request) => note("screenshot", request, { png: new Uint8Array([9, 9]), width: 1568, height: 882, region: { x: 1000, y: 0, width: 3840, height: 2160 } }),
    input: (steps, guarded, signal) =>
      new Promise((resolve, reject) => {
        calls.push(["input", { steps, guarded }]);
        if (signal?.aborted === true) return reject(new Error("stopped by the person"));
        signal?.addEventListener("abort", () => reject(new Error("stopped by the person")));
        if (!(steps as InputStep[]).some((s) => s.action === "wait")) resolve({ cursor: { x: 1000 + 3840 / 2, y: 1080 } });
      }),
  };
}

const run = async (tools: ReturnType<typeof createSystemTools>, name: string, input: Record<string, unknown>, session = "s1"): Promise<Record<string, unknown>> =>
  (await tools[name]!.run(input as never, { session: { id: session } } as never)) as Record<string, unknown>;

describe("JaiRA's own processes", () => {
  const kept = protectedProcesses(ROWS, 100);

  it("are the engine, what it runs inside, what it started, and the agents under it", () => {
    expect(kept.get(100)).toMatch(/engine/);
    expect(kept.get(20)).toMatch(/runs inside it/);
    expect(kept.get(10)).toMatch(/runs inside it/);
    expect(kept.get(110)).toMatch(/started it/);
    expect(kept.get(111)).toMatch(/agent/);
    // The app's other processes, by its own program's name.
    expect(kept.get(21)).toMatch(/part of the JaiRA app/);
  });

  it("are not what an agent started, nor a stranger whose parent pid was reused", () => {
    expect(kept.has(112)).toBe(false);
    expect(kept.has(113)).toBe(false);
    expect(kept.has(400)).toBe(false);
    expect(kept.has(300)).toBe(false);
  });

  it("include what the operating system needs", () => {
    expect(kept.get(4)).toMatch(/operating system/);
    expect(kept.get(301)).toMatch(/operating system/);
  });

  it("are reached by a tree stop of what contains them", () => {
    expect(treeOf(ROWS, 110).sort()).toEqual([110, 111, 112, 113]);
    expect(treeOf(ROWS, 100)).not.toContain(400);
  });
});

describe("stop_process and list_processes", () => {
  it("refuse JaiRA's own, and a tree that holds one", async () => {
    const machine = fakeMachine();
    const tools = createSystemTools({ backend: machine, enginePid: 100 });
    expect((await run(tools, "stop_process", { pid: 100 }))["error"]).toMatch(/refused: node \(100\) — it is JaiRA's engine/);
    expect((await run(tools, "stop_process", { pid: 110 }))["error"]).toMatch(/refused: cmd \(110\) — JaiRA started it/);
    expect((await run(tools, "stop_process", { pid: 600, tree: true }))["error"]).toMatch(/would stop JaiRA \(601\) — it is part of the JaiRA app/);
    expect(machine.calls.some(([name]) => name === "stopProcess")).toBe(false);
  });

  it("stop what an agent started, as the one listed", async () => {
    const machine = fakeMachine();
    const tools = createSystemTools({ backend: machine, enginePid: 100 });
    expect(await run(tools, "stop_process", { pid: 112, tree: true })).toMatchObject({ pid: 112, stopped: true, processes: 2 });
    expect(machine.calls.find(([name]) => name === "stopProcess")?.[1]).toEqual({ pid: 112, started: at(4), tree: true, force: false });
  });

  it("say which are protected, and why, in the list", async () => {
    const tools = createSystemTools({ backend: fakeMachine(), enginePid: 100 });
    const listed = (await run(tools, "list_processes", { name: "node", sort: "pid" }))["processes"] as Array<{ pid: number; protected?: string }>;
    expect(listed.map((row) => [row.pid, row.protected !== undefined])).toEqual([
      [100, true],
      [113, false],
    ]);
  });
});

describe("open_app runs nothing the shell should judge", () => {
  const tools = createSystemTools({ backend: fakeMachine(), enginePid: 100, cwd: "C:/work" });

  it.each([
    [{ action: "launch", app: "cmd" }, /runs code it is handed/],
    [{ action: "launch", app: "powershell.exe" }, /runs code it is handed/],
    [{ action: "launch", app: "python" }, /runs code it is handed/],
    [{ action: "launch", app: "taskkill" }, /is a command/],
    [{ action: "open", target: "deploy.ps1" }, /would run as a program/],
    [{ action: "open", target: "setup.exe" }, /would run as a program/],
    [{ action: "open", target: "search-ms:query=x" }, /a link to another program/],
    [{ action: "open", target: ".jaira/system/x.txt" }, /engine's own/],
  ])("%j", async (input, why) => {
    expect((await run(tools, "open_app", input))["error"]).toMatch(why);
  });

  it("opens a document, a web link and a settings page, and launches an app", async () => {
    const machine = fakeMachine();
    const open = createSystemTools({ backend: machine, enginePid: 100, cwd: "C:/work" });
    await run(open, "open_app", { action: "open", target: "report.pdf" });
    await run(open, "open_app", { action: "open", target: "https://example.com" });
    await run(open, "open_app", { action: "open", target: "ms-settings:display" });
    await run(open, "open_app", { action: "launch", app: "notepad" });
    expect(machine.calls.filter(([name]) => name === "openApp").map(([, args]) => args)).toEqual([
      { action: "open", target: expect.stringMatching(/[\\/]work[\\/]report\.pdf$/) },
      { action: "open", target: "https://example.com" },
      { action: "open", target: "ms-settings:display" },
      { action: "launch", app: "notepad" },
    ]);
  });

  it("does not close JaiRA's own window", async () => {
    expect((await run(tools, "open_app", { action: "close", window_id: 7 }))["error"]).toMatch(/JaiRA's own window/);
  });
});

describe("screenshot and control_input", () => {
  it("keeps the picture with the task and hands it to the model as an image", async () => {
    const saved: Array<[string, number]> = [];
    const tools = createSystemTools({
      backend: fakeMachine(),
      enginePid: 100,
      keep: () => ({ save: (logical, bytes) => (saved.push([logical, bytes.length]), { path: logical, file: `C:/central/${logical}`, bytes: bytes.length }) }),
    });
    const shot = await run(tools, "screenshot", {});
    expect(shot).toMatchObject({ width: 1568, height: 882, scaled_from: { width: 3840, height: 2160 }, path: expect.stringMatching(/^system\/screenshot-.*\.png$/) });
    expect(shot[TOOL_IMAGES]).toEqual([{ mimeType: "image/png", data: Buffer.from([9, 9]).toString("base64") }]);
    expect(saved).toEqual([[shot["path"], 2]]);
  });

  it("refuses a coordinate before a screenshot, and maps the picture's onto the screen after", async () => {
    const machine = fakeMachine();
    const tools = createSystemTools({ backend: machine, enginePid: 100 });
    expect((await run(tools, "control_input", { steps: [{ action: "left_click", x: 10, y: 10 }] }))["error"]).toMatch(/take a screenshot first/);
    await run(tools, "screenshot", {});
    const done = await run(tools, "control_input", { steps: [{ action: "left_click", x: 784, y: 441 }, { action: "type", text: "hi" }] });
    const input = machine.calls.find(([name]) => name === "input")![1] as { steps: InputStep[]; guarded: number[] };
    // The picture's middle is the screen's middle, on a display that starts at x 1000.
    expect(input.steps).toEqual([{ action: "left_click", x: 2920, y: 1080 }, { action: "type", text: "hi" }]);
    // JaiRA's own windows are named to the input, which refuses them step by step.
    expect(input.guarded).toEqual(expect.arrayContaining([100, 20, 21, 111]));
    // And the pointer comes back in the picture's coordinates.
    expect(done).toEqual({ done: 2, cursor: { x: 784, y: 441 } });
    // A conversation's picture is its own.
    expect((await run(tools, "control_input", { steps: [{ action: "mouse_move", x: 1, y: 1 }] }, "other"))["error"]).toMatch(/take a screenshot first/);
  });

  it("tells the app while it drives, and the person's Stop ends the call and keeps it off until allowed", async () => {
    const events: DrivingEvent[] = [];
    let stopped: string | undefined;
    const tools = createSystemTools({ backend: fakeMachine(), enginePid: 100, onDriving: (event) => events.push(event), mayDrive: () => stopped });
    await run(tools, "screenshot", {});
    const driving = run(tools, "control_input", { steps: [{ action: "wait", seconds: 5 }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.map((e) => e.active)).toEqual([true]);
    events[0]!.stop!();
    stopped = "the person stopped you";
    expect((await driving)["error"]).toMatch(/stopped by the person/);
    expect(events.map((e) => e.active)).toEqual([true, false]);
    expect((await run(tools, "control_input", { steps: [{ action: "cursor_position" }] }))["error"]).toBe("the person stopped you");
  });

  it("reads each step as the computer-use action set writes it", () => {
    const geo = { x: 0, y: 0, width: 200, height: 100, width_px: 100, height_px: 50 };
    expect(inputStepOf({ action: "scroll", x: 10, y: 10, direction: "down", amount: 2 }, 0, geo)).toEqual({ action: "scroll", x: 20, y: 20, direction: "down", amount: 2 });
    expect(inputStepOf({ action: "key", keys: "ctrl+s" }, 0, undefined)).toEqual({ action: "key", keys: "ctrl+s" });
    expect(inputStepOf({ action: "left_click_drag", from: { x: 0, y: 0 }, x: 50, y: 25 }, 0, geo)).toEqual({ action: "left_click_drag", from: { x: 0, y: 0 }, x: 100, y: 50 });
    expect(() => inputStepOf({ action: "left_click", x: 101, y: 0 }, 2, geo)).toThrow(/step 3: \(101, 0\) is outside the last screenshot/);
    expect(() => inputStepOf({ action: "fly" }, 0, geo)).toThrow(/'fly' is not an action/);
  });
});

describe("where no System tool is built", () => {
  it("says so, rather than failing some other way", async () => {
    const tools = createSystemTools({ backend: null });
    expect((await run(tools, "list_processes", {}))["error"]).toMatch(/built for Windows and macOS; this machine runs/);
  });
});

describe("the tools that always ask (decision 0019 §6)", () => {
  const gated = (set: Record<string, unknown>, builtins = true) => {
    const registry = newRegistry();
    registerSystemTools(registry, { backend: fakeMachine(), enginePid: 100 });
    const asked: string[] = [];
    const permissionSet = parsePermissionSet(set).permissionSet;
    const { tools } = gateTools({
      registry,
      names: Object.keys(set).filter((k) => k !== "other"),
      sessionId: "s",
      permissionSet,
      policy: compilePolicy(builtins ? {} : { builtins: false }, { permissionSet }),
      approve: (req) => (asked.push(req.tool), { decision: "deny", scope: "once" }),
    });
    return { tools, asked };
  };

  it("asks before `power` and `install_software` even where the set allows them", async () => {
    const { tools, asked } = gated({ power: "allow", install_software: "allow", list_processes: "allow", other: "deny" });
    await Promise.resolve(tools["power"]!.run({ action: "lock" } as never, {} as never)).catch(() => undefined);
    await Promise.resolve(tools["install_software"]!.run({ action: "install", id: "jqlang.jq" } as never, {} as never)).catch(() => undefined);
    await tools["list_processes"]!.run({} as never, {} as never);
    expect(asked).toEqual(["power", "install_software"]);
  });

  it("does not, with the built-ins switched off", async () => {
    const { tools, asked } = gated({ power: "allow", other: "deny" }, false);
    await tools["power"]!.run({ action: "lock" } as never, {} as never);
    expect(asked).toEqual([]);
  });
});
