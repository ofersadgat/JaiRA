/**
 * The System tools (decision 0019): the machine the engine runs on and its desktop, each area a LOOK and a
 * CHANGE — `read_system`/`power`, `list_processes`/`stop_process`, `list_services`/`control_service`,
 * `list_software`/`install_software`, `read_settings`/`write_settings`, `read_clipboard`/`write_clipboard`,
 * `list_windows`/`open_app`, `screenshot`/`control_input`.
 *
 * What a tool does on one operating system is its backend's (`system/windows.ts`, `system/macos.ts`);
 * what is the same everywhere is here:
 *
 *  - **JaiRA's own processes are not the agent's.** `stop_process` refuses the engine, the app around it
 *    and the agents it runs ({@link protectedProcesses}), and the parts of the operating system that
 *    take the machine down with them; `control_input` refuses to click or type into JaiRA's own window,
 *    where a click could answer the agent's own approval.
 *  - **What runs is the shell's.** `open_app` launches an app or opens a file in its app; it does not
 *    start an interpreter, and it does not open a file that would run as a program — that is `script`,
 *    judged on the shell's line.
 *  - **A picture is kept with the task.** `screenshot` (and an image on the clipboard) is saved as one of
 *    the task's files and handed to the model as an image ({@link TOOL_IMAGES}); `control_input`'s
 *    coordinates are that picture's, mapped back onto the screen.
 *  - **Bounded.** Lists are cut to a `limit`, text to a length, waits to a ceiling.
 *
 * The tools act on the machine the ENGINE runs on, whatever the project's shell: a WSL project's agent
 * looks at the Windows desktop, where the screen is (decision 0019, ruling 4). On Linux none is built
 * yet, and each says so.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";
import { TOOL_IMAGES } from "@declarative-ai/json";
import { EMBEDDERS, SCRIPT_INTERPRETERS, isSystemProgram, openerTool, programName } from "@jaira/shared";
import type { CiArtifactSink } from "./ciArtifacts";
import { isDeniedPath } from "./policy";
import {
  INSTALL_ACTIONS,
  LOG_LEVELS,
  OPEN_ACTIONS,
  POWER_ACTIONS,
  SERVICE_ACTIONS,
  SETTINGS_AREAS,
  SOFTWARE_KINDS,
  START_TYPES,
  SYSTEM_ABOUT,
  SystemToolRefusal,
  VALUE_TYPES,
  WRITE_AREAS,
  type InputStep,
  type InstallManager,
  type LogLevel,
  type ProcessRow,
  type ScreenPicture,
  type SystemBackend,
} from "./system/types";
import { WindowsSystem } from "./system/windows";
import { MacSystem } from "./system/macos";

export { SystemToolRefusal } from "./system/types";
export type { SystemBackend } from "./system/types";

/** The sixteen, in the order the vocabulary lists them. */
export const SYSTEM_TOOL_NAMES = [
  "read_system",
  "power",
  "list_processes",
  "stop_process",
  "list_services",
  "control_service",
  "list_software",
  "install_software",
  "read_settings",
  "write_settings",
  "read_clipboard",
  "write_clipboard",
  "list_windows",
  "open_app",
  "screenshot",
  "control_input",
] as const;

/**
 * Where a tool's result carries pictures for the MODEL — `{ …, "$images": [{ mimeType, data }] }` —
 * which every route hands a model as images beside the rest (`@declarative-ai/json`'s `splitToolImages`).
 */
export { TOOL_IMAGES } from "@declarative-ai/json";

/** The long side a picture is scaled to for the model (decision 0019 §2). */
export const SCREENSHOT_MAX_SIDE = 1568;

export interface SystemToolOptions {
  /** The machine. Default: this one's ({@link systemBackendFor}); `null` ⇒ none, and every tool says so. */
  backend?: SystemBackend | null;
  /** The engine's own pid — what JaiRA's protected processes are found from. Default `process.pid`. */
  enginePid?: number;
  /** Where a call's pictures are kept with its task; absent ⇒ they go to the model only. */
  keep?: (ctx: ExecServices | undefined) => CiArtifactSink | undefined;
  /** Workspace root for a relative path when the call has none. */
  cwd?: string;
  /** Told when an agent starts and stops driving the mouse and keyboard — the app's band (decision 0019, ruling 6). */
  onDriving?: (event: DrivingEvent) => void;
  /** Why this call may not drive the mouse and keyboard — the person stopped it — or `undefined`. */
  mayDrive?: (ctx: ExecServices | undefined) => string | undefined;
}

/** An agent's hands on the desktop: a `control_input` call starting, or done. */
export interface DrivingEvent {
  active: boolean;
  /** The conversation it is in, when known. */
  session?: string;
  /** Aborts the call that is driving — the band's Stop. Only on `active: true`. */
  stop?: () => void;
}

/** This machine's backend, or `undefined` where none is built (Linux). */
export function systemBackendFor(platform: NodeJS.Platform = process.platform): SystemBackend | undefined {
  if (platform === "win32") return new WindowsSystem();
  if (platform === "darwin") return new MacSystem();
  return undefined;
}

// --- JaiRA's own -------------------------------------------------------------------------------

/** Programs whose stopping takes the machine, or the desktop, down with it. */
const CRITICAL = new Set([
  "system",
  "idle",
  "registry",
  "memory compression",
  "secure system",
  "smss",
  "csrss",
  "wininit",
  "winlogon",
  "services",
  "lsass",
  "lsaiso",
  "svchost",
  "dwm",
  "fontdrvhost",
  "launchd",
  "kernel_task",
  "windowserver",
  "loginwindow",
]);

