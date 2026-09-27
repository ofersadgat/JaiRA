/**
 * Another machine's workspaces, used from this one (decision 0013 §4, §7): two engines in one process,
 * each its own base root, host, network listener and fleet, published on loopback. Once paired, A lists
 * B's open project under B's name and the repository it is a clone of, reads its board through the
 * remote key, creates a task on it that B has, and hears B's pushes keyed for A. With B gone, an answer
 * for it waits in A's outbox.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { AppService, hostEngine, loopbackReach, serviceHandlers, type HostedEngine } from "@jaira/service";
import { parseRemoteProjectKey, type ProjectSummary, type PushMessage } from "@jaira/shared";

interface Machine {
  base: string;
  service: AppService;
  hosted: HostedEngine;
  pushes: PushMessage[];
  call: (channel: string, request?: unknown) => Promise<unknown>;
}

const made: Machine[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const m of made.splice(0)) await m.hosted.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function machine(label: string): Promise<Machine> {
  const base = mkdtempSync(join(tmpdir(), `jaira-fed-${label}-`));
  dirs.push(base);
  const pushes: PushMessage[] = [];
  let hosted: HostedEngine | undefined;
  const service = new AppService({ baseDir: base, version: "0.2.0", reach: loopbackReach, watchWorkflows: false, publish: (m) => {
    pushes.push(m);
    hosted?.host.broadcast(m);
  } });
  hosted = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  service.fleet.rename(label);
  await service.fleet.setReachable(true);
  const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
  const m: Machine = { base, service, hosted, pushes, call: async (channel, request) => handlers[channel]!(request) };
  made.push(m);
  return m;
}

function clone(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-fed-clone-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:ofersadgat/jaira.git"], { cwd: dir });
  return dir;
}

const remotes = async (m: Machine): Promise<ProjectSummary[]> => ((await m.call("project:list")) as ProjectSummary[]).filter((p) => p.machine?.self !== true);

describe("another machine's workspaces", () => {
  it("are listed, read and written from here, and pushes come back keyed for here", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    const dir = clone();
    initProject(dir, b.base);
    await b.service.open(dir);
    // A has a clone of its own: it must not come back to A through B, which lists it as remote.
    const mine = clone();
    initProject(mine, a.base);
    await a.service.open(mine);
    await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);

    await expect.poll(async () => (await remotes(a)).map((p) => [p.label, p.identity, p.machine?.label]), { timeout: 8000 }).toEqual([[expect.any(String), "github.com/ofersadgat/jaira", "mac-mini"]]);
    const [remote] = await remotes(a);
    expect(parseRemoteProjectKey(remote!.project)).toEqual({ machineId: b.service.fleet.identity().id, dir: expect.any(String) });
    const local = ((await a.call("project:list")) as ProjectSummary[]).filter((p) => p.machine?.self === true);
    expect(local.every((p) => p.machine?.label === "desk")).toBe(true);

    // Read and written through the key.
    const roots = await a.call("board:roots", { project: remote!.project });
    expect(roots).toMatchObject({ columns: expect.any(Array) });
    const made = (await a.call("task:create", { title: "from desk", workflow: "chat/session", project: remote!.project })) as { taskId: string };
    expect(b.service.listTasks(dir).map((t) => t.taskId)).toContain(made.taskId);

    // Asking every machine answers, rather than two machines asking each other for ever.
    const all = (await a.call("task:all", {})) as Array<{ project: string }>;
    expect(all.some((row) => row.project === remote!.project)).toBe(true);
    expect(all.every((row) => parseRemoteProjectKey(row.project)?.machineId !== a.service.fleet.identity().id)).toBe(true);
    expect((await remotes(a)).length).toBe(1);

    // B's news, heard on A with A's key.
    await expect.poll(() => a.pushes.some((m) => m.type === "store:invalidate" && (m as { project?: string }).project === remote!.project), { timeout: 5000 }).toBe(true);
  });

  it("browses another machine's folders and opens a project there", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
    const dir = clone();
    initProject(dir, b.base);
    const bId = b.service.fleet.identity().id;
    const parent = join(dir, "..");
    const listing = (await a.call("files:browse", { machine: bId, dir: parent })) as { dir: string; entries: Array<{ path: string; project: boolean; git: boolean }> };
    expect(listing.entries.find((e) => e.path === dir)).toMatchObject({ project: true, git: true });
    expect(b.service.inspect(dir).open).toBe(false);
    await a.call("project:open", { dir, machine: bId });
    expect(b.service.inspect(dir).open).toBe(true);
    await expect.poll(async () => (await remotes(a)).length, { timeout: 8000 }).toBe(1);
  });

  it("keeps a copy of another machine's tasks, and reads it while that machine is away", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    a.service.fleet.setReplicate(true);
    const dir = clone();
    initProject(dir, b.base);
    await b.service.open(dir);
    const task = (await b.call("task:create", { title: "written on the mini", workflow: "chat/session", project: dir })) as { taskId: string };
    await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);
    await expect.poll(async () => (await remotes(a)).length, { timeout: 8000 }).toBe(1);
    const [remote] = await remotes(a);
    const bId = b.service.fleet.identity().id;
    await a.service.replicator.pull(bId);
    expect(a.service.replicator.hasReplica(bId, parseRemoteProjectKey(remote!.project)!.dir)).toBe(true);

    await b.hosted.close();
    made.splice(made.indexOf(b), 1);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("offline");
    // Read from the copy: the conversation and the board, as they were when it was taken.
    expect(await a.call("task:conversation", { taskId: task.taskId, project: remote!.project })).toMatchObject({ taskId: task.taskId, title: "written on the mini" });
    await expect(a.call("board:roots", { project: remote!.project })).resolves.toMatchObject({ columns: expect.any(Array) });
    // And only read: what would change it waits for the machine, or is refused.
    await expect(a.call("task:rename", { taskId: task.taskId, title: "x", project: remote!.project })).rejects.toThrow(/mac-mini is offline/);
    // Nothing of the copy is this machine's own.
    expect(((await a.call("task:all", {})) as Array<{ taskId: string }>).some((t) => t.taskId === task.taskId)).toBe(false);
  });

  it("keeps an answer for a machine that went away, and says it is waiting", async () => {
    const a = await machine("desk");
    const b = await machine("mac-mini");
    await a.service.fleet.add(b.service.fleet.view().self.reach.url!, b.service.fleet.pairingCode().pairing!.code);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("online");
    const bId = b.service.fleet.identity().id;
    await b.hosted.close();
    made.splice(made.indexOf(b), 1);
    await expect.poll(() => a.service.fleet.view().machines[0]?.state, { timeout: 5000 }).toBe("offline");
    const answer = await a.call("task:cancel", { taskId: "t-1", project: `jaira-machine://${bId}/${encodeURIComponent("C:\\src\\jaira")}` });
    expect(answer).toMatchObject({ queued: true, machine: "mac-mini" });
    expect(a.service.federation.outbox()).toEqual([expect.objectContaining({ machineId: bId, channel: "task:cancel" })]);
    const listed = (await a.call("machines:outbox")) as Array<{ id: string; machine: string; what: string }>;
    expect(listed).toEqual([expect.objectContaining({ machine: "mac-mini", what: "a cancel" })]);
    expect(await a.call("machines:withdraw", { id: listed[0]!.id })).toEqual([]);
    await expect(a.call("board:roots", { project: `jaira-machine://${bId}/x` })).rejects.toThrow(/mac-mini is offline/);
  });
});
