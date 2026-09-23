/**
 * The executor inventory and its health check (DESIGN §8.1, §8.2).
 *
 * Two behaviours carry the weight here, and both are about honesty rather than features:
 *
 *  - a DISABLED executor is left out of the registry, not registered and refusing, so a workflow
 *    that cannot run in this project says so at start rather than midway; and
 *  - a probe reports what it actually observed, with "not checked" a distinct answer from "ok" —
 *    reporting an unverified executor as healthy is the failure this surface exists to prevent.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JairaAgentConfig } from "@jaira/shared";
import type { Exec, ExecResult } from "../src/exec";
import { enabledAdapters, enabledGenericAgents, listExecutors, probeExecutor, signInAgent, signOutAgent, withSignInRefusal } from "../src/executors";
import { SecretResolver } from "../src/secrets";

/** An Exec that answers from a script, and records what it was asked to run. A full command line
 * ("claude auth status --json") is answered before the bare command. */
function fakeExec(answers: Record<string, Partial<ExecResult>>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args]);
      const answer = answers[[command, ...args].join(" ")] ??
        answers[command] ?? { code: 127, stderr: `'${command}' is not recognized` };
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        command,
        timedOut: false,
        aborted: false,
        ...answer,
      } as ExecResult);
    },
  };
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "jaira-exec-probe-"));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("listExecutors", () => {
  it("lists the three built-ins with their defaults when nothing is configured", () => {
    const list = listExecutors();

    expect(list.map((e) => e.name)).toEqual(["claude-code", "claude-cli", "codex-cli"]);
    // Configure nothing, get everything: a project that has never opened this screen still works.
    expect(list.every((e) => e.enabled)).toBe(true);
    expect(list.find((e) => e.name === "claude-cli")?.command).toBe("claude");
    expect(list.find((e) => e.name === "codex-cli")?.command).toBe("codex");
  });

  it("keeps a disabled executor in the LIST, so it can be turned back on", () => {
    const list = listExecutors({ claudeCli: { enabled: false } });

    expect(list.find((e) => e.name === "claude-cli")).toMatchObject({ enabled: false });
  });

  it("appends configured generic CLIs under their registry names", () => {
    const agents: JairaAgentConfig = {
      genericCli: [{ command: "aider" }, { name: "my-agent", command: "custom", enabled: false }],
    };
    const list = listExecutors(agents);

    expect(list.map((e) => e.name)).toEqual(["claude-code", "claude-cli", "codex-cli", "generic-cli", "my-agent"]);
    // §8.2's objection, surfaced as data: a generic binary has no permission callback.
    expect(list.find((e) => e.name === "generic-cli")?.policyEnforcement).toBe("none");
    expect(list.find((e) => e.name === "my-agent")?.enabled).toBe(false);
  });

  it("reports what each built-in can enforce of the policy", () => {
    const byName = Object.fromEntries(listExecutors().map((e) => [e.name, e.policyEnforcement]));

    expect(byName).toEqual({ "claude-code": "callback", "claude-cli": "callback", "codex-cli": "config" });
  });
});

describe("what actually gets registered", () => {
  it("installs every adapter by default", () => {
    expect(enabledAdapters()).toEqual(["sdk", "cli", "codex"]);
  });

  it("leaves a disabled adapter OUT rather than registering a refusing stub", () => {
    expect(enabledAdapters({ claudeCode: { enabled: false }, codex: { enabled: false } })).toEqual(["cli"]);
  });

  it("filters disabled generic CLIs out of the registration list", () => {
    const agents: JairaAgentConfig = {
      genericCli: [{ name: "on", command: "a" }, { name: "off", command: "b", enabled: false }],
    };

    expect(enabledGenericAgents(agents).map((a) => a.name)).toEqual(["on"]);
  });
});

