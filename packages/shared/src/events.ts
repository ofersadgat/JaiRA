/**
 * The event vocabulary (decision 0010 §2) — what `on_event(name, filter?)` names, what each event
 * carries, and what a filter on it can say.
 *
 * An event is something that happened on a remote (`git.*`) or in JaiRA (`task.*`). Here rather than
 * beside the watcher that raises them, for the reason `./userEvents` is: the RUNTIME raises and
 * delivers them, the LINT checks a guard's name and filter against them, the SETTINGS page lists them
 * with their labels, and the workflow editor offers `← event.x` picks from each payload's schema.
 * Four copies of "the push's branch is called `branch`" is four chances to disagree.
 *
 * Pure data, types and pure functions — this module is part of the browser entry.
 *
 * ## Spelling
 *
 * Payload fields are snake_case (`source_branch`, `head_sha`), because a payload is a workflow's
 * value — `event.merge_request.target_branch` in an expression, beside the snake_case of every other
 * workflow input — and not a TypeScript object that happens to cross a boundary.
 *
 * ## Filters
 *
 * {@link matchesEventFilter} reads `on_event`'s second argument. Every key takes a glob or a list of
 * globs (any one matching is enough), and every key given must match. What a key is matched against
 * depends on the event ({@link EVENT_FILTER_KEYS}); a key that has nothing to match on an event, or
 * a key that is not a filter at all, NEVER matches — a guard that cannot tell is a guard that waits,
 * which is the failure the lint names, rather than one that fires on everything.
 */
import type { JsonValue } from "@declarative-ai/json";
import { globToRegExp } from "./scopes";
import type { TaskStatus } from "./task";

// --- the names ------------------------------------------------------------------------------------

/** Every event, in the order Settings lists them: the remote's first, then JaiRA's own. */
export const EVENT_NAMES = [
  "git.push",
  "git.merge_request.opened",
  "git.merge_request.updated",
  "git.merge_request.comments",
  "git.merge_request.merged",
  "git.merge_request.closed",
  "git.checks.failed",
  "task.finished",
  "task.failed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Where an event happens: on a project's git remote, or in JaiRA. */
export type EventGroup = "git" | "task";

/** Whether a string is one of {@link EVENT_NAMES}. */
export function isEventName(name: unknown): name is EventName {
  return typeof name === "string" && (EVENT_NAMES as readonly string[]).includes(name);
}

/** The group an event belongs to — its name's first segment, which is the same thing said once. */
export function eventGroupOf(name: EventName): EventGroup {
  return name.startsWith("git.") ? "git" : "task";
}

// --- the payloads ---------------------------------------------------------------------------------

/** What every `git.*` event carries: which remote it happened on, and the connection that saw it. */
export interface GitEventBase {
  /** The git remote's name in the project's `.git/config` — `origin`, `upstream`. */
  remote: string;
  /** The name of the connection (Settings → Connections → Forges) its host picked. */
  connection: string;
  /** The forge host — `github.com`, `gitlab.example.org`. */
  host: string;
  /** The project's path on the host: `owner/repo`, `group/sub/project`. */
  repository: string;
}

/** One commit a push brought. */
export interface EventCommit {
  sha: string;
  /** The whole message — subject, blank line, body. */
  message: string;
  /** Who wrote it, as the forge names them (a login when it knows one, else the commit's name). */
  author: string;
}

/**
 * The `before` of a push that created its branch — git's own convention, and the forges' webhooks',
 * so a workflow written against either reads it the same way.
 */
export const NEW_BRANCH_SHA = "0000000000000000000000000000000000000000";

export interface GitPushPayload extends GitEventBase {
  /** The branch's short name — `main`, `release/2.0`, never `refs/heads/…`. */
  branch: string;
  /** The head the watcher last saw; {@link NEW_BRANCH_SHA} when the branch is new to it. */
  before: string;
  /** The head now. */
  after: string;
  /** The commits in `before..after`, oldest first — the last is `after`. */
  commits: EventCommit[];
}

/** A merge request's state, as one word for both forges (a GitHub pull request is one too). */
export type EventMergeRequestState = "open" | "closed" | "merged";

/** A merge request, as much as a workflow needs to act on it or link to it. */
export interface EventMergeRequest {
  number: number;
  title: string;
  state: EventMergeRequestState;
  /** Who opened it, by login. */
  author: string;
  source_branch: string;
  target_branch: string;
  /** The source branch's head as the forge reports it. */
  head_sha: string;
  url: string;
}

export interface GitMergeRequestPayload extends GitEventBase {
  merge_request: EventMergeRequest;
}

/** Where on the diff a comment is anchored. */
export interface EventCommentAnchor {
  path: string;
  line: number;
  side: "before" | "after";
}

/** One comment on a merge request. */
export interface EventComment {
  id: string;
  author: string;
  body: string;
  /** ISO 8601. */
  created_at: string;
  /** The thread it belongs to, when the forge threads comments. */
  thread_id?: string;
  /** Where on the diff it is anchored — absent for a comment on the request as a whole. */
  anchor?: EventCommentAnchor;
}

/** ONE event however many comments arrived (decision 0010 §2) — each is an element of `comments`. */
export interface GitMergeRequestCommentsPayload extends GitMergeRequestPayload {
  /** Oldest first. */
  comments: EventComment[];
}

/** One check run or pipeline job that did not pass. */
export interface EventCheck {
  name: string;
  /** The forge's word for how it ended — `failure`, `failed`, `timed_out`, `canceled`. */
  conclusion: string;
  /** Its page on the forge, when it has one. */
  url?: string;
}

export interface GitChecksFailedPayload extends GitEventBase {
  /** The branch the checks ran for, by its short name. */
  ref: string;
  /** The commit they ran on. */
  sha: string;
  /** The checks that failed — only those. */
  checks: EventCheck[];
}

/** What every `task.*` event carries. */
export interface TaskEventPayload {
  task_id: string;
  title: string;
  /** The task's workflow, as the task names it — `feature/plan`. */
  workflow: string;
  /** How it ended — `completed` for `task.finished`, `failed` for `task.failed`. */
  status: TaskStatus;
}

/** Each event's payload, by name. */
export interface EventPayloads {
  "git.push": GitPushPayload;
  "git.merge_request.opened": GitMergeRequestPayload;
  "git.merge_request.updated": GitMergeRequestPayload;
  "git.merge_request.comments": GitMergeRequestCommentsPayload;
  "git.merge_request.merged": GitMergeRequestPayload;
  "git.merge_request.closed": GitMergeRequestPayload;
  "git.checks.failed": GitChecksFailedPayload;
  "task.finished": TaskEventPayload;
  "task.failed": TaskEventPayload;
}

/** One event as it is delivered — its name, and the payload that name carries. Narrows on `name`. */
export type JairaEvent = { [N in EventName]: { name: N; payload: EventPayloads[N] } }[EventName];

// --- the payloads' schemas ------------------------------------------------------------------------

type Schema = Record<string, JsonValue>;

const text = (title: string, description: string, extra: Schema = {}): Schema => ({ type: "string", title, description, ...extra });

const object = (properties: Record<string, Schema>, optional: readonly string[] = []): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});

