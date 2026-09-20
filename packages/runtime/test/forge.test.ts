/**
 * The two forge providers, against fixtures (decision 0004, build order 1).
 *
 * Nothing here reaches a network: `replayForge` throws on any request no fixture answers. The read
 * side replays RECORDED public responses where the forge gives them to anyone; the rest is built
 * from the documented shapes — each fixture's `_source` says which.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseIntegrations, type RemoteHandle } from "@jaira/shared";
import { checkForges, ForgeError, forgeForHost, forgeProvider, NoForgeConnection } from "../src/forge";
import { SecretResolver } from "../src/secrets";
import { replayForge, type Replay } from "./forgeReplay";

let replay: Replay;
beforeEach(() => {
  replay = replayForge();
});

const GITLAB = { provider: "gitlab", host: "gitlab.com" } as const;
const GITHUB = { provider: "github", host: "github.com" } as const;

const mr = (number: number): RemoteHandle => ({
  id: `gitlab.com/gitlab-org/gitlab-runner!${number}`,
  provider: "gitlab",
  host: "gitlab.com",
  project: "gitlab-org/gitlab-runner",
  branch: "renovate/gitlab.com-gitlab-org-fleeting-fleeting-artifact-digest",
  target: "main",
  number,
  url: `https://gitlab.com/gitlab-org/gitlab-runner/-/merge_requests/${number}`,
  head: "8eee49006c0d827d27228bac5ec8078d86e3354e",
});

const pr = (number: number): RemoteHandle => ({
  id: `github.com/cli/cli#${number}`,
  provider: "github",
  host: "github.com",
  project: "cli/cli",
  branch: "revert-14437-williammartin-apple-codesign-action",
  target: "trunk",
  number,
  url: `https://github.com/cli/cli/pull/${number}`,
  head: "189706bccb1686c68fb73c5bd9013358320a9e71",
});

describe("GitLab", () => {
  const gitlab = (token = "good") => forgeProvider(GITLAB, token, { http: replay.http, now: () => Date.parse("2026-09-19T12:00:00Z") });

  it("says who the token is, and sends the token as a header and never in a URL", async () => {
    expect(await gitlab().whoami()).toEqual({ login: "jaira-bot", name: "JaiRA Bot" });
    expect(replay.seen[0]!.headers["PRIVATE-TOKEN"]).toBe("good");
    expect(replay.seen.every((request) => !request.url.includes("good"))).toBe(true);
  });

  it("reports a refused token as a 401, in the forge's own words and without the token", async () => {
    const refused = await gitlab("refused").whoami().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ForgeError);
    expect((refused as ForgeError).status).toBe(401);
    expect((refused as ForgeError).message).toContain("401 Unauthorized");
    expect((refused as ForgeError).message).not.toContain("refused");
  });

  it("carries the forge's Retry-After on a 429", async () => {
    const error = (await gitlab("throttled").whoami().catch((e: unknown) => e)) as ForgeError;
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(60);
  });

  it("finds the request already open for a branch instead of opening a second", async () => {
    const handle = await gitlab().open({
      host: "gitlab.com",
      project: "gitlab-org/gitlab-runner",
      branch: "renovate/gitlab.com-gitlab-org-fleeting-fleeting-artifact-digest",
      target: "main",
      title: "unused",
      description: "",
      draft: false,
    });
    expect(handle).toEqual(mr(7429));
    expect(replay.seen.map((r) => r.method)).toEqual(["GET"]);
  });

  it("opens one when there is none — a draft is a title, because GitLab has no draft field", async () => {
    const handle = await gitlab().open({
      host: "gitlab.com",
      project: "gitlab-org/gitlab-runner",
      branch: "jaira/t-1/review",
      target: "main",
      title: "Review the implementation",
      description: "the prompt and the changeset summary",
      draft: true,
    });
    expect(handle).toMatchObject({ id: "gitlab.com/gitlab-org/gitlab-runner!7430", number: 7430, branch: "jaira/t-1/review", target: "main" });
    const post = replay.seen.find((r) => r.method === "POST")!;
    expect(post.body).toEqual({
      source_branch: "jaira/t-1/review",
      target_branch: "main",
      title: "Draft: Review the implementation",
      description: "the prompt and the changeset summary",
    });
  });

  describe("probe", () => {
    it("calls everything news on the first probe, and makes no request to say so", async () => {
      const probe = await gitlab().probe([mr(7429), mr(7430)], {});
      expect(probe.moved).toEqual([mr(7429).id, mr(7430).id]);
      expect(probe.cursor.since).toBe("2026-09-19T11:59:00.000Z");
      expect(replay.seen).toEqual([]);
    });

    it("is ONE list call for the host however many requests are watched", async () => {
      const probe = await gitlab().probe([mr(7429), mr(7431), mr(9999)], { since: "2026-09-18T05:18:00.087Z" });
      expect(replay.seen).toHaveLength(1);
      const url = new URL(replay.seen[0]!.url);
      expect(url.pathname).toBe("/api/v4/merge_requests");
      expect(url.searchParams.get("scope")).toBe("created_by_me");
      expect(url.searchParams.get("updated_after")).toBe("2026-09-18T05:18:00.087Z");
      // 9999 is watched and is not in the list: it did not move.
      expect(probe.moved.sort()).toEqual([mr(7429).id, mr(7431).id]);
    });

    it("moves the cursor a millisecond PAST the newest row, because updated_after is inclusive", async () => {
      const probe = await gitlab().probe([mr(7429)], { since: "2026-09-18T05:18:00.087Z" });
      expect(probe.cursor.since).toBe("2026-09-19T13:58:14.050Z");
    });

    it("asks nothing when nothing is watched", async () => {
      expect(await gitlab().probe([], { since: "2026-09-18T00:00:00.000Z" })).toEqual({ moved: [], cursor: { since: "2026-09-18T00:00:00.000Z" } });
      expect(replay.seen).toEqual([]);
    });
  });

  describe("read", () => {
    it("reads the recorded request: merged, by whom, and the commit that landed", async () => {
      const state = await gitlab().read(mr(7429));
      expect(state.state).toBe("merged");
      expect(state.draft).toBe(false);
      expect(state.head).toBe("8eee49006c0d827d27228bac5ec8078d86e3354e");
      expect(state.mergeCommit).toBe("c60cffd39eaa8e45da87c481ff9695e39701252a");
      expect(state.closedBy).toBe("ajwalker");
      expect(state.updatedAt).toBe("2026-09-18T05:18:00.087Z");
    });

    it("turns an inline discussion into a thread anchored on a side, with its replies in order", async () => {
      const { threads } = await gitlab().read(mr(7429));
      expect(threads[0]).toEqual({
        id: "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c",
        anchor: { path: "commands/helpers/cache.go", line: 42, side: "after" },
        resolved: false,
        comments: [
          { id: "1101", who: "mara", body: "This cache key ignores the runner's architecture.", at: "2026-09-18T09:00:00.000Z", canWrite: true, own: false },
          { id: "1102", who: "jaira-bot", body: "Fixed in the next push.", at: "2026-09-18T09:20:00.000Z", canWrite: true, own: true },
        ],
      });
      // A line that only exists BEFORE the change anchors on the old side; resolved is the forge's word.
      expect(threads[1]).toMatchObject({ anchor: { path: "go.mod", line: 10, side: "before" }, resolved: true });
      // A discussion on the request as a whole is still a thread — it has replies — with no anchor.
      expect(threads[2]!.anchor).toBeUndefined();
      expect(threads[2]!.comments.map((c) => c.who)).toEqual(["mara", "sam"]);
    });

    it("shows anyone's comment and says who can write — a non-member is a 404, which is an answer", async () => {
      const { comments } = await gitlab().read(mr(7429));
      expect(comments).toEqual([
        { id: "1103", who: "visitor", body: "Looks fine to me", at: "2026-09-18T09:30:00.000Z", canWrite: false, own: false },
      ]);
    });

    it("reads approvals from the approvals endpoint and a request for changes from the note the act leaves", async () => {
      const { reviews } = await gitlab().read(mr(7429));
      expect(reviews).toEqual([
        { id: "approval:ajwalker", who: "ajwalker", at: "2026-09-18T02:17:09.910Z", verdict: "approved", canWrite: true, own: false },
        { id: "note:1104", who: "mara", at: "2026-09-18T09:40:00.000Z", verdict: "changes_requested", canWrite: true, own: false },
      ]);
      // sam asked for changes and then approved: the later act withdraws the earlier one.
      expect(reviews.some((r) => r.who === "sam")).toBe(false);
    });

    it("asks for an author's access once, however many notes they wrote", async () => {
      await gitlab().read(mr(7429));
      const lookups = replay.seen.filter((r) => r.url.includes("/members/all/501"));
      expect(lookups).toHaveLength(1);
    });
  });

  describe("writing", () => {
    it("posts a general comment as a note", async () => {
      await gitlab().comment(mr(7429), "Decided in JaiRA: revise.");
      expect(replay.seen.map((r) => [r.method, new URL(r.url).pathname.split("/").pop(), r.body])).toEqual([
        ["POST", "notes", { body: "Decided in JaiRA: revise." }],
      ]);
    });

    it("positions an inline thread against the request's CURRENT diff refs", async () => {
      await gitlab().comment(mr(7429), "Off by one.", { path: "commands/helpers/cache.go", line: 42, side: "after" });
      const post = replay.seen.find((r) => r.method === "POST")!;
      expect(post.body).toEqual({
        body: "Off by one.",
        position: {
          position_type: "text",
          base_sha: "981e8efeb885f4943f7c56acd9772db123d72011",
          start_sha: "981e8efeb885f4943f7c56acd9772db123d72011",
          head_sha: "8eee49006c0d827d27228bac5ec8078d86e3354e",
          new_path: "commands/helpers/cache.go",
          new_line: 42,
        },
      });
    });

    it("never loses a note to a position the forge cannot place: it goes on the request, saying where", async () => {
      await gitlab().comment(mr(7429), "About this line.", { path: "README.md", line: 999, side: "after" });
      const posts = replay.seen.filter((r) => r.method === "POST");
      expect(posts.map((r) => new URL(r.url).pathname.split("/").pop())).toEqual(["discussions", "notes"]);
      expect(posts[1]!.body).toEqual({ body: "`README.md:999` — About this line." });
    });

    it("replies on a thread, and resolves it only when asked", async () => {
      const thread = "6a9c1d8b3e1f4a2c9d7e5f0b1a2c3d4e5f6a7b8c";
      await gitlab().reply(mr(7429), thread, "Done.");
      expect(replay.seen.map((r) => r.method)).toEqual(["POST"]);
      await gitlab().reply(mr(7429), thread, "fixed", true);
      expect(replay.seen.map((r) => r.method)).toEqual(["POST", "POST", "PUT"]);
      expect(replay.seen[2]!.body).toEqual({ resolved: true });
    });

    it("merges and closes, and says a request that cannot merge cannot merge", async () => {
      await gitlab().merge(mr(7429));
      await gitlab().close(mr(7429));
      expect(replay.seen.map((r) => [r.method, r.body])).toEqual([
        ["PUT", undefined],
        ["PUT", { state_event: "close" }],
      ]);
      await expect(gitlab().merge(mr(7431))).rejects.toThrow(/cannot be merged right now \(GitLab answered 405\)/);
    });
  });
});

describe("GitHub", () => {
  const github = (token = "good") => forgeProvider(GITHUB, token, { http: replay.http });

  it("says who the token is, with the scopes a classic token lists", async () => {
    expect(await github().whoami()).toEqual({ login: "jaira-bot", name: "JaiRA Bot", scopes: ["repo", "read:org"] });
    expect(replay.seen[0]!.headers["Authorization"]).toBe("Bearer good");
    expect(replay.seen[0]!.url).toBe("https://api.github.com/user");
  });

  it("reports a refused token as a 401, in the forge's own words", async () => {
    const refused = (await github("refused").whoami().catch((e: unknown) => e)) as ForgeError;
    expect(refused.status).toBe(401);
    expect(refused.message).toContain("Requires authentication");
  });

  it("keeps an Enterprise Server's API under /api on the same host", async () => {
    const seen: string[] = [];
    const ghe = forgeProvider({ provider: "github", host: "ghe.example.org" }, "t", {
      http: async (request) => {
        seen.push(request.url);
        return { status: 200, headers: {}, body: request.url.endsWith("/graphql") ? { data: {} } : { login: "me" } };
      },
    });
    await ghe.whoami();
    await ghe.reply(pr(1), "T", "x");
    expect(seen).toEqual(["https://ghe.example.org/api/v3/user", "https://ghe.example.org/api/graphql"]);
  });

  it("finds the request already open for a branch, asking by owner:branch", async () => {
    const handle = await github().open({ host: "github.com", project: "cli/cli", branch: "revert-14437-williammartin-apple-codesign-action", target: "trunk", title: "unused", description: "", draft: false });
    expect(handle).toEqual(pr(14462));
    expect(new URL(replay.seen[0]!.url).searchParams.get("head")).toBe("cli:revert-14437-williammartin-apple-codesign-action");
  });

  it("opens one when there is none, as a real draft", async () => {
    const handle = await github().open({ host: "github.com", project: "cli/cli", branch: "jaira/t-1/review", target: "trunk", title: "Review the implementation", description: "summary", draft: true });
    expect(handle).toMatchObject({ id: "github.com/cli/cli#14470", number: 14470, url: "https://github.com/cli/cli/pull/14470", head: "4444444444444444444444444444444444444444" });
    expect(replay.seen.find((r) => r.method === "POST")!.body).toEqual({ title: "Review the implementation", head: "jaira/t-1/review", base: "trunk", body: "summary", draft: true });
  });

  describe("probe", () => {
    const ETAG = '"317fc63fc44b31f5301de92dd4280de06f430c441e1d92421783b7f19609f265"';

    it("reads a request unconditionally the first time and keeps its ETag", async () => {
      const probe = await github().probe([pr(14462)], {});
      expect(probe.moved).toEqual([pr(14462).id]);
      expect(probe.cursor.etags).toEqual({ [pr(14462).id]: ETAG });
      expect(replay.seen[0]!.headers["If-None-Match"]).toBeUndefined();
    });

    it("sends the ETag back, and a recorded 304 means it did not move", async () => {
      const probe = await github().probe([pr(14462)], { etags: { [pr(14462).id]: ETAG } });
      expect(replay.seen[0]!.headers["If-None-Match"]).toBe(ETAG);
      expect(probe.moved).toEqual([]);
      expect(probe.cursor.etags).toEqual({ [pr(14462).id]: ETAG });
    });

    it("calls a request that vanished news, and forgets the ETag of one nobody watches", async () => {
      const probe = await github().probe([pr(14466)], { etags: { [pr(14466).id]: '"x"', [pr(1).id]: '"stale"' } });
      expect(probe.moved).toEqual([pr(14466).id]);
      expect(probe.cursor.etags).toEqual({});
    });

    it("stops at a 429 with the forge's Retry-After, for the poller to obey", async () => {
      const error = (await github().probe([pr(14465)], {}).catch((e: unknown) => e)) as ForgeError;
      expect(error.status).toBe(429);
      expect(error.retryAfterSeconds).toBe(60);
    });
  });

  describe("read", () => {
    it("is ONE GraphQL query, because REST has no thread resolution", async () => {
      const provider = github();
      await provider.whoami();
      replay.seen.length = 0;
      await provider.read(pr(14462));
      expect(replay.seen).toHaveLength(1);
      expect(replay.seen[0]!.url).toBe("https://api.github.com/graphql");
      expect((replay.seen[0]!.body as { variables: unknown }).variables).toEqual({ owner: "cli", name: "cli", number: 14462 });
    });

    it("maps threads, keeping an outdated thread where it WAS", async () => {
      const { threads } = await github().read(pr(14462));
      expect(threads).toEqual([
        {
          id: "PRRT_1",
          anchor: { path: "pkg/cmd/root/root.go", line: 12, side: "after" },
          resolved: false,
          comments: [
            { id: "PRRC_1", who: "mara", body: "This flag is never read.", at: "2026-09-18T09:15:00Z", canWrite: true, own: false },
            { id: "PRRC_2", who: "jaira-bot", body: "Fixed in the next push.", at: "2026-09-18T09:25:00Z", canWrite: true, own: true },
          ],
        },
        {
          id: "PRRT_2",
          anchor: { path: "go.mod", line: 7, side: "before" },
          resolved: true,
          comments: [{ id: "PRRC_3", who: "drive-by", body: "Why drop this?", at: "2026-09-17T08:00:00Z", canWrite: false, own: false }],
        },
      ]);
    });

    it("keeps each person's latest opinion, and drops a dismissed one", async () => {
      const { reviews } = await github().read(pr(14462));
      expect(reviews).toEqual([
        { id: "PRR_mara", who: "mara", at: "2026-09-18T09:40:00Z", verdict: "changes_requested", body: "needs tests", canWrite: true, own: false },
        { id: "PRR_sam", who: "sam", at: "2026-09-18T09:45:00Z", verdict: "approved", canWrite: true, own: false },
      ]);
    });

    it("lists general comments in order — a review submitted as a comment is one — and marks write access and its own", async () => {
      const { comments } = await github().read(pr(14462));
      expect(comments.map((c) => [c.who, c.body, c.canWrite, c.own])).toEqual([
        ["jaira-bot", "Opened by JaiRA for review.", true, true],
        ["drive-by", "nice", false, false],
        ["mara", "An overall comment, submitted as a review.", true, false],
        ["sam", "approve", true, false],
      ]);
    });

    it("reads merged with the merge commit, and closed with who closed it", async () => {
      expect(await github().read(pr(14463))).toMatchObject({ state: "merged", mergeCommit: "0cf1092493af067646fc5f3db9421c6a6ec9c938", closedBy: "mara" });
      const closed = await github().read(pr(14464));
      expect(closed).toMatchObject({ state: "closed", closedBy: "lee" });
      expect(closed.mergeCommit).toBeUndefined();
    });

    it("turns a GraphQL refusal — a 200 with errors — into an error", async () => {
      const error = (await github().read(pr(99999)).catch((e: unknown) => e)) as ForgeError;
      expect(error).toBeInstanceOf(ForgeError);
      expect(error.status).toBe(404);
    });
  });

  describe("writing", () => {
    it("posts a general comment on the ISSUE, which is where a pull request keeps them", async () => {
      await github().comment(pr(14462), "Decided in JaiRA: revise.");
      expect(replay.seen.map((r) => [r.method, new URL(r.url).pathname, r.body])).toEqual([
        ["POST", "/repos/cli/cli/issues/14462/comments", { body: "Decided in JaiRA: revise." }],
      ]);
    });

    it("pins an inline comment to the head commit as it is NOW, on the right side", async () => {
      await github().comment(pr(14462), "Off by one.", { path: "go.mod", line: 7, side: "before" });
      expect(replay.seen.find((r) => r.method === "POST")!.body).toEqual({
        body: "Off by one.",
        commit_id: "189706bccb1686c68fb73c5bd9013358320a9e71",
        path: "go.mod",
        line: 7,
        side: "LEFT",
      });
    });

    it("never loses a note to a line outside the diff: it goes on the request, saying where", async () => {
      await github().comment(pr(14462), "About this line.", { path: "README.md", line: 999, side: "after" });
      const posts = replay.seen.filter((r) => r.method === "POST");
      expect(posts.map((r) => new URL(r.url).pathname)).toEqual(["/repos/cli/cli/pulls/14462/comments", "/repos/cli/cli/issues/14462/comments"]);
      expect(posts[1]!.body).toEqual({ body: "`README.md:999` — About this line." });
    });

    it("replies and resolves through GraphQL, where a thread has an id", async () => {
      await github().reply(pr(14462), "PRRT_1", "fixed", true);
      const operations = replay.seen.map((r) => /^(?:query|mutation) (\w+)/.exec((r.body as { query: string }).query)![1]);
      expect(operations).toEqual(["JairaReply", "JairaResolve"]);
    });

    it("merges and closes, and says a request that cannot merge cannot merge", async () => {
      await github().merge(pr(14462));
      await github().close(pr(14462));
      expect(replay.seen.map((r) => [r.method, r.body])).toEqual([
        ["PUT", undefined],
        ["PATCH", { state: "closed" }],
      ]);
      await expect(github().merge(pr(14464))).rejects.toThrow(/cannot be merged right now \(GitHub answered 405\)/);
    });
  });
});

describe("connections", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jaira-forge-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const secrets = (env: Record<string, string>) => new SecretResolver({ baseDir: dir, env });

  it("validates each connection by asking its host who the token is", async () => {
    const checks = await checkForges(parseIntegrations(undefined), { http: replay.http, secrets: secrets({ GITLAB_TOKEN: "good", GITHUB_TOKEN: "refused" }) });
    expect(checks).toEqual([
      { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "ok", detail: "signed in as @jaira-bot", identity: { login: "jaira-bot", name: "JaiRA Bot" }, credential: { source: "environment" } },
      {
        name: "github",
        provider: "github",
        host: "github.com",
        status: "failed",
        detail: "the token was refused (401)",
        fix: "replace the token; it needs the `repo` scope to open and read pull requests",
        credential: { source: "environment" },
      },
    ]);
  });

  it("never puts the token's value in what it reports", async () => {
    const checks = await checkForges(parseIntegrations(undefined), { http: replay.http, secrets: secrets({ GITLAB_TOKEN: "good", GITHUB_TOKEN: "noscope" }) });
    expect(JSON.stringify(checks)).not.toMatch(/"good"|noscope/);
  });

  it("fails a classic GitHub token that can sign in and cannot touch a repository", async () => {
    const [, github] = await checkForges(parseIntegrations(undefined), { http: replay.http, secrets: secrets({ GITHUB_TOKEN: "noscope" }) });
    expect(github).toMatchObject({ status: "failed", detail: "signed in as @jaira-bot, but the token lacks the repo scope" });
  });

  it("passes a fine-grained token, which lists no scopes at all", async () => {
    const [, github] = await checkForges(parseIntegrations(undefined), { http: replay.http, secrets: secrets({ GITHUB_TOKEN: "finegrained" }) });
    expect(github).toMatchObject({ status: "ok", detail: "signed in as @jaira-bot" });
  });

  it("says not set up, and makes no request, when the token is stored nowhere", async () => {
    const [gitlab] = await checkForges(parseIntegrations(undefined), { http: replay.http, secrets: secrets({}) });
    expect(gitlab).toMatchObject({ status: "unconfigured", detail: "no token stored under GITLAB_TOKEN", credentialMissing: "GITLAB_TOKEN" });
    expect(replay.seen.filter((r) => r.url.includes("gitlab.com"))).toEqual([]);
  });

  it("says turned off, and makes no request, for a connection that is off", async () => {
    const checks = await checkForges(parseIntegrations({ forges: { gitlab: { enabled: false }, github: { enabled: false } } }), { http: replay.http, secrets: secrets({ GITLAB_TOKEN: "good" }) });
    expect(checks.map((c) => c.status)).toEqual(["disabled", "disabled"]);
    expect(replay.seen).toEqual([]);
  });

  it("reports an unreachable host as a failure of the connection, not an exception", async () => {
    const [gitlab] = await checkForges(parseIntegrations({ forges: { github: { enabled: false } } }), {
      secrets: secrets({ GITLAB_TOKEN: "good" }),
      http: async () => {
        throw new Error("getaddrinfo ENOTFOUND gitlab.com");
      },
    });
    expect(gitlab).toMatchObject({ status: "failed", detail: "could not reach gitlab.com — getaddrinfo ENOTFOUND gitlab.com" });
  });

  it("picks the provider by a remote's host, and refuses with a sentence when it cannot", async () => {
    const integrations = parseIntegrations(undefined);
    const options = { http: replay.http, secrets: secrets({ GITLAB_TOKEN: "good" }) };
    expect(forgeForHost(integrations, "gitlab.com", options).kind).toBe("gitlab");
    expect(() => forgeForHost(integrations, "git.example.org", options)).toThrow(NoForgeConnection);
    expect(() => forgeForHost(integrations, "git.example.org", options)).toThrow(/no connection is set up for git.example.org/);
    // GitLab with no token could still push-to-open, but could not WATCH — so `remote` refuses to start.
    expect(() => forgeForHost(integrations, "github.com", options)).toThrow(/GITHUB_TOKEN is not stored anywhere/);
  });
});
