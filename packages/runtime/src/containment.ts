/**
 * Containment of a session's processes, and the sweep for what got out (decision 0032, ruling 7).
 *
 * A session's processes are found by the walk — parent pid and start time on Windows, the process group
 * on POSIX (`leftRunning.ts`). The walk loses a process whose chain is cut: a POSIX daemon that left its
 * group with `setsid`, a Windows child whose parent's start time cannot be read. Where the platform has a
 * container that a process cannot leave by being reparented, a session's processes are also put in one:
 *
 * - **Windows: a Job Object per session.** Node cannot call Win32, so ONE long-lived helper per engine
 *   ({@link JOB_HELPER}: Windows PowerShell carrying C# through `Add-Type`, as `killTree.ts` does) holds
 *   every session's job and answers one request per line on stdin. Started lazily, and every request has
 *   a deadline: a helper that does not start, does not answer in time or exits is killed, and from then on
 *   every group is unavailable — callers fall back to the walk. Never a hang.
 *   - **Joined after spawn.** Node cannot create a process suspended, so a session's shell is assigned
 *     a moment after it starts (a warm helper answers in a few ms). Windows PowerShell takes hundreds of
 *     milliseconds before it runs the line, so what the line starts is created inside the job. A program
 *     that starts a child within its first milliseconds can beat the assignment; that child is outside
 *     the job and is still found by the walk.
 *   - **No breakaway.** The job allows none (no `JOB_OBJECT_LIMIT_BREAKAWAY_OK`), so `Start-Process`,
 *     `start`, a detached spawn: every child of a member is a member. Only another program creating the
 *     process — WMI's `Win32_Process.Create`, the Task Scheduler — puts it outside, which is what
 *     {@link findEscaped} looks for.
 *   - **No `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.** The job's only handle is the helper's. With
 *     kill-on-close, a helper that wedged and was killed by its own deadline would take every session's
 *     dev servers with it, and so would an engine crash — which ruling 9 says must not happen silently
 *     (after a crash JaiRA lists what it had started and offers to stop it). Without it, closing the job
 *     lets its processes run on, and a session's end stops them with {@link ContainmentGroup.stopAll}.
 *     Note: libuv itself puts every child Node spawns without `detached` into a kill-on-close job of its
 *     own, so a session's direct child already dies with the engine; the session's job nests inside it,
 *     and what the child started does too. Spawning `detached` is what would let them outlive a crash.
 * - **Linux: a systemd user scope per spawn, under one slice per session**, when `systemd-run --user`
 *   works (probed once). Membership is decided at spawn time by wrapping the argv
 *   ({@link ContainmentGroup.wrapArgv}); `systemd-run --scope` execs the command, so the pid is the
 *   command's. Members are read from the slice's cgroup (`cgroup.procs`, recursively), which `setsid` does
 *   not leave.
 * - **macOS: none.** The walk alone; every group answers "unavailable" cleanly.
 *
 * None of this is a sandbox (ruling 7): a program can still ask another program to start something.
 * {@link findEscaped} lists what did, so the person sees it.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger } from "@declarative-ai/log";
import { isAlive, type ProcessLister } from "./leftRunning";
import { cpuSecondsOf } from "./processTree";
import type { ProcessRow } from "./system/types";

const log = createLogger("jaira.runtime.containment");

export type ContainmentKind = "job" | "systemd-scope" | "none";

/** A process in a group, as much as the platform says. */
export interface ContainedProcess {
  pid: number;
  parent?: number;
  name: string;
  /** Epoch ms. */
  startedAt?: number;
}

/** The environment variable every spawn of a session carries ({@link ContainmentGroup.env}). */
export const GROUP_MARKER = "JAIRA_PROCESS_GROUP";

/** One session's processes. */
export interface ContainmentGroup {
  readonly key: string;
  /** What this group uses on this platform. "none" on macOS, and where the platform lacks it. */
  readonly kind: ContainmentKind;
  /** Whether {@link members} can answer now. False before the Linux probe, after a Windows helper failure, on macOS. */
  available(): boolean;
  /**
   * Environment to add to every process spawned for the session: a marker inherited by what it starts,
   * which confirms an escaped POSIX process as the session's ({@link findEscaped}).
   */
  env(): Record<string, string>;
  /** Linux: the argv run inside a new scope of the session's slice. Elsewhere, and before the probe: the argv. */
  wrapArgv(argv: readonly string[]): string[];
  /**
   * Windows: put `pid` (just spawned) in the session's job. Resolves within the helper's deadline,
   * `false` when it could not be (the process exited, the helper is unavailable). Elsewhere: `false`,
   * a no-op (Linux membership is decided by {@link wrapArgv}).
   */
  add(pid: number): Promise<boolean>;
  /** Every live process in the group, grandchildren included. `undefined`: cannot tell — use the walk. */
  members(): Promise<ContainedProcess[] | undefined>;
  /** Stop every process in the group. `false` when the group could not (unavailable). */
  stopAll(): Promise<boolean>;
  /** Let go of the group. Its processes keep running (see the module note). */
  close(): void;
}

export interface HelperCommand {
  command: string;
  args: readonly string[];
}

/** How a Linux group runs `systemd-run` and `systemctl`; a test stands in its own. */
export type CommandRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;

