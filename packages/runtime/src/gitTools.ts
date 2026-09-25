/**
 * The Git tools (decision 0010 §1): `list_merge_requests`, `read_merge_request`, `git_checks`,
 * `open_merge_request`, `git_comment`, `git_merge`, `close_merge_request`, `git_push` — and
 * `wait_git_event`, which is named in the vocabulary and served by the event hub a later step builds.
 *
 * ## Which forge
 *
 * The WORKSPACE's own git remote picks it, as it picks it for the review primitives (`remote.ts`):
 * the remote's configured url → `parseRemoteUrl` → `connectionForHost`. The remote is the one the
 * call names, else the repository's only one, else `origin`. Nothing about where is typed: a call
 * whose host has no connection signed in is refused with the sentence Settings shows — "no connection
 * for github.com — sign in on Connections".
 *
 * ## What leaves the machine
 *
 * A push leaves the machine, so `git_push` and `open_merge_request` pass the SAME publish question
 * the review primitives do — `functions.review_artifacts.publish`, asked at most once per task
 * ({@link PublishAuthorizer}) — on top of the tool's own permission mode. A comment, a merge and a
 * close are decided by the tool's mode alone, as `remote_comment`/`remote_merge`/`remote_close` are.
 *
 * `git_push` pushes with the CONNECTION's token, not whatever git would have found: the token is
 * handed to git as an `Authorization` header through `GIT_CONFIG_*` environment variables — never an
 * argument, which a process list shows and a job row records — and the push goes to the project's
 * https url, so a remote configured over ssh still pushes as the connection. Never `--force`.
 *
 * Like every tool here a refusal is RETURNED — `{ error }` — never thrown: the model reads it and
 * says so, or supplies what was missing and calls again.
 */
import type { ExecServices, Tool } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import {
  FORGE_LABELS,
  handleOfSummary,
  parseRemoteUrl,
  type ForgeAnchor,
  type JairaIntegrationsConfig,
  type MergeRequestQuery,
  type MergeRequestSummary,
  type RemoteHandle,
  type RemoteLocation,
} from "@jaira/shared";
import type { Exec } from "./exec";
import { forgeAccess, NoForgeConnection, type ForgeAccess, type ForgeHttp } from "./forge";
import { Git } from "./git";
import { isWslEnv, type ExecEnv } from "./paths";
import { PublishRefusal, type PublishAuthorizer, type PublishRequest } from "./remote";
import type { SecretResolver } from "./secrets";

export const GIT_TOOL_NAMES = [
  "list_merge_requests",
  "read_merge_request",
  "git_checks",
  "open_merge_request",
  "git_comment",
  "git_merge",
  "close_merge_request",
  "git_push",
] as const;

/** What serves the tools: a workspace's git, the connections, and the publish question. */
export interface GitToolHost {
  /** Why nothing here can serve them — every call answers it. Absent: served. */
  readonly unserved?: string;
  /** The task the tools serve — named on the publish question. */
  readonly taskId: string;
  /** The workspace a call acts in when its own context names none. */
  readonly workspaceRoot?: string;
  /** Git over a directory, through the project's exec — a WSL project uses the distro's git. */
  git(dir: string): Git;
  /** Where git runs, for handing it the push credentials. */
  readonly execEnv?: ExecEnv;
  /** The connection for a host: its provider and token. Throws {@link NoForgeConnection} when there is none. */
  forge(host: string): ForgeAccess;
  /** `functions.review_artifacts.publish`. Throws {@link PublishRefusal}; `request` is built only when somebody is asked. */
  authorizePublish(request: () => Promise<PublishRequest>): Promise<void>;
}

/** What {@link workspaceGitHost} is built from — what the review primitives are built from. */
export interface WorkspaceGitOptions {
  taskId: string;
  workspaceRoot: string;
  exec: Exec;
  execEnv?: ExecEnv;
  integrations: JairaIntegrationsConfig;
  secrets: SecretResolver;
  http?: ForgeHttp;
  /** The run's publish question — `RemotePrimitives.publishing` where a run has them, so both ask once. */
  publishing: Pick<PublishAuthorizer, "authorize">;
}