/** An agent JaiRA runs, wherever it sits under the engine (a shim makes the real one a grandchild). */
const AGENT_NAMES = /^(claude|codex)(\.exe)?$/i;

/** Runtimes many programs share — an ancestor running one does not make every one of them JaiRA's. */
const SHARED_RUNTIMES = /^(node|bun|deno|python[0-9.]*|powershell|pwsh|cmd|bash|zsh|sh|wsl|conhost|explorer|windowsterminal|terminal|iterm2|code)(\.exe)?$/i;

const startedAt = (row: ProcessRow | undefined): number | undefined => {
  const t = row?.started !== undefined ? Date.parse(row.started) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/**
 * The processes `stop_process` will not stop, each with why: the engine, the app around it (its
 * ancestors, and every process of the app's own program — Electron's helpers), the engine's own
 * children and the agents anywhere under it, and the operating system's critical ones.
 *
 * A parent pid is a number Windows reuses, so a child counts as a child only when it started no
 * earlier than its parent — the check `killTree`'s walk makes too.
 */
export function protectedProcesses(rows: readonly ProcessRow[], enginePid: number): Map<number, string> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const out = new Map<number, string>();
  const isChildOf = (child: ProcessRow, parent: ProcessRow): boolean => {
    const c = startedAt(child);
    const p = startedAt(parent);
    return c === undefined || p === undefined || c >= p;
  };
  out.set(enginePid, "it is JaiRA's engine");
  // Up: the app (and whatever started it).
  const appNames = new Set<string>();
  for (let at = byPid.get(enginePid), hops = 0; at?.parent_pid !== undefined && hops < 64; hops++) {
    const parent = byPid.get(at.parent_pid);
    if (parent === undefined || !isChildOf(at, parent)) break;
    out.set(parent.pid, "JaiRA runs inside it — stopping it stops JaiRA");
    if (!SHARED_RUNTIMES.test(parent.name)) appNames.add(parent.name.toLowerCase());
    at = parent;
  }
  const engine = byPid.get(enginePid);
  if (engine !== undefined && !SHARED_RUNTIMES.test(engine.name)) appNames.add(engine.name.toLowerCase());
  // Down: what the engine started, and the agents under it.
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.parent_pid === undefined) continue;
    const list = children.get(row.parent_pid) ?? [];
    list.push(row);
    children.set(row.parent_pid, list);
  }
  const queue: Array<{ row: ProcessRow; depth: number }> = engine !== undefined ? [{ row: engine, depth: 0 }] : [];
  for (let i = 0; i < queue.length && i < 10_000; i++) {
    const { row, depth } = queue[i]!;
    for (const child of children.get(row.pid) ?? []) {
      if (child.pid === row.pid || !isChildOf(child, row)) continue;
      if (depth === 0) out.set(child.pid, "JaiRA started it, to run an agent or a tool");
      else if (AGENT_NAMES.test(child.name)) out.set(child.pid, "it is an agent JaiRA is running");
      queue.push({ row: child, depth: depth + 1 });
    }
  }
  for (const row of rows) {
    if (out.has(row.pid)) continue;
    const name = row.name.toLowerCase();
    if (appNames.has(name)) out.set(row.pid, "it is part of the JaiRA app");
    else if (CRITICAL.has(name.replace(/\.exe$/, "")) || row.pid <= 4) out.set(row.pid, "the operating system needs it — stopping it would take the machine down");
  }
  return out;
}

/** The processes a stop of `pid` with `tree` reaches: it, and what it started (by parent pid and start time). */
export function treeOf(rows: readonly ProcessRow[], pid: number): number[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) if (row.parent_pid !== undefined) byParent.set(row.parent_pid, [...(byParent.get(row.parent_pid) ?? []), row]);
  const root = rows.find((row) => row.pid === pid);
  if (root === undefined) return [];
  const out: ProcessRow[] = [root];
  for (let i = 0; i < out.length && i < 10_000; i++) {
    const parent = out[i]!;
    for (const child of byParent.get(parent.pid) ?? []) {
      const c = startedAt(child);
      const p = startedAt(parent);
      if (child.pid !== parent.pid && (c === undefined || p === undefined || c >= p) && !out.includes(child)) out.push(child);
    }
  }
  return out.map((row) => row.pid);
}

/** A protected set, kept for a few seconds: `control_input` asks per call, and a process list costs a PowerShell start. */
function protectedCache(backend: SystemBackend, enginePid: number): () => Promise<Map<number, string>> {
  let kept: { at: number; set: Map<number, string> } | undefined;
  return async () => {
    if (kept !== undefined && Date.now() - kept.at < 30_000) return kept.set;
    const set = protectedProcesses(await backend.processes(), enginePid);
    kept = { at: Date.now(), set };
    return set;
  };
}

// --- arguments ------------------------------------------------------------------------------

const record = (input: unknown): Record<string, unknown> => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new SystemToolRefusal(`\`${name}\` is one of ${allowed.map((a) => `'${a}'`).join(", ")}`);
}

function count(value: unknown, name: string, fallback: number, max: number, min = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new SystemToolRefusal(`\`${name}\` is a number from ${min}`);
  return Math.min(max, Math.floor(value));
}

function pidOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new SystemToolRefusal("name the process: `pid`, from list_processes");
  return value;
}

/** A place a call names, absolute — relative to the workspace — and never JaiRA's own folder. */
function placeOf(value: string, ctx: ExecServices | undefined, cwd: string | undefined): string {
  const root = ctx?.workspace?.root ?? cwd ?? process.cwd();
  const place = isAbsolute(value) ? value : resolvePath(root, value);
  if (isDeniedPath(place)) throw new SystemToolRefusal(`'${value}' is in .jaira/, which is the engine's own`);
  return place;
}

/** Cut a list to a limit, saying how many there were. */
const cut = <T>(rows: readonly T[], limit: number, key: string): JsonValue => ({ count: rows.length, ...(rows.length > limit ? { shown: limit } : {}), [key]: rows.slice(0, limit) as unknown as JsonValue }) as JsonValue;

/** Rows whose name (or any of `fields`) holds `filter`, in any case. */
function matching<T extends object>(rows: readonly T[], filter: string | undefined, fields: ReadonlyArray<keyof T>): T[] {
  if (filter === undefined) return [...rows];
  const needle = filter.toLowerCase();
  return rows.filter((row) => fields.some((field) => String(row[field] ?? "").toLowerCase().includes(needle)));
}

const MAX_CLIPBOARD_TEXT = 50_000;

/** Programs that run code they are handed — `open_app` launches apps, and these are not apps. */
const RUNS_CODE = new Set([
  ...Object.keys(EMBEDDERS),
  ...Object.keys(SCRIPT_INTERPRETERS),
  "cmd",
  "powershell",
  "pwsh",
  "wscript",
  "cscript",
  "mshta",
  "rundll32",
  "regsvr32",
  "msiexec",
  "installutil",
  "msbuild",
  "schtasks",
  "at",
  "osascript",
  "terminal",
  "iterm",
  "wt",
  "windowsterminal",
]);

/** Why an app is not one `open_app` launches, or `undefined`. */
function launchRefusal(app: string): string | undefined {
  const program = programName(app);
  if (RUNS_CODE.has(program)) return `'${app}' runs code it is handed — that is the shell's: run it through \`shell\`, where what it runs is judged`;
  if (isSystemProgram(program)) return `'${app}' is a command — run it through \`shell\`, where it is judged as the System tool it is`;
  if (openerTool([app], "powershell") === "script") return `'${app}' would run as a program — that is the shell's \`script\``;
  return undefined;
}

// --- the tools ----------------------------------------------------------------------------------

/** A tool whose refusals reach the model as a sentence, and whose other failures say which tool failed. */
function systemTool(name: string, spec: Omit<Tool, "run">, backend: SystemBackend | undefined, body: (backend: SystemBackend, args: Record<string, unknown>, ctx: ExecServices | undefined) => Promise<unknown>): Tool {
  return {
    ...spec,
    run: async (input, ctx) => {
      if (backend === undefined) return { error: `${name} is built for Windows and macOS; this machine runs ${process.platform}, where the System tools are not built yet` };
      try {
        return (await body(backend, record(input), ctx)) as JsonValue;
      } catch (e) {
        if (e instanceof SystemToolRefusal) return { error: e.message };
        return { error: `${name}: ${(e as Error).message ?? String(e)}` };
      }
    },
  };
}

const LIMIT = { type: "integer", minimum: 1, maximum: 500, description: "How many to list, at most (default 50)." } as const;

/**
 * Per conversation, the last picture `screenshot` took: what its pixels map onto, so `control_input`
 * reads a click on it as a place on the screen.
 */
type Geometry = ScreenPicture["region"] & { width_px: number; height_px: number };

