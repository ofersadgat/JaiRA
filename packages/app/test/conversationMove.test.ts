/**
 * A started conversation moved to another workspace of its project (decision 0013 ruling 7, built
 * 2026-11-20; the person: "move it there, but most of the pieces necessary to do this should already
 * exist"). It keeps its id and every word, is no longer the workspace it left, and its next message is
 * answered where it went — on this machine, and on another.
 *
 * And the composer's branch menu: a workspace's branches, what is not committed, and a switch that
 * asks before it does anything to uncommitted changes (the person: "if dirty, ask the user what to do").
 *
 * Every model call is scripted (`fake`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import type { FakeRule } from "@jaira/runtime";
import { AppService, hostEngine, loopbackTailnet, serviceHandlers, type HostedEngine } from "@jaira/service";
import type { ChatThreadView, ProjectSummary, PushMessage, WorkspaceBranches, WorkspaceSwitchResult } from "@jaira/shared";
import { eventually, shippedLayer } from "@jaira/testing";
import { CHAT_SESSION, titleOf } from "../src/renderer/chatWorkflow";
import { pairMachines } from "./pairMachines";

const dirs: string[] = [];
const closing: Array<() => Promise<void>> = [];

beforeEach(() => shippedLayer());

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `jaira-move-${name}-`));
  dirs.push(dir);
  return dir;
};
const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/** A clone of one remote, with a commit, made a project and opened. */
async function clone(service: AppService, base: string): Promise<string> {
  const dir = temp("clone");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "notes.txt"), "one\n");
  git(dir, "add", "notes.txt");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "remote", "add", "origin", "git@github.com:someone/moving.git");
  initProject(dir, base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "jaira");
  await service.open(dir);
  return dir;
}

interface Machine {
  base: string;
  service: AppService;
  pushes: PushMessage[];
  call: <T>(channel: string, request?: unknown) => Promise<T>;
}

async function machine(label: string, hosted = false): Promise<Machine> {
  const base = temp(label);
  const pushes: PushMessage[] = [];
  let host: HostedEngine | undefined;
  const service = new AppService({
    baseDir: base,
    version: "0.2.0",
    announce: false,
    watchWorkflows: false,
    // A test machine is often short of memory; placement must not hold the conversation back for it.
    placementThresholds: { cpuLimit: 2, memoryFloor: 0 },
    ...(hosted ? { tailnet: loopbackTailnet() } : {}),
    publish: (m) => {
      pushes.push(m);
      host?.host.broadcast(m);
    },
  });
  if (hosted) {
    host = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
    closing.push(() => host!.close());
    service.fleet.rename(label);
    await service.fleet.signIn();
  } else {
    closing.push(() => service.close());
  }
  const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
  return { base, service, pushes, call: async <T,>(channel: string, request?: unknown) => (await handlers[channel]!(request)) as T };
}

const ONE: FakeRule = { promptIncludes: "one", output: "first answer" };

/** `eventually`, for a check that has to ask: `eventually` would read the promise itself as a yes. */
async function until(ready: () => Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs}ms for ${what}, and it did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The transcript as `role: text`. */
async function said(m: Machine, taskId: string, project: string): Promise<string[]> {
  const thread = await m.call<ChatThreadView | null>("chat:thread", { taskId, project });
  return (thread?.session.turns ?? []).map((turn) => `${turn.role}: ${turn.text ?? ""}`);
}

/** A program conversation opened with "one", answered, and waiting for its next message. */
async function talking(m: Machine, project: string): Promise<string> {
  const { taskId } = await m.call<{ taskId: string }>("task:create", { project, title: titleOf("one"), workflow: CHAT_SESSION, conversation: true, inputs: { message: "one", improve: false } });
  // Started where it was made: with two workspaces a start is otherwise placed, maybe in the other.
  await m.call("task:start", { taskId, project, runOn: { project }, fake: [ONE] });
  await until(async () => (await said(m, taskId, project)).length >= 2 && waiting(m, project, taskId), "the opening reply", 20_000);
  return taskId;
}

/** Waiting at its `input()` in `project` — a conversation between replies. */
function waiting(m: Machine, project: string, taskId: string): boolean {
  const sessions = (m.service as unknown as { sessions: Map<string, { dir: string; hub: { list(): Array<{ component: string; taskId?: string }> } }> }).sessions;
  const session = [...sessions.values()].find((s) => s.dir === project || s.dir.toLowerCase() === project.toLowerCase());
  return session?.hub.list().some((r) => r.component === "input" && r.taskId === taskId) ?? false;
}

const tasksOf = async (m: Machine, project: string): Promise<string[]> => ((await m.call<Array<{ taskId: string }>>("task:list", { project })) ?? []).map((t) => t.taskId);