const GIT_BASE_PROPERTIES: Record<string, Schema> = {
  remote: text("remote", "The git remote's name in the project's .git/config — origin, upstream."),
  connection: text("connection", "The connection (Settings → Connections → Forges) the remote's host picked."),
  host: text("host", "The forge host — github.com, gitlab.example.org."),
  repository: text("repository", "The project's path on the host: owner/repo, group/sub/project."),
};

const COMMIT_SCHEMA: Schema = object({
  sha: text("sha", "The commit's id."),
  message: text("message", "The whole message — subject, blank line, body."),
  author: text("author", "Who wrote it, as the forge names them."),
});

const MERGE_REQUEST_SCHEMA: Schema = {
  ...object({
    number: { type: "integer", title: "number", description: "The request's number on the forge — !12, #12." },
    title: text("title", "The request's title."),
    state: text("state", "open, closed or merged.", { enum: ["open", "closed", "merged"] }),
    author: text("author", "Who opened it, by login."),
    source_branch: text("source branch", "The branch it asks to merge."),
    target_branch: text("target branch", "The branch it asks to merge into."),
    head_sha: text("head sha", "The source branch's head as the forge reports it."),
    url: text("url", "The request's page on the forge."),
  }),
  title: "merge request",
  description: "The merge request (a GitHub pull request is one too).",
};

const COMMENT_SCHEMA: Schema = object(
  {
    id: text("id", "The comment's id on the forge."),
    author: text("author", "Who wrote it, by login."),
    body: text("body", "What it says, as markdown.", { contentMediaType: "text/markdown" }),
    created_at: text("created at", "When it was written — ISO 8601."),
    thread_id: text("thread", "The thread it belongs to, when the forge threads comments."),
    anchor: {
      ...object({
        path: text("path", "The file, relative to the repository."),
        line: { type: "integer", title: "line", description: "The line on that side of the diff." },
        side: text("side", "before or after — which side of the diff the line is on.", { enum: ["before", "after"] }),
      }),
      title: "anchor",
      description: "Where on the diff the comment is anchored — absent for one on the request as a whole.",
    },
  },
  ["thread_id", "anchor"],
);