describe("probeExecutor", () => {
  const cli = () => listExecutors().find((e) => e.name === "claude-cli")!;
  const codex = () => listExecutors().find((e) => e.name === "codex-cli")!;

  it("checks a CLI with --version and its sign-in, and reports the version it answered with", async () => {
    const exec = fakeExec({
      "claude --version": { code: 0, stdout: "2.1.142 (Claude Code)\n" },
      "claude auth status --json": { code: 0, stdout: '{ "loggedIn": true, "authMethod": "claude.ai" }' },
    });
    const result = await probeExecutor(cli(), { exec });

    expect(result).toMatchObject({ name: "claude-cli", status: "ok", version: "2.1.142 (Claude Code)" });
    // Neither starts a session: pressing "Test" must not spend money.
    expect(exec.calls).toEqual([
      ["claude", "--version"],
      ["claude", "auth", "status", "--json"],
    ]);
  });

  it("says who claude is signed in as, as a list with the one in use marked", async () => {
    const exec = fakeExec({
      "claude --version": { code: 0, stdout: "2.1.142 (Claude Code)\n" },
      "claude auth status --json": {
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@b.dev", orgId: "o-1", orgName: "B Org", subscriptionType: "max" }),
      },
    });
    const result = await probeExecutor(cli(), { exec });

    expect(result.accounts).toEqual([{ label: "a@b.dev", method: "claude.ai", plan: "max", organization: "B Org", active: true }]);
  });

  it("names the cloud provider as the method when claude signs in through one", async () => {
    const exec = fakeExec({
      "claude --version": { code: 0, stdout: "2.1.142" },
      "claude auth status --json": { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "none", apiProvider: "bedrock" }) },
    });

    expect((await probeExecutor(cli(), { exec })).accounts).toEqual([{ label: "bedrock", method: "bedrock", active: true }]);
  });

  it("keeps only the method of a codex API-key sign-in, never the key", async () => {
    const exec = fakeExec({
      "codex --version": { code: 0, stdout: "codex-cli 0.147.0" },
      "codex login status": { code: 0, stdout: "Logged in using an API key - sk-proj-***abcd" },
    });
    const result = await probeExecutor(codex(), { exec });

    expect(result.accounts).toEqual([{ label: "an API key", method: "an API key", active: true }]);
    expect(JSON.stringify(result)).not.toContain("sk-proj");
  });

  it("reads a claude nobody is signed in to as a WARNING, with an empty logins list", async () => {
    const exec = fakeExec({
      "claude --version": { code: 0, stdout: "2.1.142 (Claude Code)\n" },
      "claude auth status --json": { code: 1, stdout: '{ "loggedIn": false, "authMethod": "none" }' },
    });
    const result = await probeExecutor(cli(), { exec });

    // Nothing is broken — the connector answers, and the logins list is where signing in happens.
    expect(result).toMatchObject({ status: "needs-sign-in", version: "2.1.142 (Claude Code)", accounts: [], detail: "'claude' responded" });
    expect(result.fix).toBeUndefined();
  });

  it("puts a run's refused sign-in on the login in use, as a warning", () => {
    const ok = { name: "claude-cli", status: "ok" as const, detail: "'claude' responded", accounts: [{ label: "a@b.dev", active: true }] };
    const refused = withSignInRefusal(
      cli(),
      ok,
      "claude-cli: AgentError: claude-cli agent error: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
    );

    expect(refused).toMatchObject({ status: "needs-sign-in", detail: "'claude' responded" });
    expect(refused.accounts).toEqual([
      { label: "a@b.dev", active: true, refused: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue." },
    ]);
    // No refusal, or a probe that already concluded otherwise: left as observed.
    expect(withSignInRefusal(cli(), ok, undefined)).toBe(ok);
    const failed = { ...ok, status: "failed" as const };
    expect(withSignInRefusal(cli(), failed, "x")).toBe(failed);
  });

  it("fails an agent whose refusal has no login to land on — a refused key is broken", () => {
    const ok = { name: "claude-code", status: "ok" as const, detail: "installed" };
    const sdk = listExecutors().find((e) => e.name === "claude-code")!;
    const refused = withSignInRefusal(sdk, ok, "claude-code: AgentError: claude-code agent error: Invalid API key");

    expect(refused).toMatchObject({ status: "failed", detail: "its sign-in was refused when a run last used it: Invalid API key" });
    expect(refused.fix).toBe("check the key it signs in with, then Re-check");
  });

  it("does not fail claude on a sign-in answer it cannot read", async () => {
    // An older binary with no `auth status` — the CLI's own words, not a verdict about sign-in.
    const exec = fakeExec({
      "claude --version": { code: 0, stdout: "1.0.0 (Claude Code)\n" },
      "claude auth status --json": { code: 1, stderr: "error: unknown command 'auth'" },
    });

    expect(await probeExecutor(cli(), { exec })).toMatchObject({ status: "ok" });
  });

  it("reads a codex nobody is signed in to as a warning, unless a key is configured", async () => {
    const exec = fakeExec({
      "codex --version": { code: 0, stdout: "codex-cli 0.4.1" },
      "codex login status": { code: 1, stderr: "Not logged in" },
    });

    expect(await probeExecutor(codex(), { exec })).toMatchObject({ status: "needs-sign-in", accounts: [] });

    // A key is how codex runs without its sign-in, so its sign-in is not asked about.
    writeFileSync(join(baseDir, ".env"), "OPENAI_API_KEY=sk-not-a-real-key", "utf8");
    const keyed = await probeExecutor(
      { ...codex(), credential: "OPENAI_API_KEY" },
      { exec, secrets: new SecretResolver({ baseDir, env: {} }) },
    );
    expect(keyed.status).toBe("ok");
  });

  it("reports a missing binary with the words the shell used", async () => {
    const exec = fakeExec({ claude: { code: 127, stderr: "'claude' is not recognized" } });
    const result = await probeExecutor(cli(), { exec });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("is not recognized");
  });

  it("reports a hang as a timeout rather than waiting on it", async () => {
    const exec = fakeExec({ claude: { code: null, timedOut: true } });

    expect(await probeExecutor(cli(), { exec })).toMatchObject({ status: "failed" });
    expect((await probeExecutor(cli(), { exec })).detail).toContain("did not answer in time");
  });

  it("does not run anything for a disabled executor", async () => {
    const exec = fakeExec({ claude: { code: 0 } });
    const result = await probeExecutor({ ...cli(), enabled: false }, { exec });

    expect(result).toMatchObject({ status: "disabled" });
    expect(exec.calls).toEqual([]);
  });

  it("fails a working binary whose named credential nothing supplies", async () => {
    const exec = fakeExec({ codex: { code: 0, stdout: "0.4.1" } });
    const info = { ...codex(), credential: "OPENAI_API_KEY" };
    const secrets = new SecretResolver({ baseDir, env: {} });

    const result = await probeExecutor(info, { exec, secrets });

    // The binary IS there — reporting "ok" would read as "this works", and the first real call
    // would then fail for a reason the health check had already been asked about.
    expect(result).toMatchObject({ status: "failed", credentialMissing: "OPENAI_API_KEY" });
  });

  it("passes once the credential resolves, and names only its origin", async () => {
    writeFileSync(join(baseDir, ".env"), "OPENAI_API_KEY=sk-not-a-real-key", "utf8");
    const exec = fakeExec({ codex: { code: 0, stdout: "0.4.1" } });
    const info = { ...codex(), credential: "OPENAI_API_KEY" };

    const result = await probeExecutor(info, { exec, secrets: new SecretResolver({ baseDir, env: {} }) });

    expect(result.status).toBe("ok");
    expect(result.credential).toMatchObject({ source: "base-env" });
    expect(JSON.stringify(result)).not.toContain("sk-not-a-real-key");
  });

  /**
   * The CLI adapter takes no key, so a missing one cannot make it unhealthy.
   *
   * This is the case the old probe got wrong in the one direction that matters: it checked a
   * credential for every kind, so `claude-cli` on a machine with no `ANTHROPIC_API_KEY` reported
   * `failed` — the one executor that works with no API key at all, marked as the broken one.
   */
  it("never looks for a key for a runtime that signs itself in", async () => {
    const exec = fakeExec({ claude: { code: 0, stdout: "2.1.142" } });
    const secrets = new SecretResolver({ baseDir, env: {} });

    const result = await probeExecutor(cli(), { exec, secrets });

    expect(result.status).toBe("ok");
    expect(result.credentialMissing).toBeUndefined();
    expect(result.detail).toContain("no key is needed");
  });

  it("checks the SDK adapter by resolving its package, not by spawning anything", async () => {
    const exec = fakeExec({});
    const sdk = listExecutors().find((e) => e.name === "claude-code")!;
    const secrets = new SecretResolver({ baseDir, env: { ANTHROPIC_API_KEY: "sk-not-a-real-key" } });

    const installed = await probeExecutor(sdk, { exec, secrets, resolve: () => "/somewhere/index.js" });
    const missing = await probeExecutor(sdk, {
      exec,
      secrets,
      resolve: () => {
        throw new Error("Cannot find module");
      },
    });

    expect(installed.status).toBe("ok");
    expect(missing).toMatchObject({ status: "failed" });
    expect(missing.detail).toContain("not installed");
    expect(exec.calls).toEqual([]);
  });

  /**
   * The SDK is an API client: installed but keyless, it cannot make a single call.
   *
   * It used to report `ok` in exactly that state, because with no `credential` named there was
   * nothing to look up — so the check passed by having asked no question.
   */
  it("fails the SDK adapter when the package is there but no key is", async () => {
    const exec = fakeExec({});
    const sdk = listExecutors().find((e) => e.name === "claude-code")!;

    const result = await probeExecutor(sdk, {
      exec,
      secrets: new SecretResolver({ baseDir, env: {} }),
      resolve: () => "/somewhere/index.js",
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("no API key is configured");
    expect(result.fix).toContain("claude-cli");
  });

  /**
   * Every other SDK case injects `resolve`, which is exactly how the default one shipped broken: it
   * was `createRequire(import.meta.url)`, and the Electron main process is bundled to CJS, where
   * `import.meta` is empty — so pressing "Test" on `claude-code` in the real app threw a TypeError
   * instead of answering. This exercises the path no injected resolver covers.
   */
  it("resolves with its own resolver when none is injected", async () => {
    const exec = fakeExec({});
    const sdk = listExecutors().find((e) => e.name === "claude-code")!;

    const result = await probeExecutor(sdk, { exec });

    // Whether the SDK happens to be installed here is not the point — that it ANSWERED is.
    expect(["ok", "failed"]).toContain(result.status);
    expect(result.detail).toContain("@anthropic-ai/claude-agent-sdk");
    expect(exec.calls).toEqual([]);
  });

  it("says so rather than guessing when there is nothing to check", async () => {
    const exec = fakeExec({});
    const result = await probeExecutor(
      { name: "odd", kind: "generic", enabled: true, credentialUse: "optional", policyEnforcement: "none" },
      { exec },
    );

    // "not-checked" is deliberately NOT a synonym for "ok".
    expect(result.status).toBe("not-checked");
  });
});

describe("signing an agent in and out", () => {
  const cli = () => listExecutors().find((e) => e.name === "claude-cli")!;
  const codex = () => listExecutors().find((e) => e.name === "codex-cli")!;

  it("runs the agent's own login and logout commands", async () => {
    const exec = fakeExec({ "claude auth login": { code: 0 }, "claude auth logout": { code: 0 }, "codex login": { code: 0 }, "codex logout": { code: 0 } });

    expect(await signInAgent(cli(), { exec })).toEqual({ ok: true });
    expect(await signOutAgent(cli(), { exec })).toEqual({ ok: true });
    expect(await signInAgent(codex(), { exec })).toEqual({ ok: true });
    expect(await signOutAgent(codex(), { exec })).toEqual({ ok: true });
    expect(exec.calls).toEqual([
      ["claude", "auth", "login"],
      ["claude", "auth", "logout"],
      ["codex", "login"],
      ["codex", "logout"],
    ]);
  });

  it("says why a sign-in did not finish, in the binary's words, and when it was cancelled", async () => {
    const failed = await signInAgent(cli(), { exec: fakeExec({ "claude auth login": { code: 1, stderr: "Login timed out" } }) });
    expect(failed).toEqual({ ok: false, reason: "'claude auth login' exited 1: Login timed out" });

    const cancelled = await signInAgent(cli(), { exec: fakeExec({ "claude auth login": { code: null, aborted: true } }) });
    expect(cancelled).toEqual({ ok: false, reason: "the sign in was cancelled" });
  });

  it("refuses an agent that has no sign-in of its own", async () => {
    const sdk = listExecutors().find((e) => e.name === "claude-code")!;
    const exec = fakeExec({});

    expect(await signInAgent(sdk, { exec })).toEqual({ ok: false, reason: "claude-code has no sign in of its own" });
    expect(exec.calls).toEqual([]);
  });
});
