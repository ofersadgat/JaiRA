/**
 * The Exec seam (DESIGN §9.1). Invocation shaping is asserted purely; the rest
 * runs real processes. The WSL half runs only where a distro exists, and says so
 * when it skips rather than quietly passing.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { execOk, ExecError, NodeExec, resolveInvocation } from "../src/exec";

/** A distro to test against, or undefined when WSL isn't usable here. */
function wslDistro(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    // `-l -q` prints UTF-16 on Windows; decode then take the first non-empty line.
    const raw = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 15_000 });
    const first = raw
      .toString("utf16le")
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, "").trim())
      .find((l) => l.length > 0);
    return first;
  } catch {
    return undefined;
  }
}

const DISTRO = wslDistro();
const describeWsl = DISTRO ? describe : describe.skip;

describe("resolveInvocation", () => {
  it("passes a native command through untouched", () => {
    expect(resolveInvocation("git", ["status", "--short"], { cwd: "C:\\repo" })).toEqual({
      file: "git",
      argv: ["status", "--short"],
      cwd: "C:\\repo",
    });
  });

  it("wraps a WSL command with -d, --cd and the -- terminator", () => {
    expect(resolveInvocation("git", ["status"], { execEnv: { wsl: "Ubuntu" }, cwd: "C:\\repo\\sub" })).toEqual({
      file: "wsl.exe",
      // The Windows cwd is translated for the distro, and wsl.exe itself gets no
      // cwd of its own.
      argv: ["-d", "Ubuntu", "--cd", "/mnt/c/repo/sub", "--", "git", "status"],
    });
  });

  it("omits --cd when no cwd is given, and still terminates options", () => {
    expect(resolveInvocation("ls", ["-la"], { execEnv: { wsl: "Ubuntu" } })).toEqual({
      file: "wsl.exe",
      argv: ["-d", "Ubuntu", "--", "ls", "-la"],
    });
  });
});

describe("NodeExec (native)", () => {
  const exec = new NodeExec();

  it("captures stdout and a zero exit", async () => {
    const result = await exec.run(process.execPath, ["-e", "process.stdout.write('hello')"]);
    expect(result).toMatchObject({ code: 0, stdout: "hello", timedOut: false, aborted: false });
  });

  it("captures stderr and a non-zero exit without throwing", async () => {
    const result = await exec.run(process.execPath, ["-e", "process.stderr.write('nope');process.exit(3)"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("nope");
  });

  it("runs in the given cwd", async () => {
    const result = await exec.run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
      cwd: process.cwd(),
    });
    expect(result.stdout.toLowerCase()).toBe(process.cwd().toLowerCase());
  });

  it("passes env and stdin", async () => {
    const withEnv = await exec.run(process.execPath, ["-e", "process.stdout.write(process.env.JAIRA_TEST??'')"], {
      env: { JAIRA_TEST: "set" },
    });
    expect(withEnv.stdout).toBe("set");

    const withStdin = await exec.run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      stdin: "piped",
    });
    expect(withStdin.stdout).toBe("piped");
  });

  it("keeps arguments literal — no shell to reinterpret them", async () => {
    // With `shell: true` these would be redirection and command separators.
    const tricky = 'a "b" & echo pwned > out.txt | c';
    const result = await exec.run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", tricky]);
    expect(result.stdout).toBe(tricky);
  });

  it("times out and reports it", async () => {
    const result = await exec.run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code === null || result.code !== 0).toBe(true);
  });

  it("is abortable", async () => {
    const abort = new AbortController();
    const pending = exec.run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { abortSignal: abort.signal });
    abort.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
  });

  it("rejects when the command cannot start at all", async () => {
    await expect(exec.run("jaira-no-such-binary", [])).rejects.toThrow(/failed to run/);
  });
});

describe("execOk", () => {
  const exec = new NodeExec();

  it("returns trimmed stdout on success", async () => {
    expect(await execOk(exec, process.execPath, ["-e", "process.stdout.write(' padded \\n')"])).toBe("padded");
  });

  it("throws an ExecError carrying the result and stderr", async () => {
    const failing = execOk(exec, process.execPath, ["-e", "process.stderr.write('bad input');process.exit(2)"]);
    await expect(failing).rejects.toThrow(/exited 2: bad input/);
    await failing.catch((e: unknown) => {
      expect(e).toBeInstanceOf(ExecError);
      expect((e as ExecError).result.code).toBe(2);
    });
  });
});

describeWsl(`NodeExec (WSL: ${DISTRO ?? "unavailable"})`, () => {
  const exec = new NodeExec({ execEnv: { wsl: DISTRO! } });

  it("runs a command inside the distro", async () => {
    const uname = await execOk(exec, "uname", ["-s"], { timeoutMs: 60_000 });
    expect(uname).toBe("Linux");
  });

  it("translates the working directory into the distro's view", async () => {
    const cwd = await execOk(exec, "pwd", [], { cwd: "C:\\UbuntuCode", timeoutMs: 60_000 });
    expect(cwd).toBe("/mnt/c/UbuntuCode");
  });

  it("sees a Windows file through /mnt", async () => {
    const listing = await execOk(exec, "ls", ["-1"], { cwd: process.cwd(), timeoutMs: 60_000 });
    expect(listing).toContain("package.json");
  });
});
