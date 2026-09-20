/**
 * `review_artifacts` with a `remote` — two doors on one request (decision 0004 §3).
 *
 * End to end through the service, with a real local repository for git and fixtures for the forge.
 * The forge's READ is held behind a latch the test releases, because which door answers first is the
 * whole subject: released, the forge settles the gate; never released, the person does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initProject, openProject } from "@jaira/persistence";
import { anchorOfNote, closingComment, describeReview, writeWorkflowFiles, type ForgeHttp } from "@jaira/runtime";
import type { JsonValue } from "@declarative-ai/json";
import type { Changeset, PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";
import { buildRig, type Rig } from "../../runtime/test/remoteRig";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = "rv";
const BRANCH = "task/t-1";

const files = (remote: JsonValue | undefined): Record<string, JsonValue> => ({
  [ROOT]: {
    label: "Review",
    inputs: { changeset: { schema: { type: "object" } } },
    outputs: {
      decision: { schema: { type: "string" }, binding: ".children.gate.output.decision" },
      settled_by: { schema: { type: "object" }, binding: ".children.gate.output.settled_by", optional: true },
      remote: { schema: { type: "object" }, binding: ".children.gate.output.remote", optional: true },
    },
    children: { gate: { state: `${ROOT}/gate`, inputs: { changeset: ".inputs.changeset" } } },
    sequence: ["gate"],
  },
  [`${ROOT}/gate`]: {
    label: "Approve the changes",
    inputs: { changeset: { schema: { type: "object" } } },
    outputs: {
      decision: { schema: { type: "string" } },
      decisions: { schema: { type: "array", items: { type: "object" } } },
      settled_by: { schema: { type: "object" }, optional: true },
      remote: { schema: { type: "object" }, optional: true },
    },
    operation: {
      kind: "function",
      function: "review_artifacts",
      args: { prompt: "Review the implementation", options: ["approve", "revise", "cut"], ...(remote !== undefined ? { remote } : {}) },
    },
  },
});

let changeset: Changeset = {
  source: "git:0000000000000000000000000000000000000000",
  changes: [{ id: "c1", path: "app.txt", action: "update", before: "one\ntwo\nthree\n", after: "one\ntwo, revised\nthree\n" }],
};

let rig: Rig;
let replay: Replay;
let service: AppService;
let pushes: PushMessage[];
let home: string;
let release: () => void;

/** The replay, with the forge's READ of the request held until the test says so. */
function latched(inner: ForgeHttp): ForgeHttp {
  const opened = new Promise<void>((resolve) => (release = resolve));
  return async (request) => {
    if (request.method === "GET" && /\/merge_requests\/7430(\/|$)/.test(new URL(request.url).pathname)) await opened;
    return inner(request);
  };
}

async function boot(remote: JsonValue | undefined = { to: "origin", target: "main" }): Promise<void> {
  const { workflowsDir } = initProject(rig.work, home);
  writeWorkflowFiles(workflowsDir, files(remote));
  service = new AppService({ baseDir: home, publish: (m) => pushes.push(m), forgeHttp: latched(replay.http), watchWorkflows: false });
  await service.open(rig.work);
  service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
  service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), policy: { remote: { publish: "allow" } } } as JsonValue });
}

beforeEach(() => {
  rig = buildRig();
  // The task's branch holds the work as a commit, and the project directory is back on `main`, so
  // the task gets a worktree of its own — the case the merge sequence is about.
  rig.git(rig.work, "add", "-A");
  rig.git(rig.work, "commit", "-m", "the work under review");
  rig.git(rig.work, "checkout", "main");
  // A changeset names the tree it was diffed against by object id.
  changeset = { ...changeset, source: `git:${rig.git(rig.work, "rev-parse", "main")}` };
  home = testHome();
  replay = replayForge();
  pushes = [];
});

afterEach(async () => {
  release?.();
  await service?.close().catch(() => undefined);
  rig.dispose();
});

