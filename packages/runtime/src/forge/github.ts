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
  isJairaComment,
  markRetried,
  remoteHandleId,
  type ArtifactBytes,
  type ArtifactRef,
  type ForgeAnnotation,
  type ForgeArtifact,
  type ForgeCommitStatus,
  type ForgeJob,
  type ForgePipeline,
  type ForgePosted,
  type JobDetail,
  type PipelineDetail,
  type PipelineList,
  type PipelineQuery,
  type PipelineSource,
  type PipelineStatus,
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

const COMMENT_FIELDS = "id url body createdAt authorAssociation author { login }";

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
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id url } }
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
    const data = await this.graphql(GITHUB_READ_QUERY, { owner, name, number: handle.number }, `reading ${handle.id}`);
    const pr = asRecord(asRecord(data["repository"])["pullRequest"]);
    if (Object.keys(pr).length === 0) throw new ForgeError(`reading ${handle.id}: GitHub has no such pull request for this token`, 404);

    const comment = (node: Record<string, unknown>): ForgeComment => {
      const who = asText(asRecord(node["author"])["login"]);
      return {
        id: asText(node["id"]),
        who,
        body: asText(node["body"]),
        at: asText(node["createdAt"] ?? node["submittedAt"]),
        ...(asText(node["url"]).length > 0 ? { url: asText(node["url"]) } : {}),
        canWrite: WRITERS.has(asText(node["authorAssociation"])),
        // JaiRA's own words are the ones carrying its marker — not the token's account, which is the person's.
        own: isJairaComment(asText(node["body"])),
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
        own: isJairaComment(body),
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

  async comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<ForgePosted> {
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
      if (placed.status === 201) return postedComment(placed.body);
      // 422 is "that line is not part of the diff". A note must not be lost to that: it goes on the
      // request instead, saying where it was about. Any other refusal is a real one.
      if (placed.status !== 422) expectStatus(placed, [201], `commenting on ${handle.id}`);
      body = `\`${anchor.path}:${anchor.line}\` — ${body}`;
    }
    // A pull request's general comments are its ISSUE's comments.
    return postedComment(
      expectStatus(await this.call("POST", `/repos/${handle.project}/issues/${handle.number}/comments`, { body }), [201], `commenting on ${handle.id}`).body,
    );
  }

  async reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<ForgePosted> {
    const data = await this.graphql(GITHUB_REPLY_MUTATION, { thread: threadId, body }, `replying on ${handle.id}`);
    if (resolve === true) await this.graphql(GITHUB_RESOLVE_MUTATION, { thread: threadId }, `resolving a thread on ${handle.id}`);
    const posted = asRecord(asRecord(data["addPullRequestReviewThreadReply"])["comment"]);
    return { ...(asText(posted["id"]).length > 0 ? { id: asText(posted["id"]) } : {}), ...(asText(posted["url"]).length > 0 ? { url: asText(posted["url"]) } : {}) };
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
  /** Every page of a list, following `Link: rel="next"` — the list at `key` when the answer wraps it (`check_runs`). */
  private async listed(path: string, what: string, enough: (rows: unknown[], page: unknown[]) => boolean = () => false, key?: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let url: string | undefined = `${this.rest}${path}`;
    for (let i = 0; i < MAX_PAGES && url !== undefined; i++) {
      const response = expectStatus(await this.http({ method: "GET", url, headers: this.headers() }), [200], what);
      const page = asList(key !== undefined ? asRecord(response.body)[key] : response.body);
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

  // --- CI (decision 0016) ------------------------------------------------------------------------

  /** The web host's root — where a person's links go. */
  private get web(): string {
    return this.host === "github.com" ? "https://github.com" : `https://${this.host}`;
  }

  /**
   * A pipeline here is a CHECK SUITE: one per app per commit, and for Actions one per workflow run.
   * A suite that ran nothing (an app that registered and did not report) is left out.
   *
   * A pull request's pipelines are its commits' — GitHub has no list of a pull request's runs that
   * holds for forks (their runs carry `pull_requests: []`, measured) — read in ONE GraphQL query. A
   * ref or a commit is two REST reads: its suites, and the workflow runs that own them.
   */
  async pipelines(project: string, query: PipelineQuery): Promise<PipelineList> {
    const limit = limitOf(query.limit);
    let listed: PipelineList;
    if (query.mergeRequest !== undefined) listed = await this.pullPipelines(project, query.mergeRequest);
    else {
      const ref = query.ref ?? query.sha;
      if (ref === undefined) throw new ForgeError("name the pull request, the ref or the commit whose pipelines to list", 400);
      listed = await this.refPipelines(project, ref);
    }
    const pipelines = listed.pipelines
      .filter((pipeline) => (query.status === undefined || pipeline.status === query.status) && (query.source === undefined || pipeline.source === query.source))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
      .slice(0, limit);
    const statuses = listed.statuses.filter((status) => query.status === undefined || status.status === query.status);
    return { pipelines, statuses: query.source === undefined || query.source === "external" ? statuses : [] };
  }

  private async refPipelines(project: string, ref: string): Promise<PipelineList> {
    const at = `/repos/${project}/commits/${encodeURIComponent(ref)}`;
    const [suitesResponse, statusResponse] = await Promise.all([this.call("GET", `${at}/check-suites?per_page=100`), this.call("GET", `${at}/status?per_page=100`)]);
    if (suitesResponse.status === 404 || suitesResponse.status === 422) throw new ForgeError(`${project} has no commit or branch ${ref} this token can see`, 404);
    const suites = asList(asRecord(expectStatus(suitesResponse, [200], `reading the check suites of ${ref}`).body)["check_suites"])
      .map((entry) => asRecord(entry))
      .filter((suite) => Number(suite["latest_check_runs_count"] ?? 1) > 0);
    const statusBody = asRecord(expectStatus(statusResponse, [200], `reading the commit statuses of ${ref}`).body);
    const sha = asText(statusBody["sha"]) || asText(suites[0]?.["head_sha"]);
    // The workflow runs of the commit, to name each Actions suite's run: its event, attempt and link.
    const runs = new Map<number, Record<string, unknown>>();
    if (sha.length > 0 && suites.some((suite) => asText(asRecord(suite["app"])["slug"]) === "github-actions")) {
      const body = asRecord(expectStatus(await this.call("GET", `/repos/${project}/actions/runs?head_sha=${sha}&per_page=100`), [200], `reading the workflow runs of ${sha.slice(0, 7)}`).body);
      for (const entry of asList(body["workflow_runs"])) {
        const run = asRecord(entry);
        runs.set(Number(run["check_suite_id"]), run);
      }
    }
    return {
      pipelines: suites.map((suite) => this.pipelineOfSuite(project, suite, runs.get(Number(suite["id"])))),
      statuses: asList(statusBody["statuses"]).map((entry) => githubStatusOf(sha, asRecord(entry))),
    };
  }

  /** A suite from REST, with the workflow run that owns it when Actions ran it. */
  private pipelineOfSuite(project: string, suite: Record<string, unknown>, run: Record<string, unknown> | undefined): ForgePipeline {
    const app = asRecord(suite["app"]);
    const id = Number(suite["id"]);
    const sha = asText(suite["head_sha"]);
    const event = run !== undefined ? asText(run["event"]) : "";
    const finishedAt = asText(suite["status"]) === "completed" ? asText(suite["updated_at"]) : "";
    return {
      id,
      sha,
      ref: asText(suite["head_branch"]) || (run !== undefined ? asText(run["head_branch"]) : ""),
      source: run !== undefined ? githubSource(event) : "external",
      sourceName: run !== undefined ? event : asText(app["slug"]),
      status: githubStatus(asText(suite["status"]), asText(suite["conclusion"])),
      name: run !== undefined ? asText(run["name"]) : asText(app["name"]),
      ...(run !== undefined ? { runId: Number(run["id"]), attempt: Number(run["run_attempt"] ?? 1) } : {}),
      createdAt: asText(suite["created_at"]),
      ...(finishedAt.length > 0 ? { finishedAt } : {}),
      url: run !== undefined ? asText(run["html_url"]) : `${this.web}/${project}/commit/${sha}/checks?check_suite_id=${id}`,
    };
  }

  private async pullPipelines(project: string, number: number): Promise<PipelineList> {
    const [owner, name] = project.split("/");
    const data = await this.graphql(GITHUB_PULL_PIPELINES_QUERY, { owner, name, number }, `reading the pipelines of ${project}#${number}`);
    const pull = asRecord(asRecord(data["repository"])["pullRequest"]);
    if (Object.keys(pull).length === 0) throw new ForgeError(`${project} has no pull request #${number} this token can see`, 404);
    const pipelines: ForgePipeline[] = [];
    const statuses: ForgeCommitStatus[] = [];
    for (const entry of asList(asRecord(pull["commits"])["nodes"])) {
      const commit = asRecord(asRecord(entry)["commit"]);
      const sha = asText(commit["oid"]);
      for (const node of asList(asRecord(commit["checkSuites"])["nodes"])) {
        const suite = asRecord(node);
        if (Number(asRecord(suite["checkRuns"])["totalCount"] ?? 0) === 0) continue;
        const app = asRecord(suite["app"]);
        const run = asRecord(suite["workflowRun"]);
        const hasRun = Object.keys(run).length > 0;
        const id = Number(suite["databaseId"]);
        const event = asText(run["event"]).toLowerCase();
        const status = asText(suite["status"]).toLowerCase();
        pipelines.push({
          id,
          sha,
          ref: asText(asRecord(suite["branch"])["name"]),
          source: hasRun ? githubSource(event) : "external",
          sourceName: hasRun ? event : asText(app["slug"]),
          status: githubStatus(status, asText(suite["conclusion"]).toLowerCase()),
          name: hasRun ? asText(asRecord(run["workflow"])["name"]) : asText(app["name"]),
          ...(hasRun ? { runId: Number(run["databaseId"]) } : {}),
          createdAt: asText(suite["createdAt"]),
          ...(status === "completed" ? { finishedAt: asText(suite["updatedAt"]) } : {}),
          url: hasRun ? asText(run["url"]) : `${this.web}/${project}/commit/${sha}/checks?check_suite_id=${id}`,
        });
      }
      for (const node of asList(asRecord(commit["status"])["contexts"])) {
        const context = asRecord(node);
        statuses.push(
          githubStatusOf(sha, { context: context["context"], state: asText(context["state"]).toLowerCase(), description: context["description"], target_url: context["targetUrl"], created_at: context["createdAt"] }),
        );
      }
    }
    return { pipelines, statuses };
  }

  /**
   * A suite, its check runs (the jobs), and — when Actions ran it — the workflow run's event, attempt
   * and uploaded artifacts, which belong to the run and name no job.
   */
  async pipeline(project: string, id: number, options: { jobStatus?: readonly PipelineStatus[]; includeRetried?: boolean } = {}): Promise<PipelineDetail> {
    const response = await this.call("GET", `/repos/${project}/check-suites/${id}`);
    if (response.status === 404) throw new ForgeError(`${project} has no check suite ${id} this token can see`, 404);
    const suite = asRecord(expectStatus(response, [200], `reading check suite ${id}`).body);
    const actions = asText(asRecord(suite["app"])["slug"]) === "github-actions";
    const run = actions
      ? asRecord(
          asList(
            asRecord(expectStatus(await this.call("GET", `/repos/${project}/actions/runs?check_suite_id=${id}&per_page=1`), [200], `reading the workflow run of suite ${id}`).body)["workflow_runs"],
          )[0],
        )
      : undefined;
    const filter = options.includeRetried === true ? "all" : "latest";
    const rows = await this.listed(`/repos/${project}/check-suites/${id}/check-runs?filter=${filter}&per_page=100`, `reading the check runs of suite ${id}`, () => false, "check_runs");
    const wanted = options.jobStatus !== undefined && options.jobStatus.length > 0 ? new Set(options.jobStatus) : undefined;
    const jobs = markRetried(rows.map((row) => githubJobOf(asRecord(row)))).filter((job) => wanted === undefined || wanted.has(job.status));
    const artifacts: ForgeArtifact[] = [];
    if (run !== undefined && Object.keys(run).length > 0) {
      const body = asRecord(expectStatus(await this.call("GET", `/repos/${project}/actions/runs/${run["id"]}/artifacts?per_page=100`), [200], `reading the artifacts of run ${run["id"]}`).body);
      for (const entry of asList(body["artifacts"])) {
        const artifact = asRecord(entry);
        if (artifact["expired"] === true) continue;
        const expiresAt = asText(artifact["expires_at"]);
        artifacts.push({
          artifactId: Number(artifact["id"]),
          fileType: "archive",
          name: asText(artifact["name"]),
          ...(typeof artifact["size_in_bytes"] === "number" ? { size: artifact["size_in_bytes"] } : {}),
          ...(expiresAt.length > 0 ? { expiresAt } : {}),
          url: `${this.web}/${project}/actions/runs/${run["id"]}/artifacts/${artifact["id"]}`,
        });
      }
    }
    return { ...this.pipelineOfSuite(project, suite, run !== undefined && Object.keys(run).length > 0 ? run : undefined), jobs, artifacts };
  }

  /**
   * A check run, and for Actions the job it is (the same id, measured): steps, the labels it asked for,
   * the runner's name. The exit code is in the failure annotation Actions writes — "Process completed
   * with exit code 1." (measured) — so it is known without the log.
   */
  async job(project: string, id: number): Promise<JobDetail> {
    const response = await this.call("GET", `/repos/${project}/check-runs/${id}`);
    if (response.status === 404) throw new ForgeError(`${project} has no check run ${id} this token can see`, 404);
    const row = asRecord(expectStatus(response, [200], `reading check run ${id}`).body);
    const job = githubJobOf(row);
    const actions = asText(asRecord(row["app"])["slug"]) === "github-actions";
    const count = Number(asRecord(row["output"])["annotations_count"] ?? 0);
    const [actionsJob, annotationRows] = await Promise.all([
      actions ? this.call("GET", `/repos/${project}/actions/jobs/${id}`).then((r) => asRecord(expectStatus(r, [200], `reading job ${id}`).body)) : Promise.resolve(undefined),
      count > 0 ? this.listed(`/repos/${project}/check-runs/${id}/annotations?per_page=100`, `reading the annotations of ${id}`) : Promise.resolve([]),
    ]);
    const annotations: ForgeAnnotation[] = annotationRows.map((entry) => {
      const a = asRecord(entry);
      const level = asText(a["annotation_level"]);
      const title = asText(a["title"]);
      return {
        path: asText(a["path"]),
        ...(typeof a["start_line"] === "number" ? { startLine: a["start_line"] } : {}),
        ...(typeof a["end_line"] === "number" ? { endLine: a["end_line"] } : {}),
        level: level === "failure" || level === "warning" ? level : "notice",
        ...(title.length > 0 ? { title } : {}),
        message: asText(a["message"]),
      };
    });
    const exit = annotations.map((a) => /exit code (\d+)/.exec(a.message)).find((match) => match !== null);
    const runnerName = actionsJob !== undefined ? asText(actionsJob["runner_name"]) : "";
    return {
      ...job,
      pipelineId: Number(asRecord(row["check_suite"])["id"]),
      sha: asText(row["head_sha"]),
      ...(actionsJob !== undefined ? { runner: { ...(runnerName.length > 0 ? { name: runnerName } : {}), tags: asList(actionsJob["labels"]).map(asText) } } : {}),
      steps:
        actionsJob === undefined
          ? []
          : asList(actionsJob["steps"]).map((entry) => {
              const step = asRecord(entry);
              const startedAt = asText(step["started_at"]);
              const finishedAt = asText(step["completed_at"]);
              return {
                number: Number(step["number"]),
                name: asText(step["name"]),
                status: githubStatus(asText(step["status"]), asText(step["conclusion"])),
                ...(startedAt.length > 0 ? { startedAt } : {}),
                ...(finishedAt.length > 0 ? { finishedAt } : {}),
              };
            }),
      ...(exit !== undefined && exit !== null ? { exitCode: Number(exit[1]) } : {}),
      annotations,
      // Only Actions keeps a log GitHub will hand over; another app's check run has its output above.
      artifacts: actions ? [{ jobId: id, fileType: "trace", name: "job.log", url: job.url }] : [],
    };
  }

  /** A job's log, or a run's uploaded artifact (a zip). Both answer 302 to a link valid for a minute. */
  async artifact(project: string, which: ArtifactRef): Promise<ArtifactBytes> {
    let path: string;
    if ("artifactId" in which) path = `/repos/${project}/actions/artifacts/${which.artifactId}/zip`;
    else if (which.fileType === "trace") path = `/repos/${project}/actions/jobs/${which.jobId}/logs`;
    else throw new ForgeError("GitHub keeps one artifact per job — its log (file_type trace); a run's uploads are named by artifact_id", 400);
    const response = await this.http({ method: "GET", url: `${this.rest}${path}`, headers: this.headers(), expect: "bytes", timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (response.status === 404 || response.status === 410) throw new ForgeError(`${"artifactId" in which ? `artifact ${which.artifactId}` : `the log of job ${which.jobId}`} is not there to download — it may have expired`, 404);
    const body = expectStatus(response, [200], `downloading ${"artifactId" in which ? `artifact ${which.artifactId}` : `the log of job ${which.jobId}`}`).body;
    return { bytes: body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? "")), ...(response.headers["content-type"] !== undefined ? { contentType: response.headers["content-type"] } : {}) };
  }
}

/** How long a download gets: a log or an archive can be tens of megabytes. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A pull request's commits, each with its check suites and commit statuses, in one round trip. */
export const GITHUB_PULL_PIPELINES_QUERY = `
query JairaPullPipelines($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 50) {
        nodes {
          commit {
            oid
            checkSuites(first: 30) {
              nodes {
                databaseId status conclusion createdAt updatedAt
                app { slug name }
                branch { name }
                checkRuns(first: 1) { totalCount }
                workflowRun { databaseId event url workflow { name } }
              }
            }
            status { contexts { context state description targetUrl createdAt } }
          }
        }
      }
    }
  }
}`.trim();

/** A check suite's, run's or step's status and conclusion, in {@link PipelineStatus}'s words. */
function githubStatus(status: string, conclusion: string): PipelineStatus {
  if (status === "in_progress") return "running";
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "cancelled":
    case "stale":
      return "canceled";
    case "skipped":
    case "neutral":
      return "skipped";
    case "action_required":
      // Waiting for somebody to approve it — GitLab's manual.
      return "manual";
    default:
      // failure, timed_out, startup_failure
      return "failed";
  }
}

function githubSource(event: string): PipelineSource {
  switch (event) {
    case "push":
    case "schedule":
      return event;
    case "pull_request":
    case "pull_request_target":
    case "merge_group":
      return "merge_request";
    case "workflow_dispatch":
      return "web";
    case "repository_dispatch":
      return "api";
    case "workflow_call":
    case "workflow_run":
      return "trigger";
    default:
      return "other";
  }
}

/** A check run as a job. */
function githubJobOf(row: Record<string, unknown>): ForgeJob {
  const startedAt = asText(row["started_at"]);
  const finishedAt = asText(row["completed_at"]);
  return {
    id: Number(row["id"]),
    name: asText(row["name"]),
    status: githubStatus(asText(row["status"]), asText(row["conclusion"])),
    ...(startedAt.length > 0 ? { startedAt } : {}),
    ...(finishedAt.length > 0 ? { finishedAt } : {}),
    url: asText(row["html_url"]) || asText(row["details_url"]),
  };
}

/** A commit status — REST's, or GraphQL's mapped onto REST's field names. */
function githubStatusOf(sha: string, row: Record<string, unknown>): ForgeCommitStatus {
  const state = asText(row["state"]);
  const description = asText(row["description"]);
  const url = asText(row["target_url"]);
  return {
    sha,
    context: asText(row["context"]),
    status: state === "success" ? "success" : state === "pending" || state === "expected" ? "pending" : "failed",
    ...(description.length > 0 ? { description } : {}),
    ...(url.length > 0 ? { url } : {}),
    createdAt: asText(row["created_at"]),
  };
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

/** What a REST post answered with: the comment's id and its page. */
function postedComment(body: unknown): ForgePosted {
  const row = asRecord(body);
  const url = asText(row["html_url"]);
  return { ...(row["id"] !== undefined ? { id: String(row["id"]) } : {}), ...(url.length > 0 ? { url } : {}) };
}