/** The host a run or a typed turn lends the tools. */
export function workspaceGitHost(options: WorkspaceGitOptions): GitToolHost {
  return {
    taskId: options.taskId,
    workspaceRoot: options.workspaceRoot,
    ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}),
    git: (dir) => new Git({ exec: options.exec, repoDir: dir, ...(options.execEnv !== undefined ? { execEnv: options.execEnv } : {}) }),
    forge: (host) => forgeAccess(options.integrations, host, { secrets: options.secrets, ...(options.http !== undefined ? { http: options.http } : {}) }),
    authorizePublish: (request) => options.publishing.authorize(request),
  };
}

/** A host for a place that has none: the names resolve, and every call answers why it cannot be served. */
export function noGitToolHost(where = "here"): GitToolHost {
  const unserved = `the Git tools are not served ${where} — they need a task's workspace and the forge connections`;
  const refuse = (): never => {
    throw new Error(unserved);
  };
  return { unserved, taskId: "", git: refuse, forge: refuse, authorizePublish: refuse };
}

/** A sentence for the model, returned as the call's `{ error }`. */
class GitToolRefusal extends Error {}

const record = (input: unknown): Record<string, unknown> => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

/** The forge a call reaches: the remote, where it points, and the connection that answers there. */
interface Reached {
  git: Git;
  remote: string;
  url: string;
  location: RemoteLocation;
  access: ForgeAccess;
}

/** The last lines git wrote, for a sentence — never the whole of a push's chatter. */
const lastLines = (error: unknown): string =>
  ((error as Error).message ?? String(error))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-2)
    .join(" ");

const REMOTE_PROPERTY = {
  remote: { type: "string", description: "The git remote whose forge to use. Absent: the repository's only remote, else `origin`." },
} as const;

const NUMBER_PROPERTY = { number: { type: "integer", minimum: 1, description: "The merge request's number (GitLab's !iid, GitHub's #number)." } } as const;

