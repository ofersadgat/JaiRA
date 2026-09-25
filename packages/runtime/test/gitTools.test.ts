/**
 * The Git tools (decision 0010 §1), end to end on the remote rig: a real repository whose `origin`
 * reads as gitlab.com and whose bytes go to a bare repository on disk, and the forge as a replay of
 * fixtures. Nothing leaves the process but writes into a temp directory.
 *
 * What is held here: the forge is the one the WORKSPACE's remote picks; a call with no connection is
 * refused with the sentence Settings shows; every refusal comes back as `{ error }` and nothing is
 * thrown; a push goes through the publish question and carries the CONNECTION's token, in the
 * environment and never on the command line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@declarative-ai/exec";
import { parseIntegrations, type JairaEvent, type JairaIntegrationsConfig } from "@jaira/shared";
import { NodeExec, type Exec, type ExecOptions } from "../src/exec";
import { createGitTools, GIT_TOOL_NAMES, noGitToolHost, pushCredentials, workspaceGitHost, type GitEventWaits } from "../src/gitTools";
import { EventHub } from "../src/eventHub";
import { PublishAuthorizer, type PublishAnswer, type PublishRequest } from "../src/remote";
import { SecretResolver } from "../src/secrets";
import { replayForge, type Replay } from "./forgeReplay";
import { buildRig, type Rig } from "./remoteRig";

let rig: Rig;
let replay: Replay;
/** Every git command the tools ran, with the environment it was given. */
let ran: Array<{ args: string[]; env?: Record<string, string> }>;
let asked: PublishRequest[];

beforeEach(() => {
  rig = buildRig();
  replay = replayForge();
  ran = [];
  asked = [];
});
afterEach(() => rig.dispose());

const recording = (): Exec => {
  const inner = new NodeExec();
  return {
    run: (command: string, args: readonly string[], options?: ExecOptions) => {
      ran.push({ args: [...args], ...(options?.env !== undefined ? { env: options.env } : {}) });
      return inner.run(command, args, options);
    },
  };
};

interface Setup {
  publish?: "ask" | "allow" | "deny";
  answer?: PublishAnswer;
  integrations?: JairaIntegrationsConfig;
  env?: Record<string, string>;
  root?: string;
  events?: GitEventWaits;
}

function tools(setup: Setup = {}): Record<string, Tool> {
  return createGitTools(
    workspaceGitHost({
      taskId: "t-1",
      workspaceRoot: setup.root ?? rig.work,
      exec: recording(),
      integrations: setup.integrations ?? parseIntegrations(undefined),
      secrets: new SecretResolver({ env: setup.env ?? { GITLAB_TOKEN: "good" } }),
      http: replay.http,
      ...(setup.events !== undefined ? { events: setup.events } : {}),
      publishing: new PublishAuthorizer({
        publish: setup.publish ?? "allow",
        ...(setup.answer !== undefined
          ? {
              confirmPublish: async (request: PublishRequest) => {
                asked.push(request);
                return setup.answer!;
              },
            }
          : {}),
      }),
    }),
  );
}

const call = async (set: Record<string, Tool>, name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await set[name]!.run(input as never, undefined as never)) as Record<string, unknown>;

