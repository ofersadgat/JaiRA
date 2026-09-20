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
import { asList, asRecord, asText, expectStatus, ForgeError, type ForgeProviderOptions, type ForgeResponse } from "./http";

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
      headers: { "PRIVATE-TOKEN": this.options.token, Accept: "application/json", "User-Agent": "jaira" },
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
    const [me, mrResponse, discussions, approvalsResponse] = await Promise.all([
      this.whoami(),
      this.call("GET", path),
      this.pages(`${path}/discussions`, `reading the discussions of ${handle.id}`),
      this.call("GET", `${path}/approvals`),
    ]);
    const mr = asRecord(expectStatus(mrResponse, [200], `reading ${handle.id}`).body);
    const approvals = asRecord(expectStatus(approvalsResponse, [200], `reading the approvals of ${handle.id}`).body);

    const comment = async (note: Record<string, unknown>): Promise<ForgeComment> => {
      const author = asRecord(note["author"]);
      const who = asText(author["username"]);
      return {
        id: String(note["id"]),
        who,
        body: asText(note["body"]),
        at: asText(note["created_at"]),
        canWrite: await this.canWrite(handle.project, Number(author["id"])),
        own: who === me.login,
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
        own: who === me.login,
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
        own: who === me.login,
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

  async comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<void> {
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
      if (placed.status === 201) return;
      // GitLab refuses a position it cannot place — an unchanged line wants BOTH line numbers, a line
      // outside the diff wants none. A note must not be lost to that: it goes on the request instead,
      // saying where it was about. Any other refusal is a real one.
      if (placed.status !== 400) expectStatus(placed, [201], `commenting on ${handle.id}`);
      body = `\`${anchor.path}:${anchor.line}\` — ${body}`;
    }
    expectStatus(await this.call("POST", `${path}/notes`, { body }), [201], `commenting on ${handle.id}`);
  }

  async reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<void> {
    const thread = `${this.mr(handle)}/discussions/${encodeURIComponent(threadId)}`;
    expectStatus(await this.call("POST", `${thread}/notes`, { body }), [201], `replying on ${handle.id}`);
    if (resolve === true) expectStatus(await this.call("PUT", thread, { resolved: true }), [200], `resolving a thread on ${handle.id}`);
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
