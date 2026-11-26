/**
 * Integrations: a connection becomes a provider, and a connection is CHECKED (decision 0004 §1).
 *
 * The check is the executor check's sibling and follows its rule — the state of a connection is
 * OBSERVED, never assumed. A token that is named and found proves nothing; what proves something is
 * the host saying who the token belongs to, so that is what is asked.
 */
import {
  FORGE_CLIS,
  FORGE_LABELS,
  connectionForHost,
  type ForgeCheck,
  type ForgeProvider,
  type JairaForgeConnection,
  type JairaIntegrationsConfig,
  type SecretSource,
} from "@jaira/shared";
import type { SecretResolver } from "../secrets";
import { ForgeCliUnavailable, cliForgeHttp, type ForgeCliOptions } from "./cli";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";
import { ForgeError, NoForgeConnection, fetchForgeHttp, type ForgeHttp } from "./http";

export * from "./http";
export * from "./deviceFlow";
export * from "./cli";
export { GitLabProvider } from "./gitlab";
export { GitHubProvider, GITHUB_READ_QUERY, GITHUB_REPLY_MUTATION, GITHUB_RESOLVE_MUTATION } from "./github";

export interface ForgeOptions {
  secrets: SecretResolver;
  /** The transport. Injected by every test; the platform `fetch` otherwise. */
  http?: ForgeHttp;
  now?: () => number;
  /**
   * Where a sign-in through the browser WROTE the token under a secret name, if one did — what makes
   * a check say `via: "oauth"`. Only while the chain still finds that name there: a token found
   * anywhere else is some other token, and is `token`.
   */
  signedIn?: (credential: string) => SecretSource | undefined;
  /**
   * The forge's own command line (`gh`, `glab`), for a connection no token is stored for: the same
   * provider, its requests sent through the command line as whoever it is signed in as (decision 0004,
   * amended 2026-11-20). Absent: a connection with no token has no way in, as before.
   */
  cli?: ForgeCliOptions;
}

/** How a provider reaches its forge: with a token over the API, or through the forge's command line. */
export type ForgeWay = { token: string } | { cli: ForgeCliOptions };

/**
 * The provider for a connection, given the token's value or the command line to go through. The only
 * place a provider is constructed: the same class either way, only its transport differs.
 */
