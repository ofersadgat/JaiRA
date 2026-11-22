/**
 * Making a workspace through the engine's maker, with real git and two stand-in machines: a folder
 * copied from another machine as it is (packed there, handed over in pieces), opened, its ignored
 * files brought, its setup run and approved; the plan said beforehand; a clone from a "forge"; and
 * the projects folder's numbering when the name is taken.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PushMessage, WorkspaceFinished } from "@jaira/shared";
import type { SetupToolPort } from "@jaira/runtime";
import { WorkspaceMaker, type WorkspaceMakerHost } from "../src/workspaces";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-ws-"));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

/** A checkout with a setup file, an unpushed commit, a change, and a .env.local git ignores. */
function sourceCheckout(): { bare: string; work: string } {
  const root = scratch();
  const seed = join(root, "seed");
  mkdirSync(join(seed, ".jaira"), { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, ".gitignore"), ".env*.local\n");
  writeFileSync(
    join(seed, ".jaira", "setup.json"),
    JSON.stringify({ version: 1, default: [{ install: "node" }, { bring: ".env*.local" }, { run: "echo set > setup-ran.txt" }] }),
  );
  writeFileSync(join(seed, "app.js"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  const bare = join(root, "forge.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const work = join(root, "work");
  git(root, "clone", "-q", bare, work);
  writeFileSync(join(work, "app.js"), "2\n");
  git(work, "commit", "-q", "-am", "local");
  writeFileSync(join(work, "app.js"), "3\n");
  writeFileSync(join(work, ".env.local"), "KEY=1\n");
  return { bare, work };
}

const TOOLS: SetupToolPort = {
  check: async () => ({ known: true, satisfied: true, found: { path: "/bin/node", version: "22.1.0" } }),
  ensure: async () => ({ ok: true, already: true }),
};

function host(id: string, projectsFolder: string, pushes: PushMessage[], peers: Record<string, WorkspaceMaker> = {}, opened: string[] = []): WorkspaceMakerHost {
  return {
    baseDir: scratch(),
    selfId: () => id,
    machine: () => ({ label: id, os: "linux", tags: [], projectsFolder }),
    execEnv: () => "windows",
    peer: (machineId) => {
      const other = peers[machineId];
      if (other === undefined) return undefined;
      const table = other.peerHandlers() as Record<string, (request: unknown) => unknown>;
      return { invoke: async (channel, request) => JSON.parse(JSON.stringify(await table[channel]!(request))) as unknown };
    },
    labelOf: (machineId) => machineId,
    integrations: () => ({ forges: {} }) as never,
    secrets: () => ({ lookup: () => undefined }) as never,
    workspacesOf: () => [],
    identityOf: () => undefined,
    open: async (dir) => void opened.push(dir),
    publish: (message) => void pushes.push(message),
    tools: () => TOOLS,
  };
}

function finished(pushes: PushMessage[], jobId: string): Promise<WorkspaceFinished> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const look = (): void => {
      const done = pushes.find((p): p is PushMessage & WorkspaceFinished => p.type === "workspace:finished" && (p as WorkspaceFinished).jobId === jobId);
      if (done !== undefined) return resolve(done);
      if (Date.now() - started > 60_000) return reject(new Error("never finished"));
      setTimeout(look, 50);
    };
    look();
  });
}

