/**
 * Integrations: a connection becomes a provider, and a connection is CHECKED (decision 0004 §1).
 *
 * The check is the executor check's sibling and follows its rule — the state of a connection is
 * OBSERVED, never assumed. A token that is named and found proves nothing; what proves something is
 * the host saying who the token belongs to, so that is what is asked.
 */
import {
  FORGE_LABELS,
  connectionForHost,
  type ForgeCheck,
  type ForgeProvider,
  type JairaForgeConnection,
  type JairaIntegrationsConfig,
} from "@jaira/shared";
import type { SecretResolver } from "../secrets";
import { GitHubProvider } from "./github";
import { GitLabProvider } from "./gitlab";
import { ForgeError, fetchForgeHttp, type ForgeHttp } from "./http";

export * from "./http";
export { GitLabProvider } from "./gitlab";
export { GitHubProvider, GITHUB_READ_QUERY, GITHUB_REPLY_MUTATION, GITHUB_RESOLVE_MUTATION } from "./github";

export interface ForgeOptions {
  secrets: SecretResolver;
  /** The transport. Injected by every test; the platform `fetch` otherwise. */
  http?: ForgeHttp;
  now?: () => number;
}

/** The provider for a connection, given the token's value. The only place a provider is constructed. */
export function forgeProvider(connection: JairaForgeConnection, token: string, options: Pick<ForgeOptions, "http" | "now"> = {}): ForgeProvider {
  const built = {
    host: connection.host,
    token,
    http: options.http ?? fetchForgeHttp,
    ...(connection.apiUrl !== undefined ? { apiUrl: connection.apiUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  return connection.provider === "gitlab" ? new GitLabProvider(built) : new GitHubProvider(built);
}

/** Why a host has no usable provider — said as a sentence, because every caller shows it to a person. */
export class NoForgeConnection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoForgeConnection";
  }
}

/**
 * The provider a git remote's HOST picks, with its token resolved.
 *
 * Refuses rather than returning something half-working. GitLab with no token can still push and open
 * (push options need only git credentials) but cannot WATCH, and a request nobody hears is worse than
 * no request — so a caller that needs a provider gets one that can do everything, or a reason.
 */
export function forgeForHost(integrations: JairaIntegrationsConfig, host: string, options: ForgeOptions): ForgeProvider {
  const found = connectionForHost(integrations, host);
  if (found === undefined) {
    throw new NoForgeConnection(`no connection is set up for ${host} — add one under Settings → Integrations`);
  }
  const { name, connection } = found;
  if (connection.credential === undefined) {
    throw new NoForgeConnection(`the ${name} connection names no token — store one under Settings → Integrations`);
  }
  const hit = options.secrets.lookup(connection.credential);
  if (hit === undefined) {
    throw new NoForgeConnection(`the ${name} connection's token ${connection.credential} is not stored anywhere JaiRA looks`);
  }
  return forgeProvider(connection, hit.value, options);
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
  if (connection.credential === undefined) {
    return { ...base, status: "unconfigured", detail: "no token is named", fix: "store a token below" };
  }
  const hit = options.secrets.lookup(connection.credential);
  if (hit === undefined) {
    return {
      ...base,
      status: "unconfigured",
      detail: `no token stored under ${connection.credential}`,
      fix: "store a token below",
      credentialMissing: connection.credential,
    };
  }
  const credential = { source: hit.source, ...(hit.file !== undefined ? { file: hit.file } : {}) };
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
      };
    }
    return { ...base, status: "ok", detail: `signed in as @${identity.login}`, identity, credential };
  } catch (error) {
    if (error instanceof ForgeError && (error.status === 401 || error.status === 403)) {
      return { ...base, status: "failed", detail: `the token was refused (${error.status})`, fix: TOKEN_NEEDS[connection.provider], credential };
    }
    const label = FORGE_LABELS[connection.provider].name;
    const why = error instanceof ForgeError ? `${label} answered ${error.status}` : (error as Error).message;
    return { ...base, status: "failed", detail: `could not reach ${connection.host} — ${why}`, fix: "check the host and the network, then re-check", credential };
  }
}

/** Every connection, checked side by side — one slow host does not hold the others' answers back. */
export function checkForges(integrations: JairaIntegrationsConfig, options: ForgeOptions): Promise<ForgeCheck[]> {
  return Promise.all(Object.entries(integrations.forges).map(([name, connection]) => checkForge(name, connection, options)));
}
