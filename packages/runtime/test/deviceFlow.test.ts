/**
 * Signing in to a forge through the browser (RFC 8628), without a network or a wait.
 *
 * The forge is a script of answers and the clock is a number the fake `sleep` moves forward, so a
 * sign-in that would take minutes — a person reading a code off one screen and typing it into
 * another — runs in a tick, and every way it can end is one test.
 */
import { describe, expect, it } from "vitest";
import {
  DEVICE_CODE_GRANT,
  DeviceFlowError,
  deviceFlowEndpoints,
  oauthAppNeeded,
  pollDeviceToken,
  refreshDeviceToken,
  requestDeviceCode,
  type DeviceAuthorization,
  type ForgeHttp,
  type ForgeRequest,
  type ForgeResponse,
} from "../src/forge";

const GITHUB = deviceFlowEndpoints("github", { provider: "github", host: "github.com" });
const GITLAB = deviceFlowEndpoints("gitlab", { provider: "gitlab", host: "gitlab.com" });

/** A forge that answers each request with the next scripted response — or throws, for a dropped network. */
function scripted(answers: Array<ForgeResponse | Error>): { http: ForgeHttp; seen: ForgeRequest[] } {
  const seen: ForgeRequest[] = [];
  return {
    seen,
    http: async (request) => {
      seen.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error(`nothing scripted for ${request.url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const ok = (body: unknown, status = 200): ForgeResponse => ({ status, headers: {}, body });

/** A clock that only moves when the flow waits, and a record of every wait. */
function clock(start = 1_000_000) {
  let now = start;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted === true) throw new DeviceFlowError("canceled", "the sign-in was canceled");
      waits.push(ms);
      now += ms;
    },
  };
}

const authorization = (at: number, overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization => ({
  deviceCode: "dev-123",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: at + 900_000,
  intervalMs: 5_000,
  ...overrides,
});

describe("where a forge's device flow lives", () => {
  it("hangs off the web root, not the API", () => {
    expect(GITHUB).toMatchObject({ web: "https://github.com", deviceCodeUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", scope: "repo read:org" });
    expect(GITLAB).toMatchObject({ web: "https://gitlab.com", deviceCodeUrl: "https://gitlab.com/oauth/authorize_device", tokenUrl: "https://gitlab.com/oauth/token", scope: "api" });
  });

  it("takes a self-hosted forge's path prefix from its apiUrl", () => {
    expect(deviceFlowEndpoints("work", { provider: "gitlab", host: "git.example.org", apiUrl: "https://git.example.org/gitlab/api/v4" }).tokenUrl).toBe("https://git.example.org/gitlab/oauth/token");
    expect(deviceFlowEndpoints("work", { provider: "github", host: "ghe.example.org", apiUrl: "https://ghe.example.org/api/v3" }).deviceCodeUrl).toBe("https://ghe.example.org/login/device/code");
    expect(deviceFlowEndpoints("work", { provider: "gitlab", host: "git.example.org:8443" }).web).toBe("https://git.example.org:8443");
  });

  it("says what to set, and where, when a self-hosted instance has no OAuth app", () => {
    const { reason, fix } = oauthAppNeeded("work", "github", "ghe.example.org");
    expect(reason).toMatch(/ghe\.example\.org .*needs an OAuth app registered there — JaiRA's own GitHub app is registered on github\.com only/);
    expect(fix).toContain("integrations.forges.work.oauthClientId");
    expect(fix).toMatch(/paste a token instead/);
  });
});

describe("asking for a code", () => {
  it("sends the client id and scope form-encoded, and answers with what the person types", async () => {
    const time = clock();
    const forge = scripted([
      ok({ device_code: "dev-123", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }),
    ]);
    const code = await requestDeviceCode(GITHUB, "Iv1.abc", { http: forge.http, now: time.now });
    expect(code).toEqual({ deviceCode: "dev-123", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: time.now() + 900_000, intervalMs: 5_000 });
    expect(forge.seen[0]).toMatchObject({ method: "POST", url: GITHUB.deviceCodeUrl, form: { client_id: "Iv1.abc", scope: "repo read:org" } });
    expect(forge.seen[0]!.headers["Accept"]).toBe("application/json");
  });

  it("keeps the plain page and not GitLab's page with the code in it, which gitlab.com refuses the token after", async () => {
    const forge = scripted([
      ok({ device_code: "d", user_code: "ABCD", verification_uri: "https://gitlab.com/oauth/device", verification_uri_complete: "https://gitlab.com/oauth/device?user_code=ABCD", expires_in: 300, interval: 5 }),
    ]);
    const code = await requestDeviceCode(GITLAB, "app", { http: forge.http, now: () => 0 });
    expect(code).toEqual({ deviceCode: "d", userCode: "ABCD", verificationUri: "https://gitlab.com/oauth/device", expiresAt: 300_000, intervalMs: 5_000 });
  });

  it("says the app has device flow turned off, naming the box to tick", async () => {
    const forge = scripted([ok({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled for this App" }, 400)]);
    const refused = await requestDeviceCode(GITHUB, "Iv1.abc", { http: forge.http }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DeviceFlowError);
    expect(refused).toMatchObject({ code: "failed", message: expect.stringMatching(/Enable Device Flow/) });
  });

  it("says a client id the forge does not know is the setting to check", async () => {
    const forge = scripted([ok({ error: "invalid_client", error_description: "Client authentication failed" }, 401)]);
    const refused = await requestDeviceCode(GITLAB, "nope", { http: forge.http }).catch((e: unknown) => e);
    expect((refused as Error).message).toMatch(/does not accept the client ID nope for this sign-in — check integrations\.forges\.gitlab\.oauthClientId/);
  });

  it("says an unreachable forge is unreachable", async () => {
    const forge = scripted([new Error("getaddrinfo ENOTFOUND github.com")]);
    const refused = await requestDeviceCode(GITHUB, "Iv1.abc", { http: forge.http }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "failed", message: "could not reach https://github.com — getaddrinfo ENOTFOUND github.com" });
  });
});

describe("polling for the token", () => {
  it("waits the interval before every poll, keeps waiting while pending, and returns the token", async () => {
    const time = clock();
    const forge = scripted([
      ok({ error: "authorization_pending", error_description: "The authorization request is still pending." }),
      ok({ error: "authorization_pending" }),
      ok({ access_token: "gho_token", token_type: "bearer", scope: "repo,read:org" }),
    ]);
    const token = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep });
    expect(token).toEqual({ accessToken: "gho_token", tokenType: "bearer", scope: "repo,read:org" });
    expect(time.waits).toEqual([5_000, 5_000, 5_000]);
    expect(forge.seen.map((r) => r.form)).toEqual(Array(3).fill({ client_id: "Iv1.abc", device_code: "dev-123", grant_type: DEVICE_CODE_GRANT }));
  });

  it("reads GitLab's pending as pending though it comes as a 400, and keeps the refresh token and expiry", async () => {
    const time = clock();
    const forge = scripted([
      ok({ error: "authorization_pending", error_description: "…" }, 400),
      ok({ access_token: "glpat-oauth", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 7200, scope: "api read_user" }),
    ]);
    const token = await pollDeviceToken(GITLAB, "app", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep });
    expect(token).toEqual({ accessToken: "glpat-oauth", tokenType: "Bearer", scope: "api read_user", refreshToken: "refresh-1", expiresAt: time.now() + 7_200_000 });
  });

  it("slows down by five seconds on slow_down, for this poll and every later one", async () => {
    const time = clock();
    const forge = scripted([
      ok({ error: "slow_down" }),
      ok({ error: "authorization_pending" }),
      ok({ error: "slow_down", interval: 20 }),
      ok({ access_token: "t", token_type: "bearer" }),
    ]);
    await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep });
    // 5 → 10 after the first slow_down; GitHub's own `interval: 20` wins over 10 + 5.
    expect(time.waits).toEqual([5_000, 10_000, 10_000, 20_000]);
  });

  it("ends as expired when the forge says the code expired", async () => {
    const time = clock();
    const forge = scripted([ok({ error: "authorization_pending" }), ok({ error: "expired_token" }, 400)]);
    const ended = await pollDeviceToken(GITLAB, "app", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep }).catch((e: unknown) => e);
    expect(ended).toMatchObject({ code: "expired", message: expect.stringMatching(/expired before it was entered/) });
  });

  it("ends as expired by the clock, without polling past the code's life", async () => {
    const time = clock();
    const forge = scripted([ok({ error: "authorization_pending" }), ok({ error: "authorization_pending" })]);
    const ended = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now(), { expiresAt: time.now() + 12_000 }), {
      http: forge.http,
      now: time.now,
      sleep: time.sleep,
    }).catch((e: unknown) => e);
    expect(ended).toMatchObject({ code: "expired" });
    // Polled at 5 s and 10 s; at 15 s the code was dead, so no third request.
    expect(forge.seen).toHaveLength(2);
  });

  it("ends as denied when the person refuses on the forge's page", async () => {
    const time = clock();
    const forge = scripted([ok({ error: "access_denied", error_description: "The user has denied your application access." })]);
    const ended = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep }).catch((e: unknown) => e);
    expect(ended).toMatchObject({ code: "denied", message: "the sign-in was refused on GitHub's page" });
  });

  it("ends as canceled when the signal aborts, whether waiting or mid-poll", async () => {
    const time = clock();
    const controller = new AbortController();
    controller.abort();
    const forge = scripted([]);
    const waiting = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep, signal: controller.signal }).catch((e: unknown) => e);
    expect(waiting).toMatchObject({ code: "canceled" });
    expect(forge.seen).toEqual([]);

    // Canceled while the poll that brings the token is in flight: the token is not wanted any more.
    const midPoll = new AbortController();
    const late: ForgeHttp = async () => {
      midPoll.abort();
      return ok({ access_token: "t", token_type: "bearer" });
    };
    const inFlight = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: late, now: time.now, sleep: time.sleep, signal: midPoll.signal }).catch((e: unknown) => e);
    expect(inFlight).toMatchObject({ code: "canceled" });
  });

  it("cancels a real wait the moment the signal aborts", async () => {
    const controller = new AbortController();
    const forge = scripted([]);
    const pending = pollDeviceToken(GITHUB, "Iv1.abc", authorization(Date.now(), { intervalMs: 60_000 }), { http: forge.http, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
  });

  it("rides out a dropped network, and gives up after three in a row", async () => {
    const time = clock();
    const recovered = scripted([new Error("ECONNRESET"), ok({ error: "authorization_pending" }), new Error("ECONNRESET"), ok({ access_token: "t", token_type: "bearer" })]);
    await expect(pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: recovered.http, now: time.now, sleep: time.sleep })).resolves.toMatchObject({ accessToken: "t" });

    const down = scripted([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ETIMEDOUT")]);
    const ended = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: down.http, now: time.now, sleep: time.sleep }).catch((e: unknown) => e);
    expect(ended).toMatchObject({ code: "failed", message: "could not reach https://github.com — ETIMEDOUT" });
  });

  it("fails on an error it does not know, in the forge's own words", async () => {
    const time = clock();
    const forge = scripted([ok({ error: "incorrect_device_code", error_description: "The device_code provided is not valid." })]);
    const ended = await pollDeviceToken(GITHUB, "Iv1.abc", authorization(time.now()), { http: forge.http, now: time.now, sleep: time.sleep }).catch((e: unknown) => e);
    expect(ended).toMatchObject({ code: "failed", message: "GitHub answered 200 — The device_code provided is not valid." });
  });
});

describe("renewing a token", () => {
  it("trades the refresh token for a new pair", async () => {
    const forge = scripted([ok({ access_token: "new", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 7200 })]);
    const token = await refreshDeviceToken(GITLAB, "app", "refresh-1", { http: forge.http, now: () => 5 });
    expect(token).toEqual({ accessToken: "new", tokenType: "Bearer", refreshToken: "refresh-2", expiresAt: 5 + 7_200_000 });
    expect(forge.seen[0]).toMatchObject({ url: GITLAB.tokenUrl, form: { client_id: "app", refresh_token: "refresh-1", grant_type: "refresh_token" } });
  });

  it("fails with the forge's reason when the refresh token is dead", async () => {
    const forge = scripted([ok({ error: "invalid_grant", error_description: "The provided authorization grant is invalid, expired, revoked" }, 400)]);
    await expect(refreshDeviceToken(GITLAB, "app", "old", { http: forge.http })).rejects.toMatchObject({ code: "failed", message: expect.stringMatching(/invalid, expired, revoked/) });
  });
});
