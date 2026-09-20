/**
 * A workflow that waits on the forge, end to end through the service (decision 0004 §2–§3).
 *
 * Push, open, then a guard parks on `on_remote_event`. What is pinned is the chain nothing smaller
 * can see: the wait marks the request awaited, that makes the service probe, the probe makes it
 * read, the read settles, and the run continues down the rule the settlement chose — with nobody at
 * this machine doing anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";
import { buildRig, type Rig } from "../../runtime/test/remoteRig";

vi.setConfig({ testTimeout: 60_000 });

const ROOT = "ship";
const WAIT = "on_remote_event('merge_request', { settle_after: '5m', timeout: '7d' })";

const files = (): Record<string, JsonValue> => ({
  [ROOT]: {
    label: "Ship it",
    children: { push: { state: `${ROOT}/push` }, open: { state: `${ROOT}/open` }, landed: { state: `${ROOT}/landed` }, revise: { state: `${ROOT}/revise` } },
    sequence: ["push", "open"],
    transitions: [
      { to: "landed", when: `.run.cursor === 'open' && .children.open.outcome === 'success' && ${WAIT}.decision === 'approve'` },
      { to: "revise", when: `.run.cursor === 'open' && .children.open.outcome === 'success' && ${WAIT}` },
      { to: "terminate.success", when: ".children.landed.outcome === 'success' || .children.revise.outcome === 'success'" },
    ],
  },
  [`${ROOT}/push`]: { label: "Push", outputs: { remote: { schema: { type: "object" } } }, operation: { kind: "function", function: "remote_push", args: { remote: { to: "origin", target: "main" } } } },
  [`${ROOT}/open`]: { label: "Open", outputs: { remote: { schema: { type: "object" } } }, operation: { kind: "function", function: "remote_open" } },
  // Two states that do nothing but exist: which one is entered is the whole observation.
  [`${ROOT}/landed`]: { label: "Landed", outputs: { settled: { schema: { type: "boolean" } } }, operation: { kind: "function", function: "changeset-review-status", input: { decisions: { binding: { json: [] } } } } },
  [`${ROOT}/revise`]: { label: "Revise", outputs: { settled: { schema: { type: "boolean" } } }, operation: { kind: "function", function: "changeset-review-status", input: { decisions: { binding: { json: [] } } } } },
});

let rig: Rig;
let replay: Replay;
let service: AppService;
let pushes: PushMessage[];
let home: string;

beforeEach(async () => {
  rig = buildRig();
  home = testHome();
  const { workflowsDir } = initProject(rig.work, home);
  writeWorkflowFiles(workflowsDir, files());
  replay = replayForge();
  pushes = [];
  service = new AppService({ baseDir: home, publish: (m) => pushes.push(m), forgeHttp: replay.http, watchWorkflows: false });
  await service.open(rig.work);
  service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
  service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), policy: { remote: { publish: "allow" } } } as JsonValue });
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rig.dispose();
});

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 45_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a workflow that waits on the forge", () => {
  it("is carried on by a merge nobody here made: probe, read, settle, and the rule the settlement chose", async () => {
    const { taskId } = await service.createTask({ title: "Review the implementation", workflow: ROOT });
    await service.startTask({ taskId });
    await until(() => pushes.find((m) => m.type === "run:finished" && (m as { taskId?: string }).taskId === taskId), "the run to finish");

    const detail = JSON.stringify(service.taskDetail(taskId));
    expect(service.taskDetail(taskId).status, detail.slice(0, 600)).toBe("completed");

    // The forge was asked the way the design says: the request, its discussions, its approvals.
    const reads = replay.seen.filter((r) => r.method === "GET" && r.url.includes("/merge_requests/7430")).map((r) => new URL(r.url).pathname.split("/7430")[1] ?? "");
    expect(reads.sort()).toEqual(["", "/approvals", "/discussions"]);
    await service.close();

    const project = openProject(rig.work, { baseDir: home });
    try {
      // `landed` ran and `revise` did not: the guard read `.decision` off the settlement.
      const entered = project.events.list(taskId).filter((e) => e.type === "instance.entered").map((e) => (e.event as { stateId?: string }).stateId);
      expect(entered).toContain(`${ROOT}/landed`);
      expect(entered).not.toContain(`${ROOT}/revise`);
      // Settled, so nothing is awaited and nothing will be polled.
      expect(project.remotes.get(taskId, "review")).toMatchObject({ number: 7430, awaiting: false, seen: ["1301"] });
      expect(project.remotes.awaiting()).toEqual([]);
    } finally {
      project.close();
    }
  });
});
