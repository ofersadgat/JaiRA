/**
 * The repository watcher as the service builds it (decision 0010 §2): targets are the open project's
 * own git remotes, each through the connection its host picks — nothing about where is typed — and
 * nothing is watched until an event is switched on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject } from "@jaira/persistence";
import type { JsonValue } from "@declarative-ai/json";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";
import { buildRig, type Rig } from "../../runtime/test/remoteRig";

vi.setConfig({ testTimeout: 60_000 });

let rig: Rig;
let replay: Replay;
let service: AppService;

beforeEach(async () => {
  rig = buildRig();
  initProject(rig.work, testHome());
  replay = replayForge();
  service = new AppService({ baseDir: testHome(), publish: () => undefined, forgeHttp: replay.http, watchWorkflows: false });
  await service.open(rig.work);
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rig.dispose();
});

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 30_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const branchReads = (): number => replay.seen.filter((r) => r.url.includes("/repository/branches")).length;

describe("the service's repository watcher", () => {
  it("watches nothing while nothing is switched on, then the project's origin through its connection — and takes a baseline", async () => {
    service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
    await new Promise((r) => setTimeout(r, 300));
    expect(replay.seen).toEqual([]);

    service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), events: { "git.push": { enabled: true } } } as JsonValue });
    await until(() => branchReads() >= 2, "the branches of origin to be read");
    // gitlab.com/gitlab-org/gitlab-runner, from `.git/config` — and only the branches: push needs nothing else.
    expect(replay.seen.every((r) => r.url.includes("/projects/gitlab-org%2Fgitlab-runner/repository/branches"))).toBe(true);
    // A baseline: the heads are remembered and nothing was said.
    const store = (service as unknown as { sessions: Map<string, { project: { repoWatch: { seenAll(scope: unknown, kind: string): Map<string, unknown> } } }> }).sessions;
    const project = [...store.values()][0]!.project;
    await until(() => project.repoWatch.seenAll({ remote: "origin", repository: "gitlab.com/gitlab-org/gitlab-runner" }, "branch").size === 3, "the baseline");
    expect(service.eventWaits()).toEqual([]);
  });

  it("does not watch a remote whose host has no connection signed in, and says so once", async () => {
    // No token: GitLab's connection names GITLAB_TOKEN and nothing stores it — the provider refuses.
    service.writeConfig({
      layer: "project",
      config: { ...(service.readConfig().project as object), integrations: { forges: { gitlab: { enabled: false } } }, events: { "git.push": { enabled: true } } } as JsonValue,
    });
    await until(() => service.readLogs({ source: "runtime" }).entries.find((e) => e.message.startsWith("not watching origin")), "the skip to be said");
    // Asked again — another write, the window back — it is not said again.
    service.kickRepoWatch();
    service.kickRepoWatch();
    await new Promise((r) => setTimeout(r, 300));
    const said = service.readLogs({ source: "runtime" }).entries.filter((e) => e.message.startsWith("not watching origin"));
    expect(said.map((e) => e.message)).toEqual(["not watching origin (gitlab.com/gitlab-org/gitlab-runner) for events: no connection for gitlab.com — sign in on Connections"]);
    expect(replay.seen).toEqual([]);
  });
});

describe("events:status", () => {
  it("lists the project's remotes with their connection, and how the watcher stands with each", async () => {
    const before = await service.readEventStatus();
    expect(before.cadenceMs).toBe(60_000);
    expect(before.remotes).toEqual([
      { name: "origin", host: "gitlab.com", repository: "gitlab-org/gitlab-runner", provider: "gitlab", connection: { name: "gitlab" }, watchable: true, watching: false, events: {} },
    ]);
    service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
    service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), events: { "git.push": { enabled: true } } } as JsonValue });
    await until(() => branchReads() >= 2, "the branches of origin to be read");
    let status = await service.readEventStatus();
    for (const deadline = Date.now() + 30_000; status.remotes[0]?.checkedAt === undefined && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 20));
      status = await service.readEventStatus();
    }
    expect(status.remotes[0]).toMatchObject({ name: "origin", watching: true });
    expect(typeof status.remotes[0]!.checkedAt).toBe("number");
  });

  it("answers the shared root by role, which is no repository, with a project open", async () => {
    const status = await service.readEventStatus({ project: "shared" });
    expect(status.remotes).toEqual([]);
  });

  it("answers the shared root with no remotes when no project is open", async () => {
    await service.close();
    service = new AppService({ baseDir: testHome(), publish: () => undefined, forgeHttp: replay.http, watchWorkflows: false });
    const status = await service.readEventStatus();
    expect(status.remotes).toEqual([]);
    expect(status.tasks).toEqual({});
  });
});
