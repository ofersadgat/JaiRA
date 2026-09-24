/**
 * The remote primitives (decision 0004, build order 2).
 *
 * The git half is REAL and local: `origin` reads as gitlab.com and every byte goes to a bare
 * repository in a temp directory (`remoteRig.ts`). The forge half is the fixture replay, which throws
 * on any request it has no answer for. Nothing here can push, open or comment anywhere real.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionInputs, JsonValue } from "@declarative-ai/exec";
import { parseIntegrations, type Changeset } from "@jaira/shared";
import { NodeExec } from "../src/exec";
import { registerRemoteFunctions, REMOTE_FUNCTIONS, type PublishAnswer, type PublishRequest, type RemoteOptions } from "../src/remote";
import { SecretResolver } from "../src/secrets";
import { newRegistry } from "../src/wiring";
import { replayForge, type Replay } from "./forgeReplay";
import { buildRig, MemoryHandles, type Rig } from "./remoteRig";

// Every test here runs a dozen real git processes, and the suite runs files in parallel: the 5 s
// default is a statement about unit tests, not about these.
vi.setConfig({ testTimeout: 60_000 });

let rig: Rig;
let replay: Replay;
let handles: MemoryHandles;
let asked: PublishRequest[];

beforeEach(() => {
  rig = buildRig();
  replay = replayForge();
  handles = new MemoryHandles();
  asked = [];
});
afterEach(() => rig.dispose());

interface Setup extends Partial<RemoteOptions> {
  answer?: PublishAnswer;
}

function functions(setup: Setup = {}) {
  const { answer, ...rest } = setup;
  const registry = newRegistry();
  registerRemoteFunctions(registry, {
    taskId: "t-1",
    taskTitle: "Review the implementation",
    baseBranch: "main",
    workspaceRoot: rig.work,
    scratchDir: join(rig.root, "scratch"),
    handles,
    integrations: parseIntegrations(undefined),
    publish: "ask",
    secrets: new SecretResolver({ env: { GITLAB_TOKEN: "good" } }),
    exec: new NodeExec(),
    http: replay.http,
    ...(answer !== undefined
      ? {
          confirmPublish: async (request: PublishRequest) => {
            asked.push(request);
            return answer;
          },
        }
      : {}),
    ...rest,
  });
  const call = async (name: string, inputs: Record<string, unknown> = {}): Promise<{ value?: Record<string, JsonValue>; error?: string }> => {
    const entry = registry.functions.get(name)!;
    const result = (await entry.impl(inputs as FunctionInputs, { workspace: { root: rig.work } } as never)) as { value?: unknown; error?: { reason?: string; message?: string } };
    return {
      ...(result.value !== undefined ? { value: result.value as Record<string, JsonValue> } : {}),
      ...(result.error !== undefined ? { error: result.error.reason ?? result.error.message ?? JSON.stringify(result.error) } : {}),
    };
  };
  return { registry, call };
}

const branches = (): string[] => rig.git(rig.bare, "branch", "--format=%(refname:short)").split(/\r?\n/).filter((b) => b.length > 0).sort();
const REVIEW = "jaira/t-1/review";

describe("registration", () => {
  it("registers the five primitives, none of them memoizable or read-only", () => {
    const { registry } = functions();
    for (const name of REMOTE_FUNCTIONS) {
      const entry = registry.functions.get(name)!;
      expect(entry, name).toBeDefined();
      expect(entry.capabilities, name).toMatchObject({ memoizable: false, readOnly: false });
    }
  });
});

describe("remote.publish", () => {
  it("refuses under `deny`, and nothing leaves the machine", async () => {
    const { call } = functions({ publish: "deny", answer: "once" });
    expect((await call("remote_push")).error).toMatch(/policy does not let a workflow publish/);
    expect(branches()).toEqual(["main"]);
    expect(asked).toEqual([]);
  });

  it("refuses when it would have to ask and nobody can be asked", async () => {
    expect((await functions().call("remote_push")).error).toMatch(/needs a person's say-so and nobody can be asked/);
    expect(branches()).toEqual(["main"]);
  });

  it("asks once, saying exactly what will be sent and as whom", async () => {
    const { call } = functions({ answer: "once" });
    expect((await call("remote_push")).error).toBeUndefined();
    expect(asked).toEqual([
      {
        taskId: "t-1",
        provider: "gitlab",
        to: "origin · gitlab.com/gitlab-org/gitlab-runner",
        host: "gitlab.com",
        project: "gitlab-org/gitlab-runner",
        branch: REVIEW,
        target: "main",
        commitsAs: "Test Author (git config)",
        openedBy: "@jaira-bot",
      },
    ]);
    // A second push, and an open, in the same task: already answered.
    writeFileSync(join(rig.work, "app.txt"), "one\ntwo, revised again\nthree\n");
    await call("remote_push");
    await call("remote_open");
    expect(asked).toHaveLength(1);
  });

  it("does not ask again after a restart: a task that has pushed has been answered", async () => {
    await functions({ answer: "once" }).call("remote_push");
    // A new process: new primitives, no memory — and nobody to ask. The row is the memory.
    writeFileSync(join(rig.work, "app.txt"), "one\ntwo, after a restart\nthree\n");
    expect((await functions().call("remote_push")).error).toBeUndefined();
  });

  it("pushes nothing when the person says no", async () => {
    expect((await functions({ answer: "no" }).call("remote_push")).error).toMatch(/publishing was declined/);
    expect(branches()).toEqual(["main"]);
  });

  it("makes `always` the project's standing answer", async () => {
    let granted = 0;
    await functions({ answer: "always", grantProject: () => granted++ }).call("remote_push");
    expect(granted).toBe(1);
  });

  it("does not ask at all under `allow`", async () => {
    expect((await functions({ publish: "allow" }).call("remote_push")).error).toBeUndefined();
    expect(asked).toEqual([]);
    expect(branches()).toEqual([REVIEW, "main"]);
  });
});

describe("remote_push", () => {
  const allow = { publish: "allow" } as const;

  it("commits the worktree as the local git identity and pushes it to the task's own branch", async () => {
    const { value } = await functions(allow).call("remote_push");
    expect(rig.git(rig.bare, "log", "-1", "--format=%an <%ae>|%s", REVIEW)).toBe("Test Author <test.author@example.test>|Review the implementation");
    expect(rig.git(rig.bare, "show", `${REVIEW}:app.txt`)).toContain("two, revised");
    const head = rig.git(rig.work, "rev-parse", "HEAD");
    expect(value!["remote"]).toEqual({ provider: "gitlab", host: "gitlab.com", project: "gitlab-org/gitlab-runner", branch: REVIEW, target: "main", head, key: "review", remote: "origin" });
    expect(handles.get("t-1", "review")).toMatchObject({ pushedHead: head, branch: REVIEW, awaiting: false });
  });

  it("keeps `.jaira/` out of the commit — that is the recorder's writing, not the work", async () => {
    mkdirSync(join(rig.work, ".jaira", "system"), { recursive: true });
    writeFileSync(join(rig.work, ".jaira", "system", "journal.jsonl"), "{}\n");
    await functions(allow).call("remote_push");
    expect(rig.git(rig.bare, "ls-tree", "-r", "--name-only", REVIEW).split(/\r?\n/).sort()).toEqual(["README.md", "app.txt"]);
  });

  it("pushes a second round to the SAME branch, as a new commit on top", async () => {
    const { call } = functions(allow);
    await call("remote_push");
    const first = rig.git(rig.bare, "rev-parse", REVIEW);
    writeFileSync(join(rig.work, "app.txt"), "one\ntwo, as the reviewer asked\nthree\n");
    await call("remote_push", { message: "address the review" });
    expect(branches()).toEqual([REVIEW, "main"]);
    expect(rig.git(rig.bare, "rev-parse", `${REVIEW}~1`)).toBe(first);
    expect(rig.git(rig.bare, "log", "-1", "--format=%s", REVIEW)).toBe("address the review");
  });

  it("never force-pushes: a branch that moved on the forge refuses the push and keeps what is there", async () => {
    const { call } = functions(allow);
    await call("remote_push");
    // The reviewer pushes a fixup of their own to the request's branch.
    const theirs = rig.reviewer();
    rig.git(theirs, "checkout", REVIEW);
    writeFileSync(join(theirs, "fixup.txt"), "theirs\n");
    rig.git(theirs, "add", "-A");
    rig.git(theirs, "commit", "-m", "a reviewer's fixup");
    rig.git(theirs, "push", "origin", REVIEW);
    const onForge = rig.git(rig.bare, "rev-parse", REVIEW);

    writeFileSync(join(rig.work, "app.txt"), "one\ntwo, unaware of the fixup\nthree\n");
    expect((await call("remote_push")).error).toMatch(/the push to origin\/jaira\/t-1\/review was refused/);
    expect(rig.git(rig.bare, "rev-parse", REVIEW)).toBe(onForge);
  });

  it("gives a request named by a scoped name a branch of its own", async () => {
    const { value } = await functions(allow).call("remote_push", { config: { remote: { to: "origin", target: "main", $key: "review#feature/impl[2]" } } });
    expect((value!["remote"] as { branch: string }).branch).toBe("jaira/t-1/review-feature/impl-2");
    expect(branches()).toContain("jaira/t-1/review-feature/impl-2");
  });

  it("refuses a remote that is on no forge, and one whose host has no connection", async () => {
    rig.git(rig.work, "remote", "add", "backup", rig.bare);
    expect((await functions(allow).call("remote_push", { remote: { to: "backup" } })).error).toMatch(/'backup' is not on a forge/);
    expect((await functions(allow).call("remote_push", { remote: { to: "nowhere" } })).error).toMatch(/no git remote called 'nowhere' — it has backup, origin|origin, backup/);
    rig.git(rig.work, "remote", "add", "work", "git@git.example.org:team/app.git");
    expect((await functions(allow).call("remote_push", { remote: { to: "work", $key: "w" } })).error).toMatch(/no connection is set up for git.example.org/);
    // Two remotes and none named: say which, rather than guessing.
    expect((await functions(allow).call("remote_push", { remote: { $key: "x" } })).error).toMatch(/say which with remote.to/);
  });

  it("refuses when the connection's token is stored nowhere — a request nobody could watch", async () => {
    const { call } = functions({ ...allow, secrets: new SecretResolver({ env: {} }) });
    expect((await call("remote_push")).error).toMatch(/GITLAB_TOKEN is not stored anywhere/);
    expect(branches()).toEqual(["main"]);
  });

  describe("a `tree: \"base\"` changeset", () => {
    const changeset = (after: string): Changeset => ({
      source: "sync",
      changes: [
        { id: "c1", path: "docs/plan.md", action: "create", after },
        { id: "c2", path: "app.txt", action: "update", before: "one\ntwo\nthree\n", after: "one\ntwo\nthree\nfour\n" },
      ],
    });

    it("has no commit to push, so it is written onto a branch of the target and pushed from there", async () => {
      rig.git(rig.work, "checkout", "--", "app.txt");
      await functions(allow).call("remote_push", { tree: "base", changeset: changeset("# plan\n") as unknown as JsonValue });
      expect(rig.git(rig.bare, "show", `${REVIEW}:docs/plan.md`)).toBe("# plan");
      expect(rig.git(rig.bare, "show", `${REVIEW}:app.txt`)).toContain("four");
      // The task's own worktree was not touched: the proposal is still only a proposal there.
      expect(existsSync(join(rig.work, "docs", "plan.md"))).toBe(false);
    });

    it("keeps that worktree for the next round, because a rebuilt one could only arrive by force", async () => {
      rig.git(rig.work, "checkout", "--", "app.txt");
      const { call } = functions(allow);
      await call("remote_push", { tree: "base", changeset: changeset("# plan\n") as unknown as JsonValue });
      const first = rig.git(rig.bare, "rev-parse", REVIEW);
      await call("remote_push", { tree: "base", changeset: changeset("# plan, revised\n") as unknown as JsonValue, message: "revise" });
      expect(rig.git(rig.bare, "rev-parse", `${REVIEW}~1`)).toBe(first);
      expect(rig.git(rig.bare, "show", `${REVIEW}:docs/plan.md`)).toBe("# plan, revised");
    });
  });
});

describe("remote_open", () => {
  const allow = { publish: "allow" } as const;

  it("needs a pushed branch first", async () => {
    expect((await functions(allow).call("remote_open")).error).toMatch(/nothing has been pushed to jaira\/t-1\/review yet/);
  });

  it("opens the request for the pushed branch and remembers where it lives", async () => {
    const { call } = functions(allow);
    await call("remote_push");
    const { value } = await call("remote_open", { remote: { draft: true, description: "the prompt and the changeset summary" } });
    expect(value!["remote"]).toMatchObject({
      id: "gitlab.com/gitlab-org/gitlab-runner!7430",
      number: 7430,
      url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7430",
      branch: REVIEW,
      target: "main",
      key: "review",
    });
    expect(replay.seen.find((r) => r.method === "POST")!.body).toMatchObject({ title: "Draft: Review the implementation", source_branch: REVIEW, target_branch: "main" });
    expect(handles.get("t-1", "review")).toMatchObject({ number: 7430 });
  });

  it("never opens a second one: the next round gets the same request back without asking the forge", async () => {
    const { call } = functions(allow);
    await call("remote_push");
    const first = (await call("remote_open")).value!["remote"];
    const before = replay.seen.length;
    const again = (await call("remote_open")).value!["remote"];
    expect(again).toEqual(first);
    expect(replay.seen.length).toBe(before);
  });
});

describe("the request afterwards", () => {
  const allow = { publish: "allow" } as const;
  /** A request that exists — the recorded one, adopted by value the way a sub-task would. */
  const byValue = {
    provider: "gitlab",
    host: "gitlab.com",
    project: "gitlab-org/gitlab-runner",
    branch: "renovate/gitlab.com-gitlab-org-fleeting-fleeting-artifact-digest",
    target: "main",
    number: 7429,
    url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7429",
    head: "8eee49006c0d827d27228bac5ec8078d86e3354e",
    key: "review",
    remote: "origin",
  };

  it("adopts a handle passed BY VALUE — how a request crosses a task boundary", async () => {
    const { call } = functions({ ...allow, taskId: "t-2" });
    expect((await call("remote_comment", { remote: byValue, body: "Decided in JaiRA: revise." })).error).toBeUndefined();
    expect(handles.get("t-2", "review")).toMatchObject({ number: 7429, host: "gitlab.com" });
    expect(replay.seen.map((r) => [r.method, r.body])).toEqual([["POST", { body: "Decided in JaiRA: revise." }]]);
  });

  it("comments inline, replies on a thread, and resolves it when asked", async () => {
    const { call } = functions({ ...allow, taskId: "t-2" });
    await call("remote_comment", { remote: byValue, body: "Off by one.", anchor: { path: "commands/helpers/cache.go", line: 42, side: "after" } });
    await call("remote_comment", { remote: byValue, body: "fixed", thread: "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c", resolve: true });
    const writes = replay.seen.filter((r) => r.method !== "GET").map((r) => [r.method, new URL(r.url).pathname.split("/").slice(-2).join("/")]);
    expect(writes).toEqual([
      ["POST", "7429/discussions"],
      ["POST", "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c/notes"],
      ["PUT", "discussions/6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c"],
    ]);
    expect((await call("remote_comment", { remote: byValue })).error).toMatch(/needs a body/);
  });

  it("merges, and reports the commit that LANDED rather than the head it pushed", async () => {
    const { value } = await functions({ ...allow, taskId: "t-2" }).call("remote_merge", { remote: byValue });
    expect((value!["remote"] as { head: string }).head).toBe("c60cffd39eaa8e45da87c481ff9695e39701252a");
  });

  it("closes", async () => {
    await functions({ ...allow, taskId: "t-2" }).call("remote_close", { remote: byValue });
    expect(replay.seen.at(-1)).toMatchObject({ method: "PUT", body: { state_event: "close" } });
  });

  it("says a request that was never opened was never opened", async () => {
    const { call } = functions(allow);
    await call("remote_push");
    expect((await call("remote_comment", { body: "hello" })).error).toMatch(/no merge request has been opened for jaira\/t-1\/review/);
  });
});
