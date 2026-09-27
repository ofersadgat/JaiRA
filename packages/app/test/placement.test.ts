/**
 * Where a task runs (decision 0013 §5). The rules alone: a machine is passed over offline, without a tag
 * its workflow requires, stale, at its cap, busy, low on memory, or out of usage. Then two engines in one
 * process, each with a clone of the same repository: by default a task started here goes to the other
 * machine first and is re-made there; an order that puts this machine first keeps it here; a workflow
 * requiring a tag no machine has waits in the queue, and starts once a machine is given the tag.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { AppService, hostEngine, loopbackReach, serviceHandlers, whyNot, DEFAULT_THRESHOLDS, workspaceKey, type HostedEngine, type MachineCapacity } from "@jaira/service";
import type { ProjectSummary } from "@jaira/shared";

describe("whether a machine takes a run", () => {
  const now = 1_000_000;
  const capacity = (patch: Partial<MachineCapacity> = {}): MachineCapacity => ({
    machineId: "m",
    tags: ["mac", "gpu"],
    resources: { cores: 8, cpu: 0.2, freeMemory: 8, totalMemory: 16, at: now },
    running: { "/src/jaira": 1 },
    accounts: ["claude"],
    spent: [],
    ...patch,
  });
  const why = (c: MachineCapacity | undefined, requires: string[] = [], cap?: number): string | undefined => whyNot(c, "/src/jaira", requires, cap, DEFAULT_THRESHOLDS, now);

  it("takes it with room", () => expect(why(capacity(), ["mac"])).toBeUndefined());
  it("passes over a machine that is offline, or lacks a tag", () => {
    expect(why(undefined)).toBe("offline");
    expect(why(capacity(), ["linux"])).toBe("not linux");
  });
  it("passes over a stale reading, a full cap, a busy CPU, low memory, and spent accounts", () => {
    expect(why(capacity({ resources: { cores: 8, cpu: 0.2, freeMemory: 8, totalMemory: 16, at: now - 60_000 } }))).toBe("no recent reading");
    expect(why(capacity(), [], 1)).toBe("1 of 1 running");
    expect(why(capacity({ resources: { cores: 8, cpu: 0.95, freeMemory: 8, totalMemory: 16, at: now } }))).toMatch(/busy/);
    expect(why(capacity({ resources: { cores: 8, cpu: 0.2, freeMemory: 1, totalMemory: 16, at: now } }))).toMatch(/low on memory/);
    expect(why(capacity({ spent: ["claude"] }))).toBe("out of usage");
  });
  it("judges usage by the accounts the task spends, when they are known", () => {
    const both = capacity({ accounts: ["claude", "codex"], spent: ["claude"] });
    const at = (needs: string[]): string | undefined => whyNot(both, "/src/jaira", [], undefined, DEFAULT_THRESHOLDS, now, needs);
    expect(at(["codex"])).toBeUndefined();
    expect(at(["claude"])).toBe("out of usage (claude)");
    // Nothing known: out only when every account is.
    expect(at([])).toBeUndefined();
  });
});

interface Machine {
  base: string;
  service: AppService;
  hosted: HostedEngine;
  call: (channel: string, request?: unknown) => Promise<unknown>;
}

const made: Machine[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const m of made.splice(0)) await m.hosted.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function machine(label: string): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-place-${label}-`));
  dirs.push(base);
  let hosted: HostedEngine | undefined;
  const service = new AppService({ baseDir: base, version: "0.2.0", reach: loopbackReach, watchWorkflows: false, publish: (m) => hosted?.host.broadcast(m) });
  hosted = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  service.fleet.rename(label);
  await service.fleet.setReachable(true);
  const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
  const m: Machine = { base, service, hosted, call: async (channel, request) => handlers[channel]!(request) };
  made.push(m);
  return m;
}

/** A clone of the same repository, set up as a project with one workflow that needs `gpu`. */
async function clone(m: Machine): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "jaira-place-clone-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:ofersadgat/jaira.git"], { cwd: dir });
  const paths = initProject(dir, m.base);
  mkdirSync(join(paths.workflowsDir, "t"), { recursive: true });
  writeFileSync(join(paths.workflowsDir, "t", "gpu.json"), JSON.stringify({ label: "Needs a GPU", requires: ["gpu"], operation: { prompt: "say hi", output: { said: { schema: { type: "string" } } } } }));
  await m.service.open(dir);
  return dir;
}

const FAKE = [{ output: { said: "hi" } }];

async function pair(a: Machine, b: Machine): Promise<void> {
  await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);
  await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
  await expect.poll(() => b.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
  await expect.poll(async () => ((await a.call("project:list")) as ProjectSummary[]).filter((p) => p.identity !== undefined).length, { timeout: 8000 }).toBe(2);
}

describe("placing a task", () => {
  it("goes to the other machine first by default, re-made there and gone from here", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const here = await clone(a);
    const there = await clone(b);
    await pair(a, b);
    b.service.fleet.setTags(["gpu"]);
    a.service.fleet.setTags(["gpu"]);
    const task = a.service.createTask({ title: "say hi", workflow: "t/gpu", project: here });
    const answer = (await a.call("task:start", { taskId: task.taskId, project: here, fake: FAKE })) as { taskId: string; placedOn?: string };
    expect(answer.placedOn).toBe("mac-mini");
    expect(b.service.listTasks(there).map((t) => t.taskId)).toContain(answer.taskId);
    expect(a.service.listTasks(here).map((t) => t.taskId)).not.toContain(task.taskId);
  });

  it("stays here when the project's order puts this machine first", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const here = await clone(a);
    await clone(b);
    await pair(a, b);
    await a.call("placement:setRules", { project: here, order: [workspaceKey(a.service.fleet.identity().id, here)], caps: {} });
    const task = a.service.createTask({ title: "say hi", workflow: "t/gpu", project: here });
    a.service.fleet.setTags(["gpu"]);
    const answer = (await a.call("task:start", { taskId: task.taskId, project: here, fake: FAKE })) as { taskId: string; placedOn?: string };
    expect(answer).toEqual({ taskId: task.taskId });
  });

  it("waits when no machine has the tag its workflow requires, and starts once one does", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const here = await clone(a);
    await clone(b);
    await pair(a, b);
    const task = a.service.createTask({ title: "needs a gpu", workflow: "t/gpu", project: here });
    const answer = await a.call("task:start", { taskId: task.taskId, project: here, fake: FAKE });
    expect(answer).toEqual({ taskId: task.taskId, queued: true });
    expect(await a.call("placement:queue")).toEqual([expect.objectContaining({ taskId: task.taskId, requires: ["gpu"] })]);
    a.service.fleet.setTags(["gpu"]);
    await a.service.tryQueue();
    expect(await a.call("placement:queue")).toEqual([]);
    expect(a.service.listTasks(here).find((t) => t.taskId === task.taskId)?.status).not.toBe("queued");
  });
});