export interface ContainmentOptions {
  platform?: NodeJS.Platform;
  /** Windows: the helper; default {@link JOB_HELPER} through `powershell.exe`. */
  helper?: HelperCommand;
  /** Windows: how long the helper gets to start (PowerShell plus one `Add-Type`: 1–2 s warm). */
  helperStartMs?: number;
  /** Windows: how long one request gets. */
  helperRequestMs?: number;
  /** Linux: runs `systemd-run` and `systemctl`. */
  run?: CommandRunner;
  /** Linux: where cgroups and `/proc` are; tests point them at fixtures. */
  cgroupRoot?: string;
  procRoot?: string;
}

export const HELPER_START_MS = 15_000;
export const HELPER_REQUEST_MS = 3_000;

/**
 * The Windows helper: one C# class, and a loop that answers one request per line. A request is four
 * integers — `id op group pid` with `op` a word — so nothing a caller supplies is parsed as text. An
 * answer is one JSON line: `{"id":1,"ok":true,"result":…}` or `{"id":1,"ok":false,"error":"…"}`; the
 * first line is `{"ready":true}`.
 *
 * - `add g pid`: the job of group `g` (created on first use, unnamed — only the helper holds it) takes
 *   `pid`.
 * - `members g`: `[[pid, parent, name, startedMs|null, -1], …]` for the job's live processes.
 * - `stop g`: `TerminateJobObject`. `close g`: the handle closed; the processes run on.
 * - `snapshot`: `{"schedule": <pid of the Task Scheduler's svchost or -1>, "rows": [[pid, parent, name,
 *   startedMs|null, mine 1|0|-1], …]}` for every process — the sweep's list, from the kernel's toolhelp
 *   snapshot rather than WMI, with start time and account read per process with the least access there is.
 */
