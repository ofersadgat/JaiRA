/**
 * An agent the check finds signed out, whose sign-in on file still names its account, stopped working —
 * it was not never signed in — and says so: "sign-in expired", Sign in again (the person, 2026-11-19:
 * Claude Code on Windows had emptied both tokens after a refused refresh and kept the account, and the
 * row said "not signed in — 'claude' responded").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentDownOf, type ProbeResult } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService, type AgentLoginStore } from "@jaira/service";
import { agentActionOf, loginAddWords, providerSayState, providerState } from "../src/renderer/connectionsModel";

const WIPED = '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"refreshTokenExpiresAt":1797485146918,"subscriptionType":"max","accountUuid":"8b3e"}}';

interface Internals {
  withLapsedSignIn(probe: ProbeResult, command: string | undefined): ProbeResult;
}

let held: string | undefined;
let service: AppService;

beforeEach(() => {
  held = undefined;
  const store: AgentLoginStore = {
    agent: "claude-cli",
    unavailable: () => undefined,
    read: () => (held !== undefined ? { value: held, at: 0 } : undefined),
    write: (value) => void (held = value),
    remove: () => void (held = undefined),
  };
  service = new AppService({ baseDir: testHome(), watchWorkflows: false, agentLogins: [store] });
});

afterEach(async () => {
  await service.close();
});

const SIGNED_OUT: ProbeResult = { name: "claude-cli", status: "needs-sign-in", detail: "'claude auth status --json' says it is not signed in", accounts: [] };

describe("a sign-in that stopped working", () => {
  it("is lapsed when the sign-in on file still names its account", () => {
    held = WIPED;
    const probe = (service as unknown as Internals).withLapsedSignIn(SIGNED_OUT, "claude");
    expect(probe).toMatchObject({ status: "needs-sign-in", lapsed: true, fix: "sign in again — Sign in again here, or 'claude auth login' in a terminal" });
    expect(probe.detail).toContain("no longer works");

    const state = providerState(true, probe);
    expect(providerSayState(probe, state)).toBe("sign-in expired");
    expect(agentActionOf({ id: "claude-cli" } as never, probe, state, undefined, {})).toMatchObject({ kind: "sign-in", label: "Sign in again" });
    expect(loginAddWords([], true).title).toBe("Sign in again");
    expect(agentDownOf(probe)).toMatchObject({ signIn: true, again: true, why: "Claude (cli)'s sign-in has expired. Sign in to it again (Settings → Connections → Agents), then send again." });
  });

  it("is plain signed out when there is nothing on file, or nothing naming an account", () => {
    for (const value of [undefined, '{"mcpOAuth":{}}']) {
      held = value;
      const probe = (service as unknown as Internals).withLapsedSignIn(SIGNED_OUT, "claude");
      expect(probe).toBe(SIGNED_OUT);
      const state = providerState(true, probe);
      expect(providerSayState(probe, state)).toBe("not signed in");
      expect(agentActionOf({ id: "claude-cli" } as never, probe, state, undefined, {})).toMatchObject({ label: "Sign in" });
      expect(agentDownOf(probe)).toEqual({ signIn: true, why: "Claude (cli) is signed out. Sign in to it (Settings → Connections → Agents), then send again." });
    }
  });
});
