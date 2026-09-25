/**
 * GitHub, over REST and GraphQL (decision 0004 §1).
 *
 * The only file that knows a GitHub endpoint. What shapes it:
 *
 *  - **An authenticated conditional request answered `304` is free** — it does not count against the
 *    rate limit. So the probe is one `If-None-Match` GET per watched pull request, and a request that
 *    has not moved costs nothing however often it is asked about.
 *  - **The full read is ONE GraphQL query.** REST has no thread resolution at all (`isResolved` exists
 *    only on GraphQL's `reviewThreads`), and the REST spelling of the same read is four calls.
 *  - **Replies and resolution are GraphQL too**, because a thread's id is a GraphQL node id — REST
 *    knows a thread only as the comment that started it.
 *
 * A pull request is called a merge request everywhere above this file.
 */
import {
  ciStateOf,
  remoteHandleId,
  type CiConclusion,
  type CiRun,
  type CiStatus,
  type ForgeAnchor,
  type ForgeBranch,
  type ForgeCommit,
  type ForgeComment,
  type ForgeIdentity,
  type ForgeNote,
  type ForgeProvider,
  type ForgeReview,
  type ForgeThread,
  type MergeRequestQuery,
  type MergeRequestSummary,
  type OpenRequest,
  type Probe,
  type ProbeCursor,
  type RemoteHandle,
  type RemoteState,
} from "@jaira/shared";
import {
  asList,
  asRecord,
  asText,
  expectStatus,
  ForgeError,
  limitOf,
  retryAfterOf,
  type ForgeHttp,
  type ForgeProviderOptions,
  type ForgeRequest,
  type ForgeResponse,
} from "./http";

/** `author_association` values that mean write access to the repository ("who counts"). */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const COMMENT_FIELDS = "id body createdAt authorAssociation author { login }";

/** Everything a settlement is decided from, in one round trip. */
export const GITHUB_READ_QUERY = `
query JairaRead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft merged updatedAt headRefOid
      mergeCommit { oid }
      mergedBy { login }
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
      latestOpinionatedReviews(first: 100) { nodes { id state body submittedAt authorAssociation author { login } } }
      reviews(first: 100, states: [COMMENTED]) { nodes { ${COMMENT_FIELDS} } }
      comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
      reviewThreads(first: 100) {
        nodes { id isResolved path line originalLine diffSide comments(first: 100) { nodes { ${COMMENT_FIELDS} } } }
      }
    }
  }
}`.trim();

export const GITHUB_REPLY_MUTATION = `
mutation JairaReply($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } }
}`.trim();

export const GITHUB_RESOLVE_MUTATION = `
mutation JairaResolve($thread: ID!) {
  resolveReviewThread(input: { threadId: $thread }) { thread { id isResolved } }
}`.trim();

export class GitHubProvider implements ForgeProvider {
  readonly kind = "github" as const;
  readonly host: string;
  private readonly rest: string;
  private readonly graphqlUrl: string;
  private readonly http: ForgeHttp;
  private me?: Promise<ForgeIdentity>;

