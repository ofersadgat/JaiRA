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
  remoteHandleId,
  type ForgeAnchor,
  type ForgeComment,
  type ForgeIdentity,
  type ForgeProvider,
  type ForgeReview,
  type ForgeThread,
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
}
