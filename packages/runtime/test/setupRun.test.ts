/**
 * Running a setup plan in a real folder with a real shell and a stand-in tool installer: which steps
 * each moment runs, `check` and `optional`, versions read from files, a `use` step read out of the CI
 * file it names, and what a plan would take before anything runs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSetupTarget, readSetupValue, type PlannedStep } from "@jaira/shared";
import { NodeExec } from "../src/exec";
import { needsOf, readinessOf, runSetup, stepsFor, type SetupContainerPort, type SetupRunContext, type SetupToolPort, type ToolRequestLike } from "../src/setupRun";
import type { ContainerRequest } from "../src/container";
import type { ContainerExecEnv, ExecEnv } from "../src/paths";
import { machineExec } from "./installRig";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-setup-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...path.split("/")), text);
  }
  return dir;
}

function plan(value: unknown, target = "default"): PlannedStep[] {
  const read = readSetupValue(value);
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  const planned = planSetupTarget(read.file, target, { name: "build-01", tags: ["linux", "mac"] });
  if (!planned.ok) throw new Error(JSON.stringify(planned.problems));
  return planned.steps;
}

/** A tool installer that knows node (installed at 20) and pnpm (missing), and records what it was asked. */
function tools(asked: ToolRequestLike[] = []): SetupToolPort {
  return {
    check: async (req) =>
      req.tool === "node"
        ? { known: true, satisfied: req.version === undefined || req.version.startsWith("20"), found: { path: "/usr/bin/node", version: "20.1.0" }, plan: { method: "nvm", display: `nvm install ${req.version ?? ""}` } }
        : req.tool === "apt-only"
          ? { known: true, satisfied: false, plan: { method: "apt", display: "sudo apt-get install -y x", needsPassword: true } }
          : req.tool === "pnpm"
            ? { known: true, satisfied: false, plan: { method: "corepack", display: "corepack enable pnpm" } }
            : { known: false, satisfied: false },
    ensure: async (req, say) => {
      asked.push(req);
      say(`installing ${req.tool}\n`);
      return req.tool === "broken" ? { ok: false, reason: "no installer" } : { ok: true, already: false };
    },
  };
}

function context(dir: string, extra: Partial<SetupRunContext> = {}): SetupRunContext & { log: string[] } {
  const log: string[] = [];
  return {
    dir,
    exec: new NodeExec(),
    execEnv: "windows",
    os: "linux",
    readFile: async (path) => {
      try {
        return readFileSync(join(dir, ...path.split("/")), "utf8");
      } catch {
        return undefined;
      }
    },
    tools: tools(),
    bring: async () => 2,
    clone: async () => undefined,
    onOutput: (text) => log.push(text),
    log,
    ...extra,
  };
}