const CHECK_SCHEMA: Schema = object(
  {
    name: text("name", "The check run or pipeline job."),
    conclusion: text("conclusion", "The forge's word for how it ended — failure, failed, timed_out, canceled."),
    url: text("url", "Its page on the forge."),
  },
  ["url"],
);

const gitSchema = (own: Record<string, Schema>): Schema => object({ ...GIT_BASE_PROPERTIES, ...own });

const mergeRequestSchema = (own: Record<string, Schema> = {}): Schema => gitSchema({ merge_request: MERGE_REQUEST_SCHEMA, ...own });

const taskSchema = (status: TaskStatus): Schema =>
  object({
    task_id: text("task", "The task's id."),
    title: text("title", "The task's title."),
    workflow: text("workflow", "The task's workflow, as the task names it — feature/plan."),
    status: text("status", `How it ended — always ${status} here.`, { enum: [status] }),
  });

// --- the specs ------------------------------------------------------------------------------------

/**
 * The keys `on_event`'s filter takes, and what each is matched against:
 *
 *  - `branch` — a push's branch, a merge request's TARGET branch, the branch checks ran for.
 *  - `remote` — the git remote's name, on every `git.*` event.
 *  - `author` — a merge request's author on every merge request event (`comments` included: "on the
 *    requests X opened"), and the head commit's author on a push.
 *  - `source_branch`, `target_branch` — a merge request's own two branches.
 *
 * Branches and remotes match case-sensitively, as git's refs do; an author does not, as neither
 * forge's logins do.
 */
export const EVENT_FILTER_KEYS = ["branch", "remote", "author", "source_branch", "target_branch"] as const;

export type EventFilterKey = (typeof EVENT_FILTER_KEYS)[number];

/** `on_event`'s second argument: each key a glob or a list of globs. */
export type EventFilter = Partial<Record<EventFilterKey, string | readonly string[]>>;

export interface EventSpec {
  name: EventName;
  group: EventGroup;
  /** What Settings calls it — a noun phrase, sentence case. */
  label: string;
  /** One sentence: when it fires. */
  hint: string;
  /** The filter keys that mean something on it; any other key never matches. */
  filters: readonly EventFilterKey[];
  /** Whether Settings' per-event `branches` applies to it, and to which branch (the payload's). */
  branches: "branch" | "target_branch" | "ref" | undefined;
  /** The payload's JSON Schema — what `← event.x` picks are offered from, and what the lint reads. */
  schema: Schema;
}

const MERGE_REQUEST_FILTERS: readonly EventFilterKey[] = ["branch", "remote", "author", "source_branch", "target_branch"];

