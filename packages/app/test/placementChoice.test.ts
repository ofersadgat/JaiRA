/**
 * What a task waiting for a workspace keeps, and where a person may send one (decision 0013 §5, ruled
 * 2026-10-02). One engine with two clones of the same repository, so placement runs without a second
 * machine, and a cap of zero on a workspace stands in for "no room".
 *
 *  - A start that has to wait is kept WHOLE: the composer's settings and a scripted model are what it
 *    starts with when a workspace frees up. It used to start with neither — a conversation asked for on
 *    one model ran on the project's default.
 *  - While it waits it says what it asked and what each workspace answered, and counts the rounds.
 *  - A task sent to one workspace waits for THAT workspace: another with room is not a substitute.
 *  - What it waits for can be changed before it starts.
 *  - How it was placed is on the task once it has started.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { AppService, candidatesOf, queuedView, serviceHandlers, waitsForWords, workspaceKey, type QueuedTask } from "@jaira/service";
import type { ProjectSummary, PushMessage, QueuedPlacement, TaskDetail } from "@jaira/shared";
import { eventually } from "@jaira/testing";

const dirs: string[] = [];
const services: AppService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FAKE = [{ output: { said: "hi" } }];

interface Rig {
  service: AppService;
  pushes: PushMessage[];
  call: (channel: string, request?: unknown) => Promise<unknown>;
  /** The two clones, in the order tasks are placed on them. */
  first: string;
  second: string;
  /** Set how many runs each clone takes at once; absent is no limit. */
  caps: (caps: { first?: number; second?: number }) => Promise<void>;
  finished: (taskId: string) => Promise<void>;
}

async function rig(): Promise<Rig> {
  const base = mkdtempSync(join(tmpdir(), "jaira-choice-base-"));
  dirs.push(base);
  const pushes: PushMessage[] = [];
  // The machine's real load must not decide a test: only the caps do.
  const service = new AppService({ baseDir: base, version: "0.2.0", watchWorkflows: false, placementThresholds: { cpuLimit: 2, memoryFloor: 0 }, publish: (m) => pushes.push(m) });
  services.push(service);
  const clone = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-choice-clone-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:ofersadgat/jaira.git"], { cwd: dir });
    const paths = initProject(dir, base);
    mkdirSync(join(paths.workflowsDir, "t"), { recursive: true });
    writeFileSync(join(paths.workflowsDir, "t", "hi.json"), JSON.stringify({ label: "Say hi", operation: { prompt: "say hi", output: { said: { schema: { type: "string" } } } } }));
    await service.open(dir);
    return dir;
  };
  const one = await clone();
  const two = await clone();
  const handlers = serviceHandlers(service) as Record<string, (request: unknown) => unknown>;
  const call = async (channel: string, request?: unknown): Promise<unknown> => handlers[channel]!(request);
  const me = service.fleet.identity().id;
  // The service's own names for the two directories, which is what a workspace's key is written with.
  const listed = ((await call("project:list")) as ProjectSummary[]).filter((p) => p.identity !== undefined).map((p) => p.project);
  expect(listed).toHaveLength(2);
  const [first, second] = [listed.find((p) => p.toLowerCase().includes(one.split(/[\\/]/).pop()!.toLowerCase()))!, listed.find((p) => p.toLowerCase().includes(two.split(/[\\/]/).pop()!.toLowerCase()))!];
  const caps: Rig["caps"] = async (wanted) => {
    await call("placement:setRules", {
      project: first,
      order: [workspaceKey(me, first), workspaceKey(me, second)],
      caps: { ...(wanted.first !== undefined ? { [workspaceKey(me, first)]: wanted.first } : {}), ...(wanted.second !== undefined ? { [workspaceKey(me, second)]: wanted.second } : {}) },
    });
  };
  const finished = (taskId: string): Promise<void> => eventually(() => pushes.some((m) => m.type === "run:finished" && m.taskId === taskId), "the run to finish");
  return { service, pushes, call, first, second, caps, finished };
}

const queue = async (r: Rig): Promise<QueuedPlacement[]> => (await r.call("placement:queue")) as QueuedPlacement[];