describe("running a setup", () => {
  it("runs every step when the workspace is made, reading a version from its file", async () => {
    const dir = folder({ ".nvmrc": "v22.11.0\n" });
    const asked: ToolRequestLike[] = [];
    const ctx = context(dir, { tools: tools(asked) });
    const steps = plan({ version: 1, default: [{ install: "node", version: ".nvmrc" }, { run: "echo made > made.txt" }, { bring: ".env*.local" }] });
    const result = await runSetup(steps, ctx);
    expect(result.ok).toBe(true);
    expect(asked).toEqual([{ tool: "node", version: "22.11.0" }]);
    expect(readFileSync(join(dir, "made.txt"), "utf8").trim()).toBe("made");
    expect(result.steps.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(result.steps[2]!.detail).toBe("2 files");
  });

  it("skips a step whose check passes, goes on past an optional failure, and stops at a required one", async () => {
    const dir = folder({});
    const ctx = context(dir);
    const steps = plan({
      version: 1,
      default: [{ run: "echo no > never.txt", check: "true" }, { run: "exit 3", optional: true }, { run: "exit 4" }, { run: "echo after > after.txt" }],
    });
    const result = await runSetup(steps, ctx);
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(["skipped", "failed", "failed"]);
    expect(result.reason).toMatch(/exited 4/);
  });

  it("runs only the open steps when a workspace opens, and only the again steps after a pull", () => {
    const steps = plan({
      version: 1,
      default: [{ run: "a" }, { run: "b", when: "open" }, { run: "c", again: ["pnpm-lock.yaml"] }, { use: "compose" }],
    });
    expect(stepsFor(steps, "open").map((s) => ("run" in s ? s.run : "use"))).toEqual(["b", "use"]);
    expect(stepsFor(steps, "again", ["pnpm-lock.yaml"]).map((s) => ("run" in s ? s.run : ""))).toEqual(["c"]);
    expect(stepsFor(steps, "again", ["README.md"])).toEqual([]);
  });

  it("runs the part of a GitHub job a use step names, cloning a sibling it checks out", async () => {
    const ci = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with: { path: app }",
      "      - uses: actions/checkout@v4",
      "        with: { repository: org/lib, path: lib }",
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: 20 }",
      "      - name: deps",
      "        run: echo deps > deps.txt",
      "        working-directory: app",
      "      - name: test",
      "        run: exit 1",
    ].join("\n");
    const dir = folder({ ".github/workflows/ci.yml": ci });
    const cloned: unknown[] = [];
    const asked: ToolRequestLike[] = [];
    const ctx = context(dir, { tools: tools(asked), clone: async (r) => void cloned.push(r) });
    const steps = plan({ version: 1, default: [{ use: "github", file: ".github/workflows/ci.yml", job: "build", through: "deps" }] });
    const result = await runSetup(steps, ctx);
    expect(result.ok).toBe(true);
    expect(cloned).toEqual([{ repository: "org/lib", path: "../lib" }]);
    expect(asked).toEqual([{ tool: "node", version: "20" }]);
    expect(readFileSync(join(dir, "deps.txt"), "utf8").trim()).toBe("deps");
  });
});

describe("what a setup would take", () => {
  it("says, step by step, what is there, what installs, what needs a password, and where each came from", async () => {
    const dir = folder({ ".nvmrc": "20\n", "package.json": '{"packageManager":"pnpm@9.12.0"}' });
    const ctx = context(dir);
    const steps = plan({
      version: 1,
      default: [{ install: "node", version: ".nvmrc" }, { install: "pnpm", version: "package.json" }, { install: "apt-only" }, { run: "pnpm install" }, { bring: ".env" }],
    });
    const needs = await needsOf(steps, ctx);
    expect(needs.map((n) => [n.label, n.status, n.source])).toEqual([
      ["Install node 20", "there", ".nvmrc"],
      ["Install pnpm 9.12.0", "installs", "package.json"],
      ["Install apt-only", "password", undefined],
      ["pnpm install", "runs", undefined],
      ["Bring .env", "brings", undefined],
    ]);
    expect(readinessOf(needs)).toBe("password");
    expect(readinessOf(needs.slice(0, 2))).toBe("installs");
    const unknown = await needsOf(plan({ version: 1, default: [{ install: "mystery" }] }), ctx);
    expect(readinessOf(unknown)).toBe("cannot");
  });
});