export const JOB_HELPER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class JairaJobs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool QueryServiceStatusEx(IntPtr service, int level, IntPtr buffer, int size, out int needed);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr handle);

  const uint QUERY_LIMITED = 0x1000, SET_QUOTA = 0x0100, TERMINATE = 0x0001;
  static readonly Dictionary<int, IntPtr> jobs = new Dictionary<int, IntPtr>();
  static readonly SecurityIdentifier me = WindowsIdentity.GetCurrent().User;

  struct Row { public int Pid; public int Parent; public string Name; }

  static List<Row> Snapshot() {
    var rows = new List<Row>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Exception("CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error());
    try {
      Entry entry = new Entry(); entry.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
        Row row = new Row(); row.Pid = (int)entry.th32ProcessID; row.Parent = (int)entry.th32ParentProcessID; row.Name = entry.szExeFile;
        rows.Add(row);
      }
    } finally { CloseHandle(snapshot); }
    return rows;
  }

  static int Mine(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 0x0008, out token)) return -1;
    try {
      int needed;
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed);
      if (needed <= 0) return -1;
      IntPtr buffer = Marshal.AllocHGlobal(needed);
      try {
        if (!GetTokenInformation(token, 1, buffer, needed, out needed)) return -1;
        return new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Equals(me) ? 1 : 0;
      } finally { Marshal.FreeHGlobal(buffer); }
    } finally { CloseHandle(token); }
  }

  static void Describe(StringBuilder sb, Row row, bool owner) {
    long started = -1; int mine = -1;
    IntPtr process = OpenProcess(QUERY_LIMITED, false, (uint)row.Pid);
    if (process != IntPtr.Zero) {
      try {
        long creation, exit, kernel, user;
        if (GetProcessTimes(process, out creation, out exit, out kernel, out user) && creation > 0) started = (creation - 116444736000000000L) / 10000L;
        if (owner) mine = Mine(process);
      } finally { CloseHandle(process); }
    }
    sb.Append('[').Append(row.Pid).Append(',').Append(row.Parent).Append(',').Append(Quote(row.Name)).Append(',');
    sb.Append(started < 0 ? "null" : started.ToString()).Append(',').Append(mine).Append(']');
  }

  static int[] JobPids(IntPtr job) {
    int capacity = 64;
    while (true) {
      int size = 8 + IntPtr.Size * capacity;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        if (QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero)) {
          int count = Marshal.ReadInt32(buffer, 4);
          int[] pids = new int[count];
          for (int i = 0; i < count; i++) pids[i] = (int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
          return pids;
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 234 || capacity >= 65536) throw new Exception("QueryInformationJobObject failed: " + error);
        capacity = Math.Max(capacity * 4, Marshal.ReadInt32(buffer, 0) + 16);
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }

  static int SchedulePid() {
    IntPtr manager = OpenSCManagerW(null, null, 0x0001);
    if (manager == IntPtr.Zero) return -1;
    try {
      IntPtr service = OpenServiceW(manager, "Schedule", 0x0004);
      if (service == IntPtr.Zero) return -1;
      try {
        IntPtr buffer = Marshal.AllocHGlobal(64);
        try {
          int needed;
          if (!QueryServiceStatusEx(service, 0, buffer, 64, out needed)) return -1;
          int pid = Marshal.ReadInt32(buffer, 28);
          return pid > 0 ? pid : -1;
        } finally { Marshal.FreeHGlobal(buffer); }
      } finally { CloseServiceHandle(service); }
    } finally { CloseServiceHandle(manager); }
  }

  static string Quote(string s) {
    var sb = new StringBuilder("\\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\\\') sb.Append('\\\\').Append(c);
      else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static string Handle(string op, int group, int pid) {
    IntPtr job;
    switch (op) {
      case "ping": return "true";
      case "add": {
        if (!jobs.TryGetValue(group, out job)) {
          job = CreateJobObjectW(IntPtr.Zero, null);
          if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
          jobs[group] = job;
        }
        IntPtr process = OpenProcess(SET_QUOTA | TERMINATE | QUERY_LIMITED, false, (uint)pid);
        if (process == IntPtr.Zero) throw new Exception("process " + pid + " could not be opened (" + Marshal.GetLastWin32Error() + ")");
        try {
          if (!AssignProcessToJobObject(job, process)) throw new Exception("process " + pid + " could not join the job (" + Marshal.GetLastWin32Error() + ")");
        } finally { CloseHandle(process); }
        return "true";
      }
      case "members": {
        if (!jobs.TryGetValue(group, out job)) return "[]";
        var inJob = new HashSet<int>(JobPids(job));
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (Row row in Snapshot()) {
          if (!inJob.Contains(row.Pid)) continue;
          if (!first) sb.Append(',');
          first = false;
          Describe(sb, row, false);
        }
        return sb.Append(']').ToString();
      }
      case "stop": {
        if (jobs.TryGetValue(group, out job) && !TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
        return "true";
      }
      case "close": {
        if (jobs.TryGetValue(group, out job)) { CloseHandle(job); jobs.Remove(group); }
        return "true";
      }
      case "snapshot": {
        var sb = new StringBuilder("{\\"schedule\\":");
        sb.Append(SchedulePid()).Append(",\\"rows\\":[");
        bool first = true;
        foreach (Row row in Snapshot()) {
          if (!first) sb.Append(',');
          first = false;
          Describe(sb, row, true);
        }
        return sb.Append("]}").ToString();
      }
      default: throw new Exception("unknown request " + op);
    }
  }

  public static void Serve() {
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = true;
    output.Write("{\\"ready\\":true}\\n");
    string line;
    while ((line = input.ReadLine()) != null) {
      string[] parts = line.Trim().Split(' ');
      int id;
      if (parts.Length < 4 || !int.TryParse(parts[0], out id)) continue;
      string answer;
      try {
        answer = "{\\"id\\":" + id + ",\\"ok\\":true,\\"result\\":" + Handle(parts[1], int.Parse(parts[2]), int.Parse(parts[3])) + "}";
      } catch (Exception e) {
        answer = "{\\"id\\":" + id + ",\\"ok\\":false,\\"error\\":" + Quote(e.Message) + "}";
      }
      output.Write(answer + "\\n");
    }
  }
}
'@
[JairaJobs]::Serve()
`;

const defaultHelper = (): HelperCommand => ({
  command: "powershell.exe",
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(JOB_HELPER, "utf16le").toString("base64")],
});

interface HelperAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The engine's one Windows helper: started on first use, and failed for good at its first missed deadline. */
class JobHelper {
  private child: ChildProcess | undefined;
  private starting: Promise<boolean> | undefined;
  private failure: string | undefined;
  private ready = false;
  private readonly pending = new Map<number, (answer: HelperAnswer | undefined) => void>();
  private nextId = 1;
  private buffer = "";
  private onReady: (() => void) | undefined;

  constructor(
    private readonly command: HelperCommand,
    private readonly startMs: number,
    private readonly requestMs: number,
  ) {}

  /** Why the helper is not there, once it is not. */
  failed(): string | undefined {
    return this.failure;
  }

  isReady(): boolean {
    return this.ready && this.failure === undefined;
  }

  start(): Promise<boolean> {
    if (this.failure !== undefined) return Promise.resolve(false);
    this.starting ??= new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.command.command, [...this.command.args], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      } catch (error) {
        this.fail(`it could not start: ${error instanceof Error ? error.message : String(error)}`);
        return resolve(false);
      }
      this.child = child;
      const timer = setTimeout(() => {
        this.fail(`it did not start within ${this.startMs} ms`);
        resolve(false);
      }, this.startMs);
      this.onReady = () => {
        clearTimeout(timer);
        this.ready = true;
        resolve(true);
      };
      child.on("error", (error) => {
        clearTimeout(timer);
        this.fail(`it could not start: ${error.message}`);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        this.fail(`it exited (${code ?? "no code"})`);
        resolve(false);
      });
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (text: string) => this.read(text));
      child.stdin!.on("error", () => undefined);
      // The helper never keeps the engine alive: a request in flight holds its own timer.
      child.unref();
      (child.stdout as unknown as { unref?: () => void }).unref?.();
      (child.stdin as unknown as { unref?: () => void }).unref?.();
    });
    return this.starting;
  }

  async request(op: "add" | "members" | "stop" | "close" | "snapshot" | "ping", group = 0, pid = 0, deadlineMs = this.requestMs): Promise<HelperAnswer | undefined> {
    if (!(await this.start())) return undefined;
    const child = this.child;
    if (child === undefined || this.failure !== undefined) return undefined;
    const id = this.nextId++;
    return new Promise<HelperAnswer | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.fail(`it did not answer '${op}' within ${deadlineMs} ms`);
        resolve(undefined);
      }, deadlineMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(answer);
      });
      try {
        child.stdin!.write(`${id} ${op} ${Math.trunc(group)} ${Math.trunc(pid)}\n`);
      } catch {
        this.pending.get(id)?.(undefined);
      }
    });
  }

  close(): void {
    this.fail("closed", false);
  }

  private read(text: string): void {
    this.buffer += text;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.length === 0) continue;
      let value: { ready?: boolean; id?: number } & HelperAnswer;
      try {
        value = JSON.parse(line) as typeof value;
      } catch {
        continue;
      }
      if (value.ready === true) this.onReady?.();
      else if (typeof value.id === "number") this.pending.get(value.id)?.(value);
    }
  }

  private fail(why: string, warn = true): void {
    if (this.failure !== undefined) return;
    this.failure = why;
    if (warn) log.warn("the process containment helper is unavailable; a session's processes are found by the walk alone", { why });
    try {
      this.child?.kill();
    } catch {
      // Gone already.
    }
    for (const settle of [...this.pending.values()]) settle(undefined);
    this.pending.clear();
  }
}

/** A row of the sweep's process list. */
export interface EscapeRow {
  pid: number;
  parent?: number;
  name: string;
  /** Epoch ms. */
  startedAt?: number;
  /** Windows: whether its account is the user's, where that could be read. */
  mine?: boolean;
  /** POSIX: its account. */
  uid?: number;
  /** Linux: the systemd unit its cgroup names (`run-r1a2b.service`). */
  unit?: string;
  /** Whether it carries the session's {@link GROUP_MARKER}, where its environment could be read. */
  marked?: boolean;
}

/** The engine's containment: one per engine, one group per session. */
export class Containment {
  readonly platform: NodeJS.Platform;
  private readonly helper: JobHelper | undefined;
  private readonly groups = new Map<string, ContainmentGroup>();
  private nextGroup = 1;
  private systemd: Promise<boolean> | undefined;
  private systemdOk: boolean | undefined;
  private readonly run: CommandRunner;
  readonly cgroupRoot: string;
  readonly procRoot: string;

  constructor(private readonly options: ContainmentOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? runCommand;
    this.cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup";
    this.procRoot = options.procRoot ?? "/proc";
    if (this.platform === "win32") this.helper = new JobHelper(options.helper ?? defaultHelper(), options.helperStartMs ?? HELPER_START_MS, options.helperRequestMs ?? HELPER_REQUEST_MS);
  }

  /** What this platform contains with. */
  get kind(): ContainmentKind {
    if (this.platform === "win32") return "job";
    if (this.platform === "linux") return "systemd-scope";
    return "none";
  }

  /**
   * Start the helper (Windows) or probe `systemd-run --user` (Linux), and say what is available. Called
   * once at engine start, so the first shell call neither waits for it nor runs unwrapped.
   */
  async ready(): Promise<ContainmentKind> {
    if (this.helper !== undefined) return (await this.helper.start()) ? "job" : "none";
    if (this.platform === "linux") return (await this.probeSystemd()) ? "systemd-scope" : "none";
    return "none";
  }

  /** The session's group, made on first ask. */
  group(key: string): ContainmentGroup {
    let group = this.groups.get(key);
    if (group === undefined) {
      const marker = `${safeName(key)}.${randomBytes(6).toString("hex")}`;
      const forget = (): void => {
        this.groups.delete(key);
      };
      if (this.helper !== undefined) group = new JobGroup(key, this.nextGroup++, this.helper, marker, forget);
      else if (this.platform === "linux") group = new ScopeGroup(key, marker, this, this.run, forget);
      else group = new NoGroup(key, marker, forget);
      this.groups.set(key, group);
    }
    return group;
  }

  /**
   * Windows: every process, from the helper — the sweep's list and the walk's, without a PowerShell
   * start each time. `undefined` where there is no helper or it failed.
   */
  async snapshot(): Promise<{ schedule?: number; rows: EscapeRow[] } | undefined> {
    if (this.helper === undefined) return undefined;
    const answer = await this.helper.request("snapshot", 0, 0, (this.options.helperRequestMs ?? HELPER_REQUEST_MS) * 3);
    if (answer === undefined || !answer.ok) return undefined;
    const result = answer.result as { schedule: number; rows: Array<[number, number, string, number | null, number]> };
    return {
      ...(result.schedule > 0 ? { schedule: result.schedule } : {}),
      rows: result.rows.map(([pid, parent, name, started, mine]) => ({
        pid,
        parent,
        name,
        ...(started !== null ? { startedAt: started } : {}),
        ...(mine === 1 ? { mine: true } : mine === 0 ? { mine: false } : {}),
      })),
    };
  }

  /** Whether {@link snapshot} is cheap now: the helper is up. */
  snapshotReady(): boolean {
    return this.helper?.isReady() ?? false;
  }

  /**
   * A process lister for `findLeftRunning`: the helper's snapshot where it is up, else `fallback` (the
   * System tools' list, a PowerShell start).
   */
  lister(fallback?: ProcessLister): ProcessLister | undefined {
    if (this.helper === undefined) return fallback;
    return async () => {
      const snapshot = this.helper!.isReady() ? await this.snapshot() : undefined;
      if (snapshot === undefined) return fallback !== undefined ? fallback() : [];
      return snapshot.rows.map(toProcessRow);
    };
  }

  /** Let go of every group and the helper. Processes keep running. */
  close(): void {
    for (const group of [...this.groups.values()]) group.close();
    this.helper?.close();
  }

  /** @internal Linux: whether scopes can be made, probed once. */
  probeSystemd(): Promise<boolean> {
    this.systemd ??= this.run("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], 5_000).then(
      (result) => (this.systemdOk = result.code === 0),
      () => (this.systemdOk = false),
    );
    return this.systemd;
  }

  /** @internal Linux: the probe's answer, if it has come. */
  systemdKnown(): boolean | undefined {
    return this.systemdOk;
  }
}

class JobGroup implements ContainmentGroup {
  readonly kind = "job" as const;
  private readonly adds = new Set<Promise<boolean>>();
  private closed = false;

  constructor(
    readonly key: string,
    private readonly id: number,
    private readonly helper: JobHelper,
    private readonly marker: string,
    private readonly forget: () => void,
  ) {}

  available(): boolean {
    return !this.closed && this.helper.failed() === undefined;
  }

  env(): Record<string, string> {
    return { [GROUP_MARKER]: this.marker };
  }

  wrapArgv(argv: readonly string[]): string[] {
    return [...argv];
  }

  add(pid: number): Promise<boolean> {
    if (!this.available()) return Promise.resolve(false);
    const adding = this.helper.request("add", this.id, pid).then((answer) => {
      if (answer !== undefined && !answer.ok) log.info("a process did not join its session's job", { pid, why: answer.error });
      return answer?.ok === true;
    });
    this.adds.add(adding);
    void adding.finally(() => this.adds.delete(adding));
    return adding;
  }

  async members(): Promise<ContainedProcess[] | undefined> {
    // An add still in flight is waited for, so a process spawned a moment ago is counted.
    await Promise.allSettled([...this.adds]);
    if (!this.available()) return undefined;
    const answer = await this.helper.request("members", this.id);
    if (answer === undefined || !answer.ok) return undefined;
    return (answer.result as Array<[number, number, string, number | null, number]>).map(([pid, parent, name, started]) => ({
      pid,
      parent,
      name,
      ...(started !== null ? { startedAt: started } : {}),
    }));
  }

  async stopAll(): Promise<boolean> {
    await Promise.allSettled([...this.adds]);
    if (!this.available()) return false;
    return (await this.helper.request("stop", this.id))?.ok === true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.forget();
    if (this.helper.failed() === undefined) void this.helper.request("close", this.id);
  }
}

class ScopeGroup implements ContainmentGroup {
  readonly kind = "systemd-scope" as const;
  private closed = false;
  private scopes = 0;
  /** `-` in a unit name is hierarchy: `jaira-<key>.slice` sits under `jaira.slice`. */
  readonly slice: string;

  constructor(
    readonly key: string,
    private readonly marker: string,
    private readonly containment: Containment,
    private readonly run: CommandRunner,
    private readonly forget: () => void,
  ) {
    this.slice = `jaira-${safeName(key)}.slice`;
  }

  available(): boolean {
    if (this.closed) return false;
    const known = this.containment.systemdKnown();
    if (known === undefined) void this.containment.probeSystemd();
    return known === true;
  }

  env(): Record<string, string> {
    return { [GROUP_MARKER]: this.marker };
  }

  wrapArgv(argv: readonly string[]): string[] {
    if (!this.available()) return [...argv];
    const unit = `jaira_${safeName(this.key)}_${++this.scopes}_${Date.now().toString(36)}`;
    return scopeArgv(this.slice, unit, argv);
  }

  add(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async members(): Promise<ContainedProcess[] | undefined> {
    if (!this.available()) return undefined;
    let shown;
    try {
      shown = await this.run("systemctl", ["--user", "show", this.slice, "-p", "ControlGroup"], 3_000);
    } catch {
      return undefined;
    }
    if (shown.code !== 0) return undefined;
    const path = parseControlGroup(shown.stdout);
    // A slice with nothing running has no cgroup: no members.
    if (path === undefined) return [];
    const pids = cgroupPids(this.containment.cgroupRoot, path);
    if (pids === undefined) return [];
    const boot = bootTimeMs(this.containment.procRoot);
    return pids.map((pid) => procProcess(this.containment.procRoot, pid, boot)).filter((p): p is ContainedProcess => p !== undefined);
  }

  async stopAll(): Promise<boolean> {
    const members = await this.members();
    if (members === undefined) return false;
    const signal = (pids: readonly number[], how: NodeJS.Signals): void => {
      for (const pid of pids) {
        try {
          process.kill(pid, how);
        } catch {
          // Gone already.
        }
      }
    };
    signal(
      members.map((m) => m.pid),
      "SIGTERM",
    );
    const until = Date.now() + 2_000;
    let left = members.map((m) => m.pid).filter(isAlive);
    while (left.length > 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      left = left.filter(isAlive);
    }
    signal(left, "SIGKILL");
    return true;
  }

  close(): void {
    this.closed = true;
    this.forget();
  }
}

class NoGroup implements ContainmentGroup {
  readonly kind = "none" as const;
  constructor(
    readonly key: string,
    private readonly marker: string,
    private readonly forget: () => void,
  ) {}
  available(): boolean {
    return false;
  }
  env(): Record<string, string> {
    return { [GROUP_MARKER]: this.marker };
  }
  wrapArgv(argv: readonly string[]): string[] {
    return [...argv];
  }
  add(): Promise<boolean> {
    return Promise.resolve(false);
  }
  members(): Promise<ContainedProcess[] | undefined> {
    return Promise.resolve(undefined);
  }
  stopAll(): Promise<boolean> {
    return Promise.resolve(false);
  }
  close(): void {
    this.forget();
  }
}

// --- Linux: scopes and cgroups ------------------------------------------------------------------------

/** A key as a systemd unit name may hold it: letters, digits and `_` (`-` would be hierarchy). */
export function safeName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  return safe.length > 0 ? safe : "_";
}

/** The argv that runs `argv` in a new scope `unit` under `slice`. `systemd-run --scope` execs it: the pid stays the command's. */
export function scopeArgv(slice: string, unit: string, argv: readonly string[]): string[] {
  return ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--slice=${slice}`, `--unit=${unit}`, "--", ...argv];
}

/** `systemctl show -p ControlGroup`'s answer (`ControlGroup=/user.slice/…`, or the bare value) as a path; `undefined` when empty. */
export function parseControlGroup(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return undefined;
  const value = line.startsWith("ControlGroup=") ? line.slice("ControlGroup=".length) : line;
  return value.startsWith("/") ? value : undefined;
}

/**
 * Every pid in the cgroup at `path` and the cgroups under it. cgroup v2 at `<root><path>`; a hybrid
 * system's v1 `systemd` hierarchy at `<root>/systemd<path>`. `undefined` when no such directory exists.
 */
export function cgroupPids(root: string, path: string): number[] | undefined {
  const dir = [`${root}${path}`, `${root}/unified${path}`, `${root}/systemd${path}`].find((candidate) => {
    try {
      return statSync(candidate).isDirectory() && existsSync(`${candidate}/cgroup.procs`);
    } catch {
      return false;
    }
  });
  if (dir === undefined) return undefined;
  const pids = new Set<number>();
  const walk = (at: string, depth: number): void => {
    try {
      for (const token of readFileSync(`${at}/cgroup.procs`, "utf8").split(/\s+/)) if (/^\d+$/.test(token)) pids.add(Number(token));
    } catch {
      // Gone while it was being read.
    }
    if (depth > 16) return;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) walk(`${at}/${entry.name}`, depth + 1);
  };
  walk(dir, 0);
  return [...pids].sort((a, b) => a - b);
}

