/**
 * Settings → Connections, below the pixels: signing in to a forge through the browser, finding the
 * local servers, and checking the embedded weights.
 *
 * The forge is a fake that answers the device flow and `GET /user`; the clock only moves when the
 * sign-in waits, so a flow that takes a person minutes runs in a tick. What these pin down is where a
 * signed-in token ENDS UP — the same place a pasted one does — and that the "OAuth" tag on it is
 * honest: it goes when a paste replaces the token, and with the token when the person disconnects.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import { DeviceFlowError, type ForgeHttp, type ForgeRequest, type ForgeResponse, type LocalFetch } from "@jaira/runtime";
import { BUILTIN_OAUTH_APPS, parseSettings, type ForgeSignInOutcome, type PushMessage } from "@jaira/shared";
import { AppService, type KeychainPort } from "../src/main/service";

let dir: string;
let home: string;
let service: AppService;
let stored: Record<string, string>;
let pushes: PushMessage[];
let opened: string[];
let seen: ForgeRequest[];
/** What the token endpoint answers, in order — the device flow's polls, then any renewal. */
let tokenAnswers: ForgeResponse[];
let now: number;
/** Set to hold every wait until the test releases it — what a sign-in still waiting looks like. */
let holding: Array<() => void> | undefined;

const answer = (body: unknown, status = 200): ForgeResponse => ({ status, headers: {}, body });

/** gitlab.com and github.com as far as a device flow and a connection check need them. */
const forge: ForgeHttp = async (request) => {
  seen.push(request);
  const url = new URL(request.url);
  if (url.pathname === "/oauth/authorize_device" || url.pathname === "/login/device/code") {
    return answer({
      device_code: "device-1",
      user_code: "WDJB-MJHT",
      verification_uri: `${url.origin}/device`,
      ...(url.pathname === "/oauth/authorize_device" ? { verification_uri_complete: `${url.origin}/device?user_code=WDJB-MJHT` } : {}),
      expires_in: 900,
      interval: 5,
    });
  }
  if (url.pathname === "/oauth/token" || url.pathname === "/login/oauth/access_token") {
    return tokenAnswers.shift() ?? answer({ error: "authorization_pending" }, 400);
  }
  if (url.pathname === "/api/v4/user" || (url.host === "api.github.com" && url.pathname === "/user")) {
    const token = request.headers["Authorization"]?.replace(/^Bearer /, "");
    if (token === undefined || !token.startsWith("access")) return answer({ message: "401 Unauthorized" }, 401);
    return { status: 200, headers: { "x-oauth-scopes": "repo, read:org" }, body: { login: `me-${token}`, username: `me-${token}` } };
  }
  throw new Error(`nothing answers ${request.method} ${request.url}`);
};

function keychain(): KeychainPort {
  return {
    available: () => true,
    get: (name) => stored[name],
    set: (name, value) => {
      stored[name] = value;
    },
    remove: (name) => {
      delete stored[name];
    },
  };
}