describe("a start that has to wait", () => {
  it("is kept whole, and starts as it was asked to when a workspace frees up", async () => {
    const r = await rig();
    // What a direct start under the same pick pins: the waiting one must pin the same.
    await r.caps({});
    const direct = r.service.createTask({ title: "direct", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: direct.taskId, project: r.first, fake: FAKE, overrides: { model: "fake/picked" } });
    await r.finished(direct.taskId);
    const plain = r.service.createTask({ title: "plain", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: plain.taskId, project: r.first, fake: FAKE });
    await r.finished(plain.taskId);
    const pinned = (taskId: string): string | undefined => (r.service.taskDetail(taskId, r.first) as TaskDetail).runs[0]?.snapshotHash;
    expect(pinned(direct.taskId)).not.toBe(pinned(plain.taskId));

    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    expect(await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, overrides: { model: "fake/picked" } })).toEqual({ taskId: task.taskId, queued: true });
    expect(await queue(r)).toEqual([expect.objectContaining({ taskId: task.taskId, phase: "waiting", settings: { model: "fake/picked" } })]);

    await r.caps({});
    await r.service.tryQueue();
    await r.finished(task.taskId);
    expect(await queue(r)).toEqual([]);
    // The scripted model answered (the run completed) and the pick was pinned, as for the direct start.
    expect(r.service.listTasks(r.first).find((t) => t.taskId === task.taskId)?.status).toBe("completed");
    expect(pinned(task.taskId)).toBe(pinned(direct.taskId));
  });

  it("judges usage by the model that was picked, not the one the file or the default names", async () => {
    const r = await rig();
    const accountsOf = (picked?: string): string[] => (r.service as unknown as { accountsOf(workflow: string, project: string, picked?: string): string[] }).accountsOf("t/hi", r.first, picked);
    expect(accountsOf("codex-cli/gpt-5")).toEqual(["codex"]);
    expect(accountsOf("claude-cli/claude-sonnet-5")).toEqual(["claude"]);
    // A pick that names no route decides nothing: the file and the default do, as before.
    expect(accountsOf("some-preset")).toEqual(accountsOf());
  });

  it("says what it asked and what each workspace answered, and counts the rounds", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE });
    const [once] = await queue(r);
    expect(once).toMatchObject({ asked: 2, refused: 2, waits: 1 });
    expect(once!.asks.map((ask) => [ask.project, ask.why])).toEqual([
      [r.first, "0 of 0 running"],
      [r.second, "0 of 0 running"],
    ]);
    expect(once!.nextAt).toBeGreaterThan(once!.askedAt!);

    r.pushes.length = 0;
    await r.service.tryQueue();
    expect((await queue(r))[0]).toMatchObject({ asked: 4, refused: 4, waits: 2 });
    // A round that only asked again moves the waiting conversation's figures and nothing else.
    expect(r.pushes.map((m) => m.type)).toEqual(["placement:changed"]);
  });

  it("carries how it was placed once it has started", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE });
    await r.service.tryQueue();
    // The first has no room still; the second has.
    await r.caps({ first: 0 });
    await r.service.tryQueue();
    const there = r.service.listTasks(r.second);
    expect(there).toHaveLength(1);
    await r.finished(there[0]!.taskId);
    const placed = r.service.taskDetail(there[0]!.taskId, r.second).placed!;
    expect(placed).toMatchObject({ asked: 6, refused: 5, waits: 2, on: { project: r.second } });
    expect(placed.asks.map((ask) => ask.why)).toEqual(["0 of 0 running", undefined]);
    expect(placed.steps?.map((step) => step.kind)).toEqual(["pin"]);
    expect(placed.at).toBeGreaterThanOrEqual(placed.since);
    // Re-made where it runs, and gone from where it was asked for.
    expect(r.service.listTasks(r.first)).toEqual([]);
    // …and a window that was showing it where it waited is told where it went.
    const moved = r.pushes.flatMap((m) => (m.type === "placement:changed" ? (m.moved ?? []) : []));
    expect(moved).toEqual([{ taskId: task.taskId, project: r.first, to: { taskId: there[0]!.taskId, project: r.second } }]);
  });

  it("is asked about again as soon as the rules make room, not at the next tick", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE });
    expect(await queue(r)).toHaveLength(1);
    await r.caps({});
    await r.finished(task.taskId);
    expect(await queue(r)).toEqual([]);
  });

  it("says where it went when a person sends it to another workspace by hand", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE });
    const sent = (await r.call("placement:runOn", { taskId: task.taskId, project: r.first, target: r.second })) as { taskId: string; project: string };
    expect(sent.project).toBe(r.second);
    await r.finished(sent.taskId);
    const moved = r.pushes.flatMap((m) => (m.type === "placement:changed" ? (m.moved ?? []) : []));
    expect(moved).toEqual([{ taskId: task.taskId, project: r.first, to: sent }]);
    expect(r.service.taskDetail(sent.taskId, r.second).placed).toMatchObject({ byHand: true, on: { project: r.second } });
  });
});