export function forgeProvider(connection: JairaForgeConnection, way: string | ForgeWay, options: Pick<ForgeOptions, "http" | "now"> = {}): ForgeProvider {
  const chosen: ForgeWay = typeof way === "string" ? { token: way } : way;
  const built = {
    host: connection.host,
    // Through the command line there is no token here: it signs the request, and drops the header.
    token: "token" in chosen ? chosen.token : "",
    http: "cli" in chosen ? cliForgeHttp(connection.provider, connection.host, chosen.cli) : (options.http ?? fetchForgeHttp),
    ...(connection.apiUrl !== undefined ? { apiUrl: connection.apiUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  return connection.provider === "gitlab" ? new GitLabProvider(built) : new GitHubProvider(built);
}

/**
 * The provider a git remote's HOST picks, with its token resolved.
 *
 * Refuses rather than returning something half-working. GitLab with no token can still push and open
 * (push options need only git credentials) but cannot WATCH, and a request nobody hears is worse than
 * no request — so a caller that needs a provider gets one that can do everything, or a reason.
 */
export function forgeForHost(integrations: JairaIntegrationsConfig, host: string, options: ForgeOptions): ForgeProvider {
  return forgeAccess(integrations, host, options).provider;
}

/**
 * What {@link forgeForHost} finds, with the token's VALUE beside the provider — for the one caller
 * that hands the token to something other than the provider: `git_push`, which gives it to git
 * (decision 0010 §1). Held in memory for the call and never written anywhere.
 */
export interface ForgeAccess {
  name: string;
  connection: JairaForgeConnection;
  provider: ForgeProvider;
  /** Absent when the provider goes through the forge's command line: git then signs in as it already does. */
  token?: string;
  /** How the provider reaches the forge. */
  via: "token" | "cli";
}

export function forgeAccess(integrations: JairaIntegrationsConfig, host: string, options: ForgeOptions): ForgeAccess {
  const found = connectionForHost(integrations, host);
  if (found === undefined) {
    throw new NoForgeConnection(`no connection is set up for ${host} — add one under Settings → Connections → Forges`);
  }
  const { name, connection } = found;
  const hit = connection.credential !== undefined ? options.secrets.lookup(connection.credential) : undefined;
  if (hit !== undefined) return { name, connection, provider: forgeProvider(connection, hit.value, options), token: hit.value, via: "token" };
  // No token: the forge's command line, when there is one to go through. Whether it is signed in is
  // found out by the first request, which says so in a sentence (`ForgeCliUnavailable`).
  if (options.cli !== undefined) return { name, connection, provider: forgeProvider(connection, { cli: options.cli }, options), via: "cli" };
  if (connection.credential === undefined) {
    throw new NoForgeConnection(`the ${name} connection names no token — store one under Settings → Connections → Forges`);
  }
  throw new NoForgeConnection(`the ${name} connection's token ${connection.credential} is not stored anywhere JaiRA looks`);
}

/** What a token needs, said once per provider — the `fix` line of a refused one. */
const TOKEN_NEEDS: Record<JairaForgeConnection["provider"], string> = {
  gitlab: "replace the token; it needs the `api` scope to open and read merge requests",
  github: "replace the token; it needs the `repo` scope to open and read pull requests",
};

/** Check one connection by asking its host who the token is. Never throws: a failure IS the result. */
export async function checkForge(name: string, connection: JairaForgeConnection, options: ForgeOptions): Promise<ForgeCheck> {
  const base = { name, provider: connection.provider, host: connection.host };
  if (connection.enabled === false) return { ...base, status: "disabled", detail: "turned off" };
  const hit = connection.credential !== undefined ? options.secrets.lookup(connection.credential) : undefined;
  if (hit === undefined) {
    const none: ForgeCheck =
      connection.credential === undefined
        ? { ...base, status: "unconfigured", detail: "no token is named", fix: "store a token below" }
        : { ...base, status: "unconfigured", detail: `no token stored under ${connection.credential}`, fix: "store a token below", credentialMissing: connection.credential };
    return options.cli !== undefined ? checkForgeCli(base, connection, options.cli, none) : none;
  }
  const credential = { source: hit.source, ...(hit.file !== undefined ? { file: hit.file } : {}) };
  const via = connection.credential !== undefined && options.signedIn?.(connection.credential) === hit.source ? ("oauth" as const) : ("token" as const);
  try {
    const identity = await forgeProvider(connection, hit.value, options).whoami();
    // A classic GitHub token says what it may do. One that can sign in and cannot touch a repository
    // would pass this check and fail at the first push — so it fails here, where the fix is a sentence.
    if (connection.provider === "github" && identity.scopes !== undefined && !identity.scopes.includes("repo")) {
      return {
        ...base,
        status: "failed",
        detail: `signed in as @${identity.login}, but the token lacks the repo scope`,
        fix: TOKEN_NEEDS.github,
        identity,
        credential,
        via,
      };
    }
    return { ...base, status: "ok", detail: `signed in as @${identity.login}`, identity, credential, via };
  } catch (error) {
    if (error instanceof ForgeError && (error.status === 401 || error.status === 403)) {
      // A token from a sign-in is not replaced by hand — the sign-in that made it is done again.
      const fix = via === "oauth" ? "sign in again" : TOKEN_NEEDS[connection.provider];
      return { ...base, status: "failed", detail: `the token was refused (${error.status})`, fix, credential, via };
    }
    const label = FORGE_LABELS[connection.provider].name;
    const why = error instanceof ForgeError ? `${label} answered ${error.status}` : (error as Error).message;
    return { ...base, status: "failed", detail: `could not reach ${connection.host} — ${why}`, fix: "check the host and the network, then re-check", credential, via };
  }
}

/**
 * A connection with no token, checked through its forge's command line: who it is signed in as there.
 * Not installed, or not signed in to the host, leaves the connection as it was without one (`none`); a
 * command line that is signed in and answers otherwise is a failed connection, said why.
 */
async function checkForgeCli(base: Pick<ForgeCheck, "name" | "provider" | "host">, connection: JairaForgeConnection, cli: ForgeCliOptions, none: ForgeCheck): Promise<ForgeCheck> {
  const program = FORGE_CLIS[connection.provider];
  try {
    const identity = await forgeProvider(connection, { cli }).whoami();
    if (connection.provider === "github" && identity.scopes !== undefined && !identity.scopes.includes("repo")) {
      return { ...base, status: "failed", detail: `signed in to ${program} as @${identity.login}, but without the repo scope`, fix: `run \`gh auth refresh --hostname ${connection.host} --scopes repo\``, identity, via: "cli" };
    }
    return { ...base, status: "ok", detail: `signed in as @${identity.login} through ${program}`, identity, via: "cli" };
  } catch (error) {
    // Installed and signed out: a sign-in lost, if it ever worked (`ForgeCheck.signedOut`); not installed is no way in at all.
    if (error instanceof ForgeCliUnavailable) {
      if (error.reason !== "signed-out") return none;
      return { ...none, detail: error.message, fix: `sign in again — here, or \`${program} auth login --hostname ${connection.host}\` in a terminal`, signedOut: error.message };
    }
    const why = error instanceof ForgeError && error.status > 0 ? `${FORGE_LABELS[connection.provider].name} answered ${error.status}` : (error as Error).message;
    return { ...base, status: "failed", detail: `${program} could not reach ${connection.host} — ${why}`, fix: "check the host and the network, then re-check", via: "cli" };
  }
}

/** Every connection, checked side by side — one slow host does not hold the others' answers back. */
export function checkForges(integrations: JairaIntegrationsConfig, options: ForgeOptions): Promise<ForgeCheck[]> {
  return Promise.all(Object.entries(integrations.forges).map(([name, connection]) => checkForge(name, connection, options)));
}
