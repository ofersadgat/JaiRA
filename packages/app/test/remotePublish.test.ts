/**
 * Publishing, end to end through the service (decision 0004 §1–§2).
 *
 * A workflow that pushes and opens a merge request, run the way the app runs one. What is being
 * pinned is the seam nothing in `@jaira/runtime` can see: that the question arrives as an ordinary
 * gate in the conversation saying what will be sent and as whom, that NOTHING leaves the machine
 * before it is answered, and that "always for this project" lands in the project's own settings.
 *
 * `origin` reads as gitlab.com and pushes to a bare repository on disk; the forge is fixtures.
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

// Real git processes and a real run, in a suite that runs files in parallel.
vi.setConfig({ testTimeout: 60_000 });

const ROOT = "publish";

const files = (): Record<string, JsonValue> => ({
  [ROOT]: {
    label: "Publish for review",
    outputs: { remote: { schema: { type: "object" }, binding: ".children.open.output.remote" } },
    children: {
      push: { state: `${ROOT}/push` },
      // The request is carried BY VALUE here: the push's result is the open's argument.
      open: { state: `${ROOT}/open`, inputs: { remote: ".children.push.output.remote" } },
    },
    sequence: ["push", "open"],
  },
  [`${ROOT}/push`]: {
    label: "Push",
    outputs: { remote: { schema: { type: "object" } } },
    operation: { kind: "function", function: "remote_push", args: { remote: { to: "origin", target: "main" } } },
  },
  [`${ROOT}/open`]: {
    label: "Open",
    inputs: { remote: { schema: { type: "object" } } },
    outputs: { remote: { schema: { type: "object" } } },
    operation: { kind: "function", function: "remote_open", input: { remote: { binding: ".inputs.remote" } } },
  },
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
});

afterEach(async () => {
  await service.close().catch(() => undefined);
  rig.dispose();
});

async function until<T>(read: () => T | undefined, label: string, budgetMs = 45_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const branches = (): string[] => rig.git(rig.bare, "branch", "--format=%(refname:short)").split(/\r?\n/).filter((b) => b.length > 0).sort();
const finished = (taskId: string): PushMessage | undefined => pushes.find((m) => m.type === "run:finished" && (m as { taskId?: string }).taskId === taskId);

async function start(): Promise<string> {
  const { taskId } = await service.createTask({ title: "Review the implementation", workflow: ROOT });
  await service.startTask({ taskId });
  return taskId;
}

describe("a workflow that publishes", () => {
  it("asks first — in the conversation, saying what will be sent and as whom — and sends nothing until answered", async () => {
    const taskId = await start();
    const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === taskId), "the publish question");
    expect(gate.component).toBe("confirm_action");
    expect(gate.inputs).toMatchObject({
      prompt: "Push this review to GitLab and open a merge request?",
      confirmLabel: "Push and open",
      cancelLabel: "Review here only",
      details: [
        { label: "to", value: "origin · gitlab.com/gitlab-org/gitlab-runner" },
        { label: "branch", value: `jaira/${taskId}/review → main` },
        { label: "commits as", value: "Test Author (git config)" },
        { label: "request opened by", value: "@jaira-bot (the GitLab connection's token)" },
      ],
      options: [{ value: "always", label: "Always for this project" }],
    });
    // Parked, and the forge's repository has not heard a thing.
    expect(branches()).toEqual(["main"]);
    expect(replay.seen.filter((r) => r.method !== "GET")).toEqual([]);

    service.submitInteraction(gate.requestId, { confirmed: true });
    await until(() => finished(taskId), "the run to finish");
    expect(branches()).toEqual([`jaira/${taskId}/review`, "main"]);
    expect(service.taskDetail(taskId).status).toBe("completed");
  });

  it("remembers the request on the task's row, and returns it as data", async () => {
    const taskId = await start();
    const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === taskId), "the publish question");
    service.submitInteraction(gate.requestId, { confirmed: true });
    await until(() => finished(taskId), "the run to finish");
    await service.close();

    const project = openProject(rig.work, { baseDir: home });
    try {
      expect(project.remotes.forTask(taskId)).toMatchObject([
        { key: "review", provider: "gitlab", host: "gitlab.com", project: "gitlab-org/gitlab-runner", remote: "origin", branch: `jaira/${taskId}/review`, target: "main", number: 7430, awaiting: false },
      ]);
      expect(JSON.parse(project.runtime.get(taskId)?.outputsJson ?? "{}")).toMatchObject({ remote: { number: 7430, url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7430", key: "review" } });
    } finally {
      project.close();
    }
  });

  it("pushes nothing when the answer is to review here only, and the state fails with that sentence", async () => {
    const taskId = await start();
    const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === taskId), "the publish question");
    service.submitInteraction(gate.requestId, { confirmed: false });
    await until(() => finished(taskId), "the run to finish");
    expect(branches()).toEqual(["main"]);
    expect(JSON.stringify(service.taskDetail(taskId))).toContain("publishing was declined");
  });

  it("makes `always for this project` the project's own standing answer, and the next task is not asked", async () => {
    const first = await start();
    const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === first), "the publish question");
    service.submitInteraction(gate.requestId, { confirmed: true, choice: "always" });
    await until(() => finished(first), "the first run to finish");
    expect((service.readConfig().project as { policy?: unknown }).policy).toMatchObject({ remote: { publish: "allow" } });
    expect(service.readConfig().base ?? {}).not.toHaveProperty("policy.remote");

    const second = await start();
    await until(() => finished(second), "the second run to finish");
    expect(service.pendingInteractions().filter((p) => p.taskId === second)).toEqual([]);
    expect(branches()).toContain(`jaira/${second}/review`);
  });

  it("refuses a choice that was never offered", async () => {
    const taskId = await start();
    const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === taskId), "the publish question");
    expect(() => service.submitInteraction(gate.requestId, { confirmed: true, choice: "forever and everywhere" })).toThrow(/not one of the options offered/);
    service.submitInteraction(gate.requestId, { confirmed: false });
    await until(() => finished(taskId), "the run to finish");
  });
});