/** The System tools over `options.backend` (this machine's by default), by name. */
export function createSystemTools(options: SystemToolOptions = {}): Record<string, Tool> {
  const backend = options.backend === null ? undefined : (options.backend ?? systemBackendFor());
  const enginePid = options.enginePid ?? process.pid;
  const guarded = backend !== undefined ? protectedCache(backend, enginePid) : async () => new Map<number, string>();
  const geometry = new Map<string, Geometry>();
  const sessionOf = (ctx: ExecServices | undefined): string => (ctx?.session as { id?: string } | undefined)?.id ?? "";
  let shots = 0;

  /** Keep a picture with the task, and say it as the value plus the image for the model. */
  const picture = (ctx: ExecServices | undefined, kind: string, png: Uint8Array, fields: Record<string, unknown>): JsonValue => {
    const sink = options.keep?.(ctx);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const saved = sink?.save(`system/${kind}-${stamp}-${++shots}.png`, png);
    return {
      ...fields,
      ...(saved !== undefined ? { path: saved.path, file: saved.file } : {}),
      [TOOL_IMAGES]: [{ mimeType: "image/png", data: Buffer.from(png).toString("base64") }],
    } as JsonValue;
  };

  const tool = (name: string, spec: Omit<Tool, "run">, body: (backend: SystemBackend, args: Record<string, unknown>, ctx: ExecServices | undefined) => Promise<unknown>): Tool => systemTool(name, spec, backend, body);

  return {
    read_system: tool(
      "read_system",
      {
        description:
          "Read what this machine is. `about`: 'summary' (the OS and its version, the machine's name, uptime, memory, processors, whether JaiRA runs as an administrator), 'hardware' (processor, graphics, model), 'disks' (each drive: size, free, format), 'network' (each adapter: addresses, gateway, DNS), 'users' (the accounts), or 'logs' (the system log: `log` names which — on Windows an event log such as 'System' or 'Application', on macOS a subsystem — with `level`, `since_minutes` and `limit`).",
        inputSchema: {
          type: "object",
          properties: {
            about: { type: "string", enum: [...SYSTEM_ABOUT], description: "Which part of the machine (default 'summary')." },
            log: { type: "string", description: "logs only: which log." },
            level: { type: "string", enum: [...LOG_LEVELS], description: "logs only: entries at least this severe." },
            since_minutes: { type: "number", minimum: 1, description: "logs only: how far back (default 60)." },
            limit: LIMIT,
          },
        },
        readOnly: true,
      },
      async (b, args) => {
        const about = oneOf(args["about"], SYSTEM_ABOUT, "about", "summary");
        const level = args["level"] !== undefined ? oneOf<LogLevel>(args["level"], LOG_LEVELS, "level") : undefined;
        const log = { ...(text(args["log"]) !== undefined ? { log: text(args["log"])! } : {}), ...(level !== undefined ? { level } : {}), sinceMinutes: count(args["since_minutes"], "since_minutes", 60, 60 * 24 * 30), limit: count(args["limit"], "limit", 50, 500) };
        const answer = await b.readSystem(about, log);
        if (about !== "summary") return about === "logs" ? cut(Array.isArray(answer) ? answer : [], log.limit, "entries") : answer;
        const os = await import("node:os");
        return {
          ...(record(answer) as Record<string, JsonValue>),
          machine: os.hostname(),
          architecture: os.arch(),
          uptime_hours: Math.round((os.uptime() / 3600) * 10) / 10,
          memory_gb: { total: Math.round((os.totalmem() / 2 ** 30) * 10) / 10, free: Math.round((os.freemem() / 2 ** 30) * 10) / 10 },
          processors: os.cpus().length,
          processor: os.cpus()[0]?.model ?? null,
          user: os.userInfo().username,
        };
      },
    ),

    power: tool(
      "power",
      {
        description:
          "Restart, shut down, put to sleep, hibernate, sign out of, or lock this machine — or `cancel` a restart or shut-down still counting down. A restart or shut-down waits `delay_seconds` first (default 30). Always asks the person first.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...POWER_ACTIONS] },
            delay_seconds: { type: "number", minimum: 0, description: "restart and shut_down: how long to wait first (default 30)." },
          },
          required: ["action"],
        },
        readOnly: false,
      },
      async (b, args) => b.power(oneOf(args["action"], POWER_ACTIONS, "action"), args["delay_seconds"] === undefined ? 30 : count(args["delay_seconds"], "delay_seconds", 30, 86_400, 0)),
    ),

    list_processes: tool(
      "list_processes",
      {
        description:
          "List the programs running on this machine: each one's `pid` (what stop_process takes), parent, name, memory, processor time, when it started and its window's title. `name` keeps those whose name, path or window title holds it; `sort` orders them (default memory, largest first). Processes JaiRA itself needs are marked `protected` with why.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Only those whose name, path or window title holds this, in any case." },
            sort: { type: "string", enum: ["memory", "cpu", "name", "pid", "started"] },
            limit: LIMIT,
          },
        },
        readOnly: true,
      },
      async (b, args) => {
        const rows = await b.processes();
        const kept = protectedProcesses(rows, enginePid);
        const sort = oneOf(args["sort"], ["memory", "cpu", "name", "pid", "started"] as const, "sort", "memory");
        const order: Record<typeof sort, (a: ProcessRow, b: ProcessRow) => number> = {
          memory: (x, y) => (y.memory_mb ?? 0) - (x.memory_mb ?? 0),
          cpu: (x, y) => (y.cpu_seconds ?? 0) - (x.cpu_seconds ?? 0),
          name: (x, y) => x.name.localeCompare(y.name),
          pid: (x, y) => x.pid - y.pid,
          started: (x, y) => (startedAt(y) ?? 0) - (startedAt(x) ?? 0),
        };
        const shown = matching(rows, text(args["name"]), ["name", "path", "window_title"])
          .sort(order[sort])
          .map((row) => (kept.has(row.pid) ? { ...row, protected: kept.get(row.pid)! } : row));
        return cut(shown, count(args["limit"], "limit", 50, 500), "processes");
      },
    ),

    stop_process: tool(
      "stop_process",
      {
        description:
          "Stop a running program by its `pid` (from list_processes). With `tree`, what it started stops too. Without `force` a program with a window is asked to close first, and terminated if it has not in 5 s; with `force` it is terminated at once. JaiRA's own processes, and those the operating system needs, are refused.",
        inputSchema: {
          type: "object",
          properties: {
            pid: { type: "integer", minimum: 1 },
            tree: { type: "boolean", description: "Stop what it started too (default false)." },
            force: { type: "boolean", description: "Terminate at once rather than ask it to close (default false)." },
          },
          required: ["pid"],
        },
        readOnly: false,
      },
      async (b, args) => {
        const pid = pidOf(args["pid"]);
        const rows = await b.processes();
        const row = rows.find((r) => r.pid === pid);
        if (row === undefined) throw new SystemToolRefusal(`no process ${pid} is running — list_processes lists them`);
        const kept = protectedProcesses(rows, enginePid);
        const tree = args["tree"] === true;
        const reached = tree ? treeOf(rows, pid) : [pid];
        const refused = reached.find((p) => kept.has(p));
        if (refused !== undefined) {
          const name = rows.find((r) => r.pid === refused)?.name ?? String(refused);
          throw new SystemToolRefusal(refused === pid ? `refused: ${row.name} (${pid}) — ${kept.get(pid)}` : `refused: stopping ${row.name} (${pid}) with its tree would stop ${name} (${refused}) — ${kept.get(refused)}`);
        }
        const done = await b.stopProcess(pid, { ...(row.started !== undefined ? { started: row.started } : {}), tree, force: args["force"] === true });
        return { pid, name: row.name, ...done, ...(tree ? { processes: reached.length } : {}) };
      },
    ),

    list_services: tool(
      "list_services",
      {
        description: "List the machine's services: each one's `name` (what control_service takes), display name, whether it is running, and how it starts. `name` keeps those whose name or display name holds it; `state` keeps the running or the stopped.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            state: { type: "string", enum: ["running", "stopped", "all"] },
            limit: { ...LIMIT, description: "How many to list, at most (default 100)." },
          },
        },
        readOnly: true,
      },
      async (b, args) => {
        const state = oneOf(args["state"], ["running", "stopped", "all"] as const, "state", "all");
        const rows = matching(await b.services(), text(args["name"]), ["name", "display_name"]).filter((row) => state === "all" || row.status === state);
        return cut(rows.sort((x, y) => x.name.localeCompare(y.name)), count(args["limit"], "limit", 100, 500), "services");
      },
    ),

    control_service: tool(
      "control_service",
      {
        description:
          "Start, stop, restart, pause or resume a service by its `name` (from list_services), or change how it starts (`set_start_type` with `start_type`). Answers the service as it is after. Most services need an administrator to change; when JaiRA is not one, it says so.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            action: { type: "string", enum: [...SERVICE_ACTIONS] },
            start_type: { type: "string", enum: [...START_TYPES], description: "set_start_type only." },
          },
          required: ["name", "action"],
        },
        readOnly: false,
      },
      async (b, args) => {
        const name = text(args["name"]);
        if (name === undefined) throw new SystemToolRefusal("name the service: `name`, from list_services");
        const action = oneOf(args["action"], SERVICE_ACTIONS, "action");
        const startType = action === "set_start_type" ? oneOf(args["start_type"], START_TYPES, "start_type") : undefined;
        return b.controlService(name, action, startType);
      },
    ),

    list_software: tool(
      "list_software",
      {
        description:
          "List what is installed. `kind`: 'programs' (installed programs — on macOS, the applications), 'apps' (Windows' store apps), 'modules' (PowerShell's modules), 'packages' (what the package manager installed — winget's on Windows, Homebrew's on macOS — by the `id` install_software takes). `name` keeps those whose name or publisher holds it.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...SOFTWARE_KINDS] },
            name: { type: "string" },
            limit: { ...LIMIT, description: "How many to list, at most (default 100)." },
          },
        },
        readOnly: true,
      },
      async (b, args) => {
        const kind = oneOf(args["kind"], SOFTWARE_KINDS, "kind", "programs");
        const rows = matching(await b.software(kind), text(args["name"]), ["name", "publisher", "id"]);
        return cut(rows.sort((x, y) => x.name.localeCompare(y.name)), count(args["limit"], "limit", 100, 500), "software");
      },
    ),

    install_software: tool(
      "install_software",
      {
        description:
          "Install, upgrade or uninstall software by the package manager's `id`: on Windows winget's (`manager` 'winget', the default — e.g. 'Git.Git', 'jqlang.jq') or a PowerShell module from the gallery (`manager` 'powershell'); on macOS Homebrew's ('brew'). A project's own dependencies are the project's package manager's, run through `shell` — this is for the machine. Always asks the person first. Answers the manager's exit code and the last of what it wrote.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...INSTALL_ACTIONS] },
            id: { type: "string", description: "The package's id, as list_software (kind 'packages') or the manager's search names it." },
            manager: { type: "string", enum: ["winget", "powershell", "brew"] },
            version: { type: "string", description: "install only: this version." },
          },
          required: ["action", "id"],
        },
        readOnly: false,
      },
      async (b, args) => {
        const id = text(args["id"]);
        if (id === undefined || /\s/.test(id)) throw new SystemToolRefusal("name the package by its id: `id`, one word, as the package manager names it");
        const manager = oneOf<InstallManager>(args["manager"], ["winget", "powershell", "brew"], "manager", b.os === "macos" ? "brew" : "winget");
        const version = text(args["version"]);
        return b.installSoftware({ action: oneOf(args["action"], INSTALL_ACTIONS, "action"), id, manager, ...(version !== undefined ? { version } : {}) }, 20 * 60_000);
      },
    ),

    read_settings: tool(
      "read_settings",
      {
        description:
          "Read the machine's settings. `area`: 'registry' (Windows: the values and subkeys of `key`, e.g. 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', or one value with `name`), 'defaults' (macOS: the domain `key`, e.g. 'com.apple.dock', or one key of it with `name`), 'environment' (the user's and the machine's persistent environment variables, or one with `name` — values whose names say they are secrets are withheld), 'time' (the clock and the time zone).",
        inputSchema: {
          type: "object",
          properties: {
            area: { type: "string", enum: [...SETTINGS_AREAS] },
            key: { type: "string" },
            name: { type: "string" },
          },
          required: ["area"],
        },
        readOnly: true,
      },
      async (b, args) => {
        const key = text(args["key"]);
        const name = typeof args["name"] === "string" ? args["name"] : undefined;
        return b.readSettings({ area: oneOf(args["area"], SETTINGS_AREAS, "area"), ...(key !== undefined ? { key } : {}), ...(name !== undefined ? { name } : {}) });
      },
    ),

    write_settings: tool(
      "write_settings",
      {
        description:
          "Change a setting of the machine. `area`: 'registry' (Windows: set `name` under `key` to `value` as `type` — string, expand_string, multi_string (a list), dword, qword, binary (base64) — creating the key if needed; `delete` removes the value), 'defaults' (macOS: set `name` in the domain `key` to `value` as `type` — string, int, float, bool; `delete` removes it), 'environment' (a persistent variable `name` = `value` for the user, or `scope` 'machine'; `delete` removes it — programs started after see it), 'time_zone' (`value` is a time zone id, as read_settings 'time' shows).",
        inputSchema: {
          type: "object",
          properties: {
            area: { type: "string", enum: [...WRITE_AREAS] },
            key: { type: "string" },
            name: { type: "string" },
            value: { description: "What to set: a string, a number, true or false, or (multi_string) a list of strings." },
            type: { type: "string", enum: [...VALUE_TYPES] },
            delete: { type: "boolean" },
            scope: { type: "string", enum: ["user", "machine"] },
          },
          required: ["area"],
        },
        readOnly: false,
      },
      async (b, args) => {
        const area = oneOf(args["area"], WRITE_AREAS, "area");
        const name = typeof args["name"] === "string" ? args["name"] : undefined;
        const del = args["delete"] === true;
        if (area !== "time_zone" && name === undefined) throw new SystemToolRefusal("name what to set: `name`");
        const value = args["value"];
        if (!del && value === undefined) throw new SystemToolRefusal("say what to set it to: `value` (or `delete: true`)");
        if (value !== undefined && !["string", "number", "boolean"].includes(typeof value) && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
          throw new SystemToolRefusal("`value` is a string, a number, true or false, or a list of strings");
        }
        const key = text(args["key"]);
        const type = args["type"] !== undefined ? oneOf(args["type"], VALUE_TYPES, "type") : undefined;
        const scope = args["scope"] !== undefined ? oneOf(args["scope"], ["user", "machine"] as const, "scope") : undefined;
        return b.writeSettings({
          area,
          ...(key !== undefined ? { key } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(value !== undefined ? { value: value as string | number | boolean | string[] } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(del ? { delete: true } : {}),
          ...(scope !== undefined ? { scope } : {}),
        });
      },
    ),

    read_clipboard: tool(
      "read_clipboard",
      {
        description: "Read what is on the clipboard: its text, the files copied, and a picture — kept with the task and shown to you as an image.",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      },
      async (b, _args, ctx) => {
        const content = await b.readClipboard();
        const fields: Record<string, unknown> = {};
        if (content.text !== undefined) {
          fields["text"] = content.text.length > MAX_CLIPBOARD_TEXT ? `${content.text.slice(0, MAX_CLIPBOARD_TEXT)}…` : content.text;
          if (content.text.length > MAX_CLIPBOARD_TEXT) fields["text_length"] = content.text.length;
        }
        if (content.files !== undefined) fields["files"] = content.files;
        if (content.image === undefined) return Object.keys(fields).length === 0 ? { empty: true } : fields;
        return picture(ctx, "clipboard", content.image.png, { ...fields, image: { width: content.image.width, height: content.image.height } });
      },
    ),

    write_clipboard: tool(
      "write_clipboard",
      {
        description: "Put something on the clipboard, in place of what is there: `text`, an image file (`image_path`, a PNG, JPEG, GIF or BMP), or files to paste (`files`). Empty `text` clears it.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            image_path: { type: "string", description: "A picture file, in the workspace or absolute." },
            files: { type: "array", items: { type: "string" }, description: "Files, in the workspace or absolute." },
          },
        },
        readOnly: false,
      },
      async (b, args, ctx) => {
        const image = text(args["image_path"]);
        const files = Array.isArray(args["files"]) ? (args["files"] as unknown[]).filter((f): f is string => typeof f === "string" && f.trim().length > 0) : [];
        const given = [typeof args["text"] === "string", image !== undefined, files.length > 0].filter(Boolean).length;
        if (given !== 1) throw new SystemToolRefusal("put one thing on the clipboard: `text`, `image_path` or `files`");
        if (image !== undefined) {
          if (!/\.(png|jpe?g|gif|bmp|tiff?)$/i.test(image)) throw new SystemToolRefusal("`image_path` is a picture: .png, .jpg, .gif, .bmp or .tif");
          await b.writeClipboard({ imageFile: placeOf(image, ctx, options.cwd) });
          return { ok: true, image: image };
        }
        if (files.length > 0) {
          await b.writeClipboard({ files: files.map((f) => placeOf(f, ctx, options.cwd)) });
          return { ok: true, files: files.length };
        }
        await b.writeClipboard({ text: args["text"] as string });
        return { ok: true, characters: (args["text"] as string).length };
      },
    ),

    list_windows: tool(
      "list_windows",
      {
        description: "List the windows open on the desktop: each one's `window_id` (what open_app and screenshot take), title, app, its program's pid, whether it has the keyboard, whether it is minimized, and where it is (in the screen's own pixels). `app` keeps those whose app or title holds it.",
        inputSchema: { type: "object", properties: { app: { type: "string" }, limit: LIMIT } },
        readOnly: true,
      },
      async (b, args) => cut(matching(await b.windows(), text(args["app"]), ["app", "title"]), count(args["limit"], "limit", 50, 500), "windows"),
    ),

    open_app: tool(
      "open_app",
      {
        description:
          "`launch` an app by its name or path (`app`: 'notepad', 'Safari', 'C:\\Program Files\\…\\app.exe'); `open` a file or a link in its app (`target`; `app` to open it in a particular one); `focus` a window (`window_id`, from list_windows) or `close` one — politely, as its close button does. A program that runs code (a shell, an interpreter) or a file that would run as one is not opened here: run it through `shell`.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: [...OPEN_ACTIONS] },
            app: { type: "string" },
            target: { type: "string", description: "open: a file (in the workspace or absolute) or a link." },
            window_id: { type: "integer", description: "focus and close: a window from list_windows." },
          },
          required: ["action"],
        },
        readOnly: false,
      },
      async (b, args, ctx) => {
        const action = oneOf(args["action"], OPEN_ACTIONS, "action");
        const app = text(args["app"]);
        if (action === "launch" || action === "open") {
          if (app !== undefined) {
            const why = launchRefusal(app);
            if (why !== undefined) throw new SystemToolRefusal(why);
          }
          if (action === "launch") {
            if (app === undefined) throw new SystemToolRefusal("name the app: `app`");
            return b.openApp({ action, app });
          }
          const target = text(args["target"]);
          if (target === undefined) throw new SystemToolRefusal("name what to open: `target`, a file or a link");
          const link = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
          if (link && !/^(https?|mailto|file|ms-settings):/i.test(target)) throw new SystemToolRefusal(`'${target}' is a link to another program — open_app opens web links (http, https), mail links, Windows' settings pages (ms-settings:) and files`);
          if (!link && openerTool([target], b.os === "windows" ? "powershell" : "posix") === "script") throw new SystemToolRefusal(`'${target}' would run as a program when opened — that is the shell's \`script\``);
          return b.openApp({ action, target: link ? target : placeOf(target, ctx, options.cwd), ...(app !== undefined ? { app } : {}) });
        }
        const windowId = args["window_id"];
        if (typeof windowId !== "number" || !Number.isInteger(windowId)) throw new SystemToolRefusal("name the window: `window_id`, from list_windows");
        if (action === "close") {
          const owner = (await b.windows()).find((w) => w.window_id === windowId);
          if (owner !== undefined && (await guarded()).has(owner.pid)) throw new SystemToolRefusal("refused: that is JaiRA's own window");
        }
        return b.openApp({ action, windowId });
      },
    ),

    screenshot: tool(
      "screenshot",
      {
        description:
          "Take a picture of the screen — the primary display, another (`display`, from 0) or one window (`window_id`, from list_windows) — kept with the task and shown to you as an image, scaled so its longer side is at most 1568 pixels. control_input's coordinates are this picture's: take one before clicking, and again to see what a click did.",
        inputSchema: {
          type: "object",
          properties: {
            display: { type: "integer", minimum: 0 },
            window_id: { type: "integer" },
          },
        },
        readOnly: true,
      },
      async (b, args, ctx) => {
        const windowId = typeof args["window_id"] === "number" ? args["window_id"] : undefined;
        const display = typeof args["display"] === "number" ? args["display"] : undefined;
        const shot = await b.screenshot({ ...(windowId !== undefined ? { windowId } : {}), ...(display !== undefined ? { display } : {}), maxSide: SCREENSHOT_MAX_SIDE });
        geometry.set(sessionOf(ctx), { ...shot.region, width_px: shot.width, height_px: shot.height });
        return picture(ctx, "screenshot", shot.png, { width: shot.width, height: shot.height, ...(shot.width !== shot.region.width ? { scaled_from: { width: shot.region.width, height: shot.region.height } } : {}) });
      },
    ),

    control_input: tool(
      "control_input",
      {
        description:
          "Use the mouse and keyboard, in the coordinates of the last screenshot this conversation took: `steps` run in order, each one action — mouse_move {x,y}; left_click, right_click, middle_click, double_click, triple_click {x?,y?, keys? held while clicking}; left_mouse_down; left_mouse_up; left_click_drag {from:{x,y}, x, y}; scroll {x?,y?, direction up|down|left|right, amount in notches}; type {text}; key {keys: 'ctrl+s', 'enter', 'alt+tab'}; hold_key {keys, seconds}; wait {seconds}; cursor_position. Answers where the pointer is after. JaiRA's own window takes no input: focus another first. Take a screenshot after, to see what happened.",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_mouse_down", "left_mouse_up", "left_click_drag", "scroll", "type", "key", "hold_key", "wait", "cursor_position"],
                  },
                  x: { type: "number" },
                  y: { type: "number" },
                  from: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
                  direction: { type: "string", enum: ["up", "down", "left", "right"] },
                  amount: { type: "integer", minimum: 1, maximum: 50 },
                  text: { type: "string" },
                  keys: { type: "string" },
                  seconds: { type: "number", minimum: 0, maximum: 30 },
                },
                required: ["action"],
              },
            },
          },
          required: ["steps"],
        },
        readOnly: false,
      },
      async (b, args, ctx) => {
        const stopped = options.mayDrive?.(ctx);
        if (stopped !== undefined) throw new SystemToolRefusal(stopped);
        const raw = Array.isArray(args["steps"]) ? (args["steps"] as unknown[]) : [];
        if (raw.length === 0) throw new SystemToolRefusal("say what to do: `steps`, one action each");
        if (raw.length > 50) throw new SystemToolRefusal("at most 50 steps a call — take a screenshot between");
        const geo = geometry.get(sessionOf(ctx));
        const steps = raw.map((step, i) => inputStepOf(record(step), i, geo));
        const seconds = steps.reduce((sum, step) => sum + ("seconds" in step ? step.seconds : 0), 0);
        if (seconds > 60) throw new SystemToolRefusal("the waits and holds of one call come to at most 60 s");
        const kept = await guarded();
        const session = sessionOf(ctx);
        const stop = new AbortController();
        options.onDriving?.({ active: true, ...(session !== "" ? { session } : {}), stop: () => stop.abort() });
        try {
          const done = await b.input(steps, [...kept.keys()], stop.signal);
          if (done.cursor === undefined || geo === undefined) return { done: steps.length, ...(done.cursor !== undefined ? { cursor_on_screen: done.cursor } : {}) };
          return { done: steps.length, cursor: toPicture(done.cursor, geo) };
        } finally {
          options.onDriving?.({ active: false, ...(session !== "" ? { session } : {}) });
        }
      },
    ),
  };
}