describe("which forge answers", () => {
  it("is the one the workspace's remote picks, with no connection refused in Settings' own words", async () => {
    const set = tools({ env: {} });
    for (const name of GIT_TOOL_NAMES) {
      const answer = await call(set, name, { number: 7429, body: "hello" });
      expect(answer, name).toEqual({ error: "no connection for gitlab.com — sign in on Connections" });
    }
    // Refused before anything reached the network.
    expect(replay.seen).toEqual([]);
  });

  it("refuses a turned-off connection the same way", async () => {
    const integrations = parseIntegrations({ forges: { gitlab: { enabled: false } } });
    expect(await call(tools({ integrations }), "list_merge_requests")).toEqual({ error: "no connection for gitlab.com — sign in on Connections" });
  });

  it("says a remote that is not on a forge is not", async () => {
    rig.git(rig.work, "remote", "set-url", "origin", rig.bare);
    const answer = await call(tools(), "list_merge_requests");
    expect(answer["error"]).toMatch(/^the git remote 'origin' is not on a forge/);
  });

  it("takes origin among several remotes, a named one when asked, and refuses a name that is not there", async () => {
    rig.git(rig.work, "remote", "add", "upstream", "https://github.com/cli/cli.git");
    expect(((await call(tools(), "list_merge_requests")) as { repository: string }).repository).toBe("gitlab.com/gitlab-org/gitlab-runner");
    // `upstream` is on github.com, and this machine has no GitHub token.
    expect(await call(tools(), "list_merge_requests", { remote: "upstream" })).toEqual({ error: "no connection for github.com — sign in on Connections" });
    expect((await call(tools(), "list_merge_requests", { remote: "nope" }))["error"]).toBe("this repository has no git remote called 'nope' — it has origin, upstream");
  });

  it("answers why, everywhere, where nothing serves them", async () => {
    const set = createGitTools(noGitToolHost("by the test"));
    for (const name of GIT_TOOL_NAMES) {
      expect(await call(set, name), name).toEqual({ error: "the Git tools are not served by the test — they need a task's workspace and the forge connections" });
    }
  });

  it("serves all nine, wait_git_event among them", () => {
    expect(Object.keys(tools())).toEqual([...GIT_TOOL_NAMES]);
    expect(GIT_TOOL_NAMES).toHaveLength(9);
    expect(tools()["wait_git_event"]!.readOnly).toBe(true);
  });
});

