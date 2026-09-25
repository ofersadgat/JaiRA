/**
 * The reads decision 0010 adds to both providers — every merge request on a project, one by number,
 * CI, branches, and a request's comments flat — against fixtures, like `forge.test.ts`.
 *
 * Nothing here reaches a network: `replayForge` throws on any request no fixture answers. The
 * fixtures are `*.git-tools.json` (built from the documented shapes) beside the recorded ones.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ciStateOf, handleOfSummary, type RemoteHandle } from "@jaira/shared";
import { ForgeError, forgeProvider } from "../src/forge";
import { replayForge, type Replay } from "./forgeReplay";

let replay: Replay;
beforeEach(() => {
  replay = replayForge();
});

const GITLAB = { provider: "gitlab", host: "gitlab.com" } as const;
const GITHUB = { provider: "github", host: "github.com" } as const;
const RUNNER = "gitlab-org/gitlab-runner";

const query = (index: number): Record<string, string> => Object.fromEntries(new URL(replay.seen[index]!.url).searchParams);

describe("GitHub", () => {
  const github = () => forgeProvider(GITHUB, "good", { http: replay.http });

  describe("listMergeRequests", () => {
    it("asks for the newest update first and follows the Link header to the next page", async () => {
      const list = await github().listMergeRequests("cli/cli");
      expect(list.map((m) => m.number)).toEqual([14470, 14469, 14460]);
      expect(query(0)).toMatchObject({ state: "open", sort: "updated", direction: "desc", per_page: "20" });
      expect(query(1)).toMatchObject({ page: "2" });
      expect(list[0]).toEqual({
        number: 14470,
        title: "Sign in with a device code",
        state: "open",
        draft: false,
        author: "octo",
        sourceBranch: "feature/login",
        targetBranch: "trunk",
        head: "aaaa000000000000000000000000000000000001",
        updatedAt: "2026-09-20T10:00:00Z",
        url: "https://github.com/cli/cli/pull/14470",
        description: "Adds the device flow.",
      });
      // A draft is GitHub's own flag; an empty body is no description.
      expect(list[1]).toMatchObject({ draft: true });
      expect(list[1]!.description).toBeUndefined();
    });

    it("stops at the first page older than updatedSince, and keeps only what is newer", async () => {
      const list = await github().listMergeRequests("cli/cli", { updatedSince: "2026-09-19T12:00:00Z" });
      expect(list.map((m) => m.number)).toEqual([14470]);
      expect(replay.seen).toHaveLength(1);
    });

    it("asks by owner:branch for a source branch", async () => {
      const list = await github().listMergeRequests("cli/cli", { sourceBranch: "feature/login" });
      expect(list.map((m) => m.number)).toEqual([14470]);
      expect(query(0)).toMatchObject({ head: "cli:feature/login" });
    });

    it("reads merged as a closed pull request with a merged_at — GitHub has no merged state", async () => {
      const merged = await github().listMergeRequests("cli/cli", { state: "merged" });
      expect(merged.map((m) => [m.number, m.state])).toEqual([[14468, "merged"]]);
      expect(query(0)).toMatchObject({ state: "closed", per_page: "100" });
      const closed = await github().listMergeRequests("cli/cli", { state: "closed" });
      expect(closed.map((m) => [m.number, m.state])).toEqual([
        [14468, "merged"],
        [14467, "closed"],
      ]);
    });

    it("filters by author here, because GitHub's list cannot", async () => {
      const list = await github().listMergeRequests("cli/cli", { author: "Mona" });
      expect(list.map((m) => m.number)).toEqual([14469]);
    });

    it("keeps to the limit", async () => {
      const list = await github().listMergeRequests("cli/cli", { limit: 1 });
      expect(list.map((m) => m.number)).toEqual([14470]);
      expect(query(0)).toMatchObject({ per_page: "1" });
    });
  });

  it("reads one request by number, and says so when there is none", async () => {
    const summary = await github().mergeRequest("cli/cli", 14462);
    expect(summary).toMatchObject({ number: 14462, sourceBranch: "revert-14437-williammartin-apple-codesign-action", targetBranch: "trunk" });
    expect(handleOfSummary("github", "github.com", "cli/cli", summary).id).toBe("github.com/cli/cli#14462");
    const missing = (await github().mergeRequest("cli/cli", 404).catch((e: unknown) => e)) as ForgeError;
    expect(missing).toBeInstanceOf(ForgeError);
    expect(missing.status).toBe(404);
  });

  describe("checks", () => {
    it("reads check runs AND commit statuses, and a failed status fails the whole", async () => {
      const ci = await github().checks("cli/cli", "feature/login");
      expect(ci).toEqual({
        ref: "feature/login",
        sha: "aaaa000000000000000000000000000000000001",
        state: "pending",
        runs: [
          { name: "build", status: "completed", conclusion: "success", url: "https://github.com/cli/cli/runs/1" },
          { name: "test", status: "running", url: "https://github.com/cli/cli/runs/2" },
          { name: "ci/legacy", status: "completed", conclusion: "failure", url: "https://ci.example.test/builds/9" },
        ],
      });
      // The branch is ONE path segment.
      expect(new URL(replay.seen[0]!.url).pathname).toBe("/repos/cli/cli/commits/feature%2Flogin/check-runs");
    });

    it("folds a timed-out run into failure, and does not believe the combined status's pending when nothing reported one", async () => {
      const ci = await github().checks("cli/cli", "trunk");
      expect(ci.state).toBe("failure");
      expect(ci.runs).toEqual([{ name: "build", status: "completed", conclusion: "failure", url: "https://ci.example.test/runs/3" }]);
    });

    it("says none when nothing ran for the commit", async () => {
      const ci = await github().checks("cli/cli", "b".repeat(40));
      expect(ci).toEqual({ ref: "b".repeat(40), sha: "b".repeat(40), state: "none", runs: [] });
    });
  });

  it("lists every branch, page after page", async () => {
    expect(await github().branches("cli/cli")).toEqual([
      { name: "trunk", head: "aaaa000000000000000000000000000000000009" },
      { name: "feature/login", head: "aaaa000000000000000000000000000000000001" },
      { name: "docs/help", head: "aaaa000000000000000000000000000000000002" },
    ]);
  });

  describe("comments", () => {
    const pr: RemoteHandle = {
      id: "github.com/cli/cli#14462",
      provider: "github",
      host: "github.com",
      project: "cli/cli",
      branch: "revert-14437-williammartin-apple-codesign-action",
      target: "trunk",
      number: 14462,
      url: "https://github.com/cli/cli/pull/14462",
      head: "189706bccb1686c68fb73c5bd9013358320a9e71",
    };

    it("is the read, flat and in order: a thread's comments carry its id and anchor, a general one neither", async () => {
      const notes = await github().comments(pr);
      expect(notes.map((n) => n.at)).toEqual([...notes.map((n) => n.at)].sort());
      const inline = notes.find((n) => n.threadId === "PRRT_1")!;
      expect(inline.anchor).toEqual({ path: "pkg/cmd/root/root.go", line: 12, side: "after" });
      const general = notes.filter((n) => n.threadId === undefined);
      expect(general.length).toBeGreaterThan(0);
      expect(general.every((n) => n.anchor === undefined)).toBe(true);
      // One GraphQL read, plus who the token is — never a REST walk.
      expect(replay.seen.map((r) => new URL(r.url).pathname).sort()).toEqual(["/graphql", "/user"]);
    });

    it("keeps only what was written after `since`", async () => {
      const all = await github().comments(pr);
      const since = all[Math.floor(all.length / 2)]!.at;
      const later = await github().comments(pr, { since });
      expect(later.length).toBeGreaterThan(0);
      expect(later.every((n) => n.at > since)).toBe(true);
      expect(later).toEqual(all.filter((n) => n.at > since));
    });
  });
});

describe("GitLab", () => {
  const gitlab = () => forgeProvider(GITLAB, "good", { http: replay.http });

  describe("listMergeRequests", () => {
    it("asks the forge for every filter, newest update first", async () => {
      const list = await gitlab().listMergeRequests(RUNNER);
      expect(list.map((m) => m.number)).toEqual([7440, 7439]);
      expect(query(0)).toMatchObject({ state: "opened", order_by: "updated_at", sort: "desc", per_page: "20" });
      expect(list[0]).toEqual({
        number: 7440,
        title: "Sign in with a device code",
        state: "open",
        draft: false,
        author: "mara",
        sourceBranch: "feature/login",
        targetBranch: "main",
        head: "cccc000000000000000000000000000000000001",
        updatedAt: "2026-09-20T10:00:00.000Z",
        url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7440",
        description: "Adds the device flow.",
      });
      expect(list[1]).toMatchObject({ draft: true });
    });

    it("sends state, author and since as GitLab's own parameters", async () => {
      const merged = await gitlab().listMergeRequests(RUNNER, { state: "merged", author: "mara" });
      expect(merged.map((m) => [m.number, m.state])).toEqual([[7438, "merged"]]);
      expect(query(0)).toMatchObject({ state: "merged", author_username: "mara" });
    });

    it("drops the row ON the since time, because updated_after is inclusive", async () => {
      const list = await gitlab().listMergeRequests(RUNNER, { updatedSince: "2026-09-19T10:00:00.000Z" });
      expect(list.map((m) => m.number)).toEqual([7440]);
    });
  });

  it("reads one request by number, and says so when there is none", async () => {
    const summary = await gitlab().mergeRequest(RUNNER, 7429);
    expect(summary).toMatchObject({ number: 7429, state: "merged", targetBranch: "main", head: "8eee49006c0d827d27228bac5ec8078d86e3354e" });
    const missing = (await gitlab().mergeRequest(RUNNER, 404).catch((e: unknown) => e)) as ForgeError;
    expect(missing.status).toBe(404);
  });

  describe("checks", () => {
    it("reads the newest pipeline for a branch and its jobs; the state is the pipeline's", async () => {
      const ci = await gitlab().checks(RUNNER, "feature/login");
      expect(ci).toEqual({
        ref: "feature/login",
        sha: "cccc000000000000000000000000000000000001",
        state: "pending",
        pipeline: { id: 9001, url: "https://gitlab.com/gitlab-org/gitlab-runner/-/pipelines/9001" },
        runs: [
          { name: "build", status: "completed", conclusion: "success", url: "https://gitlab.com/gitlab-org/gitlab-runner/-/jobs/1", stage: "build" },
          { name: "test", status: "running", url: "https://gitlab.com/gitlab-org/gitlab-runner/-/jobs/2", stage: "test" },
          // Waiting for somebody to press play: finished, as far as anything running is concerned.
          { name: "deploy", status: "completed", conclusion: "neutral", url: "https://gitlab.com/gitlab-org/gitlab-runner/-/jobs/3", stage: "deploy" },
        ],
      });
      expect(query(0)).toMatchObject({ ref: "feature/login", order_by: "id", sort: "desc", per_page: "1" });
    });

    it("says failure for a failed pipeline", async () => {
      const ci = await gitlab().checks(RUNNER, "main");
      expect(ci.state).toBe("failure");
      expect(ci.runs.find((r) => r.name === "test")).toMatchObject({ conclusion: "failure" });
    });

    it("asks by sha for a commit, and says none when no pipeline ran", async () => {
      const sha = "d".repeat(40);
      expect(await gitlab().checks(RUNNER, sha)).toEqual({ ref: sha, state: "none", runs: [] });
      expect(query(0)).toMatchObject({ sha });
    });
  });

  it("lists every branch, following x-next-page", async () => {
    expect(await gitlab().branches(RUNNER)).toEqual([
      { name: "main", head: "cccc000000000000000000000000000000000009" },
      { name: "feature/login", head: "cccc000000000000000000000000000000000001" },
      { name: "release/1.0", head: "cccc000000000000000000000000000000000010" },
    ]);
  });

  describe("comments", () => {
    const mr: RemoteHandle = {
      id: "gitlab.com/gitlab-org/gitlab-runner!7429",
      provider: "gitlab",
      host: "gitlab.com",
      project: RUNNER,
      branch: "renovate/gitlab.com-gitlab-org-fleeting-fleeting-artifact-digest",
      target: "main",
      number: 7429,
      url: "https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/7429",
      head: "8eee49006c0d827d27228bac5ec8078d86e3354e",
    };

    it("flattens the discussions the way read threads them, without asking who can write", async () => {
      const notes = await gitlab().comments(mr);
      expect(notes.map((n) => n.at)).toEqual([...notes.map((n) => n.at)].sort());
      expect(notes.filter((n) => n.id === "1101" || n.id === "1102")).toEqual([
        {
          id: "1101",
          threadId: "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c",
          who: "mara",
          body: "This cache key ignores the runner's architecture.",
          at: "2026-09-18T09:00:00.000Z",
          anchor: { path: "commands/helpers/cache.go", line: 42, side: "after" },
          own: false,
        },
        {
          id: "1102",
          threadId: "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c",
          who: "jaira-bot",
          body: "Fixed in the next push.",
          at: "2026-09-18T09:20:00.000Z",
          anchor: { path: "commands/helpers/cache.go", line: 42, side: "after" },
          own: true,
        },
      ]);
      // A lone note on the request is a general comment: no thread to reply in.
      expect(notes.find((n) => n.id === "1103")).toEqual({ id: "1103", who: "visitor", body: "Looks fine to me", at: "2026-09-18T09:30:00.000Z", own: false });
      // No system notes, and no member lookups — a list of what was said needs neither.
      expect(replay.seen.some((r) => r.url.includes("/members/"))).toBe(false);
    });

    it("keeps only what was written after `since`", async () => {
      const later = await gitlab().comments(mr, { since: "2026-09-18T09:20:00.000Z" });
      expect(later.every((n) => n.at > "2026-09-18T09:20:00.000Z")).toBe(true);
      expect(later.map((n) => n.id)).not.toContain("1102");
      expect(later.map((n) => n.id)).toContain("1103");
    });
  });
});

describe("ciStateOf", () => {
  it("is none with no runs, pending while any runs, failure on a failed or cancelled one, success otherwise", () => {
    expect(ciStateOf([])).toBe("none");
    expect(ciStateOf([{ name: "a", status: "queued" }])).toBe("pending");
    expect(ciStateOf([{ name: "a", status: "completed", conclusion: "cancelled" }])).toBe("failure");
    expect(ciStateOf([{ name: "a", status: "completed", conclusion: "skipped" }, { name: "b", status: "completed", conclusion: "success" }])).toBe("success");
  });
});