describe("making a workspace from a folder on another machine", () => {
  it("copies it as it is, opens it, brings its ignored files, runs and approves its setup", async () => {
    const { work } = sourceCheckout();
    const studio = new WorkspaceMaker(host("studio-mini", scratch(), []));
    const pushes: PushMessage[] = [];
    const opened: string[] = [];
    const projects = scratch();
    const buildHost = host("build-01", projects, pushes, { "studio-mini": studio }, opened);
    const build = new WorkspaceMaker(buildHost);

    const plan = await build.plan({ source: { kind: "machine", machine: "studio-mini", dir: work } });
    expect(plan.dir).toBe(join(projects, "work"));
    expect(plan.setup.from).toBe("file");
    expect(plan.setup.steps.map((s) => s.status)).toEqual(["there", "brings", "runs"]);
    expect(plan.setup.readiness).toBe("ready");
    expect(plan.bring).toEqual([".env*.local"]);
    expect(plan.checkout).toMatchObject({ branch: "main", ahead: 1, changed: 1 });

    const { jobId } = build.create({ source: { kind: "machine", machine: "studio-mini", dir: work } });
    const done = await finished(pushes, jobId);
    expect(done).toMatchObject({ ok: true, machine: "build-01", dir: join(projects, "work") });
    expect(done.setup?.ok).toBe(true);
    const dir = join(projects, "work");
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe("3\n");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("local");
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe("KEY=1\n");
    expect(readFileSync(join(dir, "setup-ran.txt"), "utf8").trim()).toBe("set");
    expect(opened).toEqual([dir]);
    expect(pushes.filter((p) => p.type === "workspace:progress").map((p) => (p as { phase: string }).phase)).toEqual(expect.arrayContaining(["fetch", "open", "setup"]));
    expect(existsSync(join(buildHost.baseDir, "system", "setup-approvals.json"))).toBe(true);
    expect(build.approved(dir, readFileSync(join(dir, ".jaira", "setup.json"), "utf8") + "\n")).toBe(true);

    // The name is taken now: the next one is numbered.
    expect(build.folderFor("work")).toEqual({ dir: join(projects, "work-1"), taken: "work", projectsFolder: projects });
  });

  it("brings from the folder copied when its machine is named, though that machine has another workspace of it", async () => {
    const { work } = sourceCheckout();
    // Another workspace of the same project on studio-mini, with its own .env.local.
    const other = scratch();
    writeFileSync(join(other, ".env.local"), "KEY=other\n");
    const studio = new WorkspaceMaker(host("studio-mini", scratch(), []));
    const pushes: PushMessage[] = [];
    const projects = scratch();
    const build = new WorkspaceMaker({
      ...host("build-01", projects, pushes, { "studio-mini": studio }),
      identityOf: () => "example.com/atlas",
      workspacesOf: () => [{ machineId: "studio-mini", dir: other }],
    });

    const { jobId } = build.create({ source: { kind: "machine", machine: "studio-mini", dir: work }, bringFrom: "studio-mini" });
    const done = await finished(pushes, jobId);
    expect(done.ok).toBe(true);
    expect(readFileSync(join(projects, "work", ".env.local"), "utf8")).toBe("KEY=1\n");
  });
});

describe("making a workspace from a forge", () => {
  it("clones at the branch named, then sets it up", async () => {
    const { bare } = sourceCheckout();
    const pushes: PushMessage[] = [];
    const projects = scratch();
    const maker = new WorkspaceMaker(host("build-01", projects, pushes));
    const { jobId } = maker.create({ source: { kind: "forge", host: "example.test", project: "org/atlas", url: bare, branch: "main" }, skipSetup: true });
    const done = await finished(pushes, jobId);
    expect(done).toMatchObject({ ok: true, dir: join(projects, "atlas") });
    expect(readFileSync(join(projects, "atlas", "app.js"), "utf8")).toBe("1\n");
  });

  it("says why when the folder cannot be made", async () => {
    const pushes: PushMessage[] = [];
    const maker = new WorkspaceMaker(host("build-01", scratch(), pushes));
    const { jobId } = maker.create({ source: { kind: "forge", host: "example.test", project: "org/none", url: join(scratch(), "missing.git") } });
    const done = await finished(pushes, jobId);
    expect(done.ok).toBe(false);
    expect(done.reason).toMatch(/Cloning failed/);
  });
});

