/**
 * A forge, as JaiRA sees one (decision 0004 §1): the wire shapes of the integration layer.
 *
 * Here rather than in `@jaira/runtime` for the reason `executors.ts` is: the renderer has to name
 * these — a gate draws a {@link RemoteHandle}, Settings draws a connection's check — and `runtime` is
 * Node-only. The behaviour (HTTP, the providers, the poller) lives there; this file is types, the
 * `integrations` block of `settings.json`, and the two pure functions both sides need.
 *
 * The word is **merge request** throughout. On GitHub it is a pull request; that difference is the
 * provider's business and nothing above the provider says it.
 */
import type { SecretOrigin } from "./executors";

/** The providers that exist. A provider is CODE — the only place that knows an endpoint. */
export const FORGE_PROVIDERS = ["gitlab", "github"] as const;
export type ForgeProviderKind = (typeof FORGE_PROVIDERS)[number];

/** How each provider is written in a sentence, and what it calls the thing JaiRA opens. */
export const FORGE_LABELS: Record<ForgeProviderKind, { name: string; request: string; sigil: string }> = {
  gitlab: { name: "GitLab", request: "merge request", sigil: "!" },
  github: { name: "GitHub", request: "pull request", sigil: "#" },
};

// --- configuration ------------------------------------------------------------------------------

/**
 * One connection: `{ provider, host, token }`, one per host.
 *
 * `credential` NAMES the token and never holds it — `settings.json` is committed source, and the
 * value is looked up through the secret chain at the moment it is needed (`runtime/secrets.ts`).
 * Nothing here is an identity: commits are authored by `git config`, and the request and every
 * comment belong to whoever owns the token.
 */
export interface JairaForgeConnection {
  provider: ForgeProviderKind;
  /** The host as a git remote spells it — `gitlab.com`, `git.example.org`. Lower-cased, no scheme. */
  host: string;
  /** The secret's NAME. Absent ⇒ the connection cannot call the API (GitLab can still push-to-open). */
  credential?: string;
  /** `false` turns the connection off without deleting it. Absent means on. */
  enabled?: boolean;
  /**
   * Where the API is, when it is not where the provider's convention puts it.
   *
   * Absent is right for gitlab.com, github.com, a self-hosted GitLab (`https://<host>/api/v4`) and a
   * GitHub Enterprise Server (`https://<host>/api/v3`). It exists for a host behind a path prefix or
   * a different port, which the git remote's host alone cannot say.
   */
  apiUrl?: string;
  /**
   * The client ID of the OAuth app a sign-in through the browser goes through (RFC 8628's device
   * flow) — an app registered on THIS host, which is why it is the connection's and not the
   * provider's: an app on a self-hosted GitLab means nothing to gitlab.com.
   *
   * Only the ID: a device flow is a PUBLIC client — one that cannot keep a secret, which a desktop
   * app is — so there is no secret to name. On GitHub the app has "Enable Device Flow" ticked; on
   * GitLab it is not confidential and allows `api`. Absent, gitlab.com and github.com use JaiRA's own
   * apps ({@link BUILTIN_OAUTH_APPS}) and any other host cannot sign in through the browser —
   * {@link oauthClientIdFor} says which is used.
   */
  oauthClientId?: string;
}

export interface JairaIntegrationsConfig {
  /** Connections by NAME — a name and not the host, because a host has dots and a config path splits on them. */
  forges: Record<string, JairaForgeConnection>;
}

/**
 * JaiRA's own OAuth apps, one per public forge, used for the device flow when no layer names another
 * (registered 2026-09-23). Only the client IDs: a device flow is a public client, and a secret
 * shipped inside a desktop app is not a secret — neither forge asks for one on this flow.
 *
 * GitHub's is a GitHub App (id 5053987), so its token acts only in repositories the app is INSTALLED
 * on, and carries its permissions rather than scopes. GitLab's allows `api`, which is what JaiRA asks.
 * Each is registered on its public host and means nothing to a self-hosted instance.
 */
export const BUILTIN_OAUTH_APPS: Record<ForgeProviderKind, { host: string; clientId: string }> = {
  github: { host: "github.com", clientId: "Iv23liJYmSQiRIpe6dPS" },
  gitlab: { host: "gitlab.com", clientId: "3324ddfef98706458b7a650cc4c26e8f406c9c486bc46679fc06c24c6a26c963" },
};

/**
 * The client ID a sign-in to this connection goes through: the one the connection names, else
 * JaiRA's own when the connection is the public host that app is registered on. Absent ⇒ none, and a
 * sign-in says what to set.
 */
export function oauthClientIdFor(connection: Pick<JairaForgeConnection, "provider" | "host" | "oauthClientId">): string | undefined {
  if (connection.oauthClientId !== undefined) return connection.oauthClientId;
  const builtIn = BUILTIN_OAUTH_APPS[connection.provider];
  return connection.host === builtIn.host ? builtIn.clientId : undefined;
}

/** The window the decision names; what `functions.review_artifacts.settleAfter` is when nobody set it. */
export const DEFAULT_SETTLE_AFTER = "10m";

/**
 * The two connections every install has, named for their provider.
 *
 * Built in rather than added by hand for the reason the built-in executors are: almost every project
 * is on one of these two hosts, and a screen that opens empty asks the person to know a host, a kind
 * and a conventional variable name before it can tell them anything. A layer overrides a field of
 * one, or turns it off; "another host" adds a third under a name of its own.
 */
