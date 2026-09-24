/**
 * Signing in to a forge through the browser: OAuth's device authorization grant (RFC 8628).
 *
 * The one OAuth flow a desktop app completes without a redirect it would have to listen for. JaiRA
 * asks the forge for a code, the person types it on the forge's own page, and JaiRA polls the token
 * endpoint until the forge says yes, no, or too late:
 *
 * ```text
 *   POST {web}/login/device/code        (GitHub)   client_id, scope  →  device_code, user_code,
 *   POST {web}/oauth/authorize_device   (GitLab)                          verification_uri, expires_in, interval
 *
 *   every `interval` seconds, until the code expires:
 *   POST {web}/login/oauth/access_token (GitHub)   client_id, device_code, grant_type=…:device_code
 *   POST {web}/oauth/token              (GitLab)     →  authorization_pending | slow_down (+5 s)
 *                                                    |  expired_token | access_denied | access_token
 * ```
 *
 * Pure over the transport and the clock — {@link ForgeHttp}, `now` and `sleep` are all injected — so
 * every way it ends is tested without a network or a wait. Nothing here stores anything: what to do
 * with the token is the caller's, which is what keeps "where a pasted token would go" in one place.
 *
 * GitHub answers a pending poll `200` with an `error` in the body; GitLab answers it `400`. So the
 * body's `error` is read first and the status second — branching on the status would read GitHub's
 * "not yet" as a token.
 */
import type { ForgeProviderKind, JairaForgeConnection } from "@jaira/shared";
import { asRecord, asText, forgeMessage, type ForgeHttp, type ForgeResponse } from "./http";

