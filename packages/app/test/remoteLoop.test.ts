/**
 * `changeset/review-loop` carries the merge request BY NAME (decision 0004, NAMES.md §3).
 *
 * The name `review` is scoped on the loop's root — above the loop — so every round's gate resolves
 * the same `(name, scope)`: the same branch, the same request. What is pinned here is that the
 * built-in workflow loads with that spelling, that the key the engine hands the gate is the scoped
 * one, and that a merge on the forge ends the loop WITHOUT `apply-changeset` writing anything.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBundle } from "@declarative-ai/hw";
import { initProject, openProject } from "@jaira/persistence";
import { CHANGESET_REVIEW_LOOP_ID, changesetReviewLoopFiles, hostCalleeSignatures, writeWorkflowFiles } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { Changeset, PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";
import { buildRig, type Rig } from "../../runtime/test/remoteRig";

vi.setConfig({ testTimeout: 90_000 });

const REMOTE = { to: "origin", target: "main" };

describe("the built-in loop, with a remote", () => {
  it("loads: the name is scoped above the loop and the gate's default argument is that name", () => {
    const files = changesetReviewLoopFiles({ remote: REMOTE }) as Record<string, { environment?: unknown; transitions?: Array<{ when: string }> }>;
    const root = files[CHANGESET_REVIEW_LOOP_ID]!;
    expect(root.environment).toEqual({
      names: { review: {} },
      functions: { review_artifacts: { args: { remote: { $ref: "review", to: "origin", target: "main" } } } },
    });
    expect(() => loadBundle(Object.fromEntries(Object.entries(files).map(([id, doc]) => [`${id}.json`, doc])) as never, CHANGESET_REVIEW_LOOP_ID, { functions: hostCalleeSignatures() })).not.toThrow();
  });

  it("is unchanged without one — no environment, no review-level options, the same transitions", () => {
    const plain = changesetReviewLoopFiles() as Record<string, { environment?: unknown; transitions?: unknown[]; operation?: { args?: Record<string, unknown> } }>;
    expect(plain[CHANGESET_REVIEW_LOOP_ID]!.environment).toBeUndefined();
    expect(plain[CHANGESET_REVIEW_LOOP_ID]!.transitions).toHaveLength(6);
    expect(plain[`${CHANGESET_REVIEW_LOOP_ID}/gate`]!.operation!.args).not.toHaveProperty("options");
  });
});

describe("run through the service", () => {
  let rig: Rig;
  let replay: Replay;
  let service: AppService;
  let pushes: PushMessage[];
  let home: string;

  beforeEach(async () => {
    rig = buildRig();
    rig.git(rig.work, "add", "-A");
    rig.git(rig.work, "commit", "-m", "the work under review");
    rig.git(rig.work, "checkout", "main");
    home = testHome();
    replay = replayForge();
    pushes = [];
    const { workflowsDir } = initProject(rig.work, home);
    writeWorkflowFiles(workflowsDir, changesetReviewLoopFiles({ remote: REMOTE }) as Record<string, JsonValue>);
    service = new AppService({ baseDir: home, publish: (m) => pushes.push(m), forgeHttp: replay.http, watchWorkflows: false });
    await service.open(rig.work);
    service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
    service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), functions: { review_artifacts: { publish: "allow" } } } as JsonValue });
  });

  afterEach(async () => {
    await service.close().catch(() => undefined);
    rig.dispose();
  });

  it("names the request by its scope, and a merge on the forge ends the loop with nothing applied", async () => {
    const changeset: Changeset = {
      source: `git:${rig.git(rig.work, "rev-parse", "main")}`,
      changes: [{ id: "c1", path: "app.txt", action: "update", before: "one\ntwo\nthree\n", after: "one\ntwo, revised\nthree\n" }],
    };
    const { taskId } = await service.createTask({ title: "Review the implementation", workflow: CHANGESET_REVIEW_LOOP_ID, branch: "task/t-1", inputs: { changeset: changeset as unknown as JsonValue } });
    // The reviewer's version of the file differs from ours: if `apply` wrote, it would clobber it.
    await service.startTask({ taskId });
    const deadline = Date.now() + 60_000;
    while (!pushes.some((m) => m.type === "run:finished" && (m as { taskId?: string }).taskId === taskId)) {
      if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(service.taskDetail(taskId)).slice(0, 800)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(service.taskDetail(taskId).status).toBe("completed");
    const worktree = service.taskDetail(taskId).worktreePath!;
    await service.close();

    const project = openProject(rig.work, { baseDir: home });
    try {
      const rows = project.remotes.forTask(taskId);
      expect(rows).toHaveLength(1);
      // The engine's key for a scoped name: the name, and where its scope is anchored.
      expect(rows[0]!.key).toMatch(/^review#/);
      expect(rows[0]!.branch).toMatch(new RegExp(`^jaira/${taskId}/review`));
      const outputs = JSON.parse(project.runtime.get(taskId)?.outputsJson ?? "{}") as { applied?: string[]; decisions?: Array<{ decision: string }> };
      expect(outputs.decisions?.map((d) => d.decision)).toEqual(["merged"]);
      // Settled `merged` and applied NOTHING: the worktree already is the forge's history.
      expect(outputs.applied).toEqual([]);
    } finally {
      project.close();
    }
    // The fixture's forge says "merged" while the bare repository's `main` never moved, so what was
    // adopted is the ORIGINAL file — and `apply` writing `after` over it is exactly what must not happen.
    // (Line endings normalized: a Windows checkout may have `autocrlf` on.)
    expect(readFileSync(join(worktree, "app.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("one\ntwo\nthree\n");
  });
});
