/**
 * Containment of a session's processes and the escaped sweep (decision 0032, ruling 7). Live on the
 * platform the suite runs on (a Job Object on Windows); the Linux and macOS parts from fixtures.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Containment,
  GROUP_MARKER,
  cgroupPids,
  escapedAmong,
  escapeSweepWorthIt,
  findEscaped,
  mayEscape,
  parseControlGroup,
  parseProcStat,
  parsePsEscapeRows,
  safeName,
  scopeArgv,
  type CommandRunner,
  type EscapeRow,
} from "../src/containment";
import { findLeftRunning, isAlive, leftAmongMembers, topsOf } from "../src/leftRunning";

const win = process.platform === "win32";
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await wait(100);
  }
  return check();
}

const strays: number[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Gone.
    }
  }
  for (const kid of kids.splice(0)) kid.kill();
});

describe.runIf(win)("a session's Job Object (Windows)", () => {
  const containment = new Containment();
  afterAll(() => containment.close());

  it("holds a child and the grandchild it starts detached; stopAll ends both", async () => {
    expect(await containment.ready()).toBe("job");
    const group = containment.group("job-test");
    // The child waits for a line before it starts the grandchild, so it is in the job first.
    const code = `
      process.stdin.once('data', () => {
        const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        g.unref();
        console.log(g.pid);
      });
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    kids.push(child);
    expect(await group.add(child.pid!)).toBe(true);
    const grandchild = await new Promise<number>((resolve) => {
      child.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      child.stdin!.write("go\n");
    });
    strays.push(grandchild);
    const members = await group.members();
    expect(members?.map((m) => m.pid)).toEqual(expect.arrayContaining([child.pid, grandchild]));
    expect(members?.find((m) => m.pid === grandchild)).toMatchObject({ parent: child.pid, name: expect.stringMatching(/node/i) });

    // What the walk alone would find of a call that ended, and what membership adds.
    const left = await findLeftRunning(child.pid!, Date.now() - 5_000, undefined, "win32", { group });
    expect(left.map((p) => p.pid)).toContain(grandchild);

    expect(await group.stopAll()).toBe(true);
    expect(await until(() => !isAlive(child.pid!) && !isAlive(grandchild), 5_000)).toBe(true);
    group.close();
  }, 60_000);

  it("holds what a PowerShell line starts with Start-Process, and a second shell of the same session", async () => {
    expect(await containment.ready()).toBe("job");
    const group = containment.group("start-process-test");
    const first = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    kids.push(first);
    expect(await group.add(first.pid!)).toBe(true);
    const callStarted = Date.now();
    const line = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList '-e','setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru; $p.Id`;
    const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    kids.push(shell);
    // A non-empty job takes a second process: both are in Node's own job, which the session's nests in.
    expect(await group.add(shell.pid!)).toBe(true);
    let out = "";
    shell.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => shell.on("exit", resolve));
    const started = Number(out.trim().split(/\s+/).pop());
    strays.push(started);
    const members = (await group.members())!.map((m) => m.pid);
    expect(members).toEqual(expect.arrayContaining([first.pid, started]));
    // The call's leftover, from membership alone (no lister): the first process is the session's other.
    const left = await findLeftRunning(shell.pid!, callStarted, undefined, "win32", { group, exclude: [first.pid!] });
    expect(topsOf(left).map((p) => p.pid)).toEqual([started]);
    expect(await group.stopAll()).toBe(true);
    expect(await until(() => !isAlive(first.pid!) && !isAlive(started), 5_000)).toBe(true);
    group.close();
  }, 60_000);

  it("does not hold what WMI starts, and the sweep finds it in the call's window", async () => {
    expect(await containment.ready()).toBe("job");
    const group = containment.group("wmi-test");
    const from = Date.now();
    const line = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"${process.execPath}" -e "setInterval(() => {}, 1000)"' }; $r.ProcessId`;
    const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    kids.push(shell);
    expect(await group.add(shell.pid!)).toBe(true);
    let out = "";
    shell.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((resolve) => shell.on("exit", resolve));
    const escapedPid = Number(out.trim().split(/\s+/).pop());
    expect(escapedPid).toBeGreaterThan(0);
    strays.push(escapedPid);
    const to = Date.now();

    const members = (await group.members()) ?? [];
    expect(members.map((m) => m.pid)).not.toContain(escapedPid);

    const escaped = await findEscaped({ from, to }, { platform: "win32", containment, group });
    const found = escaped.find((e) => e.pid === escapedPid);
    expect(found).toMatchObject({ name: expect.stringMatching(/node/i), parentName: expect.stringMatching(/wmiprvse/i), why: expect.stringMatching(/WMI/) });
    // Outside its window, it is not this call's.
    expect((await findEscaped({ from: to + 60_000, to: to + 120_000 }, { platform: "win32", containment })).some((e) => e.pid === escapedPid)).toBe(false);
    group.close();
  }, 90_000);

  it("gives the walk its process list from the helper", async () => {
    expect(await containment.ready()).toBe("job");
    const rows = await containment.lister()!();
    expect(rows.find((r) => r.pid === process.pid)).toMatchObject({ name: expect.stringMatching(/node/i), started: expect.any(String) });
  }, 30_000);
});

describe.runIf(win)("a helper that fails", () => {
  it("a helper that never starts: add resolves within its deadline and the group is unavailable", async () => {
    const containment = new Containment({ helper: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, helperStartMs: 500 });
    const group = containment.group("never");
    const at = Date.now();
    expect(await group.add(process.pid)).toBe(false);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(group.available()).toBe(false);
    expect(await group.members()).toBeUndefined();
    expect(await group.stopAll()).toBe(false);
    expect(await containment.ready()).toBe("none");
    containment.close();
  }, 20_000);

  it("a helper that starts and then never answers: the request's deadline ends it", async () => {
    const containment = new Containment({ helper: { command: process.execPath, args: ["-e", "console.log(JSON.stringify({ ready: true })); setInterval(() => {}, 1000)"] }, helperRequestMs: 400 });
    expect(await containment.ready()).toBe("job");
    const group = containment.group("mute");
    const at = Date.now();
    expect(await group.add(process.pid)).toBe(false);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(group.available()).toBe(false);
    expect(await containment.snapshot()).toBeUndefined();
    containment.close();
  }, 20_000);
});

describe("Linux: a systemd scope per spawn, a slice per session", () => {
  it("wraps argv once the probe says systemd-run works, and not before or without it", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: "" };
    };
    const containment = new Containment({ platform: "linux", run });
    const group = containment.group("t-j37e92m83j");
    expect(group.wrapArgv(["bash", "-c", "x"])).toEqual(["bash", "-c", "x"]);
    expect(await containment.ready()).toBe("systemd-scope");
    const wrapped = group.wrapArgv(["bash", "-c", "x"]);
    expect(wrapped.slice(0, 6)).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice=jaira-t_j37e92m83j.slice"]);
    expect(wrapped[6]).toMatch(/^--unit=jaira_t_j37e92m83j_1_/);
    expect(wrapped.slice(7)).toEqual(["--", "bash", "-c", "x"]);
    expect(calls[0]).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--", "true"]);
    expect(group.env()[GROUP_MARKER]).toMatch(/^t_j37e92m83j\.[0-9a-f]{12}$/);

    const none = new Containment({ platform: "linux", run: async () => ({ code: 1, stdout: "" }) });
    expect(await none.ready()).toBe("none");
    expect(none.group("x").wrapArgv(["sh"])).toEqual(["sh"]);
    expect(await none.group("x").members()).toBeUndefined();
  });

  it("reads members from the slice's cgroup and /proc", async () => {
    const root = mkdtempSync(join(tmpdir(), "jaira-cgroup-"));
    try {
      const slice = "/user.slice/user-1000.slice/user@1000.service/jaira.slice/jaira-s.slice";
      mkdirSync(join(root, "cg", slice, "jaira_s_1.scope"), { recursive: true });
      writeFileSync(join(root, "cg", slice, "cgroup.procs"), "");
      writeFileSync(join(root, "cg", slice, "jaira_s_1.scope", "cgroup.procs"), "4100\n4200\n");
      mkdirSync(join(root, "proc", "4100"), { recursive: true });
      mkdirSync(join(root, "proc", "4200"), { recursive: true });
      writeFileSync(join(root, "proc", "stat"), "cpu 1 2 3\nbtime 1700000000\n");
      writeFileSync(join(root, "proc", "4100", "stat"), "4100 (bash) S 1 4100 4100 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0");
      writeFileSync(join(root, "proc", "4200", "stat"), "4200 (npm run dev) S 4100 4200 4100 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 12400 0 0");
      const run: CommandRunner = async (file, args) => (file === "systemctl" ? { code: 0, stdout: `ControlGroup=${slice}\n` } : { code: 0, stdout: "" });
      const containment = new Containment({ platform: "linux", run, cgroupRoot: join(root, "cg"), procRoot: join(root, "proc") });
      await containment.ready();
      const members = await containment.group("s").members();
      expect(members).toEqual([
        { pid: 4100, name: "bash", parent: 1, startedAt: 1_700_000_000_000 + 123_450 },
        { pid: 4200, name: "npm run dev", parent: 4100, startedAt: 1_700_000_000_000 + 124_000 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses what systemctl and /proc say", () => {
    expect(parseControlGroup("ControlGroup=/a/b.slice\n")).toBe("/a/b.slice");
    expect(parseControlGroup("/a/b.slice")).toBe("/a/b.slice");
    expect(parseControlGroup("ControlGroup=\n")).toBeUndefined();
    expect(parseProcStat("7 (a) b) R 3 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 500 0", 1_000)).toEqual({ pid: 7, name: "a) b", parent: 3, startedAt: 6_000 });
    expect(cgroupPids("/nonexistent-root", "/x")).toBeUndefined();
    expect(safeName("a-b/c d")).toBe("a_b_c_d");
    expect(scopeArgv("s.slice", "u", ["x"])).toEqual(["systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice=s.slice", "--unit=u", "--", "x"]);
  });
});

describe("macOS: no containment", () => {
  it("answers unavailable cleanly", async () => {
    const containment = new Containment({ platform: "darwin" });
    expect(await containment.ready()).toBe("none");
    const group = containment.group("m");
    expect(group.kind).toBe("none");
    expect(group.available()).toBe(false);
    expect(group.wrapArgv(["zsh"])).toEqual(["zsh"]);
    expect(await group.add(123)).toBe(false);
    expect(await group.members()).toBeUndefined();
    expect(await group.stopAll()).toBe(false);
  });
});

describe("leftovers among a group's members", () => {
  const members = [
    // The live shell (excluded) and what it runs.
    { pid: 10, name: "bash", startedAt: 1_000 },
    { pid: 11, parent: 10, name: "sleep", startedAt: 5_500 },
    // The call: its root 20 has exited; 21 is its child, 22 a daemon whose parent (a double fork) is gone.
    { pid: 21, parent: 20, name: "node", startedAt: 5_100 },
    { pid: 22, parent: 1, name: "server", startedAt: 5_200 },
    // A background process from before the call.
    { pid: 30, parent: 2, name: "vite", startedAt: 2_000 },
  ];
  it("walks from the call, adds what started during it, and leaves out the session's others", () => {
    expect(leftAmongMembers(members, 20, 5_000, [10, 30]).map((p) => p.pid)).toEqual([21, 22]);
  });
});

describe("the escaped sweep", () => {
  const window = { from: 10_000, to: 20_000 };
  it("Windows: a child of WmiPrvSE, of the Scheduler's svchost or taskhostw — the user's, in the window", () => {
    const rows: EscapeRow[] = [
      { pid: 900, name: "WmiPrvSE.exe" },
      { pid: 800, name: "svchost.exe", startedAt: 1 },
      { pid: 801, name: "svchost.exe", startedAt: 1 },
      { pid: 700, name: "taskhostw.exe", parent: 800, startedAt: 5_000 },
      { pid: 1, parent: 900, name: "node.exe", startedAt: 12_000, mine: true },
      { pid: 2, parent: 1, name: "conhost.exe", startedAt: 12_001, mine: true },
      { pid: 3, parent: 800, name: "updater.exe", startedAt: 13_000, mine: true },
      { pid: 4, parent: 801, name: "RuntimeBroker.exe", startedAt: 13_000, mine: true },
      { pid: 5, parent: 700, name: "script.exe", startedAt: 14_000 },
      { pid: 6, parent: 900, name: "old.exe", startedAt: 2_000, mine: true },
      { pid: 7, parent: 900, name: "theirs.exe", startedAt: 12_000, mine: false },
      { pid: 8, parent: 900, name: "known.exe", startedAt: 12_000, mine: true },
    ];
    const found = escapedAmong(rows, window, { platform: "win32", schedulerPids: new Set([800]), exclude: new Set([8]) });
    expect(found.map((e) => [e.pid, e.tree])).toEqual([
      [1, [1, 2]],
      [3, [3]],
      [5, [5]],
    ]);
    expect(found[0]!.why).toMatch(/WMI/);
    expect(found[1]!.why).toMatch(/Task Scheduler/);
    // Without the Scheduler's pid, a bare svchost parent is not enough.
    expect(escapedAmong(rows, window, { platform: "win32", exclude: new Set([8]) }).map((e) => e.pid)).toEqual([1, 5]);
  });

  it("Linux: re-parented to init, cron's, systemd-run's, or marked under the user's systemd", () => {
    const rows: EscapeRow[] = [
      { pid: 1, name: "systemd", uid: 0 },
      { pid: 500, parent: 1, name: "systemd", uid: 1000, startedAt: 1 },
      { pid: 600, parent: 1, name: "cron", uid: 0, startedAt: 1 },
      { pid: 41, parent: 1, name: "node", uid: 1000, startedAt: 12_000 },
      { pid: 42, parent: 1, name: "root-daemon", uid: 0, startedAt: 12_000 },
      { pid: 43, parent: 600, name: "sh", uid: 1000, startedAt: 12_000 },
      { pid: 44, parent: 500, name: "server", uid: 1000, startedAt: 12_000, unit: "run-r1a2b.service" },
      { pid: 45, parent: 500, name: "dbus-thing", uid: 1000, startedAt: 12_000, unit: "dbus-:1.2.service" },
      { pid: 46, parent: 500, name: "daemon", uid: 1000, startedAt: 12_000, marked: true },
    ];
    expect(escapedAmong(rows, window, { platform: "linux", uid: 1000 }).map((e) => e.pid)).toEqual([41, 43, 44, 46]);
  });

  it("macOS: launchd's children count only with the session's marker", () => {
    const rows: EscapeRow[] = [
      { pid: 51, parent: 1, name: "com.apple.xpc", uid: 501, startedAt: 12_000 },
      { pid: 52, parent: 1, name: "node", uid: 501, startedAt: 12_000, marked: true },
    ];
    expect(escapedAmong(rows, window, { platform: "darwin", uid: 501 }).map((e) => e.pid)).toEqual([52]);
  });

  it("reads ps's rows", () => {
    const rows = parsePsEscapeRows("  41     1  1000       00:05 node\n  42     1  1000  1-02:00:00 /usr/bin/Some App\n", 100_000);
    expect(rows).toEqual([
      { pid: 41, parent: 1, uid: 1000, startedAt: 95_000, name: "node" },
      { pid: 42, parent: 1, uid: 1000, startedAt: 100_000 - 93_600_000, name: "Some App" },
    ]);
  });

  it("POSIX sweeps go through the injected rows and leave out the excluded", async () => {
    const rows: EscapeRow[] = [{ pid: 41, parent: 1, name: "node", uid: 1000, startedAt: 12_000 }];
    expect(await findEscaped(window, { platform: "linux", uid: 1000, posixRows: async () => rows })).toHaveLength(1);
    expect(await findEscaped(window, { platform: "linux", uid: 1000, posixRows: async () => rows, exclude: [41] })).toEqual([]);
  });

  it("is worth it on POSIX always, on Windows when cheap or the line names an escape", () => {
    expect(escapeSweepWorthIt("ls", "posix", { platform: "linux" })).toBe(true);
    expect(escapeSweepWorthIt("git status", "powershell", { platform: "win32" })).toBe(false);
    expect(mayEscape("Invoke-CimMethod -ClassName Win32_Process -MethodName Create", "powershell")).toBe(true);
    expect(mayEscape("schtasks /create /tn x", "powershell")).toBe(true);
    expect(mayEscape("./setup.ps1", "powershell")).toBe(true);
    expect(mayEscape("npm run dev", "powershell")).toBe(false);
    expect(mayEscape("echo x | at now", "posix")).toBe(true);
    expect(mayEscape("setsid ./server", "posix")).toBe(true);
    expect(mayEscape("cat file", "posix")).toBe(false);
  });
});

