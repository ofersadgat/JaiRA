/**
 * What an agent call's outcome says about the agent: a refused sign-in is reported to the host and
 * worded with the command that fixes it; a success is reported so the host can clear it; a call
 * someone stopped is not reported at all.
 */
import { describe, expect, it } from "vitest";
import type { Failure } from "@declarative-ai/json";
import { observeAgentRoute, observeAgentRun, signInCommand, withSignInFix } from "../src/agentOutcome";

const REFUSED: Failure = {
  classification: "permanent",
  reason: "claude-cli: AgentError: claude-cli agent error: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
  code: "authentication_failed",
};

function recorder() {
  const heard: Array<[string, Failure | undefined]> = [];
  return { heard, observe: (agent: string, error: Failure | undefined) => void heard.push([agent, error]) };
}

describe("signInCommand", () => {
  it("names the binary this project runs, and nothing for an agent that has no sign-in", () => {
    expect(signInCommand("claude-cli")).toBe("claude auth login");
    expect(signInCommand("claude-cli", "C:\\tools\\claude.exe")).toBe("C:\\tools\\claude.exe auth login");
    expect(signInCommand("codex-cli")).toBe("codex login");
    expect(signInCommand("claude-code")).toBeUndefined();
  });
});

describe("withSignInFix", () => {
  it("appends the fix to a refused sign-in and leaves every other failure alone", () => {
    expect(withSignInFix("claude-cli", REFUSED).reason).toBe(`${REFUSED.reason} — run 'claude auth login' in a terminal to sign in again`);
    const other: Failure = { classification: "permanent", reason: "boom" };
    expect(withSignInFix("claude-cli", other)).toBe(other);
    // An SDK's refused KEY has no sign-in command to offer.
    expect(withSignInFix("claude-code", REFUSED)).toBe(REFUSED);
  });
});

describe("observeAgentRun", () => {
  it("reports a refused sign-in and words it with the fix", async () => {
    const { heard, observe } = recorder();
    const run = observeAgentRun("claude-cli", async (_inputs: never, _ctx: never) => ({ error: REFUSED }), observe);

    const result = (await run(undefined as never, undefined as never)) as { error: Failure };

    expect(heard).toEqual([["claude-cli", REFUSED]]);
    expect(result.error.reason).toContain("run 'claude auth login'");
    expect(result.error.code).toBe("authentication_failed");
  });

  it("reports a success, so a refusal can be cleared by the call that proves it works", async () => {
    const { heard, observe } = recorder();
    await observeAgentRun("claude-cli", async (_inputs: never, _ctx: never) => ({ value: { text: "ok" } }), observe)(undefined as never, undefined as never);

    expect(heard).toEqual([["claude-cli", undefined]]);
  });

  it("says nothing about a call someone stopped", async () => {
    const { heard, observe } = recorder();
    await observeAgentRun("claude-cli", async (_inputs: never, _ctx: never) => ({ error: { classification: "canceled" as const, reason: "stopped" } }), observe)(
      undefined as never,
      undefined as never,
    );

    expect(heard).toEqual([]);
  });
});

describe("observeAgentRoute", () => {
  it("settles a route's handle through the same reading, and keeps its steering live", async () => {
    const { heard, observe } = recorder();
    const control = { interrupt: async () => {} };
    const inner = {
      capabilities: {},
      metrics: {},
      start: () => ({ events: (async function* () {})(), result: Promise.resolve({ error: REFUSED }), cancel: async () => {}, control }),
    };

    const handle = observeAgentRoute("claude-cli", inner as unknown as Parameters<typeof observeAgentRoute>[1], observe).start({} as never, {} as never);
    const result = (await handle.result) as { error: Failure };

    expect(heard).toEqual([["claude-cli", REFUSED]]);
    expect(result.error.reason).toContain("run 'claude auth login'");
    expect(handle.control).toBe(control);
  });
});