/** The eight served tools over one host, by name. */
export function createGitTools(host: GitToolHost): Record<string, Tool> {
  /** The workspace's repository and the forge its remote picks — or a refusal. */
  const reach = async (args: Record<string, unknown>, ctx: ExecServices | undefined): Promise<Reached> => {
    if (host.unserved !== undefined) throw new GitToolRefusal(host.unserved);
    const root = ctx?.workspace?.root ?? host.workspaceRoot;
    if (root === undefined) throw new GitToolRefusal("this call has no workspace, so there is no repository whose forge to reach");
    const git = host.git(root);
    const remotes = ((await git.tryRun(["remote"])) ?? "").split(/\r?\n/).map((r) => r.trim()).filter((r) => r.length > 0);
    const named = text(args["remote"]);
    let remote: string;
    if (named !== undefined) {
      if (!remotes.includes(named)) throw new GitToolRefusal(`this repository has no git remote called '${named}' — it has ${remotes.join(", ") || "none"}`);
      remote = named;
    } else if (remotes.length === 1) {
      remote = remotes[0]!;
    } else if (remotes.includes("origin")) {
      remote = "origin";
    } else {
      throw new GitToolRefusal(
        remotes.length === 0
          ? "this workspace is not a git repository with a remote — there is no forge to reach"
          : `this repository has ${remotes.length} git remotes (${remotes.join(", ")}) and none is origin — say which with \`remote\``,
      );
    }
    const url = (await git.tryRun(["config", "--get", `remote.${remote}.url`])) ?? "";
    const location = parseRemoteUrl(url);
    if (location === undefined) {
      throw new GitToolRefusal(`the git remote '${remote}' is not on a forge (${url || "it has no url"}) — the Git tools need GitLab or GitHub behind it`);
    }
    let access: ForgeAccess;
    try {
      access = host.forge(location.host);
    } catch (e) {
      // The sentence Settings shows (decision 0010 §1): whatever is missing — the connection, its
      // token, or it being on — the fix is the same place.
      if (e instanceof NoForgeConnection) throw new GitToolRefusal(`no connection for ${location.host} — sign in on Connections`);
      throw e;
    }
    return { git, remote, url, location, access };
  };

  /** A request by number, as a handle the provider's calls take. */
  const requestOf = async (at: Reached, number: unknown): Promise<{ handle: RemoteHandle; summary: MergeRequestSummary }> => {
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new GitToolRefusal("name the merge request: `number`");
    const summary = await at.access.provider.mergeRequest(at.location.project, number);
    return { handle: handleOfSummary(at.access.provider.kind, at.location.host, at.location.project, summary), summary };
  };
  const handleOf = async (at: Reached, number: unknown): Promise<RemoteHandle> => (await requestOf(at, number)).handle;

  const currentBranch = async (git: Git): Promise<string> => {
    const branch = await git.currentBranch();
    if (branch === undefined) throw new GitToolRefusal("the workspace is not on a branch (a detached HEAD) — there is no branch to push");
    return branch;
  };

  /** The branch a request targets when the call names none: the remote's default, else `main`. */
  const defaultTarget = async (at: Reached): Promise<string> => {
    const head = await at.git.tryRun(["symbolic-ref", "--short", `refs/remotes/${at.remote}/HEAD`]);
    return head !== undefined && head.startsWith(`${at.remote}/`) ? head.slice(at.remote.length + 1) : "main";
  };

  /** Ask the publish question about this push. */
  const authorize = async (at: Reached, branch: string, target: string, question: string, confirmLabel: string): Promise<void> => {
    try {
      await host.authorizePublish(async () => {
        const identity = await at.git.identity();
        const who = await at.access.provider.whoami().catch(() => undefined);
        return {
          taskId: host.taskId,
          provider: at.access.provider.kind,
          to: `${at.remote} · ${at.location.host}/${at.location.project}`,
          host: at.location.host,
          project: at.location.project,
          branch,
          target,
          commitsAs: identity.name !== undefined ? `${identity.name} (git config)` : "whoever git config names",
          ...(who !== undefined ? { openedBy: `@${who.login}` } : {}),
          question,
          confirmLabel,
        };
      });
    } catch (e) {
      throw e instanceof PublishRefusal ? new GitToolRefusal(e.message) : e;
    }
  };

  /**
   * Push a local branch to its namesake on the forge, as the connection — a fast-forward or a
   * refusal. The remote-tracking ref is moved after, as a push by remote name would have moved it.
   */
  const push = async (at: Reached, branch: string): Promise<string> => {
    const head = await at.git.revParse(`refs/heads/${branch}`);
    if (head === undefined) throw new GitToolRefusal(`there is no local branch '${branch}' to push`);
    const pushUrl = /^https?:\/\//i.test(at.url) ? at.url : `https://${at.location.host}/${at.location.project}.git`;
    try {
      await at.git.run(["push", pushUrl, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 120_000, env: pushCredentials(at.access, pushUrl, host.execEnv) });
    } catch (e) {
      throw new GitToolRefusal(`the push of ${branch} to ${at.location.host}/${at.location.project} was refused — ${lastLines(e)}`);
    }
    await at.git.tryRun(["update-ref", `refs/remotes/${at.remote}/${branch}`, head]);
    return head;
  };

  /** Run a tool body; every refusal and forge error comes back as `{ error }`, never thrown. */
  const tool = (name: string, spec: Omit<Tool, "run">, body: (args: Record<string, unknown>, ctx: ExecServices | undefined) => Promise<unknown>): Tool => ({
    ...spec,
    run: async (input, ctx) => {
      // Before the arguments: nothing about a call here can be answered but that.
      if (host.unserved !== undefined) return { error: host.unserved };
      try {
        return (await body(record(input), ctx)) as JsonValue;
      } catch (e) {
        if (e instanceof GitToolRefusal) return { error: e.message };
        return { error: `${name}: ${(e as Error).message ?? String(e)}` };
      }
    },
  });

  const repository = (at: Reached): string => `${at.location.host}/${at.location.project}`;

  return {
    list_merge_requests: tool(
      "list_merge_requests",
      {
        description:
          "List this repository's merge requests (pull requests on GitHub) on its forge, newest update first: number, title, state, author, source and target branch, head commit, last update, link. Open ones unless `state` says otherwise.",
        inputSchema: {
          type: "object",
          properties: {
            state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Which: `open` (the default), `closed` without merging, `merged`, or `all`." },
            author: { type: "string", description: "Only those opened by this login." },
            source_branch: { type: "string", description: "Only those from this branch." },
            target_branch: { type: "string", description: "Only those into this branch." },
            updated_since: { type: "string", description: "An ISO time: only those updated after it." },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many (20 when absent)." },
            ...REMOTE_PROPERTY,
          },
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const state = args["state"];
        if (state !== undefined && !["open", "closed", "merged", "all"].includes(state as string)) throw new GitToolRefusal("`state` is one of open, closed, merged, all");
        const query: MergeRequestQuery = {
          ...(state !== undefined ? { state: state as NonNullable<MergeRequestQuery["state"]> } : {}),
          ...(text(args["author"]) !== undefined ? { author: text(args["author"])! } : {}),
          ...(text(args["source_branch"]) !== undefined ? { sourceBranch: text(args["source_branch"])! } : {}),
          ...(text(args["target_branch"]) !== undefined ? { targetBranch: text(args["target_branch"])! } : {}),
          ...(text(args["updated_since"]) !== undefined ? { updatedSince: text(args["updated_since"])! } : {}),
          ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
        };
        return { repository: repository(at), merge_requests: await at.access.provider.listMergeRequests(at.location.project, query) };
      },
    ),

    read_merge_request: tool(
      "read_merge_request",
      {
        description:
          "Read one merge request: its title, description, state and branches; its review threads (each with its id — what `git_comment` replies in — where it sits in the diff, and whether it is resolved); its general comments; its approvals and requests for changes; and the CI checks of its head commit.",
        inputSchema: { type: "object", properties: { ...NUMBER_PROPERTY, ...REMOTE_PROPERTY }, required: ["number"] } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const { handle, summary } = await requestOf(at, args["number"]);
        const provider = at.access.provider;
        const [state, checks] = await Promise.all([provider.read(handle), provider.checks(at.location.project, handle.head).catch((e: Error) => ({ error: e.message }))]);
        return {
          repository: repository(at),
          merge_request: summary,
          state: state.state,
          draft: state.draft,
          head: state.head,
          ...(state.mergeCommit !== undefined ? { merge_commit: state.mergeCommit } : {}),
          ...(state.closedBy !== undefined ? { closed_by: state.closedBy } : {}),
          reviews: state.reviews,
          threads: state.threads,
          comments: state.comments,
          checks,
        };
      },
    ),

    git_checks: tool(
      "git_checks",
      {
        description:
          "The CI state of a branch or commit on the forge — GitHub's check runs and commit statuses, GitLab's newest pipeline and its jobs: each run's name, status, conclusion and link, and what they come to (`none`, `pending`, `success`, `failure`). The workspace's current branch when `ref` is absent.",
        inputSchema: {
          type: "object",
          properties: { ref: { type: "string", description: "A branch name or a commit sha. Absent: the current branch." }, ...REMOTE_PROPERTY },
        } as unknown as Tool["inputSchema"],
        readOnly: true,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const ref = text(args["ref"]) ?? (await at.git.currentBranch()) ?? (await at.git.head());
        if (ref === undefined) throw new GitToolRefusal("name the branch or commit: `ref`");
        return { repository: repository(at), ...(await at.access.provider.checks(at.location.project, ref)) };
      },
    ),

    open_merge_request: tool(
      "open_merge_request",
      {
        description:
          "Push the workspace's current branch (or `branch`) to the forge with the connection's credentials, and open its merge request into `target` — or, when one is already open for the branch, return that one, now carrying the pushed commits. Commit first: only commits are pushed. Asks the person first unless this project lets its tasks publish.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "The request's title. Absent: the last commit's subject." },
            description: { type: "string", description: "The request's description, in markdown." },
            target: { type: "string", description: "The branch to merge into. Absent: the remote's default branch." },
            branch: { type: "string", description: "The local branch to push and open from. Absent: the current branch." },
            draft: { type: "boolean", description: "Open it as a draft." },
            ...REMOTE_PROPERTY,
          },
        } as unknown as Tool["inputSchema"],
        readOnly: false,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const branch = text(args["branch"]) ?? (await currentBranch(at.git));
        const target = text(args["target"]) ?? (await defaultTarget(at));
        if (branch === target) throw new GitToolRefusal(`the branch to open from is ${target} itself — a merge request needs a branch of its own`);
        const forge = FORGE_LABELS[at.access.provider.kind];
        await authorize(at, branch, target, `Push ${branch} to ${forge.name} and open a ${forge.request} into ${target}?`, "Push and open");
        const pushed = await push(at, branch);
        const title = text(args["title"]) ?? (await at.git.tryRun(["log", "-1", "--format=%s", `refs/heads/${branch}`])) ?? branch;
        const handle = await at.access.provider.open({
          host: at.location.host,
          project: at.location.project,
          branch,
          target,
          title,
          description: typeof args["description"] === "string" ? args["description"] : "",
          draft: args["draft"] === true,
        });
        return { repository: repository(at), merge_request: { ...handle, head: pushed }, pushed };
      },
    ),

    git_comment: tool(
      "git_comment",
      {
        description:
          "Comment on a merge request: on the request as a whole, on a line of its diff (`path` and `line`, and `side: \"before\"` for a line the change removed), or as a reply in a thread (`thread`, the id `read_merge_request` gives), resolving the thread with `resolve: true`. The comment is posted as the connection's account.",
        inputSchema: {
          type: "object",
          properties: {
            ...NUMBER_PROPERTY,
            body: { type: "string", description: "What to say, in markdown." },
            thread: { type: "string", description: "Reply in this thread instead of starting a new comment." },
            resolve: { type: "boolean", description: "With `thread`: resolve it after replying." },
            path: { type: "string", description: "Comment on a line of this file in the diff." },
            line: { type: "integer", minimum: 1, description: "With `path`: the line." },
            side: { type: "string", enum: ["after", "before"], description: "With `path`: `after` (the default) for the changed file, `before` for a line the change removed." },
            ...REMOTE_PROPERTY,
          },
          required: ["number", "body"],
        } as unknown as Tool["inputSchema"],
        readOnly: false,
      },
      async (args, ctx) => {
        const body = text(args["body"]);
        if (body === undefined) throw new GitToolRefusal("say something: `body` is empty");
        const at = await reach(args, ctx);
        const handle = await handleOf(at, args["number"]);
        const thread = text(args["thread"]);
        if (thread !== undefined) {
          await at.access.provider.reply(handle, thread, body, args["resolve"] === true);
          return { ok: true, merge_request: handle.id, thread, ...(args["resolve"] === true ? { resolved: true } : {}) };
        }
        const path = text(args["path"]);
        let anchor: ForgeAnchor | undefined;
        if (path !== undefined) {
          if (typeof args["line"] !== "number") throw new GitToolRefusal("a comment on a file needs its `line`");
          anchor = { path, line: args["line"], side: args["side"] === "before" ? "before" : "after" };
        }
        await at.access.provider.comment(handle, body, anchor);
        return { ok: true, merge_request: handle.id };
      },
    ),

    git_merge: tool(
      "git_merge",
      {
        description: "Merge a merge request on the forge, as the connection's account. Refused, with why, when the forge will not merge it now — a failing check, a missing approval, a conflict.",
        inputSchema: { type: "object", properties: { ...NUMBER_PROPERTY, ...REMOTE_PROPERTY }, required: ["number"] } as unknown as Tool["inputSchema"],
        readOnly: false,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const handle = await handleOf(at, args["number"]);
        await at.access.provider.merge(handle);
        // What landed is the forge's to say: a squash or a merge commit is not the head.
        const state = await at.access.provider.read(handle).catch(() => undefined);
        return { ok: true, merge_request: handle.id, merged: true, ...(state?.mergeCommit !== undefined ? { merge_commit: state.mergeCommit } : {}) };
      },
    ),

    close_merge_request: tool(
      "close_merge_request",
      {
        description: "Close a merge request without merging it, as the connection's account.",
        inputSchema: { type: "object", properties: { ...NUMBER_PROPERTY, ...REMOTE_PROPERTY }, required: ["number"] } as unknown as Tool["inputSchema"],
        readOnly: false,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const handle = await handleOf(at, args["number"]);
        await at.access.provider.close(handle);
        return { ok: true, merge_request: handle.id, closed: true };
      },
    ),

    git_push: tool(
      "git_push",
      {
        description:
          "Push the workspace's current branch (or `branch`) to the branch of the same name on the forge, with the connection's credentials. Only commits are pushed, and never by force: a push the forge refuses as not a fast-forward comes back as an error. Asks the person first unless this project lets its tasks publish.",
        inputSchema: {
          type: "object",
          properties: { branch: { type: "string", description: "The local branch to push. Absent: the current branch." }, ...REMOTE_PROPERTY },
        } as unknown as Tool["inputSchema"],
        readOnly: false,
      },
      async (args, ctx) => {
        const at = await reach(args, ctx);
        const branch = text(args["branch"]) ?? (await currentBranch(at.git));
        await authorize(at, branch, branch, `Push ${branch} to ${FORGE_LABELS[at.access.provider.kind].name}?`, "Push");
        const head = await push(at, branch);
        return { ok: true, repository: repository(at), branch, head };
      },
    ),
  };
}