describe("wait_git_event", () => {
  const push = (branch: string) =>
    ({ name: "git.push", payload: { remote: "origin", connection: "gitlab", host: "gitlab.com", repository: "gitlab-org/gitlab-runner", branch, before: "a", after: "b", commits: [] } }) as JairaEvent;

  /** The hub of the task's project, bound to the task the way a host lends it. */
  const waits = (hub: EventHub, refuse?: (name: string) => string | undefined): GitEventWaits => ({
    wait: (name, filter, timeoutMs, signal) => hub.wait("t-1", name, filter, { waiter: "tool", timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
    ...(refuse !== undefined ? { refuse } : {}),
  });

  it("answers with the event that arrives, filtered as asked", async () => {
    const hub = new EventHub();
    const answer = call(tools({ events: waits(hub) }), "wait_git_event", { event: "git.push", filter: { branch: "release/*" }, timeout: 30 });
    for (let i = 0; i < 20 && hub.list().length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(hub.list()).toMatchObject([{ taskId: "t-1", waiter: "tool", name: "git.push", filter: { branch: "release/*" } }]);
    hub.deliver(push("main"));
    hub.deliver(push("release/2.0"));
    expect(await answer).toMatchObject({ name: "git.push", payload: { branch: "release/2.0" }, at: expect.any(String) });
    // What did not match is kept for the next wait, oldest first.
    expect(await call(tools({ events: waits(hub) }), "wait_git_event", { event: "git.push" })).toMatchObject({ payload: { branch: "main" } });
  });

  it("answers nothing when the timeout passes first", async () => {
    const hub = new EventHub();
    expect(await call(tools({ events: waits(hub) }), "wait_git_event", { event: "git.merge_request.comments", timeout: "1s" })).toEqual({ nothing: "no git.merge_request.comments within 1s" });
    expect(hub.list()).toEqual([]);
  });

  it("refuses what cannot be waited on, in a sentence", async () => {
    const set = tools({ events: waits(new EventHub(), (name) => (name === "git.checks.failed" ? "git.checks.failed is switched off for this project — Settings → Events" : undefined)) });
    expect((await call(set, "wait_git_event", { event: "git.pull" }))["error"]).toMatch(/^wait_git_event: "git.pull" is not an event — it is one of git.push, /);
    expect(await call(set, "wait_git_event", { event: "git.push", filter: { source_branch: "x" } })).toEqual({
      error: "wait_git_event('git.push'): 'source_branch' is not a filter git.push takes — it takes branch, remote, author",
    });
    expect((await call(set, "wait_git_event", { event: "task.finished" }))["error"]).toMatch(/^wait_git_event waits for the remote's events — task.finished is JaiRA's own/);
    expect(await call(set, "wait_git_event", { event: "git.checks.failed" })).toEqual({ error: "git.checks.failed is switched off for this project — Settings → Events" });
    expect(await call(set, "wait_git_event", { event: "git.push", timeout: "soon" })).toEqual({ error: "`timeout` is a number of seconds or a duration like '10m' — at most '1h'" });
  });

  it("says so where no repository watcher runs", async () => {
    expect(await call(tools(), "wait_git_event", { event: "git.push" })).toEqual({
      error: "wait_git_event is not served here — no repository watcher runs in this process, so nothing would ever arrive",
    });
  });
});

describe("the readers", () => {
  it("list_merge_requests lists the project's requests through the provider", async () => {
    const answer = (await call(tools(), "list_merge_requests", { state: "merged", author: "mara" })) as { repository: string; merge_requests: Array<{ number: number }> };
    expect(answer.repository).toBe("gitlab.com/gitlab-org/gitlab-runner");
    expect(answer.merge_requests.map((m) => m.number)).toEqual([7438]);
    expect(await call(tools(), "list_merge_requests", { state: "shut" })).toEqual({ error: "`state` is one of open, closed, merged, all" });
  });

  it("read_merge_request reads one: summary, threads, approvals and the checks of its head", async () => {
    const answer = (await call(tools(), "read_merge_request", { number: 7429 })) as Record<string, unknown>;
    expect(answer["merge_request"]).toMatchObject({ number: 7429, targetBranch: "main" });
    expect(answer["state"]).toBe("merged");
    expect(answer["merge_commit"]).toBe("c60cffd39eaa8e45da87c481ff9695e39701252a");
    expect((answer["threads"] as unknown[]).length).toBeGreaterThan(0);
    expect((answer["reviews"] as Array<{ verdict: string }>).map((r) => r.verdict)).toEqual(["approved", "changes_requested"]);
    expect(answer["checks"]).toMatchObject({ state: "failure", pipeline: { id: 9002 } });
  });

  it("read_merge_request says which number is missing, or that there is none", async () => {
    expect(await call(tools(), "read_merge_request", {})).toEqual({ error: "name the merge request: `number`" });
    expect((await call(tools(), "read_merge_request", { number: 404 }))["error"]).toMatch(/^read_merge_request: gitlab-org\/gitlab-runner has no merge request !404/);
  });

  it("git_checks reads the named ref, or the current branch", async () => {
    expect(await call(tools(), "git_checks", { ref: "feature/login" })).toMatchObject({ repository: "gitlab.com/gitlab-org/gitlab-runner", ref: "feature/login", state: "pending" });
    // The rig's workspace is on task/t-1, and nothing ran for it.
    expect(await call(tools(), "git_checks")).toEqual({ repository: "gitlab.com/gitlab-org/gitlab-runner", ref: "task/t-1", state: "none", runs: [] });
  });
});

describe("git_push", () => {
  const commit = (): string => {
    rig.git(rig.work, "commit", "-am", "Revise the second line");
    return rig.git(rig.work, "rev-parse", "HEAD");
  };

  it("pushes the current branch as the connection: the token in the environment, never in an argument", async () => {
    const head = commit();
    const answer = await call(tools(), "git_push");
    expect(answer).toEqual({ ok: true, repository: "gitlab.com/gitlab-org/gitlab-runner", branch: "task/t-1", head });
    expect(rig.git(rig.bare, "rev-parse", "refs/heads/task/t-1")).toBe(head);
    // The tracking ref moves as a push by remote name would have moved it.
    expect(rig.git(rig.work, "rev-parse", "refs/remotes/origin/task/t-1")).toBe(head);

    const push = ran.find((r) => r.args[0] === "push")!;
    expect(push.args).toEqual(["push", "https://gitlab.com/gitlab-org/gitlab-runner.git", "refs/heads/task/t-1:refs/heads/task/t-1"]);
    expect(push.args.join(" ")).not.toContain("good");
    expect(push.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://gitlab.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("oauth2:good").toString("base64")}`,
    });
  });

  it("pushes an ssh remote to the project's https url, so it still pushes as the connection", async () => {
    rig.git(rig.work, "remote", "set-url", "origin", "git@gitlab.com:gitlab-org/gitlab-runner.git");
    const head = commit();
    expect(await call(tools(), "git_push")).toMatchObject({ ok: true, head });
    expect(ran.find((r) => r.args[0] === "push")!.args[1]).toBe("https://gitlab.com/gitlab-org/gitlab-runner.git");
    expect(rig.git(rig.bare, "rev-parse", "refs/heads/task/t-1")).toBe(head);
  });

  it("is refused by a project that does not let its tasks publish, and nothing is pushed", async () => {
    commit();
    expect(await call(tools({ publish: "deny" }), "git_push")).toEqual({
      error: "this project's policy does not let a workflow publish (functions.review_artifacts.publish is deny) — nothing was pushed",
    });
    expect(ran.some((r) => r.args[0] === "push")).toBe(false);
  });

  it("refuses under ask when nobody can be asked", async () => {
    commit();
    expect((await call(tools({ publish: "ask" }), "git_push"))["error"]).toMatch(/^publishing needs a person's say-so/);
  });

  it("asks once per task, saying what it is pushing and as whom", async () => {
    commit();
    const set = tools({ publish: "ask", answer: "once" });
    expect(await call(set, "git_push")).toMatchObject({ ok: true });
    expect(await call(set, "git_push")).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      taskId: "t-1",
      provider: "gitlab",
      to: "origin · gitlab.com/gitlab-org/gitlab-runner",
      branch: "task/t-1",
      commitsAs: "Test Author (git config)",
      openedBy: "@jaira-bot",
      question: "Push task/t-1 to GitLab?",
      confirmLabel: "Push",
    });
  });

  it("says a declined push was declined", async () => {
    commit();
    expect(await call(tools({ publish: "ask", answer: "no" }), "git_push")).toEqual({ error: "publishing was declined — nothing was pushed" });
  });

  it("refuses a detached HEAD, and a push the remote rejects comes back as a sentence", async () => {
    rig.git(rig.work, "checkout", "--", "app.txt");
    rig.git(rig.work, "checkout", "--detach");
    expect(await call(tools(), "git_push")).toEqual({ error: "the workspace is not on a branch (a detached HEAD) — there is no branch to push" });
    // main on the "forge" moves on; a local main behind it is not a fast-forward.
    const reviewer = rig.reviewer();
    rig.git(reviewer, "commit", "--allow-empty", "-m", "someone else's work");
    rig.git(reviewer, "push", "origin", "main");
    rig.git(rig.work, "checkout", "main");
    rig.git(rig.work, "commit", "--allow-empty", "-m", "mine");
    expect((await call(tools(), "git_push"))["error"]).toMatch(/^the push of main to gitlab\.com\/gitlab-org\/gitlab-runner was refused — /);
  });
});

describe("open_merge_request", () => {
  it("pushes the branch and opens its request into the remote's default, titled by the last commit", async () => {
    rig.git(rig.work, "commit", "-am", "Revise the second line");
    const head = rig.git(rig.work, "rev-parse", "HEAD");
    const answer = (await call(tools({ publish: "ask", answer: "once" }), "open_merge_request", { description: "Why." })) as Record<string, unknown>;
    expect(answer["merge_request"]).toMatchObject({ id: "gitlab.com/gitlab-org/gitlab-runner!7441", number: 7441, branch: "task/t-1", target: "main", head });
    expect(answer["pushed"]).toBe(head);
    expect(rig.git(rig.bare, "rev-parse", "refs/heads/task/t-1")).toBe(head);
    const created = replay.seen.find((r) => r.method === "POST")!;
    expect(created.body).toMatchObject({ source_branch: "task/t-1", target_branch: "main", title: "Revise the second line", description: "Why." });
    expect(asked.map((r) => [r.question, r.branch, r.target])).toEqual([["Push task/t-1 to GitLab and open a merge request into main?", "task/t-1", "main"]]);
  });

  it("refuses to open a request from the target onto itself", async () => {
    rig.git(rig.work, "checkout", "--", "app.txt");
    rig.git(rig.work, "checkout", "main");
    expect(await call(tools(), "open_merge_request")).toEqual({ error: "the branch to open from is main itself — a merge request needs a branch of its own" });
  });
});

describe("the writers on a request", () => {
  it("git_comment comments on the request, on a line, or replies in a thread and resolves it", async () => {
    expect(await call(tools(), "git_comment", { number: 7429, body: "Looks right." })).toEqual({ ok: true, merge_request: "gitlab.com/gitlab-org/gitlab-runner!7429" });
    expect(replay.seen.at(-1)).toMatchObject({ method: "POST", body: { body: "Looks right." } });
    expect(new URL(replay.seen.at(-1)!.url).pathname.endsWith("/7429/notes")).toBe(true);

    await call(tools(), "git_comment", { number: 7429, body: "This line.", path: "commands/helpers/cache.go", line: 42 });
    expect(replay.seen.filter((r) => r.method === "POST").at(-1)!.body).toMatchObject({ position: { new_path: "commands/helpers/cache.go", new_line: 42 } });

    const thread = "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c";
    expect(await call(tools(), "git_comment", { number: 7429, body: "Done.", thread, resolve: true })).toEqual({
      ok: true,
      merge_request: "gitlab.com/gitlab-org/gitlab-runner!7429",
      thread,
      resolved: true,
    });
    expect(replay.seen.at(-1)).toMatchObject({ method: "PUT", body: { resolved: true } });
  });

  it("git_comment wants words, and a line with a file", async () => {
    expect(await call(tools(), "git_comment", { number: 7429, body: "  " })).toEqual({ error: "say something: `body` is empty" });
    expect(await call(tools(), "git_comment", { number: 7429, body: "x", path: "a.go" })).toEqual({ error: "a comment on a file needs its `line`" });
  });

  it("git_merge merges and says what landed", async () => {
    expect(await call(tools(), "git_merge", { number: 7429 })).toEqual({
      ok: true,
      merge_request: "gitlab.com/gitlab-org/gitlab-runner!7429",
      merged: true,
      merge_commit: "c60cffd39eaa8e45da87c481ff9695e39701252a",
    });
    expect(replay.seen.some((r) => r.method === "PUT" && r.url.endsWith("/7429/merge"))).toBe(true);
  });

  it("close_merge_request closes without merging", async () => {
    expect(await call(tools(), "close_merge_request", { number: 7429 })).toEqual({ ok: true, merge_request: "gitlab.com/gitlab-org/gitlab-runner!7429", closed: true });
    expect(replay.seen.at(-1)).toMatchObject({ method: "PUT", body: { state_event: "close" } });
  });
});

describe("pushCredentials", () => {
  it("uses each forge's documented user for a token over https", () => {
    expect(pushCredentials({ token: "t", connection: { provider: "github", host: "github.com" } }, "https://github.com/cli/cli.git")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:t").toString("base64")}`,
    });
  });

  it("scopes the header to the push url's origin, port and all, and never to a user in it", () => {
    expect(pushCredentials({ token: "t", connection: { provider: "gitlab", host: "git.example.org:8443" } }, "https://me@git.example.org:8443/team/app.git")["GIT_CONFIG_KEY_0"]).toBe(
      "http.https://git.example.org:8443/.extraHeader",
    );
  });

  it("names the variables in WSLENV for a WSL project, the only way they cross into the distro", () => {
    const env = pushCredentials({ token: "t", connection: { provider: "gitlab", host: "gitlab.com" } }, "https://gitlab.com/a/b.git", { wsl: "Ubuntu" });
    expect(env["WSLENV"]!.split(":")).toEqual(expect.arrayContaining(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]));
  });
});