describe("a task sent somewhere", () => {
  it("waits for the workspace it was sent to, though another has room", async () => {
    const r = await rig();
    await r.caps({ second: 0 });
    const task = r.service.createTask({ title: "sent", workflow: "t/hi", project: r.first });
    expect(await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, runOn: { project: r.second } })).toEqual({ taskId: task.taskId, queued: true });
    const [waiting] = await queue(r);
    expect(waiting).toMatchObject({ target: { project: r.second }, asked: 1, refused: 1 });
    expect(waiting!.asks.map((ask) => ask.project)).toEqual([r.second]);
    await r.service.tryQueue();
    // Still waiting, and nothing ran in the workspace that had room.
    expect((await queue(r))[0]).toMatchObject({ asked: 2, waits: 2 });
    expect(r.service.listTasks(r.first).map((t) => t.status)).toEqual(["queued"]);

    await r.caps({});
    await r.service.tryQueue();
    const there = r.service.listTasks(r.second);
    expect(there).toHaveLength(1);
    await r.finished(there[0]!.taskId);
    expect(r.service.taskDetail(there[0]!.taskId, r.second).placed).toMatchObject({ target: { project: r.second }, on: { project: r.second } });
  });

  it("goes straight to the workspace it was sent to when that has room", async () => {
    const r = await rig();
    await r.caps({});
    const task = r.service.createTask({ title: "sent", workflow: "t/hi", project: r.first });
    const answer = (await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, runOn: { project: r.second } })) as { taskId: string; project?: string };
    expect(answer.project).toBe(r.second);
    await r.finished(answer.taskId);
    // Only the workspace it was sent to was asked.
    expect(r.service.taskDetail(answer.taskId, r.second).placed).toMatchObject({ asked: 1, refused: 0, waits: 0 });
  });

  it("can be sent somewhere else, or anywhere, before it starts", async () => {
    const r = await rig();
    await r.caps({ second: 0 });
    const task = r.service.createTask({ title: "sent", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, runOn: { project: r.second } });
    // Anywhere: the first workspace has room, and takes it at once.
    expect(await r.call("placement:change", { taskId: task.taskId, project: r.first, runOn: null })).toEqual([]);
    await r.finished(task.taskId);
    expect(r.service.taskDetail(task.taskId, r.first).placed).toMatchObject({ on: { project: r.first } });
    expect(r.service.taskDetail(task.taskId, r.first).placed?.target).toBeUndefined();
  });

  it("changes what its first message runs under while it waits", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE, overrides: { model: "fake/one" } });
    const after = (await r.call("placement:change", { taskId: task.taskId, project: r.first, overrides: { model: "fake/two" } })) as QueuedPlacement[];
    expect(after[0]?.settings).toEqual({ model: "fake/two" });
  });

  it("leaves the queue when it is deleted", async () => {
    const r = await rig();
    await r.caps({ first: 0, second: 0 });
    const task = r.service.createTask({ title: "waits", workflow: "t/hi", project: r.first });
    await r.call("task:start", { taskId: task.taskId, project: r.first, fake: FAKE });
    await r.call("task:delete", { taskId: task.taskId, project: r.first });
    expect(await queue(r)).toEqual([]);
  });
});

describe("the rules alone", () => {
  const member = (project: string, machine?: string): ProjectSummary => ({ project, ...(machine !== undefined ? { machine: { id: machine, label: machine, state: "online" } } : {}) }) as ProjectSummary;
  const members = [member("/here/a"), member("/here/b"), member("jaira-machine://mac/%2Fcode", "mac")];

  it("narrows to one workspace, to one machine's, or not at all", () => {
    expect(candidatesOf(members, undefined, "me").map((m) => m.project)).toEqual(["/here/a", "/here/b", "jaira-machine://mac/%2Fcode"]);
    expect(candidatesOf(members, { machine: "me" }, "me").map((m) => m.project)).toEqual(["/here/a", "/here/b"]);
    expect(candidatesOf(members, { machine: "mac" }, "me").map((m) => m.project)).toEqual(["jaira-machine://mac/%2Fcode"]);
    // A workspace wins over a machine, and one that is not open leaves nothing to ask.
    expect(candidatesOf(members, { machine: "mac", project: "/here/b" }, "me").map((m) => m.project)).toEqual(["/here/b"]);
    expect(candidatesOf(members, { project: "/gone" }, "me")).toEqual([]);
  });

  const item: QueuedTask = { taskId: "t-1", project: "/here/a", identity: "host/repo", requires: [], since: 1000 };

  it("reads a waiting task as a window does", () => {
    expect(queuedView(item, "placing")).toEqual({ taskId: "t-1", project: "/here/a", requires: [], since: 1000, phase: "placing", asked: 0, refused: 0, waits: 0, asks: [] });
    const asked = queuedView({ ...item, askedAt: 5000, waits: 1, start: { overrides: { model: "m" } }, target: { machine: "mac" } }, "waiting");
    expect(asked).toMatchObject({ phase: "waiting", askedAt: 5000, nextAt: 15_000, settings: { model: "m" }, target: { machine: "mac" } });
  });

  it("says in the log what it waits for and why", () => {
    const asks = [
      { at: 1, project: "/here/a", machineId: "me", label: "desk", dir: "/here/a", why: "low on memory (9% free)" },
      { at: 1, project: "x", machineId: "mac", label: "mac-mini", dir: "/code/repo", why: "offline" },
    ];
    expect(waitsForWords({ ...item, asks })).toBe("a workspace with room: desk / a — low on memory (9% free); mac-mini / repo — offline");
    expect(waitsForWords({ ...item, target: { machine: "mac" }, asks: [asks[1]!] })).toBe("a workspace with room on the machine it was sent to: mac-mini / repo — offline");
    expect(waitsForWords({ ...item, target: { project: "/gone" }, asks: [] })).toBe("the workspace it was sent to: none of them is open");
  });
});