describe("a container step", () => {
  /** A container port that records what it was asked, and installers that say which environment they are for. */
  function port(options: { cli?: boolean; fail?: string } = {}) {
    const asked: ContainerRequest[] = [];
    const used: ContainerExecEnv[] = [];
    const installs: Array<{ env: unknown; tool: string }> = [];
    const toolsFor = (env: ExecEnv): SetupToolPort => ({
      check: async (req) =>
        req.tool === "devcontainer" ? (options.cli === true ? { known: true, satisfied: true, found: { path: "/opt/bin/devcontainer" } } : { known: true, satisfied: false, plan: { method: "npm", display: "npm i -g @devcontainers/cli" } }) : { known: true, satisfied: true, found: { path: `/usr/bin/${req.tool}` } },
      ensure: async (req) => {
        installs.push({ env, tool: req.tool });
        return { ok: true, already: false };
      },
    });
    const container: SetupContainerPort = {
      up: async (request) => {
        asked.push(request);
        if (options.fail !== undefined) return { ok: false, reason: options.fail };
        return { ok: true, made: true, env: request.kind === "devcontainer" ? { container: "eager_turing", user: "node", from: "devcontainer" } : { container: "jaira-1a2b3c4d", ...(request.user !== undefined ? { user: request.user } : {}), from: request.from ?? "docker" } };
      },
      use: (env) => void used.push(env),
      tools: toolsFor,
    };
    return { container, asked, used, installs, toolsFor };
  }
  const recording = () => machineExec(() => ({}));
  const where = (exec: ReturnType<typeof recording>) => exec.calls.map((call) => [call.args.at(-1), call.execEnv === "windows" ? "machine" : (call.execEnv as { container: string }).container]);

  it("brings the image's container up, says so in the workspace's settings, and runs the steps after it inside", async () => {
    const dir = folder({});
    const exec = recording();
    const p = port();
    const ctx = context(dir, { exec, container: p.container, tools: p.toolsFor("windows") });
    const steps = plan({ version: 1, default: [{ run: "echo before" }, { use: "docker", image: "node:22" }, { install: "jq" }, { run: "pnpm install" }] });
    const result = await runSetup(steps, ctx);
    expect(result.ok).toBe(true);
    expect(p.asked).toEqual([{ kind: "docker", image: "node:22" }]);
    expect(p.used).toEqual([{ container: "jaira-1a2b3c4d", from: "docker" }]);
    expect(where(exec)).toEqual([
      ["echo before", "machine"],
      ["pnpm install", "jaira-1a2b3c4d"],
    ]);
    // Run by the container's shell, in the workspace at its own path.
    expect(exec.calls[1]).toMatchObject({ file: "sh", args: ["-lc", "pnpm install"], cwd: dir });
    expect(p.installs).toEqual([{ env: { container: "jaira-1a2b3c4d", from: "docker" }, tool: "jq" }]);
    expect(result.steps[1]).toEqual({ label: "Use docker (node:22)", status: "done", detail: "in jaira-1a2b3c4d" });
  });

  it("hands a Dev Container to its CLI when the machine has it, and runs none of its lifecycle commands itself", async () => {
    const devcontainer = '{ "image": "node:22", "features": { "ghcr.io/devcontainers/features/github-cli:1": {} }, "postCreateCommand": "pnpm install" }';
    const dir = folder({ ".devcontainer/devcontainer.json": devcontainer });
    const exec = recording();
    const p = port({ cli: true });
    const ctx = context(dir, { exec, container: p.container, tools: p.toolsFor("windows") });
    const result = await runSetup(plan({ version: 1, default: [{ use: "devcontainer", in: "container" }, { run: "pnpm test" }] }), ctx);
    expect(result.ok).toBe(true);
    expect(p.asked).toEqual([{ kind: "devcontainer", file: ".devcontainer/devcontainer.json", text: devcontainer, cli: "/opt/bin/devcontainer" }]);
    expect(p.installs).toEqual([]);
    expect(where(exec)).toEqual([["pnpm test", "eager_turing"]]);
    expect(exec.calls[0]!.execEnv).toEqual({ container: "eager_turing", user: "node", from: "devcontainer" });
  });

  it("without the CLI, makes an image's container with docker: initializeCommand on the machine, the rest inside", async () => {
    const devcontainer = JSON.stringify({
      image: "mcr.microsoft.com/devcontainers/javascript-node:22",
      remoteUser: "node",
      containerEnv: { TZ: "UTC" },
      features: { "ghcr.io/devcontainers/features/github-cli:1": {} },
      initializeCommand: "echo host",
      postCreateCommand: "pnpm install",
      postStartCommand: "pnpm dev",
    });
    const dir = folder({ ".devcontainer/devcontainer.json": devcontainer });
    const exec = recording();
    const p = port();
    const ctx = context(dir, { exec, container: p.container, tools: p.toolsFor("windows") });
    const result = await runSetup(plan({ version: 1, default: [{ use: "devcontainer", in: "container" }] }), ctx);
    expect(result.ok).toBe(true);
    expect(p.asked).toEqual([{ kind: "docker", image: "mcr.microsoft.com/devcontainers/javascript-node:22", user: "node", env: { TZ: "UTC" }, from: "devcontainer" }]);
    expect(where(exec)).toEqual([
      ["echo host", "machine"],
      ["pnpm install", "jaira-1a2b3c4d"],
      ["pnpm dev", "jaira-1a2b3c4d"],
    ]);
    expect(p.installs).toEqual([{ env: { container: "jaira-1a2b3c4d", user: "node", from: "devcontainer" }, tool: "gh" }]);

    // Opening it again: the container started, and only what starts each time run inside.
    const again = recording();
    const opened = port();
    await runSetup(plan({ version: 1, default: [{ use: "devcontainer", in: "container" }] }), context(dir, { exec: again, container: opened.container, tools: opened.toolsFor("windows") }), "open");
    expect(opened.asked).toHaveLength(1);
    expect(where(again)).toEqual([["pnpm dev", "jaira-1a2b3c4d"]]);
  });

  it("fails with why: a Dockerfile without the CLI, a compose file, no port, a container that would not come up", async () => {
    const dir = folder({
      ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile" } }',
      "compose/devcontainer.json": '{ "dockerComposeFile": "compose.yml", "service": "app" }',
    });
    const p = port();
    const run = (setup: unknown, extra: Partial<SetupRunContext> = {}) => runSetup(plan(setup), context(dir, { exec: recording(), container: p.container, tools: p.toolsFor("windows"), ...extra }));
    expect((await run({ version: 1, default: [{ use: "devcontainer", in: "container" }] })).reason).toMatch(/Dev Containers CLI/);
    expect((await run({ version: 1, default: [{ use: "devcontainer", in: "container", file: "compose/devcontainer.json" }] })).reason).toMatch(/compose file/);
    const { container: _none, ...bare } = context(dir);
    expect((await runSetup(plan({ version: 1, default: [{ use: "docker", image: "node:22" }] }), bare)).reason).toMatch(/nothing here can bring a container up/);
    const down = port({ fail: "Docker is not running on this machine" });
    expect((await run({ version: 1, default: [{ use: "docker", image: "node:22" }, { run: "never" }] }, { container: down.container })).reason).toMatch(/Docker is not running/);
  });

  it("says beforehand what it would take: Docker, a Mac or Linux machine, and the CLI for a Dockerfile", async () => {
    const dir = folder({ ".devcontainer/devcontainer.json": '{ "build": { "dockerfile": "Dockerfile" } }' });
    const noDocker: SetupToolPort = { check: async () => ({ known: true, satisfied: false, plan: { method: "homebrew", display: "brew install --cask docker-desktop" } }), ensure: async () => ({ ok: true, already: false }) };
    const withDocker: SetupToolPort = { check: async (req) => ({ known: true, satisfied: req.tool === "docker" }), ensure: async () => ({ ok: true, already: false }) };
    const docker = plan({ version: 1, default: [{ use: "docker", image: "node:22" }] });
    expect(await needsOf(docker, context(dir, { tools: withDocker }))).toEqual([{ label: "Use docker (node:22)", status: "runs", detail: "runs the workspace inside node:22", source: "use docker" }]);
    const missing = await needsOf(docker, context(dir, { tools: noDocker }));
    expect(missing[0]).toMatchObject({ status: "cannot", detail: expect.stringMatching(/Docker is not on this machine/) });
    expect(readinessOf(missing)).toBe("cannot");
    // An earlier step installs it: the container step can run after.
    expect((await needsOf(plan({ version: 1, default: [{ install: "docker" }, { use: "docker", image: "node:22" }] }), context(dir, { tools: noDocker })))[1]!.status).toBe("runs");
    expect((await needsOf(docker, context(dir, { tools: withDocker, os: "windows" })))[0]).toMatchObject({ status: "cannot", detail: expect.stringMatching(/Mac or a Linux/) });
    expect((await needsOf(docker, context(dir, { tools: withDocker, os: "wsl" })))[0]).toMatchObject({ status: "cannot", detail: expect.stringMatching(/WSL/) });
    const dev = plan({ version: 1, default: [{ use: "devcontainer", in: "container" }] });
    expect((await needsOf(dev, context(dir, { tools: withDocker })))[0]).toMatchObject({ status: "cannot", detail: expect.stringMatching(/Dev Containers CLI/) });
    expect((await needsOf(plan({ version: 1, default: [{ install: "devcontainer" }, { use: "devcontainer", in: "container" }] }), context(dir, { tools: withDocker })))[1]!.status).toBe("runs");
  });
});