/** RFC 8628 §3.4's grant type, the same word on both forges. */
export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * What JaiRA asks for. GitHub: `repo` opens and reads pull requests, `read:org` reads who may write —
 * for an OAuth app; a GitHub App (JaiRA's own) ignores scopes and grants what the app's permissions
 * say. GitLab: `api` alone — the whole of the REST surface the provider uses, `whoami` included. JaiRA's
 * GitLab app does not allow `read_user`, and asking for a scope an app lacks refuses the whole sign-in.
 */
export const DEVICE_FLOW_SCOPES: Record<ForgeProviderKind, string> = {
  github: "repo read:org",
  gitlab: "api",
};

/** Where one forge's device flow lives. */
export interface DeviceFlowEndpoints {
  provider: ForgeProviderKind;
  /** The forge's WEB root, not its API — `https://github.com`, `https://git.example.org`. */
  web: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
}

/**
 * The device flow's endpoints for a connection.
 *
 * They hang off the forge's web root, which is the host — except where a connection names an
 * `apiUrl` because the forge sits behind a path prefix; then the web root is that URL without its
 * API suffix (`/api/v4`, `/api/v3`), which is where the prefix is.
 */
export function deviceFlowEndpoints(connection: Pick<JairaForgeConnection, "provider" | "host" | "apiUrl">): DeviceFlowEndpoints {
  const { provider } = connection;
  let web = `https://${connection.host}`;
  if (connection.apiUrl !== undefined && connection.apiUrl !== "https://api.github.com") {
    web = connection.apiUrl.replace(/\/+$/, "").replace(provider === "gitlab" ? /\/api\/v4$/ : /\/api\/v3$/, "");
  }
  return provider === "github"
    ? { provider, web, deviceCodeUrl: `${web}/login/device/code`, tokenUrl: `${web}/login/oauth/access_token`, scope: DEVICE_FLOW_SCOPES.github }
    : { provider, web, deviceCodeUrl: `${web}/oauth/authorize_device`, tokenUrl: `${web}/oauth/token`, scope: DEVICE_FLOW_SCOPES.gitlab };
}

/** A code the forge handed out, and what polling for its token needs. */
export interface DeviceAuthorization {
  /** The secret half — sent back on every poll, never shown. */
  deviceCode: string;
  /** What the person types. */
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Epoch ms. */
  expiresAt: number;
  /** How long to wait between polls, as the forge first said (RFC 8628: 5 s when it says nothing). */
  intervalMs: number;
}

/** The token the forge handed back. */
export interface DeviceToken {
  accessToken: string;
  tokenType: string;
  /** What was granted, as the forge spells it (GitHub: comma-separated; GitLab: spaces). */
  scope?: string;
  /** Present where the token dies (GitLab: two hours) and can be renewed without the person. */
  refreshToken?: string;
  /** Epoch ms the access token dies, when the forge said. */
  expiresAt?: number;
}

/** How a sign-in ended, when it did not end with a token. `reason` is a sentence for the person. */
export class DeviceFlowError extends Error {
  constructor(
    readonly code: "denied" | "expired" | "canceled" | "failed",
    reason: string,
  ) {
    super(reason);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceFlowOptions {
  http: ForgeHttp;
  now?: () => number;
  /**
   * Wait `ms`, or reject with a `canceled` {@link DeviceFlowError} the moment `signal` aborts.
   * Injected so a test walks a ten-minute flow in no time; the real one is a timer.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/** RFC 8628 §3.2: the interval when the forge names none. */
const DEFAULT_INTERVAL_S = 5;
/** RFC 8628 §3.5: what `slow_down` adds to the interval, for this and every later poll. */
const SLOW_DOWN_MS = 5_000;
/** Polls in a row that may fail to reach the forge (or meet a 5xx) before the sign-in gives up. */
const MAX_TRANSIENT = 3;

const HEADERS = { Accept: "application/json", "User-Agent": "jaira" };

/**
 * Why no sign-in can start: the connection is a self-hosted instance JaiRA's own apps are not
 * registered on, and no layer names one for it. Said with where to name one.
 */
export function oauthAppNeeded(provider: ForgeProviderKind, host: string): { reason: string; fix: string } {
  const label = provider === "github" ? "GitHub" : "GitLab";
  const app = provider === "github" ? "an OAuth app with “Enable Device Flow” ticked" : "a non-confidential application with the api scope";
  return {
    reason: `Signing in to ${host} through the browser needs an OAuth app registered there — JaiRA's own ${label} app is registered on ${provider === "github" ? "github.com" : "gitlab.com"} only.`,
    fix: `register ${app} on ${label}, then set integrations.oauth.${provider}.clientId in settings.json (Settings → settings.json) — or paste a token instead`,
  };
}

/** Ask the forge for a code. Throws a {@link DeviceFlowError} (`failed`) with the forge's reason. */
export async function requestDeviceCode(endpoints: DeviceFlowEndpoints, clientId: string, options: DeviceFlowOptions): Promise<DeviceAuthorization> {
  const now = options.now ?? Date.now;
  const response = await reach(endpoints, options, {
    method: "POST",
    url: endpoints.deviceCodeUrl,
    headers: HEADERS,
    form: { client_id: clientId, scope: endpoints.scope },
  });
  const body = asRecord(response.body);
  const deviceCode = asText(body["device_code"]);
  const userCode = asText(body["user_code"]);
  const verificationUri = asText(body["verification_uri"]);
  if (response.status !== 200 || asText(body["error"]) !== "" || deviceCode === "" || userCode === "" || verificationUri === "") {
    throw new DeviceFlowError("failed", refusalOf(endpoints, clientId, response));
  }
  const expiresIn = typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : 900;
  const interval = typeof body["interval"] === "number" && body["interval"] > 0 ? body["interval"] : DEFAULT_INTERVAL_S;
  const complete = asText(body["verification_uri_complete"]);
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete !== "" ? { verificationUriComplete: complete } : {}),
    expiresAt: now() + expiresIn * 1_000,
    intervalMs: interval * 1_000,
  };
}

/**
 * Poll until the person has answered on the forge's page, and return the token.
 *
 * Waits BEFORE each poll — the person has not typed anything yet when the code is handed out — and
 * never polls past the code's expiry, the forge's word on it or not. A poll that cannot reach the
 * forge is retried at the same pace, {@link MAX_TRANSIENT} times in a row, because a laptop changing
 * networks mid-sign-in is ordinary and a failed sign-in costs the person starting again.
 */
export async function pollDeviceToken(
  endpoints: DeviceFlowEndpoints,
  clientId: string,
  authorization: DeviceAuthorization,
  options: DeviceFlowOptions,
): Promise<DeviceToken> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  let interval = authorization.intervalMs;
  let transient = 0;
  for (;;) {
    await sleep(interval, options.signal);
    if (aborted(options.signal)) throw canceled();
    if (now() >= authorization.expiresAt) throw expired();
    let response: ForgeResponse;
    try {
      response = await options.http({
        method: "POST",
        url: endpoints.tokenUrl,
        headers: HEADERS,
        form: { client_id: clientId, device_code: authorization.deviceCode, grant_type: DEVICE_CODE_GRANT },
      });
    } catch (error) {
      if (++transient >= MAX_TRANSIENT) throw unreachable(endpoints, error);
      continue;
    }
    // Canceled while the poll was in flight: whatever it brought back is not wanted any more.
    if (aborted(options.signal)) throw canceled();
    const body = asRecord(response.body);
    const error = asText(body["error"]);
    if (error === "" && response.status === 200 && asText(body["access_token"]) !== "") return tokenOf(body, now());
    switch (error) {
      case "authorization_pending":
        transient = 0;
        continue;
      case "slow_down": {
        transient = 0;
        // GitHub says the new interval outright; RFC 8628 says add five seconds. Whichever is longer.
        const said = typeof body["interval"] === "number" ? body["interval"] * 1_000 : 0;
        interval = Math.max(interval + SLOW_DOWN_MS, said);
        continue;
      }
      case "expired_token":
        throw expired();
      case "access_denied":
        throw new DeviceFlowError("denied", `the sign-in was refused on ${label(endpoints)}'s page`);
    }
    if (error === "" && (response.status >= 500 || response.status === 429)) {
      if (++transient >= MAX_TRANSIENT) throw new DeviceFlowError("failed", `${label(endpoints)} kept answering ${response.status}`);
      continue;
    }
    throw new DeviceFlowError("failed", refusalOf(endpoints, clientId, response));
  }
}

/**
 * Renew an access token with the refresh token that came with it — no person involved.
 *
 * GitLab's tokens live two hours and come with one; GitHub's OAuth-app tokens do not expire, so this
 * is only ever reached for a forge that said `expires_in`. GitLab ROTATES the refresh token: the
 * answer carries the next one, and the old one is dead once this returns.
 */
export async function refreshDeviceToken(
  endpoints: DeviceFlowEndpoints,
  clientId: string,
  refreshToken: string,
  options: Pick<DeviceFlowOptions, "http" | "now">,
): Promise<DeviceToken> {
  const response = await reach(endpoints, options, {
    method: "POST",
    url: endpoints.tokenUrl,
    headers: HEADERS,
    form: { client_id: clientId, refresh_token: refreshToken, grant_type: "refresh_token" },
  });
  const body = asRecord(response.body);
  if (response.status !== 200 || asText(body["error"]) !== "" || asText(body["access_token"]) === "") {
    throw new DeviceFlowError("failed", refusalOf(endpoints, clientId, response));
  }
  return tokenOf(body, (options.now ?? Date.now)());
}

function tokenOf(body: Record<string, unknown>, at: number): DeviceToken {
  const scope = asText(body["scope"]);
  const refreshToken = asText(body["refresh_token"]);
  const expiresIn = body["expires_in"];
  return {
    accessToken: asText(body["access_token"]),
    tokenType: asText(body["token_type"]) || "bearer",
    ...(scope !== "" ? { scope } : {}),
    ...(refreshToken !== "" ? { refreshToken } : {}),
    ...(typeof expiresIn === "number" && expiresIn > 0 ? { expiresAt: at + expiresIn * 1_000 } : {}),
  };
}

/** One request that must reach the forge; not reaching it is a `failed` sign-in, said as such. */
async function reach(
  endpoints: DeviceFlowEndpoints,
  options: Pick<DeviceFlowOptions, "http">,
  request: Parameters<ForgeHttp>[0],
): Promise<ForgeResponse> {
  try {
    return await options.http(request);
  } catch (error) {
    throw unreachable(endpoints, error);
  }
}

/**
 * The forge's refusal as a sentence the person can act on. The OAuth error codes that mean "your
 * settings are wrong" are said as that, naming the setting; anything else is the forge's own words.
 */
function refusalOf(endpoints: DeviceFlowEndpoints, clientId: string, response: ForgeResponse): string {
  const body = asRecord(response.body);
  const error = asText(body["error"]);
  const forge = label(endpoints);
  const setting = `integrations.oauth.${endpoints.provider}.clientId`;
  switch (error) {
    case "device_flow_disabled":
      return `the OAuth app ${clientId} does not have device flow turned on — tick “Enable Device Flow” in its settings on ${forge}`;
    case "incorrect_client_credentials":
    case "invalid_client":
    case "unauthorized_client":
      return `${forge} does not accept the client ID ${clientId} for this sign-in — check ${setting}, and that the app is not confidential`;
    case "invalid_scope":
      return `the OAuth app may not ask for ${endpoints.scope} — allow those scopes in its settings on ${forge}`;
  }
  if (error === "" && response.status === 404) return `${forge} has no device sign-in at ${endpoints.web}, or does not know the client ID ${clientId} — check ${setting}`;
  const said = forgeMessage(body) ?? (typeof response.body === "string" ? forgeMessage(response.body) : undefined);
  return `${forge} answered ${response.status}${said !== undefined ? ` — ${said}` : ""}`;
}

function unreachable(endpoints: DeviceFlowEndpoints, error: unknown): DeviceFlowError {
  return new DeviceFlowError("failed", `could not reach ${endpoints.web} — ${(error as Error).message}`);
}

function expired(): DeviceFlowError {
  return new DeviceFlowError("expired", "the code expired before it was entered — start the sign-in again");
}

function canceled(): DeviceFlowError {
  return new DeviceFlowError("canceled", "the sign-in was canceled");
}

/** A function rather than an inline read: the signal can abort during any `await`, which narrowing cannot see. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function label(endpoints: DeviceFlowEndpoints): string {
  return endpoints.provider === "github" ? "GitHub" : "GitLab";
}

/** The real wait: a timer, cut short by the signal. */
function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(canceled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(canceled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
