/**
 * Reading a process JaiRA did not spawn (decision 0032, ruling 6): where its output goes, placed from
 * each platform's answer (fixtures for Linux's `/proc` links and macOS' `lsof`), a console's screen
 * compared with the last, and — with real processes this machine can start — a file followed from its
 * history on, a pipe refused with why, and on Windows a console read by attaching to it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, openSync, closeSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ExecServices } from "@declarative-ai/exec";
import { consoleDelta, lsofTargets, outputSourceFor, procLinkTarget, ProcessOutputs, type FollowedRead, type OutputSource } from "../src/processOutput";
import { createSystemTools } from "../src/systemTools";
import { WindowsSystem } from "../src/system/windows";

const NO_CTX = undefined as unknown as ExecServices;
const win = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "jaira-output-"));
const children: ChildProcess[] = [];
const outputs: ProcessOutputs[] = [];
const extraPids: number[] = [];

afterEach(() => {
  for (const o of outputs.splice(0)) o.stopAll();
  for (const c of children.splice(0)) c.kill();
  for (const pid of extraPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Gone.
    }
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keep = (o: ProcessOutputs): ProcessOutputs => (outputs.push(o), o);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A node script that prints `tick <n>` every 200 ms, as a file (no quoting through any shell). */
function ticker(name: string, lines = "let n = 0; setInterval(() => console.log('tick ' + ++n), 200);"): string {
  const file = join(dir, `${name}.js`);
  writeFileSync(file, lines);
  return file;
}

describe("where output goes", () => {
  it("places Linux's /proc links", () => {
    expect(procLinkTarget("/var/log/app.log", undefined, true, "file")).toEqual({ kind: "file", path: "/var/log/app.log" });
    expect(procLinkTarget("/var/log/app.log (deleted)", undefined, true, "file")).toEqual({ kind: "file", path: "/var/log/app.log" });
    expect(procLinkTarget("pipe:[48213]")).toEqual({ kind: "pipe" });
    expect(procLinkTarget("socket:[9911]")).toEqual({ kind: "socket" });
    expect(procLinkTarget("/dev/pts/3", undefined, true, "char")).toEqual({ kind: "tty", path: "/dev/pts/3" });
    expect(procLinkTarget("/dev/tty1")).toEqual({ kind: "tty", path: "/dev/tty1" });
    expect(procLinkTarget("/dev/null", undefined, true, "char")).toEqual({ kind: "none" });
    expect(procLinkTarget("/tmp/fifo", undefined, true, "fifo")).toEqual({ kind: "pipe" });
    expect(procLinkTarget("anon_inode:[eventfd]")).toEqual({ kind: "none" });
    expect(procLinkTarget(undefined, "EACCES")).toMatchObject({ kind: "denied", why: expect.stringMatching(/another account/) });
    expect(procLinkTarget(undefined, "ENOENT", true)).toEqual({ kind: "none" });
    expect(procLinkTarget(undefined, "ENOENT", false)).toMatchObject({ kind: "denied", why: "it is not running" });
  });

  it("places macOS' lsof -F ftn", () => {
    const fixture = ["p812", "f1", "tREG", "n/Users/me/server.log", "f2", "tCHR", "n/dev/ttys004", ""].join("\n");
    expect(lsofTargets(fixture)).toEqual({ stdout: { kind: "file", path: "/Users/me/server.log" }, stderr: { kind: "tty", path: "/dev/ttys004" } });
    expect(lsofTargets(["p9", "f1", "tPIPE", "n->0x1234", "f2", "tunix", "n->0x5678"].join("\n"))).toEqual({ stdout: { kind: "pipe" }, stderr: { kind: "socket" } });
    expect(lsofTargets(["p9", "f1", "tCHR", "n/dev/null"].join("\n"))).toEqual({ stdout: { kind: "none" }, stderr: { kind: "none" } });
    expect(lsofTargets("", "lsof: no such process")).toEqual({ stdout: { kind: "denied", why: "lsof: no such process" }, stderr: { kind: "denied", why: "lsof: no such process" } });
  });
});