  constructor(private readonly options: ForgeProviderOptions) {
    this.host = options.host;
    this.http = options.http;
    // github.com keeps its API on a host of its own; an Enterprise Server keeps it under `/api`.
    this.rest = options.apiUrl ?? (options.host === "github.com" ? "https://api.github.com" : `https://${options.host}/api/v3`);
    this.graphqlUrl = this.rest === "https://api.github.com" ? "https://api.github.com/graphql" : this.rest.replace(/\/v3$/, "/graphql");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jaira",
      ...extra,
    };
  }

  private call(method: ForgeRequest["method"], path: string, body?: Record<string, unknown>, extra?: Record<string, string>): Promise<ForgeResponse> {
    return this.http({ method, url: `${this.rest}${path}`, headers: this.headers(extra), ...(body !== undefined ? { body: body as never } : {}) });
  }

  private async graphql(query: string, variables: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const response = expectStatus(
      await this.http({ method: "POST", url: this.graphqlUrl, headers: this.headers(), body: { query, variables } as never }),
      [200],
      what,
    );
    const body = asRecord(response.body);
    // GraphQL answers 200 to a query it refused; the refusal is in `errors`.
    const errors = asList(body["errors"]);
    if (errors.length > 0) {
      const first = asRecord(errors[0]);
      throw new ForgeError(`${what}: ${asText(first["message"]) || "GitHub refused the query"}`, asText(first["type"]) === "NOT_FOUND" ? 404 : 422);
    }
    return asRecord(body["data"]);
  }

  whoami(): Promise<ForgeIdentity> {
    this.me ??= this.call("GET", "/user").then((response) => {
      const user = asRecord(expectStatus(response, [200], "asking GitHub who the token is").body);
      const name = asText(user["name"]);
      // A classic token lists its scopes; a fine-grained one sends the header empty or not at all.
      const scopes = (response.headers["x-oauth-scopes"] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return { login: asText(user["login"]), ...(name.length > 0 ? { name } : {}), ...(scopes.length > 0 ? { scopes } : {}) };
    });
    this.me.catch(() => {
      this.me = undefined;
    });
    return this.me;
  }

  private pull(handle: { project: string; number: number }): string {
    return `/repos/${handle.project}/pulls/${handle.number}`;
  }

  private handleOf(request: { host: string; project: string }, pull: Record<string, unknown>): RemoteHandle {
    const number = Number(pull["number"]);
    const head = asRecord(pull["head"]);
    return {
      id: remoteHandleId("github", request.host, request.project, number),
      provider: "github",
      host: request.host,
      project: request.project,
      branch: asText(head["ref"]),
      target: asText(asRecord(pull["base"])["ref"]),
      number,
      url: asText(pull["html_url"]),
      head: asText(head["sha"]),
    };
  }

  async open(request: OpenRequest): Promise<RemoteHandle> {
    // `head` is `owner:branch`. JaiRA pushes to the project's own remote, so the owner is the project's.
    const owner = request.project.split("/")[0]!;
    const found = expectStatus(
      await this.call(
        "GET",
        `/repos/${request.project}/pulls?state=open&head=${encodeURIComponent(`${owner}:${request.branch}`)}&base=${encodeURIComponent(request.target)}`,
      ),
      [200],
      `looking for the pull request of ${request.branch}`,
    );
    const existing = asList(found.body)[0];
    if (existing !== undefined) return this.handleOf(request, asRecord(existing));

    const created = expectStatus(
      await this.call("POST", `/repos/${request.project}/pulls`, {
        title: request.title,
        head: request.branch,
        base: request.target,
        body: request.description,
        draft: request.draft,
      }),
      [201],
      `opening a pull request for ${request.branch}`,
    );
    return this.handleOf(request, asRecord(created.body));
  }

  /**
   * Whether `/notifications` can be read: `undefined` until asked, then what the forge said.
   *
   * Only a CLASSIC token can — it lists its scopes, which is how one is recognised; a fine-grained
   * token lists none and is refused the endpoint. A refusal is remembered for the life of the
   * provider, so a token that cannot read it costs one wasted request, once.
   */
  private notifications: boolean | undefined;

  /**
   * The cross-repository shortcut (decision 0004): ONE conditional call that says whether anything
   * the token's owner is subscribed to has moved, and which. JaiRA's requests are opened by that
   * owner, who is therefore subscribed to them.
   *
   * Returns the api urls of the pull requests it names, or `undefined` when it cannot say — not
   * available, or an answer that is not a clean 200/304 — in which case every request is probed
   * directly, exactly as before. A MISSED notification (a repository the person muted) is what the
   * 30-minute backstop read is for.
   */
  private async notified(cursor: ProbeCursor): Promise<{ urls: Set<string>; notifiedAt?: string; floor?: number } | undefined> {
    if (this.notifications === false) return undefined;
    if (this.notifications === undefined) {
      const scopes = (await this.whoami().catch(() => undefined))?.scopes;
      if (scopes === undefined || !(scopes.includes("notifications") || scopes.includes("repo"))) {
        this.notifications = false;
        return undefined;
      }
    }
    const response = await this.call("GET", "/notifications?all=true&per_page=50", undefined, cursor.notifiedAt !== undefined ? { "If-Modified-Since": cursor.notifiedAt } : undefined);
    const floor = Number(response.headers["x-poll-interval"]) || undefined;
    if (response.status === 304) {
      this.notifications = true;
      return { urls: new Set(), ...(cursor.notifiedAt !== undefined ? { notifiedAt: cursor.notifiedAt } : {}), ...(floor !== undefined ? { floor } : {}) };
    }
    if (response.status !== 200) {
      // 401/403/404: this token may not read it. Anything else: not an answer to build on this tick.
      if ([401, 403, 404].includes(response.status)) this.notifications = false;
      return undefined;
    }
    this.notifications = true;
    const urls = new Set<string>();
    for (const entry of asList(response.body)) {
      const subject = asRecord(asRecord(entry)["subject"]);
      if (asText(subject["type"]) === "PullRequest") urls.add(asText(subject["url"]));
    }
    const stamp = response.headers["last-modified"];
    return { urls, ...(stamp !== undefined ? { notifiedAt: stamp } : {}), ...(floor !== undefined ? { floor } : {}) };
  }

  async probe(handles: RemoteHandle[], cursor: ProbeCursor): Promise<Probe> {
    const etags = { ...(cursor.etags ?? {}) };
    const moved: string[] = [];
    let pollAfterSeconds: number | undefined;
    // With several requests watched, ask once whether ANY of them moved. One watched request gains
    // nothing from it — its own conditional probe is already a single free call.
    const notified = handles.length > 1 ? await this.notified(cursor) : undefined;
    if (notified?.floor !== undefined) pollAfterSeconds = notified.floor;
    for (const handle of handles) {
      const known = etags[handle.id];
      // Named by no notification, and seen before: it did not move. A request with no ETag yet is
      // always probed — there is nothing to compare a notification against.
      if (notified !== undefined && known !== undefined && !notified.urls.has(`${this.rest}${this.pull(handle)}`)) continue;
      const response = await this.call("GET", this.pull(handle), undefined, known !== undefined ? { "If-None-Match": known } : undefined);
      const floor = Number(response.headers["x-poll-interval"]) || retryAfterOf(response.headers);
      if (floor !== undefined && floor > 0) pollAfterSeconds = Math.max(pollAfterSeconds ?? 0, floor);
      if (response.status === 304) continue;
      // Gone, or no longer visible to this token: that is news, and the read is what will say which.
      if (response.status === 404 || response.status === 410) {
        delete etags[handle.id];
        moved.push(handle.id);
        continue;
      }
      expectStatus(response, [200], `asking GitHub whether ${handle.id} moved`);
      const etag = response.headers["etag"];
      if (etag !== undefined) etags[handle.id] = etag;
      moved.push(handle.id);
    }
    // A request nobody watches any more takes its ETag with it.
    const watched = new Set(handles.map((h) => h.id));
    for (const id of Object.keys(etags)) if (!watched.has(id)) delete etags[id];
    const notifiedAt = notified?.notifiedAt ?? cursor.notifiedAt;
    return { moved, cursor: { etags, ...(notifiedAt !== undefined ? { notifiedAt } : {}) }, ...(pollAfterSeconds !== undefined ? { pollAfterSeconds } : {}) };
  }

  async read(handle: RemoteHandle): Promise<RemoteState> {
    const [owner, name] = handle.project.split("/");
    const [me, data] = await Promise.all([
      this.whoami(),
      this.graphql(GITHUB_READ_QUERY, { owner, name, number: handle.number }, `reading ${handle.id}`),
    ]);
    const pr = asRecord(asRecord(data["repository"])["pullRequest"]);
    if (Object.keys(pr).length === 0) throw new ForgeError(`reading ${handle.id}: GitHub has no such pull request for this token`, 404);

    const comment = (node: Record<string, unknown>): ForgeComment => {
      const who = asText(asRecord(node["author"])["login"]);
      return {
        id: asText(node["id"]),
        who,
        body: asText(node["body"]),
        at: asText(node["createdAt"] ?? node["submittedAt"]),
        canWrite: WRITERS.has(asText(node["authorAssociation"])),
        own: who === me.login,
      };
    };
    const nodes = (value: unknown): Array<Record<string, unknown>> => asList(asRecord(value)["nodes"]).map(asRecord);

    const reviews: ForgeReview[] = [];
    for (const node of nodes(pr["latestOpinionatedReviews"])) {
      const state = asText(node["state"]);
      if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") continue;
      const who = asText(asRecord(node["author"])["login"]);
      const body = asText(node["body"]);
      reviews.push({
        id: asText(node["id"]),
        who,
        at: asText(node["submittedAt"]),
        verdict: state === "APPROVED" ? "approved" : "changes_requested",
        ...(body.length > 0 ? { body } : {}),
        canWrite: WRITERS.has(asText(node["authorAssociation"])),
        own: who === me.login,
      });
    }

    const threads: ForgeThread[] = nodes(pr["reviewThreads"]).map((node) => {
      const path = asText(node["path"]);
      // `line` goes null once the thread is outdated; where it WAS is still where the note is about.
      const line = typeof node["line"] === "number" ? node["line"] : node["originalLine"];
      return {
        id: asText(node["id"]),
        ...(path.length > 0 && typeof line === "number"
          ? { anchor: { path, line, side: node["diffSide"] === "LEFT" ? ("before" as const) : ("after" as const) } }
          : {}),
        resolved: node["isResolved"] === true,
        comments: nodes(node["comments"]).map(comment),
      };
    });

    // A review submitted as "Comment" with words in it is a general comment that happens to be a review.
    const comments = [...nodes(pr["comments"]), ...nodes(pr["reviews"]).filter((node) => asText(node["body"]).length > 0)]
      .map(comment)
      .sort((a, b) => a.at.localeCompare(b.at));

    const merged = pr["merged"] === true;
    const state = asText(pr["state"]);
    const mergeCommit = asText(asRecord(pr["mergeCommit"])["oid"]);
    const closedBy = merged
      ? asText(asRecord(pr["mergedBy"])["login"])
      : asText(asRecord(asRecord(nodes(pr["timelineItems"])[0])["actor"])["login"]);
    return {
      state: merged ? "merged" : state === "CLOSED" ? "closed" : "open",
      draft: pr["isDraft"] === true,
      head: asText(pr["headRefOid"]),
      ...(merged && mergeCommit.length > 0 ? { mergeCommit } : {}),
      ...(state !== "OPEN" && closedBy.length > 0 ? { closedBy } : {}),
      updatedAt: asText(pr["updatedAt"]),
      reviews,
      threads,
      comments,
    };
  }

  async comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<void> {
    if (anchor !== undefined) {
      // An inline comment is pinned to a COMMIT, so the head is read at the moment of posting.
      const pull = asRecord(expectStatus(await this.call("GET", this.pull(handle)), [200], `reading ${handle.id}`).body);
      const placed = await this.call("POST", `${this.pull(handle)}/comments`, {
        body,
        commit_id: asText(asRecord(pull["head"])["sha"]),
        path: anchor.path,
        line: anchor.line,
        side: anchor.side === "before" ? "LEFT" : "RIGHT",
      });
      if (placed.status === 201) return;
      // 422 is "that line is not part of the diff". A note must not be lost to that: it goes on the
      // request instead, saying where it was about. Any other refusal is a real one.
      if (placed.status !== 422) expectStatus(placed, [201], `commenting on ${handle.id}`);
      body = `\`${anchor.path}:${anchor.line}\` — ${body}`;
    }
    // A pull request's general comments are its ISSUE's comments.
    expectStatus(
      await this.call("POST", `/repos/${handle.project}/issues/${handle.number}/comments`, { body }),
      [201],
      `commenting on ${handle.id}`,
    );
  }

  async reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<void> {
    await this.graphql(GITHUB_REPLY_MUTATION, { thread: threadId, body }, `replying on ${handle.id}`);
    if (resolve === true) await this.graphql(GITHUB_RESOLVE_MUTATION, { thread: threadId }, `resolving a thread on ${handle.id}`);
  }

  async merge(handle: RemoteHandle): Promise<void> {
    const response = await this.call("PUT", `${this.pull(handle)}/merge`);
    // 405 not mergeable, 409 the head moved, 422 a required check or review is missing.
    if ([405, 409, 422].includes(response.status)) {
      throw new ForgeError(`${handle.id} cannot be merged right now (GitHub answered ${response.status})`, response.status);
    }
    expectStatus(response, [200], `merging ${handle.id}`);
  }

  async close(handle: RemoteHandle): Promise<void> {
    expectStatus(await this.call("PATCH", this.pull(handle), { state: "closed" }), [200], `closing ${handle.id}`);
  }

  // --- what the Git tools and the repository watcher read (decision 0010) ---------------------------

  /**
   * A list, page after page, following the `Link: rel="next"` GitHub sets — until `enough` says so,
   * or {@link MAX_PAGES} pages, past which a list is not something anybody is reading.
   */
  private async listed(path: string, what: string, enough: (rows: unknown[], page: unknown[]) => boolean = () => false): Promise<unknown[]> {
    const out: unknown[] = [];
    let url: string | undefined = `${this.rest}${path}`;
    for (let i = 0; i < MAX_PAGES && url !== undefined; i++) {
      const response = expectStatus(await this.http({ method: "GET", url, headers: this.headers() }), [200], what);
      const page = asList(response.body);
      out.push(...page);
      if (page.length === 0 || enough(out, page)) break;
      url = nextLink(response.headers["link"]);
    }
    return out;
  }

  private summaryOf(pull: Record<string, unknown>): MergeRequestSummary {
    const head = asRecord(pull["head"]);
    const merged = asText(pull["merged_at"]).length > 0;
    const description = asText(pull["body"]);
    return {
      number: Number(pull["number"]),
      title: asText(pull["title"]),
      state: merged ? "merged" : asText(pull["state"]) === "closed" ? "closed" : "open",
      draft: pull["draft"] === true,
      author: asText(asRecord(pull["user"])["login"]),
      sourceBranch: asText(head["ref"]),
      targetBranch: asText(asRecord(pull["base"])["ref"]),
      head: asText(head["sha"]),
      updatedAt: asText(pull["updated_at"]),
      url: asText(pull["html_url"]),
      ...(description.length > 0 ? { description } : {}),
    };
  }

  /**
   * `GET /repos/{project}/pulls`, newest update first.
   *
   * GitHub filters by state, head and base; it has no author filter and no "merged" state (a merged
   * pull request is a `closed` one with a `merged_at`), and no "updated since" — so those three are
   * applied here, and the list is sorted by update so the walk can stop at the first row older than
   * `updatedSince`.
   */
  async listMergeRequests(project: string, query: MergeRequestQuery = {}): Promise<MergeRequestSummary[]> {
    const limit = limitOf(query.limit);
    const state = query.state ?? "open";
    const filtering = state === "merged" || query.author !== undefined;
    const params = new URLSearchParams({ state: state === "merged" ? "closed" : state, sort: "updated", direction: "desc", per_page: String(filtering ? 100 : limit) });
    // `head` is `owner:branch`, as in `open`: the project's own branches.
    if (query.sourceBranch !== undefined) params.set("head", `${project.split("/")[0]!}:${query.sourceBranch}`);
    if (query.targetBranch !== undefined) params.set("base", query.targetBranch);
    const since = query.updatedSince;
    const keep = (summary: MergeRequestSummary): boolean =>
      (state !== "merged" || summary.state === "merged") &&
      (query.author === undefined || summary.author.toLowerCase() === query.author.toLowerCase()) &&
      (since === undefined || summary.updatedAt > since);
    const rows = await this.listed(`/repos/${project}/pulls?${params.toString()}`, `listing the pull requests of ${project}`, (all, page) => {
      const last = this.summaryOf(asRecord(page[page.length - 1]));
      return (since !== undefined && last.updatedAt <= since) || all.map((row) => this.summaryOf(asRecord(row))).filter(keep).length >= limit;
    });
    return rows.map((row) => this.summaryOf(asRecord(row))).filter(keep).slice(0, limit);
  }

  async mergeRequest(project: string, number: number): Promise<MergeRequestSummary> {
    const response = await this.call("GET", this.pull({ project, number }));
    if (response.status === 404) throw new ForgeError(`${project} has no pull request #${number} this token can see`, 404);
    return this.summaryOf(asRecord(expectStatus(response, [200], `reading ${project}#${number}`).body));
  }

  /**
   * Check runs AND commit statuses, because a repository reports CI through either or both — Actions
   * and most apps through check runs, older integrations through the combined status. The combined
   * status's own `state` is not read: with no statuses at all it says `pending`, which is a lie about
   * a repository that has only check runs.
   */
  async checks(project: string, ref: string): Promise<CiStatus> {
    const at = `/repos/${project}/commits/${encodeURIComponent(ref)}`;
    const [runsResponse, statusResponse] = await Promise.all([this.call("GET", `${at}/check-runs?per_page=100`), this.call("GET", `${at}/status?per_page=100`)]);
    const runsBody = asRecord(expectStatus(runsResponse, [200], `reading the check runs of ${ref}`).body);
    const statusBody = asRecord(expectStatus(statusResponse, [200], `reading the commit status of ${ref}`).body);
    const runs: CiRun[] = [];
    let sha = asText(statusBody["sha"]);
    for (const entry of asList(runsBody["check_runs"])) {
      const run = asRecord(entry);
      if (sha.length === 0) sha = asText(run["head_sha"]);
      const status = asText(run["status"]);
      const url = asText(run["html_url"]) || asText(run["details_url"]);
      runs.push({
        name: asText(run["name"]),
        status: status === "completed" ? "completed" : status === "in_progress" ? "running" : "queued",
        ...(status === "completed" ? { conclusion: githubConclusion(asText(run["conclusion"])) } : {}),
        ...(url.length > 0 ? { url } : {}),
      });
    }
    for (const entry of asList(statusBody["statuses"])) {
      const status = asRecord(entry);
      const state = asText(status["state"]);
      const url = asText(status["target_url"]);
      runs.push({
        name: asText(status["context"]),
        status: state === "pending" ? "running" : "completed",
        ...(state === "pending" ? {} : { conclusion: state === "success" ? ("success" as const) : ("failure" as const) }),
        ...(url.length > 0 ? { url } : {}),
      });
    }
    return { ref, ...(sha.length > 0 ? { sha } : {}), state: ciStateOf(runs), runs };
  }

  async branches(project: string): Promise<ForgeBranch[]> {
    const rows = await this.listed(`/repos/${project}/branches?per_page=100`, `listing the branches of ${project}`);
    return rows.map((row) => ({ name: asText(asRecord(row)["name"]), head: asText(asRecord(asRecord(row)["commit"])["sha"]) }));
  }

  /**
   * The read, flattened. A reply needs the thread's GraphQL id, which only the read has — REST knows
   * a review thread only as the comment that started it — so this is one query, not a REST walk.
   */
  async comments(handle: RemoteHandle, options: { since?: string } = {}): Promise<ForgeNote[]> {
    const state = await this.read(handle);
    const notes: ForgeNote[] = [
      ...state.threads.flatMap((thread) =>
        thread.comments.map((c) => ({ id: c.id, threadId: thread.id, who: c.who, body: c.body, at: c.at, ...(thread.anchor !== undefined ? { anchor: thread.anchor } : {}), own: c.own })),
      ),
      ...state.comments.map((c) => ({ id: c.id, who: c.who, body: c.body, at: c.at, own: c.own })),
    ];
    return notes.filter((note) => options.since === undefined || note.at > options.since).sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * `GET /repos/{project}/compare/{base}...{head}` — its `commits` are oldest first, up to 250, which
   * is more than a push event needs to be useful. With no base, the one head commit.
   */
  async compare(project: string, base: string | undefined, head: string): Promise<ForgeCommit[]> {
    const commitOf = (entry: unknown): ForgeCommit => {
      const row = asRecord(entry);
      const commit = asRecord(row["commit"]);
      return {
        sha: asText(row["sha"]),
        message: asText(commit["message"]),
        author: asText(asRecord(row["author"])["login"]) || asText(asRecord(commit["author"])["name"]),
      };
    };
    if (base === undefined) {
      return [commitOf(expectStatus(await this.call("GET", `/repos/${project}/commits/${encodeURIComponent(head)}`), [200], `reading ${head.slice(0, 7)}`).body)];
    }
    const response = expectStatus(await this.call("GET", `/repos/${project}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`), [200], `comparing ${base.slice(0, 7)}...${head.slice(0, 7)}`);
    return asList(asRecord(response.body)["commits"]).map(commitOf);
  }
}

/** Ten pages of a hundred: past that a list is not something anybody is reading. */
const MAX_PAGES = 10;

/** The `rel="next"` url of a `Link` header, when there is one. */
function nextLink(link: string | undefined): string | undefined {
  for (const part of (link ?? "").split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** A check run's conclusion, in JaiRA's five words. */
function githubConclusion(conclusion: string): CiConclusion {
  switch (conclusion) {
    case "success":
      return "success";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "neutral":
    case "stale":
      return "neutral";
    default:
      // failure, timed_out, action_required, startup_failure — each a run that did not pass.
      return "failure";
  }
}
