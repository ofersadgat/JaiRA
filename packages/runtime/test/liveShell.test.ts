/**
 * A live shell (decision 0030, ruling 4) against the real zsh, bash and sh: commands one at a time in
 * one process, what carries over, a command reading what is typed, Ctrl-C reaching what the shell
 * started and not the shell, Stop replacing a shell whose command will not end, and a shell that
 * exits saying so. POSIX only.
 */
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LiveShell, liveShellKindOf } from "../src/liveShell";
import { MarkFilter, withCwdMark, withoutMarks } from "../src/shellMarks";
import { expandShellWord, shellChoiceOf } from "../src/shellSessions";
import { cpuSecondsOf } from "../src/processTree";

const posix = process.platform !== "win32";
const shells = ["/bin/zsh", "/bin/bash", "/bin/sh"].filter((path) => existsSync(path));
const open: LiveShell[] = [];
afterEach(() => {
  for (const shell of open.splice(0)) shell.close("test over");
});
const started = async (path: string, cwd: string): Promise<LiveShell> => {
  const shell = await LiveShell.start(path, cwd);
  open.push(shell);
  return shell;
};

describe.skipIf(!posix).each(shells)("a live %s", (path) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "jaira-live-")));

  it("keeps cd and a variable from one command to the next, and says where it ended and how", async () => {
    const shell = await started(path, home);
    const first = await shell.run("mkdir -p sub && cd sub && export GREETING=hello");
    expect(first).toMatchObject({ exitCode: 0, cwd: join(home, "sub"), stopped: false });
    expect(first.env?.["GREETING"]).toBe("hello");
    const second = await shell.run('pwd; echo "$GREETING"; false');
    expect(second.stdout).toBe(`${join(home, "sub")}\nhello\n`);
    expect(second.exitCode).toBe(1);
  });

  it("hands a command what is typed while it reads, never its own marks", async () => {
    const shell = await started(path, home);
    let typed = false;
    const run = await shell.run('printf "name? "; read n; echo "got:$n"', {
      onOutput: (text) => {
        if (!typed && text.includes("name?")) {
          typed = true;
          setTimeout(() => runIo?.write("ada\n"), 50);
        }
      },
      onStart: (io) => (runIo = io),
    });
    expect(run.stdout).toBe("name? got:ada\n");
  });
  let runIo: { write: (text: string) => boolean } | undefined;

  it("interrupts what the shell started and keeps the shell", async () => {
    const shell = await started(path, home);
    let io: { interrupt: () => void } | undefined;
    const run = shell.run("echo start; sleep 30", { onStart: (one) => (io = one), onOutput: (text) => (text.includes("start") ? setTimeout(() => io?.interrupt(), 100) : undefined) });
    const done = await run;
    expect(done.stopped).toBe(true);
    expect(shell.alive).toBe(true);
    expect((await shell.run("echo still")).stdout).toBe("still\n");
  });

  it("says the shell went when a command exits it", async () => {
    const shell = await started(path, home);
    const run = await shell.run("exit 3");
    expect(run.exitCode).toBe(3);
    expect(run.ended).toBe("exited with code 3");
    expect(shell.alive).toBe(false);
  });
});

describe.skipIf(!posix || !existsSync("/bin/bash"))("Stop on a live shell", () => {
  it("replaces a shell whose command ignores SIGTERM", async () => {
    const shell = await started("/bin/bash", tmpdir());
    let io: { stop: () => void } | undefined;
    const run = shell.run("trap '' TERM; echo start; sleep 30", { onStart: (one) => (io = one), onOutput: (text) => (text.includes("start") ? setTimeout(() => io?.stop(), 100) : undefined) });
    const done = await run;
    expect(done.ended).toBe("was replaced to stop a command that would not end");
    expect(shell.alive).toBe(false);
  }, 10_000);
});

describe("the pieces", () => {
  it("takes JaiRA's marks out of a stream cut anywhere, and leaves anything else", () => {
    const marks: string[] = [];
    const filter = new MarkFilter((kind, payload) => marks.push(`${kind}=${payload}`));
    const pieces = ["one\u001eJA", "IRA:cwd:/tmp/x", "\u001etwo\u001enot ours\n"];
    expect(pieces.map((piece) => filter.feed(piece)).join("") + filter.flush()).toBe("onetwo\u001enot ours\n");
    expect(marks).toEqual(["cwd=/tmp/x"]);
    expect(withoutMarks(`a${"\u001eJAIRA:cwd:/y\u001e"}`)).toBe("a");
    expect(withCwdMark("ls")).toContain("trap ");
  });

  it("reads a setting as a shell", () => {
    expect(shellChoiceOf(undefined)).toEqual({ kind: "emulated" });
    expect(shellChoiceOf("emulated")).toEqual({ kind: "emulated" });
    expect(shellChoiceOf("/bin/zsh")).toEqual({ kind: "live", path: "/bin/zsh" });
    expect(shellChoiceOf("/usr/bin/fish")).toEqual({ kind: "emulated" });
    expect(liveShellKindOf("/opt/homebrew/bin/bash")).toBe("bash");
  });

  it("expands ~ and variables as the shell would, an unset one to nothing", () => {
    const env: Record<string, string> = { HOME: "/home/a", APP: "/srv/app" };
    const valueOf = (name: string): string | undefined => env[name];
    expect(expandShellWord("~/x", valueOf)).toBe("/home/a/x");
    expect(expandShellWord("$APP/logs", valueOf)).toBe("/srv/app/logs");
    expect(expandShellWord("${APP}-old", valueOf)).toBe("/srv/app-old");
    expect(expandShellWord("$NOPE/x", valueOf)).toBe("/x");
    expect(expandShellWord("plain/path", valueOf)).toBe("plain/path");
  });

  it("reads ps's CPU time", () => {
    expect(cpuSecondsOf("0:01.50")).toBeCloseTo(1.5);
    expect(cpuSecondsOf("01:02:03")).toBe(3723);
    expect(cpuSecondsOf("2-00:00:01")).toBe(172_801);
  });
});
