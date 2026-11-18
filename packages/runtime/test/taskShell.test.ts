/**
 * The shell tool with a task's shell (decision 0030): each call starts where the last one ended, in the
 * shell its agent is set to — the emulated one or a live zsh/bash/sh — and the agent is told when a live
 * shell was started again, when a directory went, and when a live shell cannot run here. POSIX only.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShellTool, type TaskShells } from "../src/tools";
import { ShellSessions, withCallingAgent, type ShellChoice } from "../src/shellSessions";

const posix = process.platform !== "win32";
const sessions = new ShellSessions();
afterEach(() => sessions.closeAll("test over"));

function setup(choice: ShellChoice, liveRefusal?: string): { root: string; run: (command: string, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>; shells: TaskShells } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jaira-task-shell-")));
  const shells: TaskShells = { session: sessions.of(root), choiceFor: () => choice, ...(liveRefusal !== undefined ? { liveRefusal } : {}) };
  const tool = createShellTool({ shells }) as unknown as { run: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
  return { root, shells, run: (command, extra = {}) => tool.run({ command, ...extra }, withCallingAgent({ workspace: { root } } as never, "claude-cli")) };
}

describe.skipIf(!posix)("the emulated shell", () => {
  it("starts each call where the last ended, carries no variables, and says where it ended", async () => {
    const { root, run } = setup({ kind: "emulated" });
    mkdirSync(join(root, "pkg"));
    expect(await run("cd pkg && export X=1")).toMatchObject({ exitCode: 0, cwd: join(root, "pkg"), shell: "emulated" });
    const second = await run('pwd; echo "x=$X"');
    expect(second["stdout"]).toBe(`${join(root, "pkg")}\nx=\n`);
    expect(second["stderr"]).toBe("");
    // Its own cwd starts it elsewhere, relative to the root.
    expect((await run("pwd", { cwd: "." }))["stdout"]).toBe(`${root}\n`);
  });

  it("starts at the root, and says so, when the directory it stood in is gone", async () => {
    const { root, run } = setup({ kind: "emulated" });
    mkdirSync(join(root, "tmp"));
    await run("cd tmp");
    rmSync(join(root, "tmp"), { recursive: true });
    const after = await run("pwd");
    expect(after["stdout"]).toBe(`${root}\n`);
    expect(String(after["note"])).toContain("no longer exists");
  });

  it("keeps a command's own exit when it ends the shell itself", async () => {
    const { root, run } = setup({ kind: "emulated" });
    mkdirSync(join(root, "a"));
    const out = await run("cd a; exit 4");
    expect(out).toMatchObject({ exitCode: 4, cwd: join(root, "a") });
  });
});

describe.skipIf(!posix || !existsSync("/bin/bash"))("a live shell", () => {
  it("keeps variables and the directory, and starts again where it was with a note when it went", async () => {
    const { root, run, shells } = setup({ kind: "live", path: "/bin/bash" });
    mkdirSync(join(root, "app"));
    expect(await run("cd app && export TOKEN=abc")).toMatchObject({ exitCode: 0, cwd: join(root, "app"), shell: "bash" });
    expect((await run('echo "$TOKEN"'))["stdout"]).toBe("abc\n");
    // Closed as the idle rule would.
    shells.session.live!.close("was closed after 5 minutes with nothing to do");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = await run('pwd; echo "token=$TOKEN"');
    expect(again["stdout"]).toBe(`${join(root, "app")}\ntoken=\n`);
    expect(String(again["note"])).toBe(`JaiRA started a new bash in ${join(root, "app")}: the previous one was closed after 5 minutes with nothing to do. Variables, aliases and functions set in it are gone.`);
  }, 30_000);

  it("runs in the emulated shell, saying why once, where a live shell cannot run", async () => {
    const { run } = setup({ kind: "live", path: "/bin/bash" }, "this project's commands run in WSL");
    const first = await run("echo hi");
    expect(first).toMatchObject({ shell: "emulated", stdout: "hi\n" });
    expect(String(first["note"])).toContain("this project's commands run in WSL");
    expect((await run("echo again"))["note"]).toBeUndefined();
  });
});
