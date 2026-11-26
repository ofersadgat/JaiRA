/**
 * The `integrations` block and the two pure functions beside it (decision 0004 §1).
 *
 * What these pin down is what picks a connection: a git remote's HOST. So the two things that must
 * not be loose are how a remote URL is read and that a host has exactly one connection.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfigDocuments, parseConfig } from "../src/config";
import {
  BUILTIN_FORGES,
  BUILTIN_OAUTH_APPS,
  connectionForHost,
  oauthClientIdFor,
  parseDuration,
  parseIntegrations,
  parseRemoteUrl,
  publishModeOf,
  remoteHandleId,
} from "../src/forge";

describe("parseRemoteUrl", () => {
  it("reads the three spellings git accepts for a network remote", () => {
    expect(parseRemoteUrl("git@gitlab.com:mistlabs/jaira.git")).toEqual({ host: "gitlab.com", project: "mistlabs/jaira" });
    expect(parseRemoteUrl("https://github.com/ofersadgat/JaiRA.git")).toEqual({ host: "github.com", project: "ofersadgat/JaiRA" });
    expect(parseRemoteUrl("ssh://git@git.example.org:2222/group/sub/project.git")).toEqual({ host: "git.example.org", project: "group/sub/project" });
  });

  it("keeps an https port, because that IS where the forge is, and drops an ssh one", () => {
    expect(parseRemoteUrl("https://git.example.org:8443/a/b")?.host).toBe("git.example.org:8443");
    expect(parseRemoteUrl("ssh://git@git.example.org:2222/a/b")?.host).toBe("git.example.org");
  });

  it("never puts a user or a token in the host", () => {
    expect(parseRemoteUrl("https://oauth2:glpat-abc@gitlab.com/a/b.git")).toEqual({ host: "gitlab.com", project: "a/b" });
  });

  it("reads a local remote as no forge at all — a bare repository on disk is what the tests push to", () => {
    expect(parseRemoteUrl("C:\\repos\\bare.git")).toBeUndefined();
    expect(parseRemoteUrl("C:/repos/bare.git")).toBeUndefined();
    expect(parseRemoteUrl("/srv/git/bare.git")).toBeUndefined();
    expect(parseRemoteUrl("../bare.git")).toBeUndefined();
    expect(parseRemoteUrl("file:///srv/git/bare.git")).toBeUndefined();
  });
});

describe("parseDuration", () => {
  it("reads one unit per value", () => {
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("0")).toBe(0);
  });

  it("refuses a bare number that is not zero, and a second grammar", () => {
    expect(parseDuration("10")).toBeUndefined();
    expect(parseDuration("1h30m")).toBeUndefined();
    expect(parseDuration("soon")).toBeUndefined();
  });
});

describe("the integrations block", () => {
  it("has the two public hosts built in, each naming a conventional token and holding none", () => {
    const parsed = parseIntegrations(undefined);
    expect(parsed.forges).toEqual(BUILTIN_FORGES);
    expect(defaultConfig().integrations).toEqual(parsed);
  });

  it("keeps makeSshKey only when it turns key making off, and refuses anything but a boolean", () => {
    expect(parseIntegrations({ forges: { gitlab: { makeSshKey: false } } }).forges["gitlab"]?.makeSshKey).toBe(false);
    expect(parseIntegrations({ forges: { gitlab: { makeSshKey: true } } }).forges["gitlab"]).not.toHaveProperty("makeSshKey");
    expect(() => parseIntegrations({ forges: { gitlab: { makeSshKey: "no" } } })).toThrow(/makeSshKey must be true or false/);
  });

  it("lets a layer state only what it changes about a built-in", () => {
    const parsed = parseIntegrations({ forges: { gitlab: { credential: "WORK_GITLAB", enabled: false } } });
    expect(parsed.forges["gitlab"]).toEqual({ provider: "gitlab", host: "gitlab.com", credential: "WORK_GITLAB", enabled: false });
    expect(parsed.forges["github"]).toEqual(BUILTIN_FORGES["github"]);
  });

  it("adds another host under a name of its own, and normalizes how the host was written", () => {
    const parsed = parseIntegrations({ forges: { work: { provider: "gitlab", host: "https://Git.Example.org/", credential: "WORK_TOKEN" } } });
    expect(parsed.forges["work"]).toEqual({ provider: "gitlab", host: "git.example.org", credential: "WORK_TOKEN" });
    expect(connectionForHost(parsed, "GIT.example.org")?.name).toBe("work");
  });

  it("refuses two connections on one host, because the host is what picks", () => {
    expect(() => parseIntegrations({ forges: { mirror: { provider: "gitlab", host: "gitlab.com" } } })).toThrow(/both name the host gitlab.com/);
  });

  it("refuses a token where a token's NAME belongs", () => {
    expect(() => parseIntegrations({ forges: { gitlab: { credential: "glpat-abc def" } } })).toThrow(/NAMES the token/);
  });

  it("refuses a mis-spelled field by name rather than dropping it", () => {
    expect(() => parseIntegrations({ forges: { gitlab: { credental: "X" } } })).toThrow(/credental is not a setting/);
  });

  it("does not pick a connection that is turned off", () => {
    const parsed = parseIntegrations({ forges: { github: { enabled: false } } });
    expect(connectionForHost(parsed, "github.com")).toBeUndefined();
    expect(connectionForHost(parsed, "gitlab.com")?.connection.provider).toBe("gitlab");
  });

  it("layers like the rest of the config: a project overrides one field of the base's connection", () => {
    const merged = mergeConfigDocuments(
      { integrations: { forges: { work: { provider: "github", host: "ghe.example.org", credential: "GHE_TOKEN" } } } },
      { integrations: { forges: { work: { enabled: false } } } },
    );
    const config = parseConfig(merged);
    expect(config.integrations.forges["work"]).toEqual({ provider: "github", host: "ghe.example.org", credential: "GHE_TOKEN", enabled: false });
  });
});

describe("the OAuth app a forge sign-in uses", () => {
  it("is the connection's own: a self-hosted host's app is not asked on the public one", () => {
    const merged = mergeConfigDocuments(
      { integrations: { forges: { work: { provider: "gitlab", host: "git.example.org", oauthClientId: "gl-base" } } } },
      { integrations: { forges: { work: { oauthClientId: "gl-work" } } } },
    );
    const { forges } = parseConfig(merged).integrations;
    expect(forges["work"]?.oauthClientId).toBe("gl-work");
    expect(oauthClientIdFor(forges["work"]!)).toBe("gl-work");
    expect(oauthClientIdFor(forges["gitlab"]!)).toBe(BUILTIN_OAUTH_APPS.gitlab.clientId);
  });

  it("is JaiRA's own on the public hosts only, unless the connection names another", () => {
    expect(oauthClientIdFor({ provider: "github", host: "github.com" })).toBe(BUILTIN_OAUTH_APPS.github.clientId);
    expect(oauthClientIdFor({ provider: "github", host: "github.com", oauthClientId: "Iv1.mine" })).toBe("Iv1.mine");
    expect(oauthClientIdFor({ provider: "github", host: "ghe.example.org" })).toBeUndefined();
  });

  it("refuses a client id that is not one word, and the provider-wide block it replaced", () => {
    expect(() => parseIntegrations({ forges: { gitlab: { oauthClientId: "two words" } } })).toThrow(/oauthClientId must be the OAuth app's client ID — one word, no spaces/);
    expect(() => parseIntegrations({ forges: { gitlab: { oauthClientId: "" } } })).toThrow(/oauthClientId must be/);
    expect(() => parseIntegrations({ oauth: { gitlab: { clientId: "x" } } })).toThrow(/config\.integrations\.oauth is not a setting/);
  });
});

describe("functions.review_artifacts.publish", () => {
  it("asks unless the block says otherwise — a push leaves the machine", () => {
    expect(publishModeOf(undefined)).toBe("ask");
    expect(publishModeOf({})).toBe("ask");
    expect(publishModeOf({ publish: "allow" })).toBe("allow");
    expect(publishModeOf({ publish: "deny" })).toBe("deny");
    expect(publishModeOf({ publish: "yes please" })).toBe("ask");
  });
});

describe("a handle's id", () => {
  it("is the host, the project and the number, with the forge's own sigil", () => {
    expect(remoteHandleId("gitlab", "gitlab.com", "mistlabs/jaira", 41)).toBe("gitlab.com/mistlabs/jaira!41");
    expect(remoteHandleId("github", "github.com", "ofersadgat/JaiRA", 7)).toBe("github.com/ofersadgat/JaiRA#7");
  });
});

describe("a refusal at a repository", () => {
  it("is a 401, 403 or 404 from the forge, or git saying it has no access — never the network", async () => {
    const { isAccessRefusal } = await import("../src/forge");
    expect(isAccessRefusal({ status: 404, message: "Not Found" })).toBe(true);
    expect(isAccessRefusal({ status: 403 })).toBe(true);
    expect(isAccessRefusal({ status: 500, message: "the forge answered 500" })).toBe(false);
    expect(isAccessRefusal({ message: "listing the pull requests of ofersadgat/topodiff: the forge answered 404 — Not Found" })).toBe(true);
    expect(isAccessRefusal({ message: "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403" })).toBe(true);
    expect(isAccessRefusal({ message: "ERROR: Repository not found." })).toBe(true);
    expect(isAccessRefusal({ message: "! [rejected] main -> main (fetch first)" })).toBe(false);
    expect(isAccessRefusal({ message: "Could not resolve host: github.com" })).toBe(false);
    expect(isAccessRefusal(undefined)).toBe(false);
  });
});

describe("what a git, gh or glab command printed", () => {
  it("is a refusal when it could not sign in or was not let in — never a push behind the remote", async () => {
    const { mentionsForgeRefusal } = await import("../src/forge");
    expect(mentionsForgeRefusal("fatal: Authentication failed for 'https://github.com/o/r.git/'")).toBe(true);
    expect(mentionsForgeRefusal("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    expect(mentionsForgeRefusal("git@github.com: Permission denied (publickey).")).toBe(true);
    expect(mentionsForgeRefusal("To get started with GitHub CLI, please run:  gh auth login")).toBe(true);
    expect(mentionsForgeRefusal("HTTP 401: Bad credentials (https://api.github.com/user)")).toBe(true);
    expect(mentionsForgeRefusal("remote: Write access to repository not granted.")).toBe(true);
    expect(mentionsForgeRefusal("! [rejected]        main -> main (fetch first)")).toBe(false);
    expect(mentionsForgeRefusal("Everything up-to-date")).toBe(false);
  });
});
