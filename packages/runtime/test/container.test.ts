/**
 * A workspace's container (decision 0027), with no Docker: a recording Exec stands in for docker and
 * the Dev Containers CLI. What a command run inside becomes (`docker exec`, its cwd, its variables by
 * name), the shell and dialect it is judged and run in, making one from an image, a Dockerfile or a
 * Dev Container (and using one again), keeping one up — and the machine's own programs (git, the
 * agents, their installers) staying on the machine while the workspace's commands go in.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTAINER_RUN, CONTAINER_STOP, containerInvocation, resolveInvocation } from "../src/exec";
import {
  containerNameFor,
  containerPort,
  devcontainerUp,
  dockerUp,
  ensureContainer,
  inspectContainer,
  parseDevcontainerUp,
} from "../src/container";
import { listExecutors, probeExecutor } from "../src/executors";
import { Git } from "../src/git";
import { checkTool } from "../src/install";
import { mcpServersIn } from "../src/mcpServers";
import { containerRefusal, dialectFor, interpreterFor, isContainerEnv, isWslEnv, machineEnvOf, onMachine, pathFor, hostPathFor } from "../src/paths";
import type { ExecOptions } from "../src/exec";
import { LINUX_PATH, fakeFs, machineExec } from "./installRig";

const BOX = { container: "jaira-1a2b3c4d" } as const;
const NO_SUCH = { code: 1, stderr: "Error: No such object: jaira-1a2b3c4d\n" };

describe("a command run inside a workspace's container", () => {
  it("goes through docker exec, at the same path, with its variables passed by name only", () => {
    const run = resolveInvocation("pnpm", ["install", "--frozen-lockfile"], { execEnv: BOX, cwd: "/w/app", env: { TOKEN: "s3cret", CI: "1" } });
    expect(run.file).toBe("docker");
    expect(run.argv.slice(0, 9)).toEqual(["exec", "-i", "-w", "/w/app", "-e", "TOKEN", "-e", "CI", "jaira-1a2b3c4d"]);
    expect(run.argv.slice(9, 12)).toEqual(["sh", "-c", CONTAINER_RUN]);
    expect(run.argv.slice(-3)).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    // The values reach docker in its own environment, never on its command line.
    expect(resolveInvocation("pnpm", [], { execEnv: BOX, env: { TOKEN: "s3cret" } }).argv.join(" ")).not.toContain("s3cret");
    // A Dev Container's remoteUser, and no cwd when none was asked.
    expect(containerInvocation({ container: "f00d", user: "node" }, "id", ["-u"], {}, "linux", "ab12")).toEqual({
      file: "docker",
      argv: ["exec", "-i", "-u", "node", "f00d", "sh", "-c", CONTAINER_RUN, "jaira", "/tmp/.jaira-exec-ab12.pid", "id", "-u"],
      stop: { file: "docker", argv: ["exec", "-u", "node", "f00d", "sh", "-c", CONTAINER_STOP, "jaira", "/tmp/.jaira-exec-ab12.pid"] },
    });
    // Each run has a file of its own, so two runs' stops never reach each other.
    expect(resolveInvocation("ls", [], { execEnv: BOX }).argv).not.toEqual(resolveInvocation("ls", [], { execEnv: BOX }).argv);
  });

  it("is refused on a Windows host, and from inside WSL", () => {
    expect(() => containerInvocation(BOX, "ls", [], {}, "win32")).toThrow(/Mac or a Linux machine only/);
    expect(containerRefusal("darwin")).toBeUndefined();
    expect(containerRefusal("linux", { wsl: "Ubuntu" })).toMatch(/not from inside WSL/);
  });

  it("is posix, run by sh -lc, wherever the host is — and paths are the machine's", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(interpreterFor(BOX, platform)).toEqual(["sh", "-lc"]);
      expect(dialectFor(BOX, platform)).toBe("posix");
    }
    expect(pathFor(BOX, "/w/app/src")).toBe("/w/app/src");
    expect(hostPathFor(BOX, "/w/app/src")).toBe("/w/app/src");
  });

  it("leaves native and WSL as they were", () => {
    expect(interpreterFor({ wsl: "Ubuntu" }, "win32")).toEqual(["bash", "-lc"]);
    expect(interpreterFor("windows", "linux")).toEqual(["/bin/sh", "-c"]);
    expect(interpreterFor("windows", "win32")[0]).toBe("powershell.exe");
    expect(dialectFor("windows", "win32")).toBe("powershell");
    expect(resolveInvocation("git", ["status"], { execEnv: { wsl: "Ubuntu" }, cwd: "C:\\w\\app" })).toEqual({ file: "wsl.exe", argv: ["-d", "Ubuntu", "--cd", "/mnt/c/w/app", "--", "git", "status"] });
    expect(isWslEnv({ wsl: "Ubuntu" })).toBe(true);
    expect(isContainerEnv({ wsl: "Ubuntu" })).toBe(false);
  });

  it("is not the machine: git, the agents and their servers stay where the machine runs them", async () => {
    expect(machineEnvOf(BOX)).toBe("windows");
    expect(machineEnvOf({ wsl: "Ubuntu" })).toEqual({ wsl: "Ubuntu" });
    expect(onMachine({ execEnv: BOX, other: 1 })).toEqual({ execEnv: "windows", other: 1 });
    // A layer merge may leave a machine's distro beside a workspace's container: the container is meant.
    expect(isWslEnv({ wsl: "Ubuntu", container: "c" } as never)).toBe(false);

    const exec = machineExec(() => ({ stdout: "main\n" }));
    await new Git({ exec, repoDir: "/w/app", execEnv: BOX }).currentBranch();
    expect(exec.calls[0]).toMatchObject({ file: "git", execEnv: "windows", cwd: "/w/app" });

    const servers = { pw: { command: "npx", args: ["@playwright/mcp"], env: {} } };
    expect(mcpServersIn(servers as never, BOX)).toBe(servers);

    const agent = listExecutors({}).find((info) => info.enabled && info.command !== undefined)!;
    const probed = machineExec(() => ({ stdout: "1.2.3\n" }));
    await probeExecutor(agent, { exec: probed, execEnv: BOX });
    expect(probed.calls.length).toBeGreaterThan(0);
    expect(probed.calls.every((call) => call.execEnv === "windows")).toBe(true);
  });
});

describe("the installer inside a container", () => {
  it("looks inside it with one sh, as it does inside WSL, and a root container needs no sudo", async () => {
    const exec = machineExec((file, args, options?: ExecOptions) => {
      if (file === "sh" && args[0] === "-c") return { stdout: "home\t/root\nuid\t0\ntool\tapt-get\t/usr/bin/apt-get\n" };
      return undefined;
    });
    const check = await checkTool({ tool: "jq" }, { exec, execEnv: BOX, deps: fakeFs({ platform: "darwin", path: LINUX_PATH, files: {} }) });
    expect(exec.calls[0]).toMatchObject({ file: "sh", execEnv: BOX });
    expect(check.satisfied).toBe(false);
    expect(check.plan).toMatchObject({ method: "apt" });
    expect(check.plan?.needsPassword).not.toBe(true);
  });
});

describe("making a workspace's container", () => {
  const spot = { dir: "/w/app", mounts: ["/w/.jaira-worktrees/app"] };
  const io = (exec: ReturnType<typeof machineExec>, platform = "linux") => ({ exec, platform, makeDir: () => undefined });
  const name = containerNameFor("/w/app");

  it("names it after the folder", () => {
    expect(name).toMatch(/^jaira-[0-9a-f]{8}$/);
    expect(containerNameFor("/w/app")).toBe(name);
    expect(containerNameFor("/w/other")).not.toBe(name);
  });

  it("runs an image with the workspace and the worktrees' folder at their own paths, on the machine", async () => {
    const exec = machineExec((_file, args) => (args[0] === "inspect" ? NO_SUCH : { stdout: "f00d\n" }));
    const up = await dockerUp(spot, { kind: "docker", image: "node:22" }, io(exec));
    expect(up).toEqual({ ok: true, env: { container: name, from: "docker" }, made: true });
    expect(exec.calls.map((call) => [call.file, ...call.args].join(" "))).toEqual([
      `docker inspect --type container --format {{.State.Running}}\t{{.Config.Image}}\t{{.Name}} ${name}`,
      `docker run -d --name ${name} --init -v /w/app:/w/app -v /w/.jaira-worktrees/app:/w/.jaira-worktrees/app -w /w/app node:22 sleep infinity`,
    ]);
    // docker is the machine's, whatever the Exec defaults to.
    expect(exec.calls.every((call) => call.execEnv === "windows")).toBe(true);
  });

  it("builds a Dockerfile in its own folder, tagged with the container's name", async () => {
    const exec = machineExec((_file, args) => (args[0] === "inspect" ? NO_SUCH : {}));
    const up = await dockerUp(spot, { kind: "docker", file: ".devcontainer/Dockerfile" }, io(exec));
    expect(up.ok).toBe(true);
    expect(exec.calls[0]!.args).toEqual(["build", "-t", name, "-f", "/w/app/.devcontainer/Dockerfile", "/w/app/.devcontainer"]);
    expect(exec.calls.at(-1)!.args.slice(-3)).toEqual([name, "sleep", "infinity"]);
  });

  it("uses the container again: as it is when up, started when stopped, made again from another image", async () => {
    const running = machineExec(() => ({ stdout: `true\tnode:22\t/${name}\n` }));
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(running))).toMatchObject({ ok: true, made: false });
    expect(running.calls).toHaveLength(1);

    const stopped = machineExec((_file, args) => (args[0] === "inspect" ? { stdout: `false\tnode:22\t/${name}\n` } : {}));
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(stopped))).toMatchObject({ ok: true, made: false });
    expect(stopped.calls.map((call) => call.args[0])).toEqual(["inspect", "start"]);

    const other = machineExec((_file, args) => (args[0] === "inspect" ? { stdout: `true\tnode:20\t/${name}\n` } : {}));
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(other))).toMatchObject({ ok: true, made: true });
    expect(other.calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(["inspect --type", "rm -f", "run -d"]);
  });

  it("says what is wrong: no image, no Docker, Docker not running, a Windows host", async () => {
    const none = machineExec(() => ({}));
    expect(await dockerUp(spot, { kind: "docker" }, io(none))).toMatchObject({ ok: false, reason: expect.stringMatching(/needs an image/) });
    const missing = machineExec(() => undefined);
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(missing))).toMatchObject({ ok: false, reason: expect.stringMatching(/Docker is not on this machine/) });
    const down = machineExec(() => ({ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n" }));
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(down))).toMatchObject({ ok: false, reason: expect.stringMatching(/not running/) });
    const windows = machineExec(() => ({}));
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, io(windows, "win32"))).toMatchObject({ ok: false, reason: expect.stringMatching(/Mac or a Linux/) });
    expect(windows.calls).toHaveLength(0);
    expect(await dockerUp(spot, { kind: "docker", image: "node:22" }, { ...io(windows), machine: { wsl: "Ubuntu" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/WSL/) });
  });
});

describe("a Dev Container through its CLI", () => {
  const spot = { dir: "/w/app", mounts: ["/w/.jaira-worktrees/app"] };
  const text = '{ "build": { "dockerfile": "Dockerfile" }, "remoteUser": "node", "postCreateCommand": "pnpm install" }';

  it("hands devcontainer up the project's file laid over at the workspace's own path, and reads the container it made", async () => {
    let override: unknown;
    const exec = machineExec((file, args) => {
      if (file === "/opt/bin/devcontainer") {
        override = JSON.parse(readFileSync(args[args.indexOf("--override-config") + 1]!, "utf8"));
        return {
          stderr: "[1 ms] Start: Run: docker build …\n",
          stdout: '[2 ms] a log line\n{"outcome":"success","containerId":"0123abcd","remoteUser":"node","remoteWorkspaceFolder":"/w/app"}\n',
        };
      }
      if (args[0] === "inspect") return { stdout: "true\tvsc-app-123\t/eager_turing\n" };
      return undefined;
    });
    const up = await devcontainerUp(spot, { kind: "devcontainer", file: ".devcontainer/devcontainer.json", text, cli: "/opt/bin/devcontainer" }, { exec, platform: "darwin", makeDir: () => undefined });
    expect(up).toEqual({ ok: true, env: { container: "eager_turing", user: "node", from: "devcontainer" }, made: true });
    const call = exec.calls[0]!;
    expect(call.args.slice(0, 5)).toEqual(["up", "--workspace-folder", "/w/app", "--config", "/w/app/.devcontainer/devcontainer.json"]);
    expect(call.execEnv).toBe("windows");
    expect(override).toEqual({
      build: { dockerfile: "/w/app/.devcontainer/Dockerfile", context: "/w/app/.devcontainer" },
      remoteUser: "node",
      postCreateCommand: "pnpm install",
      workspaceMount: "source=/w/app,target=/w/app,type=bind",
      workspaceFolder: "/w/app",
      mounts: ["source=/w/.jaira-worktrees/app,target=/w/.jaira-worktrees/app,type=bind"],
    });
    // The CLI ran the lifecycle commands: nothing here ran them again.
    expect(exec.calls.map((one) => one.file)).toEqual(["/opt/bin/devcontainer", "docker"]);
  });

  it("says why it did not come up, and refuses a workspace put anywhere but its own path", async () => {
    const failed = machineExec(() => ({ code: 1, stdout: '{"outcome":"error","message":"Command failed: docker build","description":"…"}\n' }));
    expect(await devcontainerUp(spot, { kind: "devcontainer", file: ".devcontainer/devcontainer.json", text, cli: "devcontainer" }, { exec: failed, platform: "linux", makeDir: () => undefined })).toEqual({
      ok: false,
      reason: "devcontainer up did not make the container: Command failed: docker build",
    });
    const elsewhere = machineExec(() => ({ stdout: '{"outcome":"success","containerId":"c1","remoteWorkspaceFolder":"/workspaces/app"}\n' }));
    expect(await devcontainerUp(spot, { kind: "devcontainer", file: ".devcontainer/devcontainer.json", text, cli: "devcontainer" }, { exec: elsewhere, platform: "linux", makeDir: () => undefined })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/at \/workspaces\/app, not at its own path \/w\/app/),
    });
  });

  it("reads the CLI's answer from its last JSON line", () => {
    expect(parseDevcontainerUp('log\n{"outcome":"success","containerId":"abc","remoteUser":"vscode"}\n')).toEqual({ outcome: "success", containerId: "abc", remoteUser: "vscode" });
    expect(parseDevcontainerUp("{not json\n")).toBeUndefined();
  });
});

describe("keeping it up", () => {
  const io = (exec: ReturnType<typeof machineExec>) => ({ exec, platform: "linux" });

  it("starts a stopped container, leaves a running one, and says when one is gone", async () => {
    expect(await ensureContainer("windows", io(machineExec(() => undefined)))).toEqual({ ok: true, started: false });
    const running = machineExec(() => ({ stdout: "true\tnode:22\t/jaira-1a2b3c4d\n" }));
    expect(await ensureContainer(BOX, io(running))).toEqual({ ok: true, started: false });
    const stopped = machineExec((_file, args) => (args[0] === "inspect" ? { stdout: "false\tnode:22\t/jaira-1a2b3c4d\n" } : {}));
    expect(await ensureContainer(BOX, io(stopped))).toEqual({ ok: true, started: true });
    expect(stopped.calls.at(-1)!.args).toEqual(["start", "jaira-1a2b3c4d"]);
    const gone = machineExec(() => NO_SUCH);
    expect(await ensureContainer(BOX, io(gone))).toMatchObject({ ok: false, reason: expect.stringMatching(/is gone — run the project's setup again/) });
    expect(await inspectContainer("jaira-1a2b3c4d", io(gone))).toEqual({ ok: true, state: "none" });
  });

  it("answers the setup's port: up through docker, the record and the installer the engine gives", async () => {
    const recorded: unknown[] = [];
    const exec = machineExec((_file, args) => (args[0] === "inspect" ? NO_SUCH : {}));
    const port = containerPort({
      dir: "/w/app",
      exec,
      platform: "linux",
      makeDir: () => undefined,
      record: (env) => void recorded.push(env),
      tools: () => ({ check: async () => ({ known: true, satisfied: true }), ensure: async () => ({ ok: true, already: true }) }),
    });
    const up = await port.up({ kind: "docker", image: "alpine:3" }, { onOutput: () => undefined });
    expect(up.ok).toBe(true);
    await port.use((up as { env: { container: string } }).env as never);
    expect(recorded).toEqual([{ container: containerNameFor("/w/app"), from: "docker" }]);
  });
});

describe("what runs around a command inside the container, run by a shell here", () => {
  // Docker is not needed to try the two scripts: they are sh, run here as they run in the container.
  // This machine may have no `setsid` (a Mac): a stand-in that does what util-linux's does is put first.
  const shell = (): { dir: string; env: NodeJS.ProcessEnv } => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-box-"));
    const has = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
    if (!has) {
      writeFileSync(join(dir, "setsid"), "#!/usr/bin/perl\nuse POSIX;\nPOSIX::setsid();\nexec @ARGV or die;\n");
      chmodSync(join(dir, "setsid"), 0o755);
    }
    return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` } };
  };

  it.skipIf(process.platform === "win32")("hands the command its stdin and gives back its exit code, leaving no file behind", () => {
    const { dir, env } = shell();
    const pid = join(dir, "run.pid");
    const done = spawnSync("sh", ["-c", CONTAINER_RUN, "jaira", pid, "sh", "-c", "cat; exit 3"], { input: "hello", env, encoding: "utf8" });
    expect(done.stdout).toBe("hello");
    expect(done.status).toBe(3);
    expect(existsSync(pid)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("is ended by the stop with everything it started, and the stop after it has ended does nothing", async () => {
    const { dir, env } = shell();
    const pid = join(dir, "run.pid");
    const inner = join(dir, "inner.pid");
    const run = spawn("sh", ["-c", CONTAINER_RUN, "jaira", pid, "sh", "-c", `sleep 30 & echo $! > ${inner}; wait`], { env, stdio: "ignore" });
    const ended = new Promise<number | null>((resolve) => run.on("exit", (code, signal) => resolve(code ?? (signal !== null ? -1 : null))));
    const started = Date.now();
    while (!(existsSync(pid) && existsSync(inner) && readFileSync(inner, "utf8").trim() !== "")) {
      if (Date.now() - started > 5000) throw new Error("the command never started");
      await new Promise((r) => setTimeout(r, 25));
    }
    const sleeper = Number(readFileSync(inner, "utf8").trim());
    expect(spawnSync("sh", ["-c", CONTAINER_STOP, "jaira", pid], { env }).status).toBe(0);
    expect(await ended).toBe(143);
    const alive = (p: number): boolean => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(sleeper)).toBe(false);
    expect(existsSync(pid)).toBe(false);
    // Stopped twice, or once it has ended: nothing to stop, and no error.
    expect(spawnSync("sh", ["-c", CONTAINER_STOP, "jaira", pid], { env }).status).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