/** The next `forge:signInFinished`, however long the sign-in takes to end. */
function finished(): Promise<ForgeSignInOutcome> {
  return new Promise((resolve) => {
    const start = pushes.length;
    const look = (): void => {
      const hit = pushes.slice(start).find((m) => m.type === "forge:signInFinished");
      if (hit !== undefined && hit.type === "forge:signInFinished") resolve(hit.outcome);
      else setTimeout(look, 5);
    };
    look();
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-forge-signin-"));
  home = testHome();
  initProject(dir, home);
  stored = {};
  pushes = [];
  opened = [];
  seen = [];
  tokenAnswers = [];
  now = 1_700_000_000_000;
  holding = undefined;
  service = new AppService({
    baseDir: home,
    watchWorkflows: false,
    forgeHttp: forge,
    keychain: keychain(),
    publish: (message) => pushes.push(message),
    openExternal: (url) => opened.push(url),
    forgeClock: {
      now: () => now,
      sleep: (ms, signal) =>
        new Promise((resolve, reject) => {
          if (signal?.aborted === true) return reject(new DeviceFlowError("canceled", "the sign-in was canceled"));
          const go = (): void => {
            now += ms;
            resolve();
          };
          if (holding === undefined) return go();
          holding.push(go);
          signal?.addEventListener("abort", () => reject(new DeviceFlowError("canceled", "the sign-in was canceled")), { once: true });
        }),
    },
  });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const withApps = (): void => {
  service.writeConfig({ layer: "base", config: { integrations: { oauth: { gitlab: { clientId: "gl-app" }, github: { clientId: "Iv1.app" } } } } });
};

describe("starting a sign-in", () => {
  it("signs in to gitlab.com and github.com through JaiRA's own apps when no layer names one — client IDs only", async () => {
    holding = [];
    await service.signInForge("gitlab");
    await service.signInForge("github");
    const gitlab = seen.find((r) => r.url === "https://gitlab.com/oauth/authorize_device");
    const github = seen.find((r) => r.url === "https://github.com/login/device/code");
    expect(gitlab?.form).toEqual({ client_id: BUILTIN_OAUTH_APPS.gitlab.clientId, scope: "api" });
    expect(github?.form).toEqual({ client_id: BUILTIN_OAUTH_APPS.github.clientId, scope: "repo read:org" });
    expect(JSON.stringify(seen)).not.toMatch(/client_secret/);
  });

  it("says an OAuth app's client id is needed for a self-hosted instance, and where to set it — and asks the forge nothing", async () => {
    service.writeConfig({ layer: "base", config: { integrations: { forges: { work: { provider: "gitlab", host: "git.example.org", credential: "WORK_TOKEN" } } } } });
    const start = await service.signInForge("work");
    expect(start).toMatchObject({ ok: false, reason: expect.stringMatching(/git\.example\.org .*needs an OAuth app registered there/), fix: expect.stringContaining("integrations.oauth.gitlab.clientId") });
    expect(seen).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("refuses a connection that does not exist", async () => {
    await expect(service.signInForge("bitbucket")).rejects.toThrow(/unknown forge connection 'bitbucket'/);
  });

  it("answers with the code, opens the page with the code already in it, and lists the sign-in as waiting", async () => {
    withApps();
    holding = [];
    const start = await service.signInForge("gitlab");
    expect(start).toEqual({
      ok: true,
      pending: {
        connection: "gitlab",
        provider: "gitlab",
        host: "gitlab.com",
        userCode: "WDJB-MJHT",
        verificationUri: "https://gitlab.com/device",
        verificationUriComplete: "https://gitlab.com/device?user_code=WDJB-MJHT",
        expiresAt: now + 900_000,
        startedAt: now,
      },
    });
    expect(opened).toEqual(["https://gitlab.com/device?user_code=WDJB-MJHT"]);
    expect(seen[0]).toMatchObject({ url: "https://gitlab.com/oauth/authorize_device", form: { client_id: "gl-app", scope: "api" } });
    expect(service.pendingForgeSignIns().map((p) => p.userCode)).toEqual(["WDJB-MJHT"]);

    // A second press while it waits is the same sign-in — no second code, no second window.
    const again = await service.signInForge("gitlab");
    expect(again).toEqual(start);
    expect(seen.filter((r) => r.url.endsWith("/oauth/authorize_device"))).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });
});

describe("how a sign-in ends", () => {
  it("stores the token where a pasted one goes, marks it as OAuth, and the check that follows names the account", async () => {
    withApps();
    tokenAnswers = [
      answer({ error: "authorization_pending" }, 400),
      answer({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 7200, scope: "api read_user" }),
    ];
    const done = finished();
    await service.signInForge("gitlab");
    expect(await done).toEqual({ ok: true, connection: "gitlab", login: "me-access-1" });

    // The connection's own credential, in the keychain — and the refresh token beside it.
    expect(stored).toEqual({ GITLAB_TOKEN: "access-1", GITLAB_TOKEN_REFRESH: "refresh-1" });
    expect(service.readSettings().forgeSignIns).toEqual({
      GITLAB_TOKEN: { provider: "gitlab", host: "gitlab.com", source: "keychain", at: now, expiresAt: now + 7_200_000, refreshCredential: "GITLAB_TOKEN_REFRESH" },
    });
    expect(service.readAvailability().forges?.find((f) => f.name === "gitlab")).toMatchObject({ status: "ok", via: "oauth", identity: { login: "me-access-1" } });
    expect(service.pendingForgeSignIns()).toEqual([]);
    // Polled by the RFC's grant, form-encoded.
    expect(seen.find((r) => r.url === "https://gitlab.com/oauth/token")?.form).toEqual({
      client_id: "gl-app",
      device_code: "device-1",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it("ends as denied when the person refuses on the forge's page, and stores nothing", async () => {
    withApps();
    tokenAnswers = [answer({ error: "access_denied" })];
    const done = finished();
    await service.signInForge("github");
    expect(await done).toEqual({ ok: false, connection: "github", code: "denied", reason: "the sign-in was refused on GitHub's page" });
    expect(stored).toEqual({});
    expect(service.readSettings().forgeSignIns).toBeUndefined();
  });

  it("ends as canceled on Cancel, and stores nothing", async () => {
    withApps();
    holding = [];
    await service.signInForge("github");
    const done = finished();
    service.cancelForgeSignIn("github");
    expect(await done).toMatchObject({ ok: false, connection: "github", code: "canceled" });
    expect(stored).toEqual({});
    expect(service.pendingForgeSignIns()).toEqual([]);
    // Nothing waiting is not an error.
    expect(() => service.cancelForgeSignIn("github")).not.toThrow();
  });
});

describe("after signing in", () => {
  const signIn = async (connection = "gitlab", expiresIn = 7200): Promise<void> => {
    withApps();
    tokenAnswers = [answer({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: expiresIn })];
    const done = finished();
    await service.signInForge(connection);
    expect(await done).toMatchObject({ ok: true });
  };

  it("drops the OAuth tag, and the refresh token, when a token is pasted over it", async () => {
    await signIn();
    service.setSecret({ name: "GITLAB_TOKEN", value: "access-pasted", target: "keychain" });
    expect(service.readSettings().forgeSignIns).toBeUndefined();
    expect(stored).toEqual({ GITLAB_TOKEN: "access-pasted" });
    const { forges } = await service.refreshAvailability();
    expect(forges?.find((f) => f.name === "gitlab")).toMatchObject({ status: "ok", via: "token" });
  });

  it("disconnects: the token, its refresh token and its tag go, and the connection reads as not set up", async () => {
    await signIn();
    expect(await service.signOutForge("gitlab")).toEqual({ ok: true });
    expect(stored).toEqual({});
    expect(service.readSettings().forgeSignIns).toBeUndefined();
    expect(service.readAvailability().forges?.find((f) => f.name === "gitlab")).toMatchObject({ status: "unconfigured" });
  });

  it("disconnects a pasted token the same way, and refuses one in a file JaiRA does not write, naming it", async () => {
    service.setSecret({ name: "GITLAB_TOKEN", value: "access-pasted", target: "project-env-local" });
    expect(await service.signOutForge("gitlab")).toEqual({ ok: true });
    expect(service.readAvailability().forges?.find((f) => f.name === "gitlab")).toMatchObject({ status: "unconfigured" });

    writeFileSync(join(dir, ".env"), "GITLAB_TOKEN=access-committed\n", "utf8");
    const refused = await service.signOutForge("gitlab");
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/which JaiRA does not write — remove GITLAB_TOKEN there/) });
  });

  it("renews a token about to die with its refresh token, before the check asks about it", async () => {
    await signIn("gitlab", 60);
    tokenAnswers = [answer({ access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-2", expires_in: 7200 })];
    const { forges } = await service.refreshAvailability();
    const renewals = seen.filter((request) => request.form?.["grant_type"] === "refresh_token");
    expect(renewals.at(-1)).toMatchObject({ url: "https://gitlab.com/oauth/token", form: { client_id: "gl-app", refresh_token: "refresh-1", grant_type: "refresh_token" } });
    expect(stored).toEqual({ GITLAB_TOKEN: "access-2", GITLAB_TOKEN_REFRESH: "refresh-2" });
    expect(service.readSettings().forgeSignIns?.["GITLAB_TOKEN"]).toMatchObject({ expiresAt: now + 7_200_000, refreshCredential: "GITLAB_TOKEN_REFRESH" });
    expect(forges?.find((f) => f.name === "gitlab")).toMatchObject({ status: "ok", via: "oauth", identity: { login: "me-access-2" } });
  });
});

describe("what is on this machine", () => {
  it("asks the usual local servers, and marks the one the local route uses", async () => {
    const asked: string[] = [];
    const local: LocalFetch = async (url) => {
      asked.push(url);
      if (url === "http://localhost:1234/v1/models") return { status: 200, text: async () => JSON.stringify({ data: [{ id: "qwen2.5-7b-instruct" }] }) };
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await service.close();
    service = new AppService({ baseDir: home, watchWorkflows: false, localFetch: local });
    await service.open(dir);
    service.writeConfig({ layer: "project", config: { ...(service.readConfig().project as object), models: { routes: { local: { baseURL: "http://127.0.0.1:1234/v1" } } } } });
    const found = await service.probeLocalServers();
    expect(found.configured).toBe("http://127.0.0.1:1234/v1");
    expect(found.servers.filter((s) => s.up)).toEqual([{ name: "LM Studio", baseURL: "http://localhost:1234/v1", up: true, models: ["qwen2.5-7b-instruct"], inUse: true }]);
    // The field as typed wins over what is saved.
    const typed = await service.probeLocalServers({ baseURL: "http://localhost:11434/v1" });
    expect(typed.servers.filter((s) => s.inUse).map((s) => s.name)).toEqual(["Ollama"]);
    expect(asked).toHaveLength(10);
  });

  it("checks each embedded weights file, configured or as typed", () => {
    const weights = mkdtempSync(join(tmpdir(), "jaira-weights-"));
    writeFileSync(join(weights, "q.gguf"), "1234");
    service.writeConfig({
      layer: "project",
      config: { ...(service.readConfig().project as object), models: { routes: { embedded: { weights: { q: { modelPath: join(weights, "q.gguf") } } } } } },
    });
    const report = service.checkWeights();
    expect(report.weights).toEqual([{ id: "q", modelPath: join(weights, "q.gguf"), exists: true, sizeBytes: 4 }]);
    expect(report.loader.module).toBe("node-llama-cpp");
    expect(service.checkWeights({ weights: { gone: { modelPath: join(weights, "gone.gguf") } } }).weights).toEqual([
      { id: "gone", modelPath: join(weights, "gone.gguf"), exists: false },
    ]);
    rmSync(weights, { recursive: true, force: true });
  });
});

describe("the mark, read back", () => {
  it("keeps only whole marks: one that cannot say where its token went is no mark", () => {
    const parsed = parseSettings({
      forgeSignIns: {
        GITHUB_TOKEN: { provider: "github", host: "github.com", source: "keychain", at: 5 },
        BROKEN: { provider: "github", host: "github.com", at: 5 },
        ALIEN: { provider: "bitbucket", host: "bitbucket.org", source: "keychain", at: 5 },
      },
    });
    expect(parsed.forgeSignIns).toEqual({ GITHUB_TOKEN: { provider: "github", host: "github.com", source: "keychain", at: 5 } });
    expect(parseSettings({}).forgeSignIns).toBeUndefined();
  });
});