describe("a conversation moved to another workspace on this machine", { timeout: 60_000 }, () => {
  it("keeps its id and every word, leaves the workspace it was in, and is answered where it went", async () => {
    const m = await machine("desk");
    const a = await clone(m.service, m.base);
    const b = await clone(m.service, m.base);
    const keyA = (m.service.listProjects().find((p) => p.project.toLowerCase().endsWith(a.split(/[\\/]/).pop()!.toLowerCase())) as ProjectSummary).project;
    const keyB = (m.service.listProjects().find((p) => p.project.toLowerCase().endsWith(b.split(/[\\/]/).pop()!.toLowerCase())) as ProjectSummary).project;
    const taskId = await talking(m, keyA);

    const moved = await m.call<{ taskId: string; project: string }>("task:relocate", { taskId, project: keyA, target: { project: keyB }, fake: [{ promptIncludes: "two", output: "second answer, from b" }] });
    expect(moved).toEqual({ taskId, project: keyB });
    expect(await tasksOf(m, keyA)).not.toContain(taskId);
    expect(await tasksOf(m, keyB)).toContain(taskId);
    // Picked up where it went, waiting for the next message, as it was.
    await eventually(() => waiting(m, keyB, taskId), "the conversation to wait again in b", 20_000);
    expect(m.pushes.some((p) => p.type === "placement:changed" && p.moved?.some((x) => x.taskId === taskId && x.to.project === keyB))).toBe(true);

    await m.call("chat:send", { taskId, project: keyB, instanceId: "", message: "two" });
    await until(async () => (await said(m, taskId, keyB)).includes("assistant: second answer, from b") && waiting(m, keyB, taskId), "the reply to 'two' in b", 20_000);
    expect(await said(m, taskId, keyB)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer, from b"]);
  });

  it("is refused while it is answering, and stays where it is", async () => {
    const m = await machine("desk");
    const a = await clone(m.service, m.base);
    const b = await clone(m.service, m.base);
    const key = (dir: string): string => m.service.listProjects().find((p) => p.project.toLowerCase().endsWith(dir.split(/[\\/]/).pop()!.toLowerCase()))!.project;
    const { taskId } = await m.call<{ taskId: string }>("task:create", { project: key(a), title: titleOf("one"), workflow: CHAT_SESSION, conversation: true, inputs: { message: "one", improve: false } });
    await m.call("task:start", { taskId, project: key(a), runOn: { project: key(a) }, fake: [{ ...ONE, hold: "cancel" }] });
    await eventually(() => m.service.listTasks(key(a)).some((t) => t.taskId === taskId && t.status === "running") && !waiting(m, key(a), taskId), "the reply to be in flight", 20_000);
    await expect(m.call("task:relocate", { taskId, project: key(a), target: { project: key(b) } })).rejects.toThrow(/answering now/);
    expect(await tasksOf(m, key(a))).toContain(taskId);
  });
});

describe("a conversation moved to another machine", { timeout: 90_000 }, () => {
  it("goes there whole, and its next message is answered there", async () => {
    const a = await machine("desk", true);
    const b = await machine("mac-mini", true);
    const here = await clone(a.service, a.base);
    await clone(b.service, b.base);
    await pairMachines(a.service.fleet, b.service.fleet);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
    await expect.poll(async () => (await a.call<ProjectSummary[]>("project:list")).filter((p) => p.identity !== undefined).length, { timeout: 8000 }).toBe(2);
    const projects = await a.call<ProjectSummary[]>("project:list");
    const mine = projects.find((p) => p.machine?.self === true && p.identity !== undefined)!.project;
    const theirs = projects.find((p) => p.machine?.self !== true && p.identity !== undefined)!.project;
    expect(mine.toLowerCase()).toContain(here.split(/[\\/]/).pop()!.toLowerCase());
    const taskId = await talking(a, mine);

    const moved = await a.call<{ taskId: string; project: string }>("task:relocate", { taskId, project: mine, target: { machine: b.service.fleet.identity().id }, fake: [{ promptIncludes: "two", output: "second answer, from the mini" }] });
    expect(moved).toEqual({ taskId, project: theirs });
    expect(await tasksOf(a, mine)).not.toContain(taskId);
    const bKey = b.service.listProjects().find((p) => p.identity !== undefined && p.machine?.self === true)!.project;
    expect(await tasksOf(b, bKey)).toContain(taskId);
    await eventually(() => waiting(b, bKey, taskId), "the conversation to wait again on the mini", 20_000);
    expect(await said(b, taskId, bKey)).toEqual(["user: one", "assistant: first answer"]);

    // Asked from the desk, by the mini's key: answered on the mini.
    await a.call("chat:send", { taskId, project: theirs, instanceId: "", message: "two" });
    await until(async () => (await said(b, taskId, bKey)).includes("assistant: second answer, from the mini"), "the reply to 'two' on the mini", 30_000);
    expect(await said(b, taskId, bKey)).toEqual(["user: one", "assistant: first answer", "user: two", "assistant: second answer, from the mini"]);
  });
});

describe("the composer's branch menu", { timeout: 60_000 }, () => {
  it("lists the branches, and asks before a switch does anything to uncommitted changes", async () => {
    const m = await machine("desk");
    const dir = await clone(m.service, m.base);
    const key = m.service.listProjects().find((p) => p.identity !== undefined)!.project;
    git(dir, "branch", "other");
    const list = await m.call<WorkspaceBranches>("workspace:branches", { project: key });
    expect(list.current).toBe("main");
    expect(list.local.map((b) => b.name).sort()).toEqual(["main", "other"]);
    expect(list).toMatchObject({ dirty: [], dirtyCount: 0, busy: [] });

    writeFileSync(join(dir, "notes.txt"), "changed\n");
    const asked = await m.call<WorkspaceSwitchResult>("workspace:switchBranch", { project: key, branch: "other" });
    expect(asked).toEqual({ switched: false, needs: "dirty", dirty: ["notes.txt"], dirtyCount: 1 });
    expect(git(dir, "branch", "--show-current")).toBe("main");

    const stashed = await m.call<WorkspaceSwitchResult>("workspace:switchBranch", { project: key, branch: "other", dirty: "stash" });
    expect(stashed).toMatchObject({ switched: true, branch: "other" });
    expect(git(dir, "branch", "--show-current")).toBe("other");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "stash", "list")).toContain("before switching to other");

    writeFileSync(join(dir, "new.txt"), "mine\n");
    const carried = await m.call<WorkspaceSwitchResult>("workspace:switchBranch", { project: key, branch: "fresh", create: true, dirty: "carry" });
    expect(carried).toMatchObject({ switched: true, branch: "fresh" });
    expect(git(dir, "status", "--porcelain")).toContain("new.txt");
  });
});