describe("a console compared with its last look", () => {
  it("says the growth of the cursor's row and the rows after it", () => {
    expect(consoleDelta(["a", "b", "c"], ["a", "b", "c"])).toBe("");
    expect(consoleDelta(["a", "b", "c"], ["a", "b", "cd", "e"])).toBe("d\ne");
    expect(consoleDelta(["a", "b", ""], ["a", "b", "c", ""])).toBe("c\n");
  });

  it("follows a scroll off the top", () => {
    expect(consoleDelta(["1", "2", "3", "4"], ["3", "4", "5", "6"])).toBe("\n5\n6");
  });

  it("says a rewritten last row again, and a cleared screen whole", () => {
    expect(consoleDelta(["a", "progress 10%"], ["a", "progress 20%"])).toBe("\nprogress 20%");
    expect(consoleDelta(["x", "y", "z"], ["fresh"])).toBe("\nfresh");
  });
});

describe("following a file (a source told where)", () => {
  it("answers its history, then what is new; tail and since; a file cut back is read again", async () => {
    const log = join(dir, "told.log");
    writeFileSync(log, "one\ntwo\n");
    const source: OutputSource = { targets: async () => ({ stdout: { kind: "file", path: log }, stderr: { kind: "file", path: log } }) };
    const o = keep(new ProcessOutputs(source, { alive: () => true, filePollMs: 50 }));
    const first = (await o.read(4242)) as FollowedRead;
    expect(first).toMatchObject({ source: "file", path: log, whole: true, running: true, output: "one\ntwo\n", stdout: `file ${log}` });
    expect(Date.parse(first.from)).toBeGreaterThan(0);
    appendFileSync(log, "three\n");
    const second = (await o.read(4242)) as FollowedRead;
    expect(second.output).toBe("three\n");
    expect(((await o.read(4242, { tail: 2 })) as FollowedRead).output).toBe("two\nthree\n");
    expect(((await o.read(4242, { since: first.offset })) as FollowedRead).output).toBe("three\n");
    truncateSync(log, 0);
    appendFileSync(log, "again\n");
    const cut = (await o.read(4242)) as FollowedRead;
    expect(cut.output).toBe("again\n");
    expect(cut.notes?.[0]).toMatch(/cut back/);
  });

  it("waits for a pattern over what comes after the last read, and ends with its process", async () => {
    const log = join(dir, "waited.log");
    writeFileSync(log, "starting\n");
    let alive = true;
    const o = keep(new ProcessOutputs({ targets: async () => ({ stdout: { kind: "file", path: log }, stderr: { kind: "none" } }) }, { alive: () => alive, filePollMs: 50 }));
    await o.read(77);
    setTimeout(() => appendFileSync(log, "listening on 3000\n"), 150);
    const ready = await o.wait(77, /listening on (\d+)/, 5_000);
    expect(ready).toMatchObject({ matched: true, timedOut: false, match: "listening on 3000" });
    const none = await o.wait(77, /never/, 200);
    expect(none).toMatchObject({ matched: false, timedOut: true });
    alive = false;
    appendFileSync(log, "bye\n");
    const ended = await o.wait(77, /never/, 5_000);
    expect(ended).toMatchObject({ matched: false, timedOut: false, running: false, output: "bye\n" });
  });

  it("answers why for output it cannot read, and refuses to wait on it for output", async () => {
    const o = keep(new ProcessOutputs({ targets: async () => ({ stdout: { kind: "pipe" }, stderr: { kind: "tty", path: "/dev/pts/2" } }) }, { alive: () => true }));
    expect(await o.read(5)).toMatchObject({ source: "unreadable", output: null, why: expect.stringMatching(/stdout: its output goes to a pipe another program holds; stderr: .*terminal \(\/dev\/pts\/2\)/) });
    await expect(o.wait(5, /x/, 100)).rejects.toThrow(/cannot be read.*until: exit/);
    expect(o.followed()).toEqual([]);
  });
});