describe("a workspace's setup when it opens and when its checkout moves", () => {
  function folder(setup: unknown): string {
    const dir = scratch();
    mkdirSync(join(dir, ".jaira"), { recursive: true });
    writeFileSync(join(dir, ".jaira", "setup.json"), JSON.stringify(setup));
    return dir;
  }
  const SETUP = {
    version: 1,
    default: [
      { run: "echo made >> made.txt" },
      { run: "echo opened >> opened.txt", when: "open" },
      { run: "echo installed >> installed.txt", again: ["pnpm-lock.yaml"] },
    ],
  };

  it("runs nothing until the setup is approved on this machine, then only the open steps on open", async () => {
    const dir = folder(SETUP);
    const maker = new WorkspaceMaker(host("build-01", scratch(), []));
    expect(await maker.runPhase({ dir, phase: "open" })).toEqual({ outcome: "unapproved", steps: 1 });
    expect(existsSync(join(dir, "opened.txt"))).toBe(false);
    await maker.approveCurrent(dir);
    const ran = await maker.runPhase({ dir, phase: "open" });
    expect(ran.outcome).toBe("ran");
    expect(readFileSync(join(dir, "opened.txt"), "utf8").trim()).toBe("opened");
    expect(existsSync(join(dir, "made.txt"))).toBe(false);
    expect(existsSync(join(dir, "installed.txt"))).toBe(false);
  });

  it("runs the again steps for the files that changed, and nothing for others", async () => {
    const dir = folder(SETUP);
    const maker = new WorkspaceMaker(host("build-01", scratch(), []));
    await maker.approveCurrent(dir);
    expect((await maker.runPhase({ dir, phase: "again", changed: ["README.md"] })).outcome).toBe("none");
    expect((await maker.runPhase({ dir, phase: "again", changed: ["pnpm-lock.yaml", "src/a.ts"] })).outcome).toBe("ran");
    expect(readFileSync(join(dir, "installed.txt"), "utf8").trim()).toBe("installed");
    expect(existsSync(join(dir, "opened.txt"))).toBe(false);
  });

  it("asks again once the setup changes", async () => {
    const dir = folder(SETUP);
    const maker = new WorkspaceMaker(host("build-01", scratch(), []));
    await maker.approveCurrent(dir);
    writeFileSync(join(dir, ".jaira", "setup.json"), JSON.stringify({ ...SETUP, default: [{ run: "echo other >> opened.txt", when: "open" }] }));
    expect((await maker.runPhase({ dir, phase: "open" })).outcome).toBe("unapproved");
  });

  it("uses the setup found in a checkout with no file, once approved", async () => {
    const dir = scratch();
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    const maker = new WorkspaceMaker(host("build-01", scratch(), []));
    expect((await maker.runPhase({ dir, phase: "open" })).outcome).toBe("none");
  });
});

describe("a workspace that runs in its container", () => {
  // A workspace runs in a container on a Mac or a Linux machine only; Windows refuses it (and runs in WSL).
  it.runIf(process.platform !== "win32")("brings the container up with docker on the machine, records it for the workspace, and runs the task's setup inside", async () => {
    // In a folder of its own, so the worktrees' folder made beside it goes when the test does.
    const dir = join(scratch(), "app");
    mkdirSync(join(dir, ".jaira"), { recursive: true });
    writeFileSync(join(dir, ".jaira", "setup.json"), JSON.stringify({ version: 1, default: [], environment: [{ use: "docker", image: "node:22" }, { run: "pnpm install" }] }));
    const calls: Array<{ file: string; args: readonly string[]; execEnv?: unknown; cwd?: string }> = [];
    const recorded: Array<{ dir: string; env: unknown }> = [];
    const toolsAsked: unknown[] = [];
    const maker = new WorkspaceMaker({
      ...host("build-01", scratch(), []),
      // The focused project's container is never the machine's.
      execEnv: () => ({ container: "someone-elses" }),
      execEnvOf: () => undefined,
      recordEnv: (at, env) => void recorded.push({ dir: at, env }),
      tools: (env) => {
        toolsAsked.push(env);
        return TOOLS;
      },
      exec: {
        run: async (file, args, options) => {
          calls.push({ file, args, ...(options?.execEnv !== undefined ? { execEnv: options.execEnv } : {}), ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
          const missing = file === "docker" && args[0] === "inspect";
          return { code: missing ? 1 : 0, signal: null, stdout: "", stderr: missing ? "Error: No such object\n" : "", command: file, timedOut: false, aborted: false };
        },
      },
    });
    await maker.approveCurrent(dir);
    const runIn = join(dir, "..", "task-1");
    const outcome = await maker.runEnvironment({ projectDir: dir, runIn });
    expect(outcome.result?.ok).toBe(true);
    const name = recorded[0]?.env as { container: string };
    expect(recorded).toEqual([{ dir, env: { container: expect.stringMatching(/^jaira-[0-9a-f]{8}$/), from: "docker" } }]);
    const run = calls.find((call) => call.args[0] === "run")!;
    // The workspace and the folder its task worktrees go in, each at its own path.
    expect(run.args).toEqual(expect.arrayContaining(["-v", `${dir}:${dir}`, "-w", dir, "node:22"]));
    expect(run.args.filter((arg) => arg.includes(".jaira-worktrees"))).toHaveLength(1);
    expect(existsSync(join(dir, "..", ".jaira-worktrees", "app"))).toBe(true);
    expect(run.execEnv).toBe("windows");
    expect(calls.at(-1)).toMatchObject({ file: "sh", args: ["-lc", "pnpm install"], execEnv: { container: name.container, from: "docker" }, cwd: runIn });
    expect(toolsAsked[0]).toBe("windows");
  });
});