/** Linux's `USER_HZ`: what `/proc/<pid>/stat`'s start time counts in, 100 on every architecture Linux ships. */
const CLOCK_TICKS = 100;

/** `/proc/<pid>/stat` as a process: its name, parent and start (epoch ms, from the boot time `bootMs`). */
export function parseProcStat(text: string, bootMs: number | undefined): ContainedProcess | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // After the name: state (3), ppid (4), … starttime (22).
  const parent = Number(fields[1]);
  const ticks = Number(fields[19]);
  if (!Number.isFinite(pid)) return undefined;
  return {
    pid,
    name: text.slice(open + 1, close),
    ...(Number.isFinite(parent) ? { parent } : {}),
    ...(bootMs !== undefined && Number.isFinite(ticks) ? { startedAt: bootMs + Math.round((ticks * 1000) / CLOCK_TICKS) } : {}),
  };
}

function bootTimeMs(procRoot: string): number | undefined {
  try {
    const match = readFileSync(`${procRoot}/stat`, "utf8").match(/^btime\s+(\d+)/m);
    return match !== null ? Number(match[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function procProcess(procRoot: string, pid: number, bootMs: number | undefined): ContainedProcess | undefined {
  try {
    return parseProcStat(readFileSync(`${procRoot}/${pid}/stat`, "utf8"), bootMs);
  } catch {
    return undefined;
  }
}

function runCommand(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}

function toProcessRow(row: EscapeRow): ProcessRow {
  return {
    pid: row.pid,
    name: row.name.replace(/\.exe$/i, ""),
    ...(row.parent !== undefined ? { parent_pid: row.parent } : {}),
    ...(row.startedAt !== undefined ? { started: new Date(row.startedAt).toISOString() } : {}),
  };
}

// --- the escaped sweep --------------------------------------------------------------------------------

/** A process of the user's that started during a call, outside any tree JaiRA follows. */
export interface Escaped {
  pid: number;
  name: string;
  /** ISO, and epoch ms. */
  started: string;
  startedAt: number;
  parent: number;
  parentName?: string;
  /** Why it counts as escaped, said to the person. */
  why: string;
  /** It and what it started (by parent and start time): what a stop takes. */
  tree: number[];
}

export interface EscapeWindow {
  /** Epoch ms: the call's start. */
  from: number;
  /** Epoch ms: the call's end (now). */
  to: number;
}

export interface EscapeRules {
  platform: NodeJS.Platform;
  /** Windows: the svchost(s) hosting the Task Scheduler (the `Schedule` service). */
  schedulerPids?: ReadonlySet<number>;
  /** POSIX: the user's uid. */
  uid?: number;
  /** Already accounted for: the session's processes, the call's leftovers, the group's members. */
  exclude?: ReadonlySet<number>;
  /** How far outside the window a start may fall (clock and `etime`'s one-second grain). */
  slackMs?: number;
}

const CRON_PARENTS = new Set(["cron", "crond", "atd", "anacron"]);

/** A process name compared across platforms: lower case, no `.exe`. */
function bare(name: string | undefined): string {
  return (name ?? "").toLowerCase().replace(/\.exe$/, "");
}

/**
 * The escaped among `rows` (pure; {@link findEscaped} gathers the rows).
 *
 * - **Windows:** the user's process (where its account can be read) that started in the window and whose
 *   parent is `WmiPrvSE` (WMI's provider host — `Win32_Process.Create`), the svchost running the Task
 *   Scheduler (only when its pid is known: svchost hosts dozens of services that start the user's
 *   programs, `RuntimeBroker` among them, so a bare svchost parent is not enough), or `taskhostw`/`taskeng`
 *   (the Task Scheduler's task hosts). Not covered: a COM server's or Explorer's children
 *   (`ShellWindows.ShellExecute`) — Explorer starts whatever the person opens, and naming those would
 *   list the person's own programs.
 * - **POSIX:** the user's process that started in the window and was re-parented to init (`ppid` 1), or
 *   was started by cron/at, or (Linux) by the user's systemd as a `systemd-run` transient unit
 *   (`run-*.service`/`.scope`) or carrying the session's marker. On macOS `ppid` 1 is launchd, which also
 *   starts the user's XPC services and apps all the time, so there it counts only with the session's
 *   marker in its environment.
 */
export function escapedAmong(rows: readonly EscapeRow[], window: EscapeWindow, rules: EscapeRules): Escaped[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const slack = rules.slackMs ?? (rules.platform === "win32" ? 250 : 1_500);
  const out: Escaped[] = [];
  for (const row of rows) {
    if (rules.exclude?.has(row.pid) === true) continue;
    if (row.startedAt === undefined || row.startedAt < window.from - slack || row.startedAt > window.to + slack) continue;
    if (row.parent === undefined || row.parent === row.pid) continue;
    const parent = byPid.get(row.parent);
    // A parent younger than its child is a reused pid: not the program that started it.
    if (parent?.startedAt !== undefined && parent.startedAt > row.startedAt + slack) continue;
    const why = rules.platform === "win32" ? windowsWhy(row, parent, rules) : posixWhy(row, parent, rules);
    if (why === undefined) continue;
    out.push({
      pid: row.pid,
      name: row.name,
      started: new Date(row.startedAt).toISOString(),
      startedAt: row.startedAt,
      parent: row.parent,
      ...(parent !== undefined ? { parentName: parent.name } : {}),
      why: row.marked === true ? `${why}; it carries this session's marker` : why,
      tree: [row.pid, ...treeUnder(rows, row)],
    });
  }
  return out;
}

function windowsWhy(row: EscapeRow, parent: EscapeRow | undefined, rules: EscapeRules): string | undefined {
  if (row.mine === false) return undefined;
  const name = bare(parent?.name);
  if (name === "wmiprvse") return "started through WMI: its parent is WmiPrvSE, the WMI provider host, so it is in no tree JaiRA follows";
  if (rules.schedulerPids?.has(row.parent!) === true) return "started by the Task Scheduler: its parent is the svchost running the Schedule service";
  if (name === "taskhostw" || name === "taskeng") return `started by a scheduled task: its parent is ${parent!.name}, the Task Scheduler's task host`;
  return undefined;
}

function posixWhy(row: EscapeRow, parent: EscapeRow | undefined, rules: EscapeRules): string | undefined {
  if (rules.uid !== undefined && row.uid !== undefined && row.uid !== rules.uid) return undefined;
  if (row.parent === 1) {
    if (rules.platform === "darwin") return row.marked === true ? "re-parented to launchd (pid 1): what started it let it go" : undefined;
    return "re-parented to init (pid 1): what started it let it go";
  }
  const name = bare(parent?.name);
  if (CRON_PARENTS.has(name)) return `started by ${parent!.name}`;
  if (rules.platform === "linux" && name === "systemd" && (parent!.uid === undefined || rules.uid === undefined || parent!.uid === rules.uid)) {
    if (row.unit !== undefined && /^run-[^/]+\.(service|scope)$/.test(row.unit)) return `started by the user's systemd as ${row.unit} (systemd-run)`;
    if (row.marked === true) return "re-parented to the user's systemd: what started it let it go";
  }
  return undefined;
}

/** What `top` started, by parent pid and start time, among `rows`. */
function treeUnder(rows: readonly EscapeRow[], top: EscapeRow): number[] {
  const byParent = new Map<number, EscapeRow[]>();
  for (const row of rows) if (row.parent !== undefined) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row]);
  const out: number[] = [];
  const queue: EscapeRow[] = [top];
  for (let i = 0; i < queue.length && i < 10_000; i++) {
    const at = queue[i]!;
    for (const child of byParent.get(at.pid) ?? []) {
      if (child.pid === at.pid || child.pid === top.pid || out.includes(child.pid)) continue;
      if (child.startedAt === undefined || at.startedAt === undefined || child.startedAt < at.startedAt) continue;
      out.push(child.pid);
      queue.push(child);
    }
  }
  return out;
}

export interface FindEscapedOptions {
  platform?: NodeJS.Platform;
  /** Windows: the engine's containment — its helper's snapshot is preferred (cheap, with accounts). */
  containment?: Containment;
  /** Windows, without a helper: the System tools' process list (a PowerShell start). */
  lister?: ProcessLister;
  /** The session's group: its members are left out, and its marker confirms a POSIX candidate. */
  group?: ContainmentGroup;
  /** Already accounted for: the session's processes, the call's leftovers. */
  exclude?: Iterable<number>;
  /** POSIX: replaces `ps` and `/proc` (tests). */
  posixRows?: (marker: string | undefined) => Promise<EscapeRow[]>;
  /** POSIX: the user's uid. */
  uid?: number;
}

/**
 * The processes of the user's that started during `window` outside any tree JaiRA follows (ruling 7):
 * listed under the session as `escaped`, with {@link Escaped.why}, so the person sees them and can stop
 * them. Best-effort: a list that cannot be read answers `[]`.
 */
export async function findEscaped(window: EscapeWindow, options: FindEscapedOptions = {}): Promise<Escaped[]> {
  const platform = options.platform ?? process.platform;
  const exclude = new Set(options.exclude ?? []);
  try {
    const members = options.group?.available() === true ? await options.group.members() : undefined;
    for (const member of members ?? []) exclude.add(member.pid);
    if (platform === "win32") {
      let rows: EscapeRow[] | undefined;
      const schedulerPids = new Set<number>();
      const snapshot = options.containment !== undefined ? await options.containment.snapshot() : undefined;
      if (snapshot !== undefined) {
        rows = snapshot.rows;
        if (snapshot.schedule !== undefined) schedulerPids.add(snapshot.schedule);
      } else if (options.lister !== undefined) {
        const [listed, scheduler] = await Promise.all([options.lister(), schedulerPidBySc()]);
        rows = listed.map(fromProcessRow);
        if (scheduler !== undefined) schedulerPids.add(scheduler);
      }
      if (rows === undefined) return [];
      return escapedAmong(rows, window, { platform, schedulerPids, exclude });
    }
    const marker = options.group?.env()[GROUP_MARKER];
    const uid = options.uid ?? process.getuid?.();
    const rows = options.posixRows !== undefined ? await options.posixRows(marker) : await posixEscapeRows(window, platform, uid, marker);
    return escapedAmong(rows, window, { platform, exclude, ...(uid !== undefined ? { uid } : {}) });
  } catch (error) {
    log.warn("could not look for processes that escaped a call", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

function fromProcessRow(row: ProcessRow): EscapeRow {
  const started = row.started !== undefined ? Date.parse(row.started) : Number.NaN;
  return { pid: row.pid, name: row.name, ...(row.parent_pid !== undefined ? { parent: row.parent_pid } : {}), ...(Number.isNaN(started) ? {} : { startedAt: started }) };
}

/** `sc queryex Schedule`'s PID: the Task Scheduler's svchost, without WMI. */
export function schedulerPidBySc(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("sc.exe", ["queryex", "Schedule"], { encoding: "utf8", timeout: 3_000, windowsHide: true }, (error, stdout) => {
      if (error !== null) return resolve(undefined);
      const match = stdout.match(/PID\s*:\s*(\d+)/);
      const pid = match !== null ? Number(match[1]) : 0;
      resolve(pid > 0 ? pid : undefined);
    });
  });
}

/** `ps -A -o pid=,ppid=,uid=,etime=,comm=`'s rows, the time now `now`. */
export function parsePsEscapeRows(text: string, now: number): EscapeRow[] {
  const rows: EscapeRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), parent: Number(m[2]), uid: Number(m[3]), startedAt: now - cpuSecondsOf(m[4]!) * 1000, name: m[5]!.trim().split("/").pop()! });
  }
  return rows;
}