/** A point of the last picture, as a place on the screen. */
function toScreen(x: number, y: number, geo: Geometry, step = ""): { x: number; y: number } {
  if (x < 0 || y < 0 || x > geo.width_px || y > geo.height_px) throw new SystemToolRefusal(`${step}(${x}, ${y}) is outside the last screenshot, which is ${geo.width_px}×${geo.height_px}`);
  return { x: Math.round(geo.x + (x * geo.width) / geo.width_px), y: Math.round(geo.y + (y * geo.height) / geo.height_px) };
}

/** A place on the screen, as a point of the last picture. */
function toPicture(at: { x: number; y: number }, geo: Geometry): { x: number; y: number } {
  return { x: Math.round(((at.x - geo.x) * geo.width_px) / geo.width), y: Math.round(((at.y - geo.y) * geo.height_px) / geo.height) };
}

/** One step as the model wrote it, checked, with its coordinates on the screen. */
export function inputStepOf(step: Record<string, unknown>, index: number, geo: Geometry | undefined): InputStep {
  const at = `step ${index + 1}`;
  const action = typeof step["action"] === "string" ? step["action"] : "";
  const num = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new SystemToolRefusal(`${at}: \`${name}\` is a number`);
    return value;
  };
  const point = (x: unknown, y: unknown): { x: number; y: number } => {
    if (geo === undefined) throw new SystemToolRefusal(`${at}: take a screenshot first — coordinates are the last screenshot's`);
    return toScreen(num(x, "x"), num(y, "y"), geo, `${at}: `);
  };
  const maybePoint = (): { x?: number; y?: number } => (step["x"] === undefined && step["y"] === undefined ? {} : point(step["x"], step["y"]));
  const keys = (): string => {
    const k = typeof step["keys"] === "string" ? step["keys"].trim() : "";
    if (k.length === 0) throw new SystemToolRefusal(`${at}: \`keys\`, like 'enter' or 'ctrl+s'`);
    return k;
  };
  switch (action) {
    case "mouse_move":
      return { action, ...point(step["x"], step["y"]) };
    case "left_click":
      return { action, ...maybePoint(), ...(typeof step["keys"] === "string" && step["keys"].trim() !== "" ? { keys: step["keys"].trim() } : {}) };
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return { action, ...maybePoint() };
    case "left_mouse_down":
    case "left_mouse_up":
    case "cursor_position":
      return { action };
    case "left_click_drag": {
      const from = record(step["from"]);
      return { action, from: point(from["x"], from["y"]), ...point(step["x"], step["y"]) };
    }
    case "scroll":
      return {
        action,
        ...maybePoint(),
        direction: oneOf(step["direction"], ["up", "down", "left", "right"] as const, `${at}: direction`),
        amount: count(step["amount"], `${at}: amount`, 3, 50),
      };
    case "type": {
      if (typeof step["text"] !== "string" || step["text"].length === 0) throw new SystemToolRefusal(`${at}: \`text\` to type`);
      if (step["text"].length > 5000) throw new SystemToolRefusal(`${at}: at most 5000 characters a step`);
      return { action, text: step["text"] };
    }
    case "key":
      return { action, keys: keys() };
    case "hold_key":
      return { action, keys: keys(), seconds: Math.min(30, Math.max(0, num(step["seconds"], "seconds"))) };
    case "wait":
      return { action, seconds: Math.min(30, Math.max(0, num(step["seconds"], "seconds"))) };
    default:
      throw new SystemToolRefusal(`${at}: '${action}' is not an action — see the tool's description`);
  }
}

/** Register the System tools (decision 0019) over `options`, beside the others. */
export function registerSystemTools(registry: { tools: Map<string, Tool> }, options: SystemToolOptions = {}): void {
  for (const [name, tool] of Object.entries(createSystemTools(options))) registry.tools.set(name, tool);
}
