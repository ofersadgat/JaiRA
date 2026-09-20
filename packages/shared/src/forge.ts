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
}

export interface JairaIntegrationsConfig {
  /** Connections by NAME — a name and not the host, because a host has dots and a config path splits on them. */
  forges: Record<string, JairaForgeConnection>;
  review: {
    /** The quiet window after a comment, as a duration (`"10m"`). A state's `remote` overrides it. */
    settleAfter: string;
  };
}

/** The window the decision names; what `integrations.review.settleAfter` is when nobody set it. */
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
  return { forges: structuredClone(BUILTIN_FORGES), review: { settleAfter: DEFAULT_SETTLE_AFTER } };
}

/** What `remote.publish` may be set to under `policy` — see {@link PUBLISH_MODE_LABELS}. */
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
  onlyFields(block, ["forges", "review"], "config.integrations");

  if (block["forges"] !== undefined) {
    for (const [name, entry] of Object.entries(objectAt(block["forges"], "config.integrations.forges"))) {
      const where = `config.integrations.forges.${name}`;
      if (!CONNECTION_NAME.test(name)) {
        throw new Error(`${where}: a connection's name is letters, digits, '-' and '_' — the host goes in its 'host' field`);
      }
      const spec = objectAt(entry, where);
      onlyFields(spec, ["provider", "host", "credential", "enabled", "apiUrl"], where);
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
      out.forges[name] = {
        provider: provider as ForgeProviderKind,
        host,
        ...(credential !== undefined ? { credential: credential as string } : {}),
        ...(merged["enabled"] === false ? { enabled: false } : {}),
        ...(apiUrl !== undefined ? { apiUrl: (apiUrl as string).replace(/\/+$/, "") } : {}),
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

  if (block["review"] !== undefined) {
    const review = objectAt(block["review"], "config.integrations.review");
    onlyFields(review, ["settleAfter"], "config.integrations.review");
    const settleAfter = review["settleAfter"];
    if (settleAfter !== undefined) {
      if (typeof settleAfter !== "string" || parseDuration(settleAfter) === undefined) {
        throw new Error(`config.integrations.review.settleAfter must be a duration like "10m", "90s", "2h" or "0"`);
      }
      out.review.settleAfter = settleAfter.trim();
    }
  }
  return out;
}

/** `remote.publish` out of the opaque policy document — `ask` when absent or unreadable. */
export function publishModeOf(policy: unknown): PublishMode {
  const remote = policy !== null && typeof policy === "object" ? (policy as Record<string, unknown>)["remote"] : undefined;
  const mode = remote !== null && typeof remote === "object" ? (remote as Record<string, unknown>)["publish"] : undefined;
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

/** One thing somebody wrote. `canWrite` and `own` are the two facts "who counts" is decided from. */
export interface ForgeComment {
  id: string;
  who: string;
  body: string;
  at: string;
  /** Write access to the project — GitHub OWNER / MEMBER / COLLABORATOR, GitLab Developer and up. */
  canWrite: boolean;
  /** Written by the token's own account: JaiRA's own words, shown and never an event. */
  own: boolean;
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

/**
 * What a probe remembers between ticks — persisted on the `remote_handles` row, so a weekend with
 * the app closed costs one probe and loses nothing.
 */
export interface ProbeCursor {
  /** GitLab: the `updated_after` of the next list call. */
  since?: string;
  /** GitHub: the ETag of each watched request, by handle id. */
  etags?: Record<string, string>;
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
  comment(handle: RemoteHandle, body: string, anchor?: ForgeAnchor): Promise<void>;
  reply(handle: RemoteHandle, threadId: string, body: string, resolve?: boolean): Promise<void>;
  merge(handle: RemoteHandle): Promise<void>;
  close(handle: RemoteHandle): Promise<void>;
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
}

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