/** The POSIX rows, with the environment marker and (Linux) unit read for the few that could count. */
async function posixEscapeRows(window: EscapeWindow, platform: NodeJS.Platform, uid: number | undefined, marker: string | undefined): Promise<EscapeRow[]> {
  const now = Date.now();
  const text = await new Promise<string>((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,uid=,etime=,comm="], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => resolve(error === null ? stdout : ""));
  });
  const rows = parsePsEscapeRows(text, now);
  const candidates = rows.filter((row) => (uid === undefined || row.uid === uid) && row.startedAt! >= window.from - 1_500 && row.startedAt! <= window.to + 1_500);
  if (candidates.length === 0) return rows;
  const needle = marker !== undefined ? `${GROUP_MARKER}=${marker}` : undefined;
  if (platform === "linux") {
    for (const row of candidates) {
      try {
        const cgroup = readFileSync(`/proc/${row.pid}/cgroup`, "utf8").trim().split("\n").pop() ?? "";
        const unit = cgroup.split("/").pop();
        if (unit !== undefined && unit.length > 0) row.unit = unit;
      } catch {
        // Gone, or not ours to read.
      }
      if (needle !== undefined) {
        try {
          row.marked = readFileSync(`/proc/${row.pid}/environ`, "utf8").split("\0").includes(needle);
        } catch {
          // Not ours to read.
        }
      }
    }
  } else if (needle !== undefined) {
    // macOS: `ps -E` appends a process's environment to its command, for the user's own processes.
    const withEnv = await new Promise<string>((resolve) => {
      execFile("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", candidates.map((c) => c.pid).join(",")], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error === null ? stdout : ""));
    });
    const marked = new Set(
      withEnv
        .split("\n")
        .filter((line) => line.includes(needle))
        .map((line) => Number(line.trim().split(/\s+/)[0])),
    );
    for (const row of candidates) row.marked = marked.has(row.pid);
  }
  return rows;
}