export const BUILTIN_FORGES: Record<string, JairaForgeConnection> = {
  gitlab: { provider: "gitlab", host: "gitlab.com", credential: "GITLAB_TOKEN" },
  github: { provider: "github", host: "github.com", credential: "GITHUB_TOKEN" },
};

export function defaultIntegrations(): JairaIntegrationsConfig {
  return { forges: structuredClone(BUILTIN_FORGES) };
}

/** What `functions.review_artifacts.publish` may be set to — see {@link PUBLISH_MODE_LABELS}. */
export const PUBLISH_MODES = ["ask", "allow", "deny"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** A push and a merge request leave the machine, so the default is to ask — once per task. */
export const DEFAULT_PUBLISH_MODE: PublishMode = "ask";

export const PUBLISH_MODE_LABELS: Record<PublishMode, string> = {
  ask: "Ask once per task",
  allow: "Allow",
  deny: "Never",
};

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/;

/**
 * Parse the `integrations` block.
 *
 * Strict about what is PRESENT, like every block in `parseConfig`: a mis-spelled `credental` is a
 * connection that silently has no token, and the symptom — "cannot watch" — points nowhere near the
 * typo. The built-ins are laid under what was written, so a layer states only what it changes.
 */
export function parseIntegrations(raw: unknown): JairaIntegrationsConfig {
  const out = defaultIntegrations();
  if (raw === undefined) return out;
  const block = objectAt(raw, "config.integrations");
  onlyFields(block, ["forges"], "config.integrations");

  if (block["forges"] !== undefined) {
    for (const [name, entry] of Object.entries(objectAt(block["forges"], "config.integrations.forges"))) {
      const where = `config.integrations.forges.${name}`;
      if (!CONNECTION_NAME.test(name)) {
        throw new Error(`${where}: a connection's name is letters, digits, '-' and '_' — the host goes in its 'host' field`);
      }
      const spec = objectAt(entry, where);
      onlyFields(spec, ["provider", "host", "credential", "enabled", "apiUrl", "oauthClientId"], where);
      const merged = { ...(out.forges[name] ?? {}), ...spec } as Record<string, unknown>;

      const provider = merged["provider"];
      if (typeof provider !== "string" || !(FORGE_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(`${where}.provider must be one of ${FORGE_PROVIDERS.join(", ")}`);
      }
      const host = typeof merged["host"] === "string" ? normalizeHost(merged["host"]) : "";
      if (!HOST.test(host)) {
        throw new Error(`${where}.host must be a host name as a git remote spells it — 'gitlab.com', not a URL`);
      }
      const credential = merged["credential"];
      if (credential !== undefined && (typeof credential !== "string" || !SECRET_NAME.test(credential))) {
        throw new Error(`${where}.credential NAMES the token (like GITLAB_TOKEN) — it never holds it`);
      }
      if (merged["enabled"] !== undefined && typeof merged["enabled"] !== "boolean") {
        throw new Error(`${where}.enabled must be true or false`);
      }
      const apiUrl = merged["apiUrl"];
      if (apiUrl !== undefined && (typeof apiUrl !== "string" || !/^https?:\/\/\S+$/.test(apiUrl))) {
        throw new Error(`${where}.apiUrl must be an http(s) URL`);
      }
      const clientId = merged["oauthClientId"];
      if (clientId !== undefined && (typeof clientId !== "string" || !/^\S+$/.test(clientId))) {
        throw new Error(`${where}.oauthClientId must be the OAuth app's client ID — one word, no spaces`);
      }
      out.forges[name] = {
        provider: provider as ForgeProviderKind,
        host,
        ...(credential !== undefined ? { credential: credential as string } : {}),
        ...(merged["enabled"] === false ? { enabled: false } : {}),
        ...(apiUrl !== undefined ? { apiUrl: (apiUrl as string).replace(/\/+$/, "") } : {}),
        ...(clientId !== undefined ? { oauthClientId: clientId as string } : {}),
      };
    }
  }

  // One connection per host: the git remote's host is what PICKS the connection, so two claiming one
  // host would be a choice nothing states. Turned-off ones are counted too — off is not absent.
  const byHost = new Map<string, string>();
  for (const [name, connection] of Object.entries(out.forges)) {
    const other = byHost.get(connection.host);
    if (other !== undefined) {
      throw new Error(
        `config.integrations.forges: '${other}' and '${name}' both name the host ${connection.host} — a git remote's host picks the connection, so a host has one`,
      );
    }
    byHost.set(connection.host, name);
  }

  return out;
}

/**
 * `publish` out of an unparsed `functions.review_artifacts` block — for a reader holding a layer's raw
 * document rather than the parsed configuration. `ask` when absent or unreadable.
 */
export function publishModeOf(reviewArtifacts: unknown): PublishMode {
  const mode = reviewArtifacts !== null && typeof reviewArtifacts === "object" ? (reviewArtifacts as Record<string, unknown>)["publish"] : undefined;
  return (PUBLISH_MODES as readonly unknown[]).includes(mode) ? (mode as PublishMode) : DEFAULT_PUBLISH_MODE;
}

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function onlyFields(spec: Record<string, unknown>, allowed: string[], where: string): void {
  for (const field of Object.keys(spec)) {
    if (!allowed.includes(field)) throw new Error(`${where}.${field} is not a setting — it takes ${allowed.join(", ")}`);
  }
}

// --- two pure functions both sides need ------------------------------------------------------------

/**
 * A duration as the settings and a state's `remote` write one: `"10m"`, `"90s"`, `"2h"`, `"7d"`,
 * `"0"`. Milliseconds, or `undefined` for anything else.
 *
 * One unit per value, deliberately. `"1h30m"` is a second grammar to get wrong, and `"90m"` says it.
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2];
  // A bare number is only ever zero: `"10"` does not say ten of what.
  if (unit === undefined) return amount === 0 ? 0 : undefined;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "ms" | "s" | "m" | "h" | "d"];
  return Math.round(amount * scale);
}

/** A host as config holds one: lower-cased, no scheme, no path, no user. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/\/.*$/, "");
}

/** Where a git remote points: the host that picks the connection, and the project's path there. */
export interface RemoteLocation {
  host: string;
  /** `group/sub/project` on GitLab, `owner/repo` on GitHub — no leading slash, no `.git`. */
  project: string;
}

/**
 * Read a git remote URL — the three spellings git accepts for a network remote.
 *
 * ```text
 *   git@gitlab.com:mistlabs/jaira.git            scp-like, what `git clone` over SSH writes
 *   ssh://git@gitlab.com:2222/mistlabs/jaira.git  the same with a scheme — the port is SSH's, not the API's
 *   https://github.com/ofersadgat/JaiRA.git       https, possibly with a user before the host
 * ```
 *
 * `undefined` for a local path or a file URL: a bare repository on disk is a remote git can push to
 * and no forge, which is exactly what the tests rely on.
 */
export function parseRemoteUrl(url: string): RemoteLocation | undefined {
  const text = url.trim();
  const clean = (path: string): string => path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const schemed = /^(ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(text);
  if (schemed !== null) {
    const scheme = schemed[1]!.toLowerCase();
    // An https remote on a port IS the forge on that port; an ssh port says nothing about the API.
    const port = schemed[3] !== undefined && scheme.startsWith("http") ? `:${schemed[3]}` : "";
    const project = clean(schemed[4]!);
    return project.length > 0 ? { host: `${schemed[2]!.toLowerCase()}${port}`, project } : undefined;
  }
  // scp-like. A Windows drive (`C:\repo`, `C:/repo`) has the same colon and is a path — a host is
  // longer than one letter, and a drive never is.
  const scp = /^(?:[^@/\s]+@)?([^/:\s]{2,}):(?!\/\/)(.+)$/.exec(text);
  if (scp !== null && !/^[\\/]/.test(scp[2]!)) {
    const project = clean(scp[2]!);
    return project.length > 0 ? { host: scp[1]!.toLowerCase(), project } : undefined;
  }
  return undefined;
}

/** The connection a host picks — the enabled one naming it, else none. */
export function connectionForHost(
  integrations: JairaIntegrationsConfig,
  host: string,
): { name: string; connection: JairaForgeConnection } | undefined {
  const wanted = normalizeHost(host);
  for (const [name, connection] of Object.entries(integrations.forges)) {
    if (connection.host === wanted && connection.enabled !== false) return { name, connection };
  }
  return undefined;
}

// --- the provider's vocabulary ---------------------------------------------------------------------

/**
 * One merge request, as data (decision 0004, "The result").
 *
 * Everything a later state needs to push to the same branch, reply on the same request, or draw a
 * link — and nothing that has to be looked up to be understood. It is an ordinary JSON value on
 * purpose: it rides a function's result and crosses a task boundary by value.
 */
export interface RemoteHandle {
  /** `<host>/<project><sigil><number>` — stable for the life of the request, unique across hosts. */
  id: string;
  provider: ForgeProviderKind;
  host: string;
  project: string;
  /** The branch JaiRA pushes — the request's source. */
  branch: string;
  /** The branch the request asks to merge into. */
  target: string;
  number: number;
  url: string;
  /** The source branch's head as the forge last reported it; the merge commit once merged. */
  head: string;
}

/** The key of a request the workflow did not name — one per task. */
export const DEFAULT_REMOTE_KEY = "review";

/**
 * The branch JaiRA pushes for a request: `jaira/<task>/<key>`, the key made safe for a ref.
 *
 * It carries the task's id so two tasks never push to one branch, and the key so two `each` elements
 * of one task do not either. A scoped name's key is `name#address`; what a ref cannot hold becomes `-`.
 */
export function remoteBranchName(taskId: string, key: string): string {
  const slug = key
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-./]+|[-./]+$/g, "");
  return `jaira/${taskId}/${slug.length > 0 ? slug : DEFAULT_REMOTE_KEY}`;
}

export function remoteHandleId(provider: ForgeProviderKind, host: string, project: string, number: number): string {
  return `${host}/${project}${FORGE_LABELS[provider].sigil}${number}`;
}

/** What `open` is asked for. `open` FINDS the request already open for the branch before it creates one. */
export interface OpenRequest {
  host: string;
  project: string;
  branch: string;
  target: string;
  title: string;
  description: string;
  draft: boolean;
}

/** Whose token this is — what validating a connection learns. */
export interface ForgeIdentity {
  login: string;
  name?: string;
  /** The token's scopes, where the forge says (GitHub's `X-OAuth-Scopes`; a fine-grained PAT says none). */
  scopes?: string[];
}

/** Where a comment sits in a diff. The side is JaiRA's own word for it (`ReviewNote.side`). */
export interface ForgeAnchor {
  path: string;
  line: number;
  side: "before" | "after";
}

/** One thing somebody wrote. `canWrite` and `own` (JaiRA's marker) are the two facts "who counts" is decided from. */
export interface ForgeComment {
  id: string;
  who: string;
  body: string;
  at: string;
  /** Its own page on the forge — a link a person can open to land on this comment. */
  url?: string;
  /** Write access to the project — GitHub OWNER / MEMBER / COLLABORATOR, GitLab Developer and up. */
  canWrite: boolean;
  /**
   * JaiRA's own words: the body carries its marker (`isJairaComment`) — shown, and never an event.
   * Not "written by the token's account": that account is the person's, and so are the comments they
   * write with it on the forge (the rulings of 2026-09-25).
   */
  own: boolean;
}

/** A comment just posted: its id and link, as far as the forge answered with them. */
export interface ForgePosted {
  id?: string;
  url?: string;
}

export interface ForgeThread {
  id: string;
  /** Absent for a thread on the request as a whole that the forge still threads (GitLab does). */
  anchor?: ForgeAnchor;
  resolved: boolean;
  /** In order; the first is the thread's opening comment and the rest are its replies. */
  comments: ForgeComment[];
}

/** A review somebody SUBMITTED, or an approval somebody gave — an explicit act, never a comment. */
export interface ForgeReview {
  id: string;
  who: string;
  at: string;
  verdict: "approved" | "changes_requested";
  body?: string;
  canWrite: boolean;
  /** Its body carries JaiRA's marker. JaiRA never submits a review, so in practice never. */
  own: boolean;
}

/** Everything a settlement is decided from: truth, as one `read()` found it. */
export interface RemoteState {
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** The source branch's head on the forge. */
  head: string;
  /** Once merged: `merge_commit_sha` / `squash_commit_sha`, or GitHub's `mergeCommit`. */
  mergeCommit?: string;
  /** Who merged or closed it, where the forge says. */
  closedBy?: string;
  updatedAt: string;
  reviews: ForgeReview[];
  threads: ForgeThread[];
  /** General comments on the request — about the set, not about a line. */
  comments: ForgeComment[];
}

// --- what the Git tools and the repository watcher read (decision 0010) ------------------------------

/**
 * One merge request as a LIST shows it — any request on the project, not only one JaiRA opened.
 *
 * The fields a person scans a list by, and the ones a later call needs to reach the request again
 * (`number`) or to tell that it moved (`head`, `updatedAt`). Threads and reviews are a `read()`.
 */
export interface MergeRequestSummary {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** Who opened it — the forge's login. */
  author: string;
  sourceBranch: string;
  targetBranch: string;
  /** The source branch's head as the forge last reported it. */
  head: string;
  updatedAt: string;
  url: string;
  /** The request's description, when the forge sent one. */
  description?: string;
}

/** What `listMergeRequests` narrows by. Every field is optional; nothing means the open ones. */
export interface MergeRequestQuery {
  /** `open` when absent. */
  state?: "open" | "closed" | "merged" | "all";
  /** The login of who opened it. */
  author?: string;
  sourceBranch?: string;
  targetBranch?: string;
  /** An ISO time: only requests updated after it. */
  updatedSince?: string;
  /** At most this many, newest update first. 20 when absent; at most 100. */
  limit?: number;
}

// --- pipelines, jobs, artifacts (decision 0016) ------------------------------------------------------

/**
 * Where a pipeline or a job has got, in one vocabulary for both forges. `manual` is GitLab's: a job,
 * or a pipeline stopped at one, that runs only when somebody starts it. A GitHub job that timed out
 * or failed to start is `failed`.
 */
export type PipelineStatus = "pending" | "running" | "success" | "failed" | "canceled" | "skipped" | "manual";

export const PIPELINE_STATUSES: readonly PipelineStatus[] = ["pending", "running", "success", "failed", "canceled", "skipped", "manual"];

/**
 * Why a pipeline ran. GitLab's `source`, GitHub's run `event` — `merge_request` is GitLab's
 * `merge_request_event` and GitHub's `pull_request` — and `external` for a GitHub suite that no
 * workflow run owns (another app's checks) or a GitLab pipeline of external statuses.
 */
export type PipelineSource = "push" | "merge_request" | "schedule" | "trigger" | "api" | "web" | "external" | "other";

export const PIPELINE_SOURCES: readonly PipelineSource[] = ["push", "merge_request", "schedule", "trigger", "api", "web", "external", "other"];

/**
 * One pipeline: a GitLab pipeline, or a GitHub check suite — for Actions, the suite of one workflow
 * run. On GitHub `id` is the SUITE's id, the one id every GitHub CI result has; the workflow run's
 * id is `runId`, which is the number in its web link.
 */
export interface ForgePipeline {
  id: number;
  sha: string;
  /** The ref it ran for: a branch, a tag, or GitLab's `refs/merge-requests/<iid>/{head,merge,train}`. */
  ref: string;
  source: PipelineSource;
  /** The forge's own word for `source` — GitLab's `merge_request_event`, a GitHub app's slug. */
  sourceName: string;
  status: PipelineStatus;
  /** GitHub: the workflow's name, or the app's. GitLab: the pipeline's name, when it has one. */
  name?: string;
  /** GitHub Actions: the workflow run's id and attempt. */
  runId?: number;
  attempt?: number;
  createdAt: string;
  finishedAt?: string;
  url: string;
}

/**
 * A GitHub commit status: another CI's word on a commit, with nothing more to read than this. GitLab
 * folds these into a pipeline of source `external`; GitHub keeps them loose, so they are listed
 * beside the pipelines.
 */
export interface ForgeCommitStatus {
  sha: string;
  context: string;
  status: PipelineStatus;
  description?: string;
  url?: string;
  createdAt: string;
}

/** What `pipelines` narrows by — exactly one of `mergeRequest`, `ref`, `sha`. */
export interface PipelineQuery {
  mergeRequest?: number;
  ref?: string;
  sha?: string;
  status?: PipelineStatus;
  source?: PipelineSource;
  /** At most this many, newest first. 20 when absent; at most 100. */
  limit?: number;
}

export interface PipelineList {
  pipelines: ForgePipeline[];
  /** GitHub only: the commit statuses of the commits asked about. */
  statuses: ForgeCommitStatus[];
}

/** One job of a pipeline: a GitLab job or trigger job, a GitHub check run (for Actions, the job). */
export interface ForgeJob {
  /** GitHub: the check run's id, which for Actions IS the job's id (measured). */
  id: number;
  name: string;
  /** GitLab's stage; absent on GitHub. */
  stage?: string;
  status: PipelineStatus;
  /** GitLab's `failure_reason` — `script_failure`, `runner_system_failure`, … */
  failureReason?: string;
  /** GitLab: a failure that does not fail the pipeline. */
  allowFailure?: boolean;
  startedAt?: string;
  finishedAt?: string;
  url: string;
  /** A GitLab trigger job: the pipeline it started. */
  downstreamPipelineId?: number;
  /** Present when retried jobs were asked for: this attempt was superseded. */
  retried?: boolean;
}

/**
 * Something a job or a pipeline left, to be downloaded. The log is one: GitLab lists it as the job's
 * artifact of `fileType` `trace`, and GitHub's job log is called that here too.
 *
 * Which fields are set says how to fetch it: `jobId` + `fileType` (GitLab: every kind; GitHub: the
 * log), or `artifactId` (GitHub's uploaded artifacts, which belong to the run, not a job).
 */
export interface ForgeArtifact {
  jobId?: number;
  artifactId?: number;
  /** GitLab's `file_type` — `trace`, `archive`, `junit`, `codequality`, … — or `archive` for a GitHub upload. */
  fileType: string;
  /** The file's name, or a GitHub artifact's. */
  name: string;
  size?: number;
  expiresAt?: string;
  /** Its page on the forge, when it has one. */
  url?: string;
}

/** The counts of a GitLab pipeline's test report, per suite — each suite with the jobs that ran it. */
export interface PipelineTests {
  total: number;
  failed: number;
  skipped: number;
  errored: number;
  suites: Array<{ name: string; total: number; failed: number; skipped: number; errored: number; jobIds: number[] }>;
}

export interface PipelineDetail extends ForgePipeline {
  jobs: ForgeJob[];
  /** Artifacts that belong to the pipeline itself — GitHub's uploads. GitLab's belong to jobs. */
  artifacts: ForgeArtifact[];
  tests?: PipelineTests;
}

/** The machine a job ran on, as the forge tells it. */
export interface ForgeRunner {
  /** GitHub's runner name; GitLab's runner description. */
  name?: string;
  /** GitLab `runner_manager.platform`. */
  platform?: string;
  /** GitLab `runner_manager.architecture`. */
  architecture?: string;
  /** GitLab `runner_manager.version`. */
  version?: string;
  /** GitLab's `tag_list`; GitHub's `labels` — what the job ASKED for, `ubuntu-latest`. */
  tags: string[];
}

export interface ForgeJobStep {
  number: number;
  name: string;
  status: PipelineStatus;
  startedAt?: string;
  finishedAt?: string;
}

/** A GitHub check run annotation. */
export interface ForgeAnnotation {
  path: string;
  startLine?: number;
  endLine?: number;
  level: "notice" | "warning" | "failure";
  title?: string;
  message: string;
}

export interface JobDetail extends ForgeJob {
  pipelineId?: number;
  sha?: string;
  runner?: ForgeRunner;
  /** GitHub: the job's steps. GitLab has none in its API; its log's sections are the nearest thing. */
  steps: ForgeJobStep[];
  /** GitHub Actions: from the failure annotation "Process completed with exit code N." */
  exitCode?: number;
  annotations: ForgeAnnotation[];
  artifacts: ForgeArtifact[];
}

/**
 * With retried jobs asked for, every attempt is in the list and none says which it is: an attempt is
 * retried when a later job of the same name (and stage) exists.
 */
export function markRetried(jobs: ForgeJob[]): ForgeJob[] {
  const latest = new Map<string, number>();
  for (const job of jobs) {
    const key = `${job.stage ?? ""}\u0000${job.name}`;
    latest.set(key, Math.max(latest.get(key) ?? 0, job.id));
  }
  return jobs.map((job) => (latest.get(`${job.stage ?? ""}\u0000${job.name}`) !== job.id ? { ...job, retried: true } : job));
}

/** Which artifact to fetch — the fields a {@link ForgeArtifact} carries. */
export type ArtifactRef = { jobId: number; fileType: string; path?: string } | { artifactId: number };

/** A downloaded artifact, as bytes: a log is text, an archive a zip. */
export interface ArtifactBytes {
  bytes: Uint8Array;
  contentType?: string;
}

/** One branch on the forge. */
export interface ForgeBranch {
  name: string;
  head: string;
}

/**
 * One comment on a merge request, FLAT — what arrived, where it sits, and who wrote it.
 *
 * The flat shape of what `read()` returns threaded: a watcher asking "what was said since" wants a
 * list, and a reply wants the thread's id, which is here.
 */
export interface ForgeNote {
  id: string;
  /** The thread it is in — what `reply` takes. Absent for a general comment the forge does not thread. */
  threadId?: string;
  who: string;
  body: string;
  at: string;
  /** Where in the diff, for an inline comment. */
  anchor?: ForgeAnchor;
  /** JaiRA wrote it: the body carries its marker (`isJairaComment`). Never an event. */
  own: boolean;
}

/**
 * What a probe remembers between ticks — persisted on the `remote_handles` row, so a weekend with
 * the app closed costs one probe and loses nothing.
 */
export interface ProbeCursor {
  /** GitLab: the `updated_after` of the next list call. */
  since?: string;
  /** GitHub: the ETag of each watched request, by handle id. */
  etags?: Record<string, string>;
  /** GitHub, classic tokens: the `Last-Modified` of the last `/notifications` answer — sent back as `If-Modified-Since`. */
  notifiedAt?: string;
}

export interface Probe {
  /** The handles that MAY have moved. Truth is a `read()`; a false positive costs one. */
  moved: string[];
  cursor: ProbeCursor;
  /** The forge's own floor on the next probe (`X-Poll-Interval`, `Retry-After`), which always wins. */
  pollAfterSeconds?: number;
}

/**
 * The one interface a forge is reached through (decision 0004 §1), plus `whoami` — how a connection
 * is validated: by asking the host who the token is.
 */
export interface ForgeProvider {
  readonly kind: ForgeProviderKind;
  readonly host: string;
  whoami(): Promise<ForgeIdentity>;
  /** Create the merge request for a branch, or find the one already open for it. */
  open(request: OpenRequest): Promise<RemoteHandle>;
  /** Cheap: which of these moved? One call per host (GitLab) or one free conditional per request (GitHub). */
  probe(handles: RemoteHandle[], cursor: ProbeCursor): Promise<Probe>;
  /** Full: threads, reviews, approvals, state, head. */
  read(handle: RemoteHandle): Promise<RemoteState>;
  /** Post a comment; answers where it landed, when the forge said. */
  comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<ForgePosted | void>;
  reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<ForgePosted | void>;
  merge(handle: RemoteHandle): Promise<void>;
  close(handle: RemoteHandle): Promise<void>;

  // What the Git tools and the repository watcher read (decision 0010). Every request on the
  // project, not only the ones JaiRA opened — so these take the project, where the calls above take
  // a handle JaiRA already holds.

  /** The project's merge requests, newest update first. */
  listMergeRequests(project: string, query?: MergeRequestQuery): Promise<MergeRequestSummary[]>;
  /** One merge request by its number — what a handle is made from when only the number is known. */
  mergeRequest(project: string, number: number): Promise<MergeRequestSummary>;
  /** Every branch and its head. */
  branches(project: string): Promise<ForgeBranch[]>;
  /** The comments on one merge request, flat and in order — only those written after `since`, when given. */
  comments(handle: RemoteHandle, options?: { since?: string }): Promise<ForgeNote[]>;
  /**
   * The commits in `base..head`, oldest first — what a push brought (the forges' compare). With no
   * `base` (a branch new to the watcher), the head commit alone. Optional: a push read from a
   * provider without it carries no commits.
   */
  compare?(project: string, base: string | undefined, head: string): Promise<ForgeCommit[]>;

  // CI (decision 0016): pipelines, their jobs, and what the jobs left.

  /** The pipelines of a merge request, a ref or a commit, newest first. */
  pipelines(project: string, query: PipelineQuery): Promise<PipelineList>;
  /** One pipeline and its jobs. */
  pipeline(project: string, id: number, options?: { jobStatus?: readonly PipelineStatus[]; includeRetried?: boolean }): Promise<PipelineDetail>;
  /** One job: its machine, steps, failure and artifacts. */
  job(project: string, id: number): Promise<JobDetail>;
  /** Download one artifact. */
  artifact(project: string, which: ArtifactRef): Promise<ArtifactBytes>;
}

/** One commit, as a push event carries it. */
export interface ForgeCommit {
  sha: string;
  /** The whole message. */
  message: string;
  /** The forge's login for the author when it knows one, else the commit's author name. */
  author: string;
}

/** A request's handle, from its summary on the project — what the calls that take a handle need. */
export function handleOfSummary(provider: ForgeProviderKind, host: string, project: string, summary: MergeRequestSummary): RemoteHandle {
  return {
    id: remoteHandleId(provider, host, project, summary.number),
    provider,
    host,
    project,
    branch: summary.sourceBranch,
    target: summary.targetBranch,
    number: summary.number,
    url: summary.url,
    head: summary.head,
  };
}

/** What a connection's check found — a {@link ProbeResult}'s sibling, with who the token is. */
export interface ForgeCheck {
  /** The connection's name in `integrations.forges`. */
  name: string;
  provider: ForgeProviderKind;
  host: string;
  status: "ok" | "failed" | "unconfigured" | "disabled";
  /** One line, addressed to the user: what was found, or why it could not be. */
  detail: string;
  /** What would fix a `failed` or `unconfigured` connection, in one imperative line. */
  fix?: string;
  identity?: ForgeIdentity;
  /** Where the named token resolved from — never the value. */
  credential?: SecretOrigin;
  /** Set when the connection names a token and nothing in the chain supplies it. */
  credentialMissing?: string;
  /**
   * How the token in use got there: `oauth` when a sign-in through the browser stored it — and it is
   * still the one the chain finds — `token` for one pasted, or put in a file by hand. Absent while no
   * token resolves.
   */
  via?: "oauth" | "token";
}

// --- signing in to a forge through the browser (RFC 8628) -------------------------------------------

/**
 * A forge sign-in waiting on the person: the code they type, and the page they type it on.
 *
 * The device authorization grant, because it is the one OAuth flow a desktop app completes without a
 * redirect it would have to listen for: the forge shows a page, the person types the code there, and
 * main polls until the forge says yes, no, or too late.
 */
export interface ForgeSignInPending {
  /** The connection's name in `integrations.forges`. */
  connection: string;
  provider: ForgeProviderKind;
  host: string;
  /** What the person types on the page — `WDJB-MJHT`. Shown as the forge sent it. */
  userCode: string;
  /**
   * The page to type it on. Opened in the browser when the sign-in starts — the plain page, never
   * RFC 8628's `verification_uri_complete` with the code already in it: approving through that link
   * on gitlab.com says "Device successfully authorized" and then refuses the token (`invalid_grant`),
   * while the same code typed on the plain page signs in (measured 2026-09-25, JaiRA's app and glab's).
   */
  verificationUri: string;
  /** Epoch ms after which the code is dead, and the sign-in ends as `expired`. */
  expiresAt: number;
  /** Epoch ms the sign-in started. */
  startedAt: number;
}

/**
 * What starting a forge sign-in came to. A refusal is an ANSWER, not a rejection — no OAuth app is
 * configured, the forge refused the client id — said as one sentence, with what would fix it.
 */
export type ForgeSignInStart = { ok: true; pending: ForgeSignInPending } | { ok: false; reason: string; fix?: string };

/**
 * How a forge sign-in ended — the payload of the `forge:signInFinished` push.
 *
 * `code` says which way it failed: `denied` (the person refused on the forge's page), `expired`
 * (nobody typed the code in time), `canceled` (Cancel in JaiRA, or the app closing), and `failed` for
 * everything else, with the forge's own words in `reason`. `login` is who the stored token belongs
 * to, when the check that follows a success could say.
 */
export type ForgeSignInOutcome =
  | { ok: true; connection: string; login?: string }
  | { ok: false; connection: string; code: "denied" | "expired" | "canceled" | "failed"; reason: string };

/** What signing out of a forge came to: the token removed, or why it could not be. */
export type ForgeSignOutOutcome = { ok: true } | { ok: false; reason: string };

// --- the row a task keeps per request ---------------------------------------------------------------

/**
 * One merge request as a TASK remembers it — the `remote_handles` row (decision 0004).
 *
 * Here rather than in `@jaira/persistence` because `@jaira/runtime` reads and writes it through
 * {@link RemoteHandlePort} and cannot import the package that stores it.
 */
export interface RemoteHandleRow {
  taskId: string;
  key: string;
  provider: ForgeProviderKind;
  host: string;
  project: string;
  /** The git remote pushed to — `origin`. */
  remote: string;
  branch: string;
  target: string;
  /** Absent until the request is opened: a pushed branch is a row before it is a request. */
  number?: number;
  url?: string;
  /** The commit last pushed to `branch`. */
  pushedHead?: string;
  cursor: ProbeCursor;
  /** Ids of comments, threads' comments and reviews already folded into a settlement or shown. */
  seen: string[];
  /** Epoch ms at which a quiet window runs out. Absent ⇒ no window is running. */
  settleAt?: number;
  /** The window's length for this request, when a state's `remote` overrode the default. */
  settleAfterMs?: number;
  /** True while something is parked on this request — the ONLY rows the poller looks at. */
  awaiting: boolean;
  /** The parked gate's request id, when a gate (rather than `on_remote_event`) is what waits. */
  requestId?: string;
  /** When the forge was last read for this request, and what failed if that read failed. */
  checkedAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** What a caller may change about a row after it exists. `null` clears a nullable column. */
export interface RemoteHandlePatch {
  number?: number;
  url?: string;
  pushedHead?: string;
  target?: string;
  cursor?: ProbeCursor;
  seen?: string[];
  settleAt?: number | null;
  settleAfterMs?: number | null;
  awaiting?: boolean;
  requestId?: string | null;
  checkedAt?: number;
  lastError?: string | null;
}

/**
 * One of a task's merge requests, as the gate's remote strip draws it: where it lives, whether the
 * forge can be reached, who has spoken there, and — only while one is running — when the quiet
 * window closes.
 */
export interface RemoteStatusView {
  key: string;
  provider: ForgeProviderKind;
  host: string;
  project: string;
  branch: string;
  target: string;
  number?: number;
  url?: string;
  awaiting: boolean;
  /** Epoch ms. Present only while a window is running. */
  settleAt?: number;
  checkedAt?: number;
  /** Why the last read failed. The gate is still answerable here; the forge just cannot be heard. */
  error?: string;
  /** Who has commented there, other than the token's own account — in order of first appearance. */
  commenters: string[];
  /** What the forge has said so far, as the notes a settlement would carry: by change id. */
  notes?: Record<string, unknown[]>;
}

/** What the primitives and the poller need of the store. `@jaira/persistence` implements it. */
export interface RemoteHandlePort {
  get(taskId: string, key: string): RemoteHandleRow | undefined;
  forTask(taskId: string): RemoteHandleRow[];
  /** The rows something is parked on — "nothing parked, nothing polled" is this list being empty. */
  awaiting(): RemoteHandleRow[];
  /** Make the row for a request, or return the one already there — never a second. */
  ensure(identity: Pick<RemoteHandleRow, "taskId" | "key" | "provider" | "host" | "project" | "remote" | "branch" | "target">): RemoteHandleRow;
  update(taskId: string, key: string, patch: RemoteHandlePatch): RemoteHandleRow | undefined;
  byRequest(requestId: string): RemoteHandleRow | undefined;
  stopAwaiting(taskId: string): void;
}

/** A row as the data a function returns. `undefined` until the request has been opened. */
export function handleOfRow(row: RemoteHandleRow): RemoteHandle | undefined {
  if (row.number === undefined || row.url === undefined) return undefined;
  return {
    id: remoteHandleId(row.provider, row.host, row.project, row.number),
    provider: row.provider,
    host: row.host,
    project: row.project,
    branch: row.branch,
    target: row.target,
    number: row.number,
    url: row.url,
    head: row.pushedHead ?? "",
  };
}

// --- JaiRA's signature on what it posts ---------------------------------------------------------

/**
 * Every comment and reply JaiRA posts to a forge is SIGNED (the person's ruling, 2026-09-25): a
 * visible first line saying who wrote it — `🤖 claude-opus-5-5 · via JaiRA`, the model of the agent or
 * turn that asked for it, or `🤖 JaiRA` where no model asked (a person's words JaiRA carried, the
 * review's own closing line) — and a hidden marker at the end, `<!-- jaira:comment model=… task=… -->`,
 * which is how JaiRA knows its own words when it reads the request back.
 *
 * The marker, not the account, is what "JaiRA's own" means. The connection's token belongs to the
 * person, so the account is theirs too: a comment they write on the forge themselves is theirs, fires
 * `merge_request.commented`, and counts on a review gate; one JaiRA posted with the same token is
 * never an event and never settles anything, because it carries the marker.
 */
export interface CommentSignature {
  /** The model that asked for it, when one did. */
  model?: string;
  /** The task it was posted for. */
  taskId?: string;
}

/**
 * The marker, where {@link signComment} puts it: the END of the body. A comment that only quotes one
 * part-way through is somebody's, answering JaiRA — not JaiRA's.
 */
const MARKER = /<!--\s*jaira:comment\b([^>]*)-->\s*$/;

/** A marker attribute's value: no spaces, and nothing that would end the HTML comment. */
const attr = (value: string): string => value.trim().replace(/\s+/g, "_").replace(/-->|[<>"]/g, "");

/** The comment's first line: who wrote it. */
export function signatureLine(signature: CommentSignature): string {
  const model = signature.model !== undefined && signature.model.trim().length > 0 ? signature.model.trim() : undefined;
  return model !== undefined ? `🤖 ${model} · via JaiRA` : "🤖 JaiRA";
}

/** The hidden marker that ends a signed comment. */
export function commentMarker(signature: CommentSignature): string {
  const model = signature.model !== undefined && signature.model.trim().length > 0 ? attr(signature.model) : "JaiRA";
  const task = signature.taskId !== undefined && signature.taskId.length > 0 ? ` task=${attr(signature.taskId)}` : "";
  return `<!-- jaira:comment model=${model}${task} -->`;
}

/** `body`, signed: the visible line first, the marker last. A body already signed is returned as it is. */
export function signComment(body: string, signature: CommentSignature): string {
  if (isJairaComment(body)) return body;
  return `${signatureLine(signature)}\n\n${body}\n\n${commentMarker(signature)}`;
}

/** Whether JaiRA wrote this — it ends with the marker. */
export function isJairaComment(body: string | undefined): boolean {
  return body !== undefined && MARKER.test(body);
}

/** What a signed comment's marker says, or `undefined` for a comment JaiRA did not write. */
export function commentSignatureOf(body: string | undefined): CommentSignature | undefined {
  const found = body !== undefined ? MARKER.exec(body) : null;
  if (found === null) return undefined;
  const out: CommentSignature = {};
  for (const [, key, value] of (found[1] ?? "").matchAll(/(\w+)=(\S+)/g)) {
    if (key === "model" && value !== "JaiRA") out.model = value;
    if (key === "task") out.taskId = value;
  }
  return out;
}
