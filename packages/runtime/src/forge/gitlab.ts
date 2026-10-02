/**
 * GitLab, over REST v4 (decision 0004 §1).
 *
 * The only file that knows a GitLab endpoint. What shapes it:
 *
 *  - **A `304` still counts against the budget here** (measured), so a conditional request per merge
 *    request would spend the budget to learn nothing. The probe is ONE list call per host instead —
 *    `merge_requests?scope=created_by_me&updated_after=…` covers every request the token opened.
 *  - **A full read is three calls**: the request, its discussions, its approvals. Write access is not
 *    on a note's author, so a fourth — the project's member record — is made once per author and
 *    remembered for the life of the provider.
 *  - **"Request changes" has no endpoint of its own** on the versions this has to work with; it is
 *    the system note a reviewer's act leaves in the discussions, which is also where WHO and WHEN are.
 */
import {
  isJairaComment,
  markRetried,
  remoteHandleId,
  type ArtifactBytes,
  type ArtifactRef,
  type ForgeArtifact,
  type ForgeJob,
  type ForgePosted,
  type ForgePipeline,
  type JobDetail,
  type PipelineDetail,
  type PipelineList,
  type PipelineQuery,
  type PipelineSource,
  type PipelineStatus,
  type PipelineTests,
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
import { asList, asRecord, asText, expectStatus, ForgeError, limitOf, type ForgeProviderOptions, type ForgeResponse } from "./http";

/** GitLab's access levels: Developer is the first that can push, which is what "write access" means here. */
const DEVELOPER = 30;
/** A page is 100 at most; ten of them is a thousand discussions, past which a review is not a review. */
const MAX_PAGES = 10;

const REQUESTED_CHANGES = "requested changes";
const APPROVED = "approved this merge request";
const UNAPPROVED = "unapproved this merge request";

export class GitLabProvider implements ForgeProvider {
  readonly kind = "gitlab" as const;
  readonly host: string;
  private readonly api: string;
  private me?: Promise<ForgeIdentity>;
  private readonly members = new Map<string, Promise<boolean>>();

  constructor(private readonly options: ForgeProviderOptions) {
    this.host = options.host;
    this.api = options.apiUrl ?? `https://${options.host}/api/v4`;
  }

  private call(method: "GET" | "POST" | "PUT", path: string, body?: Record<string, unknown>): Promise<ForgeResponse> {
    return this.options.http({
      method,
      url: `${this.api}${path}`,
      // `Authorization: Bearer`, not `PRIVATE-TOKEN`: GitLab takes a personal access token either way,
      // but an OAuth token (a sign-in through the browser) ONLY this way — `PRIVATE-TOKEN` is looked up
      // as a personal token and refused.
      headers: { Authorization: `Bearer ${this.options.token}`, Accept: "application/json", "User-Agent": "jaira" },
      ...(body !== undefined ? { body: body as never } : {}),
    });
  }

  /** Every page of a list, following `x-next-page` — the header GitLab sets on a paginated answer. */
  private async pages(path: string, what: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let page = "1";
    for (let i = 0; i < MAX_PAGES && page !== ""; i++) {
      const joiner = path.includes("?") ? "&" : "?";
      const response = expectStatus(await this.call("GET", `${path}${joiner}per_page=100&page=${page}`), [200], what);
      out.push(...asList(response.body));
      page = response.headers["x-next-page"] ?? "";
    }
    return out;
  }

  whoami(): Promise<ForgeIdentity> {
    this.me ??= this.call("GET", "/user").then((response) => {
      const user = asRecord(expectStatus(response, [200], "asking GitLab who the token is").body);
      const name = asText(user["name"]);
      return { login: asText(user["username"]), ...(name.length > 0 ? { name } : {}) };
    });
    // A refusal is not remembered: the token may be replaced, and the next check must ask again.
    this.me.catch(() => {
      this.me = undefined;
    });
    return this.me;
  }

  private mr(handle: { project: string; number: number }): string {
    return `/projects/${encodeURIComponent(handle.project)}/merge_requests/${handle.number}`;
  }

  private handleOf(request: { host: string; project: string }, mr: Record<string, unknown>): RemoteHandle {
    const number = Number(mr["iid"]);
    return {
      id: remoteHandleId("gitlab", request.host, request.project, number),
      provider: "gitlab",
      host: request.host,
      project: request.project,
      branch: asText(mr["source_branch"]),
      target: asText(mr["target_branch"]),
      number,
      url: asText(mr["web_url"]),
      head: asText(mr["sha"]),
    };
  }

  async open(request: OpenRequest): Promise<RemoteHandle> {
    const project = encodeURIComponent(request.project);
    const found = expectStatus(
      await this.call(
        "GET",
        `/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(request.branch)}&target_branch=${encodeURIComponent(request.target)}`,
      ),
      [200],
      `looking for the merge request of ${request.branch}`,
    );
    const existing = asList(found.body)[0];
    if (existing !== undefined) return this.handleOf(request, asRecord(existing));

    // GitLab has no `draft` field on create: a draft IS a title that starts with `Draft:`.
    const created = expectStatus(
      await this.call("POST", `/projects/${project}/merge_requests`, {
        source_branch: request.branch,
        target_branch: request.target,
        title: request.draft ? `Draft: ${request.title}` : request.title,
        description: request.description,
      }),
      [201],
      `opening a merge request for ${request.branch}`,
    );
    return this.handleOf(request, asRecord(created.body));
  }

  async probe(handles: RemoteHandle[], cursor: ProbeCursor): Promise<Probe> {
    if (handles.length === 0) return { moved: [], cursor };
    const now = this.options.now ?? Date.now;
    // No cursor yet: everything is news, and the next probe starts from a minute before now — the
    // forge's clock and this one's need not agree, and a repeated read costs less than a missed one.
    if (cursor.since === undefined) {
      return { moved: handles.map((h) => h.id), cursor: { since: new Date(now() - 60_000).toISOString() } };
    }
    const rows = await this.pages(
      `/merge_requests?scope=created_by_me&state=all&order_by=updated_at&updated_after=${encodeURIComponent(cursor.since)}`,
      "asking GitLab which merge requests moved",
    );
    const byUrl = new Map(handles.map((h) => [h.url, h.id]));
    const moved: string[] = [];
    let latest = cursor.since;
    for (const row of rows) {
      const mr = asRecord(row);
      const id = byUrl.get(asText(mr["web_url"]));
      if (id !== undefined) moved.push(id);
      const updated = asText(mr["updated_at"]);
      if (updated > latest) latest = updated;
    }
    // One millisecond past the newest row. `updated_after` is INCLUSIVE (measured 2026-09-19: asked
    // for a request's exact `updated_at`, the list returned that request — see the recorded fixture),
    // so a cursor left ON the newest row would report that row as moved on every tick.
    const since = latest === cursor.since ? latest : new Date(Date.parse(latest) + 1).toISOString();
    return { moved, cursor: { since } };
  }

  /** Developer and up — asked once per author, because a note's author carries no access level. */
  private canWrite(project: string, userId: number): Promise<boolean> {
    const key = `${project}#${userId}`;
    let known = this.members.get(key);
    if (known === undefined) {
      known = this.call("GET", `/projects/${encodeURIComponent(project)}/members/all/${userId}`).then((response) => {
        // Not a member is an answer, not an error: anyone may comment on a public project.
        if (response.status === 404) return false;
        return Number(asRecord(expectStatus(response, [200], "asking GitLab for a member's access").body)["access_level"]) >= DEVELOPER;
      });
      known.catch(() => this.members.delete(key));
      this.members.set(key, known);
    }
    return known;
  }

  async read(handle: RemoteHandle): Promise<RemoteState> {
    const path = this.mr(handle);
    const [mrResponse, discussions, approvalsResponse] = await Promise.all([
      this.call("GET", path),
      this.pages(`${path}/discussions`, `reading the discussions of ${handle.id}`),
      this.call("GET", `${path}/approvals`),
    ]);
    const mr = asRecord(expectStatus(mrResponse, [200], `reading ${handle.id}`).body);
    const approvals = asRecord(expectStatus(approvalsResponse, [200], `reading the approvals of ${handle.id}`).body);

    const webUrl = asText(mr["web_url"]) || handle.url;
    const comment = async (note: Record<string, unknown>): Promise<ForgeComment> => {
      const author = asRecord(note["author"]);
      const who = asText(author["username"]);
      return {
        id: String(note["id"]),
        who,
        body: asText(note["body"]),
        at: asText(note["created_at"]),
        ...(webUrl.length > 0 ? { url: noteUrl(webUrl, note["id"]) } : {}),
        canWrite: await this.canWrite(handle.project, Number(author["id"])),
        // JaiRA's own words are the ones carrying its marker — not the token's account, which is the person's.
        own: isJairaComment(asText(note["body"])),
      };
    };

    const threads: ForgeThread[] = [];
    const comments: ForgeComment[] = [];
    /** Per person, the last thing they DID as a reviewer — a later approval withdraws a request for changes. */
    const lastAct = new Map<string, { note: Record<string, unknown>; act: string }>();

    for (const entry of discussions) {
      const discussion = asRecord(entry);
      const notes = asList(discussion["notes"]).map(asRecord);
      const spoken = notes.filter((note) => note["system"] !== true);
      for (const note of notes) {
        if (note["system"] !== true) continue;
        const act = [REQUESTED_CHANGES, APPROVED, UNAPPROVED].find((phrase) => asText(note["body"]).startsWith(phrase));
        if (act !== undefined) lastAct.set(asText(asRecord(note["author"])["username"]), { note, act });
      }
      if (spoken.length === 0) continue;

      const first = spoken[0]!;
      const anchor = anchorOf(asRecord(first["position"]));
      if (discussion["individual_note"] === true && anchor === undefined) {
        comments.push(await comment(first));
        continue;
      }
      const resolvable = spoken.filter((note) => note["resolvable"] === true);
      threads.push({
        id: asText(discussion["id"]),
        ...(anchor !== undefined ? { anchor } : {}),
        resolved: resolvable.length > 0 && resolvable.every((note) => note["resolved"] === true),
        comments: await Promise.all(spoken.map(comment)),
      });
    }

    const reviews: ForgeReview[] = [];
    for (const entry of asList(approvals["approved_by"])) {
      const user = asRecord(asRecord(entry)["user"]);
      const who = asText(user["username"]);
      reviews.push({
        id: `approval:${who}`,
        who,
        at: asText(asRecord(entry)["approved_at"]),
        verdict: "approved",
        canWrite: await this.canWrite(handle.project, Number(user["id"])),
        // An approval has no body to carry a marker, and JaiRA never approves: it is the person's.
        own: false,
      });
    }
    for (const [who, { note, act }] of lastAct) {
      if (act !== REQUESTED_CHANGES) continue;
      reviews.push({
        id: `note:${String(note["id"])}`,
        who,
        at: asText(note["created_at"]),
        verdict: "changes_requested",
        canWrite: await this.canWrite(handle.project, Number(asRecord(note["author"])["id"])),
        own: false,
      });
    }

    const state = asText(mr["state"]);
    // What landed on the target: the merge commit, or — squashed onto a fast-forward — the squash.
    const mergeCommit = asText(mr["merge_commit_sha"]) || asText(mr["squash_commit_sha"]);
    const closedBy = asText(asRecord(state === "merged" ? mr["merged_by"] ?? mr["merge_user"] : mr["closed_by"])["username"]);
    return {
      state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      draft: mr["draft"] === true || mr["work_in_progress"] === true,
      head: asText(mr["sha"]),
      ...(state === "merged" && mergeCommit.length > 0 ? { mergeCommit } : {}),
      ...(closedBy.length > 0 ? { closedBy } : {}),
      updatedAt: asText(mr["updated_at"]),
      reviews,
      threads,
      comments,
    };
  }

  async comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<ForgePosted> {
    const path = this.mr(handle);
    if (anchor !== undefined) {
      // An inline thread is positioned against the request's CURRENT diff, so the three shas are read
      // at the moment of posting rather than remembered from the last push.
      const refs = asRecord(asRecord(expectStatus(await this.call("GET", path), [200], `reading ${handle.id}`).body)["diff_refs"]);
      const position = {
        position_type: "text",
        base_sha: asText(refs["base_sha"]),
        start_sha: asText(refs["start_sha"]),
        head_sha: asText(refs["head_sha"]),
        ...(anchor.side === "after"
          ? { new_path: anchor.path, new_line: anchor.line }
          : { old_path: anchor.path, old_line: anchor.line }),
      };
      const placed = await this.call("POST", `${path}/discussions`, { body, position });
      if (placed.status === 201) return postedNote(handle, asRecord(asList(asRecord(placed.body)["notes"])[0]));
      // GitLab refuses a position it cannot place — an unchanged line wants BOTH line numbers, a line
      // outside the diff wants none. A note must not be lost to that: it goes on the request instead,
      // saying where it was about. Any other refusal is a real one.
      if (placed.status !== 400) expectStatus(placed, [201], `commenting on ${handle.id}`);
      body = `\`${anchor.path}:${anchor.line}\` — ${body}`;
    }
    return postedNote(handle, asRecord(expectStatus(await this.call("POST", `${path}/notes`, { body }), [201], `commenting on ${handle.id}`).body));
  }

  async reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<ForgePosted> {
    const thread = `${this.mr(handle)}/discussions/${encodeURIComponent(threadId)}`;
    const note = asRecord(expectStatus(await this.call("POST", `${thread}/notes`, { body }), [201], `replying on ${handle.id}`).body);
    if (resolve === true) expectStatus(await this.call("PUT", thread, { resolved: true }), [200], `resolving a thread on ${handle.id}`);
    return postedNote(handle, note);
  }

  async merge(handle: RemoteHandle): Promise<void> {
    const response = await this.call("PUT", `${this.mr(handle)}/merge`);
    // 405 / 406 / 409 / 422 are GitLab's four ways of saying "not mergeable right now" — conflicts, a
    // pipeline, a draft, a head that moved. One sentence covers them; the status says which.
    if ([405, 406, 409, 422].includes(response.status)) {
      throw new ForgeError(`${handle.id} cannot be merged right now (GitLab answered ${response.status})`, response.status);
    }
    expectStatus(response, [200], `merging ${handle.id}`);
  }

  async close(handle: RemoteHandle): Promise<void> {
    expectStatus(await this.call("PUT", this.mr(handle), { state_event: "close" }), [200], `closing ${handle.id}`);
  }

  // --- what the Git tools and the repository watcher read (decision 0010) ---------------------------

  private summaryOf(mr: Record<string, unknown>): MergeRequestSummary {
    const state = asText(mr["state"]);
    const description = asText(mr["description"]);
    return {
      number: Number(mr["iid"]),
      title: asText(mr["title"]),
      // `locked` is an open request mid-merge; it is still open to anybody reading it.
      state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
      draft: mr["draft"] === true || mr["work_in_progress"] === true,
      author: asText(asRecord(mr["author"])["username"]),
      sourceBranch: asText(mr["source_branch"]),
      targetBranch: asText(mr["target_branch"]),
      head: asText(mr["sha"]),
      updatedAt: asText(mr["updated_at"]),
      url: asText(mr["web_url"]),
      ...(description.length > 0 ? { description } : {}),
    };
  }

  /** `GET /projects/:id/merge_requests` — every filter is the forge's own, so one page is the answer. */
  async listMergeRequests(project: string, query: MergeRequestQuery = {}): Promise<MergeRequestSummary[]> {
    const limit = limitOf(query.limit);
    const state = query.state ?? "open";
    const params = new URLSearchParams({ state: state === "open" ? "opened" : state, order_by: "updated_at", sort: "desc", per_page: String(limit) });
    if (query.author !== undefined) params.set("author_username", query.author);
    if (query.sourceBranch !== undefined) params.set("source_branch", query.sourceBranch);
    if (query.targetBranch !== undefined) params.set("target_branch", query.targetBranch);
    if (query.updatedSince !== undefined) params.set("updated_after", query.updatedSince);
    const response = expectStatus(
      await this.call("GET", `/projects/${encodeURIComponent(project)}/merge_requests?${params.toString()}`),
      [200],
      `listing the merge requests of ${project}`,
    );
    // `updated_after` is INCLUSIVE (see `probe`); "since" here means strictly after.
    return asList(response.body)
      .map((row) => this.summaryOf(asRecord(row)))
      .filter((summary) => query.updatedSince === undefined || summary.updatedAt > query.updatedSince)
      .slice(0, limit);
  }

  async mergeRequest(project: string, number: number): Promise<MergeRequestSummary> {
    const response = await this.call("GET", this.mr({ project, number }));
    if (response.status === 404) throw new ForgeError(`${project} has no merge request !${number} this token can see`, 404);
    return this.summaryOf(asRecord(expectStatus(response, [200], `reading ${project}!${number}`).body));
  }

  async branches(project: string): Promise<ForgeBranch[]> {
    const rows = await this.pages(`/projects/${encodeURIComponent(project)}/repository/branches`, `listing the branches of ${project}`);
    return rows.map((row) => ({ name: asText(asRecord(row)["name"]), head: asText(asRecord(asRecord(row)["commit"])["id"]) }));
  }

  /**
   * The discussions, flattened — the same reading `read` makes of them (a lone note with no position
   * is a general comment; everything else is a thread), without the member lookups a settlement
   * needs and a list of what was said does not.
   */
  async comments(handle: RemoteHandle, options: { since?: string } = {}): Promise<ForgeNote[]> {
    const discussions = await this.pages(`${this.mr(handle)}/discussions`, `reading the discussions of ${handle.id}`);
    const notes: ForgeNote[] = [];
    for (const entry of discussions) {
      const discussion = asRecord(entry);
      const spoken = asList(discussion["notes"]).map(asRecord).filter((note) => note["system"] !== true);
      if (spoken.length === 0) continue;
      const anchor = anchorOf(asRecord(spoken[0]!["position"]));
      const threaded = !(discussion["individual_note"] === true && anchor === undefined);
      for (const note of spoken) {
        const who = asText(asRecord(note["author"])["username"]);
        notes.push({
          id: String(note["id"]),
          ...(threaded ? { threadId: asText(discussion["id"]) } : {}),
          who,
          body: asText(note["body"]),
          at: asText(note["created_at"]),
          ...(anchor !== undefined ? { anchor } : {}),
          own: isJairaComment(asText(note["body"])),
        });
      }
    }
    return notes.filter((note) => options.since === undefined || note.at > options.since).sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * `GET /projects/:id/repository/compare?from=&to=` — sorted oldest first here by committed date
   * (the head last), rather than trusting an order the API does not document. With no base, the one
   * head commit.
   */
  async compare(project: string, base: string | undefined, head: string): Promise<ForgeCommit[]> {
    const at = `/projects/${encodeURIComponent(project)}/repository`;
    const commitOf = (entry: unknown): ForgeCommit & { when: string } => {
      const row = asRecord(entry);
      return { sha: asText(row["id"]), message: asText(row["message"]) || asText(row["title"]), author: asText(row["author_name"]), when: asText(row["committed_date"]) || asText(row["created_at"]) };
    };
    const strip = ({ sha, message, author }: ForgeCommit & { when: string }): ForgeCommit => ({ sha, message, author });
    if (base === undefined) {
      return [strip(commitOf(expectStatus(await this.call("GET", `${at}/commits/${encodeURIComponent(head)}`), [200], `reading ${head.slice(0, 7)}`).body))];
    }
    const response = expectStatus(
      await this.call("GET", `${at}/compare?${new URLSearchParams({ from: base, to: head }).toString()}`),
      [200],
      `comparing ${base.slice(0, 7)}...${head.slice(0, 7)}`,
    );
    const commits = asList(asRecord(response.body)["commits"]).map(commitOf);
    commits.sort((a, b) => a.when.localeCompare(b.when));
    const last = commits.findIndex((commit) => commit.sha === head);
    if (last >= 0) commits.push(...commits.splice(last, 1));
    return commits.map(strip);
  }

  // --- CI (decision 0016) ------------------------------------------------------------------------

  private projectPath(project: string): string {
    return `/projects/${encodeURIComponent(project)}`;
  }

  /**
   * A merge request's pipelines come from its OWN list, not from its head commit: a merged-result
   * pipeline runs on a merge commit that is not one of the request's commits (measured, gitlab-org/cli
   * !3966), so a lookup by sha misses it. A ref or a sha asks the project's list, newest first.
   *
   * `status` and `source` go to GitLab where one of its words means exactly ours, and are applied here
   * otherwise — `pending` is five of GitLab's, and the merge request list takes no filters at all.
   */
  async pipelines(project: string, query: PipelineQuery): Promise<PipelineList> {
    const limit = limitOf(query.limit);
    const at = this.projectPath(project);
    let rows: unknown[];
    if (query.mergeRequest !== undefined) {
      const response = await this.call("GET", `${at}/merge_requests/${query.mergeRequest}/pipelines?per_page=100`);
      if (response.status === 404) throw new ForgeError(`${project} has no merge request !${query.mergeRequest} this token can see`, 404);
      rows = asList(expectStatus(response, [200], `reading the pipelines of ${project}!${query.mergeRequest}`).body);
    } else {
      const which: { ref?: string; sha?: string } | undefined = query.ref !== undefined ? { ref: query.ref } : query.sha !== undefined ? { sha: query.sha } : undefined;
      if (which === undefined) throw new ForgeError("name the merge request, the ref or the commit whose pipelines to list", 400);
      const params = new URLSearchParams({ order_by: "id", sort: "desc", per_page: String(query.status !== undefined || query.source !== undefined ? 100 : limit) });
      if (which.ref !== undefined) params.set("ref", which.ref);
      if (which.sha !== undefined) params.set("sha", which.sha);
      if (query.status !== undefined && query.status !== "pending") params.set("status", query.status);
      const source = query.source !== undefined ? GITLAB_SOURCE_OF[query.source] : undefined;
      if (source !== undefined) params.set("source", source);
      rows = asList(expectStatus(await this.call("GET", `${at}/pipelines?${params.toString()}`), [200], `reading the pipelines of ${Object.values(which)[0]}`).body);
    }
    const pipelines = rows
      .map((row) => gitlabPipelineOf(asRecord(row)))
      .filter((pipeline) => (query.status === undefined || pipeline.status === query.status) && (query.source === undefined || pipeline.source === query.source))
      .slice(0, limit);
    return { pipelines, statuses: [] };
  }

  /**
   * The pipeline, its jobs, its trigger jobs, and its test report's counts when it has one.
   *
   * Trigger jobs are not in the jobs list; `trigger_jobs` names them since GitLab 19.2, `bridges`
   * before. A test report is read only when the pipeline has finished — GitLab builds it from the
   * junit artifacts — and a refusal to read it costs the answer nothing.
   */
  async pipeline(project: string, id: number, options: { jobStatus?: readonly PipelineStatus[]; includeRetried?: boolean } = {}): Promise<PipelineDetail> {
    const at = `${this.projectPath(project)}/pipelines/${id}`;
    const response = await this.call("GET", at);
    if (response.status === 404) throw new ForgeError(`${project} has no pipeline ${id} this token can see`, 404);
    const pipeline = gitlabPipelineOf(asRecord(expectStatus(response, [200], `reading pipeline ${id}`).body));
    const scopes = [...new Set((options.jobStatus ?? []).flatMap((status) => GITLAB_SCOPES_OF[status]))];
    const query = [...scopes.map((scope) => `scope[]=${scope}`), ...(options.includeRetried === true ? ["include_retried=true"] : [])].join("&");
    const suffix = query.length > 0 ? `?${query}` : "";
    const jobs = (await this.pages(`${at}/jobs${suffix}`, `reading the jobs of pipeline ${id}`)).map((row) => gitlabJobOf(asRecord(row)));
    let triggers: ForgeJob[];
    try {
      triggers = (await this.pages(`${at}/trigger_jobs${suffix}`, `reading the trigger jobs of pipeline ${id}`)).map((row) => gitlabJobOf(asRecord(row)));
    } catch (e) {
      if (!(e instanceof ForgeError) || e.status !== 404) throw e;
      triggers = (await this.pages(`${at}/bridges${suffix}`, `reading the trigger jobs of pipeline ${id}`)).map((row) => gitlabJobOf(asRecord(row)));
    }
    const all = markRetried([...jobs, ...triggers]).sort((a, b) => a.id - b.id);
    const tests = pipeline.status === "running" || pipeline.status === "pending" ? undefined : await this.testSummary(at).catch(() => undefined);
    return { ...pipeline, jobs: all, artifacts: [], ...(tests !== undefined ? { tests } : {}) };
  }

  private async testSummary(at: string): Promise<PipelineTests | undefined> {
    const body = asRecord(expectStatus(await this.call("GET", `${at}/test_report_summary`), [200], "reading the test report").body);
    const total = asRecord(body["total"]);
    if (Number(total["count"] ?? 0) === 0) return undefined;
    return {
      total: Number(total["count"] ?? 0),
      failed: Number(total["failed"] ?? 0),
      skipped: Number(total["skipped"] ?? 0),
      errored: Number(total["error"] ?? 0),
      suites: asList(body["test_suites"]).map((entry) => {
        const suite = asRecord(entry);
        return {
          name: asText(suite["name"]),
          total: Number(suite["total_count"] ?? 0),
          failed: Number(suite["failed_count"] ?? 0),
          skipped: Number(suite["skipped_count"] ?? 0),
          errored: Number(suite["error_count"] ?? 0),
          jobIds: asList(suite["build_ids"]).map(Number),
        };
      }),
    };
  }

  /**
   * One job. The machine is `runner` (its description names it) and `runner_manager` (platform,
   * architecture, version — `null` to an unauthenticated read, measured); the image is only in the
   * log. Every artifact the job lists is offered except `metadata`, the archive's index, which is
   * GitLab's own. The log is the artifact of `file_type` `trace`.
   */
  async job(project: string, id: number): Promise<JobDetail> {
    const response = await this.call("GET", `${this.projectPath(project)}/jobs/${id}`);
    if (response.status === 404) throw new ForgeError(`${project} has no job ${id} this token can see`, 404);
    const row = asRecord(expectStatus(response, [200], `reading job ${id}`).body);
    const job = gitlabJobOf(row);
    const runner = asRecord(row["runner"]);
    const manager = asRecord(row["runner_manager"]);
    const expiresAt = asText(row["artifacts_expire_at"]);
    const artifacts: ForgeArtifact[] = asList(row["artifacts"])
      .map((entry) => asRecord(entry))
      .filter((artifact) => asText(artifact["file_type"]) !== "metadata")
      .map((artifact) => {
        const fileType = asText(artifact["file_type"]);
        return {
          jobId: id,
          fileType,
          name: asText(artifact["filename"]),
          ...(typeof artifact["size"] === "number" ? { size: artifact["size"] } : {}),
          // A log is never expired by the artifact cleanup (GitLab docs); everything else is.
          ...(fileType !== "trace" && expiresAt.length > 0 ? { expiresAt } : {}),
          url: fileType === "trace" ? `${job.url}/raw` : fileType === "archive" ? `${job.url}/artifacts/browse` : job.url,
        };
      });
    const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
    const sha = text(asRecord(row["commit"])["id"]) ?? text(asRecord(row["pipeline"])["sha"]);
    const pipelineId = asRecord(row["pipeline"])["id"];
    return {
      ...job,
      ...(typeof pipelineId === "number" ? { pipelineId } : {}),
      ...(sha !== undefined ? { sha } : {}),
      runner: {
        ...(text(runner["description"]) !== undefined ? { name: text(runner["description"])! } : {}),
        ...(text(manager["platform"]) !== undefined ? { platform: text(manager["platform"])! } : {}),
        ...(text(manager["architecture"]) !== undefined ? { architecture: text(manager["architecture"])! } : {}),
        ...(text(manager["version"]) !== undefined ? { version: text(manager["version"])! } : {}),
        tags: asList(row["tag_list"]).map(asText).filter((tag) => tag.length > 0),
      },
      steps: [],
      annotations: [],
      artifacts,
    };
  }

  /**
   * One artifact's bytes: the log (`/trace`), the whole archive, one file from it (`path`), or one
   * report by its type. GitLab has no artifact of its own apart from a job's, so an `artifactId` is
   * refused naming what to send instead.
   */
  async artifact(project: string, which: ArtifactRef): Promise<ArtifactBytes> {
    if (!("jobId" in which)) throw new ForgeError("a GitLab artifact belongs to a job: name its job_id and file_type", 400);
    const at = `${this.projectPath(project)}/jobs/${which.jobId}`;
    const path =
      which.fileType === "trace"
        ? `${at}/trace`
        : which.fileType === "archive"
          ? `${at}/artifacts${which.path !== undefined ? `/${which.path.split("/").map(encodeURIComponent).join("/")}` : ""}`
          : `${at}/artifacts?file_type=${encodeURIComponent(which.fileType)}`;
    const response = await this.options.http({
      method: "GET",
      url: `${this.api}${path}`,
      headers: { Authorization: `Bearer ${this.options.token}`, "User-Agent": "jaira" },
      expect: "bytes",
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (response.status === 404) {
      throw new ForgeError(`job ${which.jobId} has no ${which.fileType}${which.path !== undefined ? ` file ${which.path}` : ""} to download — it may have expired`, 404);
    }
    const body = expectStatus(response, [200], `downloading the ${which.fileType} of job ${which.jobId}`).body;
    return { bytes: body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? "")), ...(response.headers["content-type"] !== undefined ? { contentType: response.headers["content-type"] } : {}) };
  }
}

/** How long a download gets: a log or an archive can be tens of megabytes. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** GitLab's pipeline and job statuses, in {@link PipelineStatus}'s words. */
function gitlabStatus(status: string): PipelineStatus {
  switch (status) {
    case "running":
    case "canceling":
      return "running";
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    default:
      // created, waiting_for_resource, preparing, pending, scheduled, waiting_for_callback
      return "pending";
  }
}

/** The job scopes (`scope[]`) that make up each of our statuses. */
const GITLAB_SCOPES_OF: Record<PipelineStatus, readonly string[]> = {
  pending: ["created", "waiting_for_resource", "preparing", "pending", "scheduled"],
  running: ["running", "canceling"],
  success: ["success"],
  failed: ["failed"],
  canceled: ["canceled"],
  skipped: ["skipped"],
  manual: ["manual"],
};

/** GitLab's `source` for each of ours that has exactly one. */
const GITLAB_SOURCE_OF: Partial<Record<PipelineSource, string>> = {
  push: "push",
  merge_request: "merge_request_event",
  schedule: "schedule",
  trigger: "trigger",
  api: "api",
  web: "web",
  external: "external",
};

function gitlabSource(source: string): PipelineSource {
  switch (source) {
    case "push":
    case "schedule":
    case "trigger":
    case "api":
    case "web":
    case "external":
      return source;
    case "merge_request_event":
    case "external_pull_request_event":
      return "merge_request";
    case "parent_pipeline":
    case "pipeline":
      return "trigger";
    default:
      return "other";
  }
}

function gitlabPipelineOf(row: Record<string, unknown>): ForgePipeline {
  const name = asText(row["name"]);
  const finishedAt = asText(row["finished_at"]);
  return {
    id: Number(row["id"]),
    sha: asText(row["sha"]),
    ref: asText(row["ref"]),
    source: gitlabSource(asText(row["source"])),
    sourceName: asText(row["source"]),
    status: gitlabStatus(asText(row["status"])),
    ...(name.length > 0 ? { name } : {}),
    createdAt: asText(row["created_at"]),
    ...(finishedAt.length > 0 ? { finishedAt } : {}),
    url: asText(row["web_url"]),
  };
}

/** A job or a trigger job — a trigger job carries the pipeline it started. */
function gitlabJobOf(row: Record<string, unknown>): ForgeJob {
  const stage = asText(row["stage"]);
  const reason = asText(row["failure_reason"]);
  const startedAt = asText(row["started_at"]);
  const finishedAt = asText(row["finished_at"]);
  const downstream = asRecord(row["downstream_pipeline"])["id"];
  return {
    id: Number(row["id"]),
    name: asText(row["name"]),
    ...(stage.length > 0 ? { stage } : {}),
    status: gitlabStatus(asText(row["status"])),
    ...(reason.length > 0 ? { failureReason: reason } : {}),
    ...(typeof row["allow_failure"] === "boolean" ? { allowFailure: row["allow_failure"] } : {}),
    ...(startedAt.length > 0 ? { startedAt } : {}),
    ...(finishedAt.length > 0 ? { finishedAt } : {}),
    url: asText(row["web_url"]),
    ...(typeof downstream === "number" ? { downstreamPipelineId: downstream } : {}),
  };
}

/** A diff note's position, in JaiRA's words. A line that exists after the change is an `after` anchor. */
function anchorOf(position: Record<string, unknown>): ForgeAnchor | undefined {
  if (typeof position["new_line"] === "number" && asText(position["new_path"]).length > 0) {
    return { path: asText(position["new_path"]), line: position["new_line"], side: "after" };
  }
  if (typeof position["old_line"] === "number" && asText(position["old_path"]).length > 0) {
    return { path: asText(position["old_path"]), line: position["old_line"], side: "before" };
  }
  return undefined;
}

/**
 * A note's link: its merge request's page with `#note_<id>`. GitLab's notes carry no `web_url`, and
 * this anchor is the one its own pages and docs link a note by.
 */
function noteUrl(requestUrl: string, id: unknown): string {
  return `${requestUrl}#note_${String(id)}`;
}

/** What a post answered with, as far as it says: the note's id, and its link when the request has one. */
function postedNote(handle: RemoteHandle, note: Record<string, unknown>): ForgePosted {
  if (note["id"] === undefined) return {};
  return { id: String(note["id"]), ...(handle.url.length > 0 ? { url: noteUrl(handle.url, note["id"]) } : {}) };
}
