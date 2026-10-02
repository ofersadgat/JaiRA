/**
 * A session's shell environment (decision 0013 §5, ruled 2026-10-02): the machine it runs on, the
 * workspace, and what the checkout says of itself — its branch, what is unpushed, the lines changed —
 * as `environment:view` answers it for the bar under the composer and the list that bar opens.
 *
 *  - What a machine IS (its form) is part of its identity: guessed once, kept, the person's to change.
 *  - Git says how far a branch is ahead of its upstream and how many lines the working tree changed.
 *  - One engine with two clones answers one machine with two workspaces, in placement order, each with
 *    its checkout's facts, what is running and waiting there, and why it would take no run now.
 *  - A checkout somebody asked about is looked at again when work ends in it, and says so when it moved.
 *  - Another machine's workspaces come with their own facts, asked of that machine.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { Git, NodeExec, parseShortstat } from "@jaira/runtime";
import { AppService, hostEngine, loopbackReach, machineFile, machineIdentity, serviceHandlers, updateMachineIdentity, workspaceKey, type HostedEngine } from "@jaira/service";
import { SHARED_SESSION, type EnvironmentView, type MachinesView, type ProjectSummary, type PushMessage } from "@jaira/shared";
import { eventually } from "@jaira/testing";

const dirs: string[] = [];
const closing: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `jaira-env-${name}-`));
  dirs.push(dir);
  return dir;
};
const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/** A repository with one commit: a five-line file. */
function repository(dir: string, branch = "main"): void {
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "notes.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git(dir, "add", "notes.txt");
  git(dir, "commit", "-q", "-m", "first");
}

const FAKE = [{ output: { said: "hi" } }];

/** A clone of the shared remote, with a commit, opened as a project with one workflow. */
async function clone(service: AppService, base: string, branch = "main"): Promise<string> {
  const dir = temp("clone");
  repository(dir, branch);
  git(dir, "remote", "add", "origin", "git@github.com:ofersadgat/jaira.git");
  const paths = initProject(dir, base);
  mkdirSync(join(paths.workflowsDir, "t"), { recursive: true });
  writeFileSync(join(paths.workflowsDir, "t", "hi.json"), JSON.stringify({ label: "Say hi", operation: { prompt: "say hi", output: { said: { schema: { type: "string" } } } } }));
  // JaiRA's own files are not the checkout's changes.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "jaira");
  await service.open(dir);
  return dir;
}

describe("what a machine is", () => {
  it("is part of its identity: guessed once, kept, and the person's to change", () => {
    const base = temp("base");
    const made = machineIdentity(base);
    expect(["desktop", "laptop", "mini", "server"]).toContain(made.form);
    expect(JSON.parse(readFileSync(machineFile(base), "utf8")).form).toBe(made.form);
    expect(updateMachineIdentity(base, { form: "server" }).form).toBe("server");
    expect(machineIdentity(base).form).toBe("server");
    // Renaming it does not undo that.
    expect(updateMachineIdentity(base, { label: "box" }).form).toBe("server");
    expect(() => updateMachineIdentity(base, { form: "toaster" as never })).toThrow(/not something a machine is/);
  });

  it("is given to an identity made before the field existed", () => {
    const base = temp("base");
    const made = machineIdentity(base);
    writeFileSync(machineFile(base), JSON.stringify({ id: made.id, label: "old", tags: [], createdAt: 1 }));
    expect(machineIdentity(base)).toMatchObject({ id: made.id, label: "old" });
    expect(JSON.parse(readFileSync(machineFile(base), "utf8")).form).toBeDefined();
  });

  it("is set from Settings, and listed with the machine", async () => {
    const base = temp("base");
    const service = new AppService({ baseDir: base, watchWorkflows: false });
    closing.push(() => service.close());
    const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
    expect(((await handlers["machines:form"]!({ form: "laptop" })) as MachinesView).self.form).toBe("laptop");
    expect(((await handlers["machines:view"]!(undefined)) as MachinesView).self.form).toBe("laptop");
  });
});