async function until<T>(read: () => T | undefined | false, label: string, budgetMs = 60_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const finished = (taskId: string): PushMessage | undefined => pushes.find((m) => m.type === "run:finished" && (m as { taskId?: string }).taskId === taskId);
const outputsOf = (taskId: string): Record<string, unknown> => {
  const project = openProject(rig.work, { baseDir: home });
  try {
    return JSON.parse(project.runtime.get(taskId)?.outputsJson ?? "{}") as Record<string, unknown>;
  } finally {
    project.close();
  }
};

async function parked(): Promise<{ taskId: string; gate: ReturnType<AppService["pendingInteractions"]>[number] }> {
  const { taskId } = await service.createTask({ title: "Review the implementation", workflow: ROOT, branch: BRANCH, inputs: { changeset: changeset as unknown as JsonValue } });
  await service.startTask({ taskId });
  const gate = await until(() => service.pendingInteractions().find((p) => p.taskId === taskId && p.component === "review_artifacts"), "the gate to park");
  return { taskId, gate };
}

describe("the gate parks exactly as today, and the same request lives on the forge", () => {
  it("pushes the review, opens the request, and carries where it lives on the gate's own inputs", async () => {
    await boot();
    const { taskId, gate } = await parked();
    expect(gate.inputs["remote"]).toMatchObject({ to: "origin", target: "main", provider: "gitlab", number: 7430, url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7430", branch: `jaira/${taskId}/review`, key: "review" });
    expect(rig.git(rig.bare, "show", `jaira/${taskId}/review:app.txt`)).toContain("two, revised");
    // What the request says about itself: the prompt, then what is in the set.
    expect(replay.seen.find((r) => r.method === "POST")!.body).toMatchObject({ title: "Review the implementation", description: expect.stringContaining("`app.txt` — update") });
    // What the strip draws from, and what the board card says instead of "waiting for you".
    expect(service.remoteStatus(taskId)).toMatchObject([{ key: "review", provider: "gitlab", number: 7430, awaiting: true, commenters: [] }]);
    expect(service.listTasks().find((t) => t.taskId === taskId)?.inReview).toEqual({ provider: "gitlab", number: 7430, url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7430" });
  });

  it("\"Check now\" reads the forge on demand and reports what it found", async () => {
    await boot();
    const { taskId } = await parked();
    release();
    const rows = await service.checkRemotes(taskId);
    // The fixture's request is merged, so the look settles it: nothing is awaited any more, and the
    // person who spoke there is named.
    expect(rows).toMatchObject([{ number: 7430, awaiting: false, commenters: ["mara"] }]);
    expect(rows[0]!.checkedAt).toBeGreaterThan(0);
    await until(() => finished(taskId), "the run to finish");
    expect(service.listTasks().find((t) => t.taskId === taskId)?.inReview).toBeUndefined();
  });

  it("is the plain local gate with no remote, and with remote: null", async () => {
    await boot(null);
    const { gate } = await parked();
    expect(gate.inputs["remote"] ?? null).toBeNull();
    expect(replay.seen).toEqual([]);
    expect(rig.git(rig.bare, "branch", "--format=%(refname:short)")).toBe("main");
  });
});

describe("the forge settles first", () => {
  it("merged there → approve, every change merged, and the task's worktree adopts the forge's history", async () => {
    await boot();
    const { taskId, gate } = await parked();
    const worktree = service.taskDetail(taskId).worktreePath!;
    const pushed = rig.git(worktree, "rev-parse", "HEAD");

    // The reviewer merges on the forge — squashed, so what lands is not what was pushed.
    const theirs = rig.reviewer();
    rig.git(theirs, "merge", "--squash", `origin/jaira/${taskId}/review`);
    rig.git(theirs, "commit", "-m", "Review the implementation (!7430)");
    rig.git(theirs, "push", "origin", "main");
    const landed = rig.git(theirs, "rev-parse", "HEAD");

    release();
    await until(() => finished(taskId), "the run to finish");
    expect(service.taskDetail(taskId).status).toBe("completed");
    // The gate is gone from the conversation's inbox: answered, by the other door.
    expect(service.pendingInteractions().find((p) => p.requestId === gate.requestId)).toBeUndefined();

    const out = outputsOf(taskId);
    expect(out).toMatchObject({
      decision: "approve",
      settled_by: { via: "remote", who: "mara", act: "merged", effect: "adopt" },
      remote: { number: 7430, head: landed, adopted: { reset: true, target: "fast-forwarded", dropped: `refs/jaira/dropped/${taskId}/1` } },
    });
    // The worktree IS the merged tree, and what it held is still reachable.
    expect(rig.git(worktree, "rev-parse", "HEAD")).toBe(landed);
    expect(rig.git(rig.work, "rev-parse", `refs/jaira/dropped/${taskId}/1`)).toBe(pushed);
    // A comment anybody left rides the result as a note, marked with where it came from.
    await service.close();
    const project = openProject(rig.work, { baseDir: home });
    try {
      expect(project.remotes.get(taskId, "review")).toMatchObject({ awaiting: false });
      expect(project.remotes.get(taskId, "review")!.requestId).toBeUndefined();
    } finally {
      project.close();
    }
  });

  it("answers a gate whose run is GONE: closed for a weekend, the first read after start settles it and the task resumes", async () => {
    await boot();
    const { taskId } = await parked();
    await service.close();
    expect(finished(taskId)).toBeDefined(); // the run ended with the process; the question did not
    pushes = [];

    // A new process. Nothing is running; the row is still awaited, so opening the project probes.
    replay = replayForge();
    service = new AppService({ baseDir: home, publish: (m) => pushes.push(m), forgeHttp: replay.http, watchWorkflows: false });
    await service.open(rig.work);
    await until(() => finished(taskId), "the resumed run to finish");
    expect(service.taskDetail(taskId).status).toBe("completed");
    expect(outputsOf(taskId)).toMatchObject({ decision: "approve", settled_by: { via: "remote", act: "merged" } });
    // The resumed run found the SAME request: nothing was opened twice.
    expect(replay.seen.filter((r) => r.method === "POST" && /\/merge_requests$/.test(new URL(r.url).pathname))).toEqual([]);
  });
});

describe("the person settles first", () => {
  it("answers the state, stops watching, posts the notes as threads and says once what was decided", async () => {
    await boot();
    const { taskId, gate } = await parked();
    service.submitInteraction(gate.requestId, {
      decision: "revise",
      decisions: [
        {
          id: "c1",
          decision: "comment",
          notes: [{ artifact: "c1", quote: "two, revised", side: "after", body: "Say what was revised.", author: "Test Author", at: "2026-09-19T10:00:00.000Z" }],
        },
      ],
    } as unknown as JsonValue);
    // The person answered FIRST. Only now does the forge get to answer anything — including the read
    // that was already in flight, which must find a gate that is no longer waiting and drop it.
    release();
    await until(() => finished(taskId), "the run to finish");

    expect(outputsOf(taskId)).toMatchObject({ decision: "revise", settled_by: { via: "local", who: "Test Author", act: "answered" }, remote: { number: 7430, key: "review" } });
    const writes = replay.seen.filter((r) => r.method === "POST" && r.url.includes("/7430/"));
    expect(writes.map((r) => new URL(r.url).pathname.split("/").pop())).toEqual(["discussions", "notes"]);
    // The note went where it points: line 2 of the file as it would be.
    expect(writes[0]!.body).toMatchObject({ body: "Say what was revised.", position: { new_path: "app.txt", new_line: 2 } });
    expect(writes[1]!.body).toEqual({ body: "Decided in JaiRA by Test Author: **revise** (1 comment)." });
    // Approve at the gate does not merge the request, and neither does anything else here.
    expect(replay.seen.some((r) => r.method === "PUT")).toBe(false);

    await service.close();
    const project = openProject(rig.work, { baseDir: home });
    try {
      expect(project.remotes.awaiting()).toEqual([]);
    } finally {
      project.close();
    }
  });
});

describe("what the gate says on the forge", () => {
  it("describes the review by its prompt and what is in the set", () => {
    expect(describeReview("Review the implementation", changeset)).toContain("- `app.txt` — update");
    expect(describeReview("Just this", undefined)).toBe("Just this");
  });

  it("finds a note's line from the words it quotes, on the side it was taken", () => {
    const change = changeset.changes[0]!;
    const note = { artifact: "c1", quote: "two, revised", body: "x", author: "a", at: "t" };
    expect(anchorOfNote({ ...note, side: "after" }, change)).toEqual({ path: "app.txt", line: 2, side: "after" });
    expect(anchorOfNote({ ...note, quote: "two", side: "before" }, change)).toEqual({ path: "app.txt", line: 2, side: "before" });
    expect(anchorOfNote({ ...note, quote: "not in the file" }, change)).toBeUndefined();
  });

  it("says once what was decided, with a tally", () => {
    expect(closingComment("Ofer", { decision: "approve", decisions: [{ id: "a", decision: "merged" }, { id: "b", decision: "merged" }] })).toBe("Decided in JaiRA by Ofer: **approve** (2 merged).");
    expect(closingComment(undefined, { decisions: [] })).toBe("Decided in JaiRA: the review was answered.");
  });
});