/**
 * Whether a call is worth a sweep after it ends — what keeps it cheap.
 *
 * - **POSIX:** always: one `ps`, tens of milliseconds.
 * - **Windows:** when the containment helper is up (its snapshot costs a few milliseconds), or when the
 *   line names a way of having another program start a process, or runs a script file that could
 *   ({@link mayEscape}) — then the System tools' list, a PowerShell start, is worth its second.
 */
export function escapeSweepWorthIt(command: string, dialect: "posix" | "powershell", options: { platform?: NodeJS.Platform; containment?: Containment } = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return true;
  if (options.containment?.snapshotReady() === true) return true;
  return mayEscape(command, dialect);
}

/** Whether a line names a way of having ANOTHER program start a process, or runs a script that could. A cheap reading, not the policy's. */
export function mayEscape(command: string, dialect: "posix" | "powershell"): boolean {
  if (dialect === "powershell") {
    return /\b(invoke-cimmethod|invoke-wmimethod|wmic|win32_process|winmgmts|\[wmiclass\]|schtasks|register-scheduledtask|new-scheduledtask\w*|start-scheduledtask|register-scheduledjob|cscript|wscript|mshta)\b|\.(ps1|bat|cmd|vbs|vbe|wsf|hta)\b/i.test(command);
  }
  return /(^|[\s;&|(])(at|batch|crontab|systemd-run|launchctl|setsid|disown|daemonize|nohup)\b/.test(command);
}