describe("what git says of a checkout", () => {
  it("reads a shortstat line, whichever halves it has", () => {
    expect(parseShortstat(" 3 files changed, 128 insertions(+), 34 deletions(-)")).toEqual({ added: 128, removed: 34 });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ added: 1, removed: 0 });
    expect(parseShortstat(" 1 file changed, 2 deletions(-)")).toEqual({ added: 0, removed: 2 });
    expect(parseShortstat("")).toEqual({ added: 0, removed: 0 });
  });

  it("counts the lines the working tree changed and the commits its upstream lacks", async () => {
    const dir = temp("repo");
    repository(dir);
    const reader = new Git({ exec: new NodeExec({}), repoDir: dir });
    expect(await reader.changedLines()).toEqual({ added: 0, removed: 0 });
    // Never pushed: there is no upstream to be ahead of.
    expect(await reader.aheadOfUpstream()).toBeUndefined();

    writeFileSync(join(dir, "notes.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    expect(await reader.changedLines()).toEqual({ added: 2, removed: 1 });

    const remote = temp("remote");
    git(remote, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "main");
    expect(await reader.aheadOfUpstream()).toBe(0);
    git(dir, "commit", "-q", "-am", "second");
    expect(await reader.aheadOfUpstream()).toBe(1);
    expect(await reader.changedLines()).toEqual({ added: 0, removed: 0 });
  });

  it("knows a folder its repository ignores is no part of that checkout", async () => {
    const dir = temp("repo");
    repository(dir);
    writeFileSync(join(dir, ".gitignore"), "scratch/\n");
    mkdirSync(join(dir, "scratch", "world"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    const at = (sub: string): Git => new Git({ exec: new NodeExec({}), repoDir: join(dir, sub) });
    expect(await new Git({ exec: new NodeExec({}), repoDir: dir }).isIgnored()).toBe(false);
    expect(await at("src").isIgnored()).toBe(false);
    expect(await at(join("scratch", "world")).isIgnored()).toBe(true);
  });

  it("has no answer where there is no commit yet", async () => {
    const dir = temp("repo");
    git(dir, "init", "-q");
    const reader = new Git({ exec: new NodeExec({}), repoDir: dir });
    expect(await reader.changedLines()).toBeUndefined();
    expect(await reader.aheadOfUpstream()).toBeUndefined();
  });
});

describe("a project's environment", () => {
  async function rig(): Promise<{ service: AppService; pushes: PushMessage[]; call: (channel: string, request?: unknown) => Promise<unknown>; first: string; second: string; dirs: [string, string] }> {
    const base = temp("base");
    const pushes: PushMessage[] = [];
    const service = new AppService({ baseDir: base, watchWorkflows: false, placementThresholds: { cpuLimit: 2, memoryFloor: 0 }, publish: (m) => pushes.push(m) });
    closing.push(() => service.close());
    const one = await clone(service, base, "main");
    const two = await clone(service, base, "feature/session-cache");
    const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
    const call = async (channel: string, request?: unknown): Promise<unknown> => handlers[channel]!(request);
    const listed = ((await call("project:list")) as ProjectSummary[]).filter((p) => p.identity !== undefined).map((p) => p.project);
    const named = (dir: string): string => listed.find((p) => p.toLowerCase().includes(dir.split(/[\\/]/).pop()!.toLowerCase()))!;
    const [first, second] = [named(one), named(two)];
    const me = service.fleet.identity().id;
    await call("placement:setRules", { project: first, order: [workspaceKey(me, first), workspaceKey(me, second)], caps: {} });
    return { service, pushes, call, first, second, dirs: [one, two] };
  }

  it("is one machine with its workspaces in placement order, each with what its checkout says", async () => {
    const r = await rig();
    writeFileSync(join(r.dirs[1], "notes.txt"), "one\ntwo\nthree\n");
    const view = (await r.call("environment:view", { workspace: r.first })) as EnvironmentView;
    expect(view.identity).toBe("github.com/ofersadgat/jaira");
    expect(view.machines).toHaveLength(1);
    const [machine] = view.machines;
    expect(machine).toMatchObject({ self: true, state: "online", os: r.service.fleet.identity().os, form: r.service.fleet.identity().form });
    expect(machine!.cores).toBeGreaterThan(0);
    expect(machine!.memoryTotal).toBeGreaterThan(0);
    expect(machine!.workspaces.map((w) => w.project)).toEqual([r.first, r.second]);
    expect(machine!.workspaces[0]).toMatchObject({ running: 0, queued: 0, git: { branch: "main", added: 0, removed: 0 } });
    expect(machine!.workspaces[1]).toMatchObject({ git: { branch: "feature/session-cache", added: 0, removed: 2 } });
    // No forge is connected, so nothing is asked of one.
    expect(machine!.workspaces[0]!.git?.mergeRequest).toBeUndefined();
    // Asked of either workspace, it is the same project.
    expect(((await r.call("environment:view", { workspace: r.second })) as EnvironmentView).machines[0]!.workspaces.map((w) => w.project)).toEqual([r.first, r.second]);
  });

  it("says why a workspace would take no run, and what waits for it", async () => {
    const r = await rig();
    const me = r.service.fleet.identity().id;
    await r.call("placement:setRules", { project: r.first, order: [workspaceKey(me, r.first), workspaceKey(me, r.second)], caps: { [workspaceKey(me, r.second)]: 0 } });
    const task = r.service.createTask({ title: "sent", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, runOn: { project: r.second } });
    const [machine] = ((await r.call("environment:view", { workspace: r.first })) as EnvironmentView).machines;
    expect(machine!.workspaces[0]).toMatchObject({ queued: 0 });
    expect(machine!.workspaces[0]!.why).toBeUndefined();
    expect(machine!.workspaces[1]).toMatchObject({ queued: 1, why: "0 of 0 running" });
  });

  it("looks again when work ends in a checkout somebody asked about, and says so when it moved", async () => {
    const r = await rig();
    await r.call("environment:view", { workspace: r.first });
    writeFileSync(join(r.dirs[0], "notes.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    r.pushes.length = 0;
    const task = r.service.createTask({ title: "works", workflow: "t/hi", project: r.first });
    await r.service.startTask({ taskId: task.taskId, project: r.first, fake: FAKE });
    await eventually(() => r.pushes.some((m) => m.type === "environment:changed" && m.project === r.first), "the checkout to be looked at again");
    const [machine] = ((await r.call("environment:view", { workspace: r.first })) as EnvironmentView).machines;
    expect(machine!.workspaces[0]!.git).toMatchObject({ added: 2, removed: 0 });
  });

  it("is one machine with one workspace for a project that has no other", async () => {
    const base = temp("base");
    const service = new AppService({ baseDir: base, watchWorkflows: false });
    closing.push(() => service.close());
    const dir = temp("solo");
    repository(dir);
    initProject(dir, base);
    await service.open(dir);
    const view = await service.environmentView(service.listProjects().find((p) => p.kind === "user")!.project);
    expect(view.identity).toBeUndefined();
    expect(view.machines).toHaveLength(1);
    expect(view.machines[0]!.workspaces).toHaveLength(1);
    expect(view.machines[0]!.workspaces[0]!.git?.branch).toBe("main");
    // JaiRA's own root is somewhere a conversation runs too: this machine, that folder, no checkout read.
    const root = await service.environmentView(SHARED_SESSION);
    expect(root.machines).toHaveLength(1);
    expect(root.machines[0]).toMatchObject({ self: true, state: "online" });
    expect(root.machines[0]!.workspaces).toHaveLength(1);
    expect(root.machines[0]!.workspaces[0]!.git).toBeUndefined();
    // And nothing at all for what is no workspace.
    expect(await service.environmentView(join(base, "nowhere"))).toEqual({ machines: [] });
  });
});

describe("another machine's workspaces", () => {
  interface Machine {
    base: string;
    service: AppService;
    hosted: HostedEngine;
    call: (channel: string, request?: unknown) => Promise<unknown>;
  }
  async function machine(label: string): Promise<Machine> {
    const base = temp(label);
    let hosted: HostedEngine | undefined;
    const service = new AppService({ baseDir: base, version: "0.2.0", reach: loopbackReach, watchWorkflows: false, placementThresholds: { cpuLimit: 2, memoryFloor: 0 }, publish: (m) => hosted?.host.broadcast(m) });
    hosted = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
    closing.push(() => hosted!.close());
    service.fleet.rename(label);
    await service.fleet.setReachable(true);
    const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
    return { base, service, hosted, call: async (channel, request) => handlers[channel]!(request) };
  }

  it("come with what they are and what their checkouts say, asked of that machine", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const here = await clone(a.service, a.base, "main");
    const there = await clone(b.service, b.base, "release");
    b.service.fleet.setForm("mini");
    await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
    await expect.poll(async () => ((await a.call("project:list")) as ProjectSummary[]).filter((p) => p.identity !== undefined).length, { timeout: 8000 }).toBe(2);
    writeFileSync(join(there, "notes.txt"), "one\n");

    const mine = ((await a.call("project:list")) as ProjectSummary[]).find((p) => p.machine?.self === true && p.identity !== undefined)!.project;
    expect(mine.toLowerCase()).toContain(here.split(/[\\/]/).pop()!.toLowerCase());
    const view = (await a.call("environment:view", { workspace: mine })) as EnvironmentView;
    // Other machines first, this one last: the order tasks are placed in.
    expect(view.machines.map((m) => [m.label, m.self, m.state])).toEqual([
      ["mac-mini", false, "online"],
      ["desk", true, "online"],
    ]);
    expect(view.machines[0]).toMatchObject({ form: "mini", os: b.service.fleet.identity().os });
    expect(view.machines[0]!.cores).toBeGreaterThan(0);
    expect(view.machines[0]!.workspaces[0]!.git).toMatchObject({ branch: "release", added: 0, removed: 4 });
    expect(view.machines[1]!.workspaces[0]!.git).toMatchObject({ branch: "main" });
  });
});