/**
 * The connection's token, as git takes it for one push: an `Authorization` header on the push url's
 * origin, through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` — environment, so it is on no command line.
 *
 * Basic with the user each forge documents for a token over https (GitHub `x-access-token`, GitLab
 * `oauth2`), which both accept from a personal token and an OAuth one alike. Under WSL the variables
 * are named in `WSLENV`, the only way an environment variable crosses into the distro.
 */
export function pushCredentials(access: Pick<ForgeAccess, "token" | "connection">, pushUrl: string, execEnv?: ExecEnv): Record<string, string> {
  const user = access.connection.provider === "github" ? "x-access-token" : "oauth2";
  const url = new URL(pushUrl);
  const header = `Authorization: Basic ${Buffer.from(`${user}:${access.token}`).toString("base64")}`;
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${url.protocol}//${url.host}/.extraHeader`,
    GIT_CONFIG_VALUE_0: header,
  };
  if (execEnv !== undefined && isWslEnv(execEnv)) {
    env["WSLENV"] = [process.env["WSLENV"], "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_TERMINAL_PROMPT"].filter((part) => part !== undefined && part.length > 0).join(":");
  }
  return env;
}

/** Register the eight served Git tools — over `host`, or over {@link noGitToolHost} where there is none. */
export function registerGitTools(registry: { tools: Map<string, Tool> }, host: GitToolHost = noGitToolHost()): void {
  for (const [name, tool] of Object.entries(createGitTools(host))) registry.tools.set(name, tool);
}