/** Every event's label, hint, group, filters and payload schema, by name. */
export const EVENT_SPECS: { readonly [N in EventName]: EventSpec & { name: N } } = {
  "git.push": {
    name: "git.push",
    group: "git",
    label: "Push",
    hint: "A branch's head moved on the remote — one event for everything pushed since it was last seen.",
    filters: ["branch", "remote", "author"],
    branches: "branch",
    schema: gitSchema({
      branch: text("branch", "The branch's short name — main, release/2.0."),
      before: text("before", `The head last seen; ${NEW_BRANCH_SHA} when the branch is new.`),
      after: text("after", "The head now."),
      commits: { type: "array", title: "commits", description: "The commits pushed, oldest first — the last is after.", items: COMMIT_SCHEMA },
    }),
  },
  "git.merge_request.opened": {
    name: "git.merge_request.opened",
    group: "git",
    label: "Merge request opened",
    hint: "Somebody opened a merge request on the remote.",
    filters: MERGE_REQUEST_FILTERS,
    branches: "target_branch",
    schema: mergeRequestSchema(),
  },
  "git.merge_request.updated": {
    name: "git.merge_request.updated",
    group: "git",
    label: "Merge request updated",
    hint: "An open merge request's branch moved, or its title or description changed.",
    filters: MERGE_REQUEST_FILTERS,
    branches: "target_branch",
    schema: mergeRequestSchema(),
  },
  "git.merge_request.comments": {
    name: "git.merge_request.comments",
    group: "git",
    label: "Merge request comments",
    hint: "New comments on a merge request — one event carrying every comment that arrived since the last.",
    filters: MERGE_REQUEST_FILTERS,
    branches: "target_branch",
    schema: mergeRequestSchema({
      comments: { type: "array", title: "comments", description: "The comments that arrived, oldest first.", items: COMMENT_SCHEMA },
    }),
  },
  "git.merge_request.merged": {
    name: "git.merge_request.merged",
    group: "git",
    label: "Merge request merged",
    hint: "A merge request was merged into its target branch.",
    filters: MERGE_REQUEST_FILTERS,
    branches: "target_branch",
    schema: mergeRequestSchema(),
  },
  "git.merge_request.closed": {
    name: "git.merge_request.closed",
    group: "git",
    label: "Merge request closed",
    hint: "A merge request was closed without being merged.",
    filters: MERGE_REQUEST_FILTERS,
    branches: "target_branch",
    schema: mergeRequestSchema(),
  },
  "git.checks.failed": {
    name: "git.checks.failed",
    group: "git",
    label: "Checks failed",
    hint: "The CI pipeline or check runs on a branch's head finished, and at least one failed.",
    filters: ["branch", "remote"],
    branches: "ref",
    schema: gitSchema({
      ref: text("branch", "The branch the checks ran for, by its short name."),
      sha: text("sha", "The commit they ran on."),
      checks: { type: "array", title: "checks", description: "The checks that failed — only those.", items: CHECK_SCHEMA },
    }),
  },
  "task.finished": {
    name: "task.finished",
    group: "task",
    label: "Task finished",
    hint: "A task in this project ran to its end.",
    filters: [],
    branches: undefined,
    schema: taskSchema("completed"),
  },
  "task.failed": {
    name: "task.failed",
    group: "task",
    label: "Task failed",
    hint: "A task in this project stopped on a failure nothing handled.",
    filters: [],
    branches: undefined,
    schema: taskSchema("failed"),
  },
};

// --- matching -------------------------------------------------------------------------------------

/** The values a filter key is matched against on this event; `undefined` where it has none. */
export function eventFilterValues(event: JairaEvent, key: EventFilterKey): string[] | undefined {
  if (!EVENT_SPECS[event.name].filters.includes(key)) return undefined;
  const payload = event.payload as unknown as Record<string, unknown>;
  const request = payload["merge_request"] as EventMergeRequest | undefined;
  switch (key) {
    case "remote":
      return [String(payload["remote"])];
    case "branch": {
      const field = EVENT_SPECS[event.name].branches;
      if (field === undefined) return undefined;
      return [String(field === "target_branch" ? request?.target_branch : payload[field])];
    }
    case "source_branch":
      return request === undefined ? undefined : [request.source_branch];
    case "target_branch":
      return request === undefined ? undefined : [request.target_branch];
    case "author": {
      if (request !== undefined) return [request.author];
      // A push has no author of its own; the head commit's is what "a push by X" means.
      const commits = (payload["commits"] ?? []) as EventCommit[];
      const head = commits.find((commit) => commit.sha === payload["after"]) ?? commits[commits.length - 1];
      return head === undefined ? undefined : [head.author];
    }
  }
}

/** Whether `value` matches one glob of `patterns` — a branch glob as a path glob, `*` stopping at `/`. */
export function matchesGlobs(value: string, patterns: string | readonly string[], caseInsensitive = false): boolean {
  const list = typeof patterns === "string" ? [patterns] : patterns;
  return list.some((pattern) => globToRegExp(pattern, caseInsensitive ? "i" : "").test(value));
}

/**
 * Whether an event passes `on_event`'s filter: every key given matches one of its globs. No filter,
 * or an empty one, passes everything. A key that means nothing on this event (`source_branch` on a
 * push), or that is not a filter key at all, never matches — see the module's note.
 */
export function matchesEventFilter(event: JairaEvent, filter: EventFilter | undefined): boolean {
  if (filter === undefined) return true;
  for (const [key, patterns] of Object.entries(filter) as Array<[string, string | readonly string[] | undefined]>) {
    if (patterns === undefined) continue;
    if (!(EVENT_FILTER_KEYS as readonly string[]).includes(key)) return false;
    const values = eventFilterValues(event, key as EventFilterKey);
    if (values === undefined) return false;
    const caseInsensitive = key === "author";
    if (!values.some((value) => matchesGlobs(value, patterns, caseInsensitive))) return false;
  }
  return true;
}