describe.skipIf(!win)("another program on Windows, for real", () => {
  const backend = new WindowsSystem();
  const source = outputSourceFor(backend)!;

  it("follows a program whose output goes to a file, from its history on", async () => {
    const log = join(dir, "real.log");
    const fd = openSync(log, "w");
    const child = spawn(process.execPath, [ticker("real")], { stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    children.push(child);
    await sleep(900);
    const o = keep(new ProcessOutputs(source, { filePollMs: 100 }));
    const first = (await o.read(child.pid!)) as FollowedRead;
    expect(first).toMatchObject({ source: "file", whole: true, running: true });
    expect(first.path!.toLowerCase()).toBe(log.toLowerCase());
    expect(first.output).toMatch(/^tick 1\ntick 2\n/);
    const seen = first.output.trim().split("\n").length;
    await sleep(600);
    const second = (await o.read(child.pid!)) as FollowedRead;
    expect(second.output).toMatch(new RegExp(`^tick ${seen + 1}\\n`));
    const waited = await o.wait(child.pid!, /tick \d*0\n/, 5_000);
    expect(waited.matched).toBe(true);
  }, 30_000);

  it("says a pipe another program holds is unreadable", async () => {
    const child = spawn(process.execPath, [ticker("piped")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.push(child);
    const o = keep(new ProcessOutputs(source));
    expect(await o.read(child.pid!)).toMatchObject({ source: "unreadable", output: null, why: "its output goes to a pipe another program holds" });
  }, 30_000);

  it("says the null device goes nowhere", async () => {
    const child = spawn(process.execPath, [ticker("nowhere")], { stdio: "ignore", windowsHide: true });
    children.push(child);
    expect(await source.targets(child.pid!)).toEqual({ stdout: { kind: "none" }, stderr: { kind: "none" } });
  }, 30_000);

  it("reads a console program's screen by attaching to it, then what is new", async () => {
    const script = ticker("console");
    const pid = Number(
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Start-Process -WindowStyle Hidden -PassThru -FilePath $env:JAIRA_NODE -ArgumentList $env:JAIRA_SCRIPT).Id"], {
        encoding: "utf8",
        env: { ...process.env, JAIRA_NODE: process.execPath, JAIRA_SCRIPT: `"${script}"` },
        windowsHide: true,
      }).trim(),
    );
    extraPids.push(pid);
    await sleep(1_000);
    expect(await source.targets(pid)).toEqual({ stdout: { kind: "console" }, stderr: { kind: "console" } });
    const o = keep(new ProcessOutputs(source, { consolePollMs: 300 }));
    const first = (await o.read(pid)) as FollowedRead;
    expect(first).toMatchObject({ source: "console", whole: false, stdout: "console" });
    expect(first.output).toMatch(/^tick 1\ntick 2/);
    const waited = await o.wait(pid, /tick \d*5\b/, 10_000);
    expect(waited.matched).toBe(true);
  }, 60_000);

  it("reads through read_process at scope all, and refuses a process outside the scope asked", async () => {
    const log = join(dir, "tool.log");
    const fd = openSync(log, "w");
    const child = spawn(process.execPath, [ticker("tool")], { stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    children.push(child);
    await sleep(500);
    const tools = createSystemTools({ backend });
    const read = (await tools["read_process"]!.run({ pid: child.pid!, scope: "all" }, NO_CTX)) as Record<string, unknown>;
    expect(read).toMatchObject({ pid: child.pid, scope: "all", source: "file", whole: true });
    expect(String(read["output"])).toMatch(/tick 1/);
    const refused = (await tools["read_process"]!.run({ pid: child.pid!, scope: "system" }, NO_CTX)) as Record<string, unknown>;
    expect(String(refused["error"])).toMatch(/is not in scope 'system'/);
  }, 60_000);
});
