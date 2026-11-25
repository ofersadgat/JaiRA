/**
 * Claude's long-lived token (`claude setup-token`), kept by JaiRA: in the keychain under the variable
 * `claude` reads it from, checked to be one before it is kept, and what Log out removes while it is
 * the sign-in claude uses (the person, 2026-11-25: Claude Code's own sign-in file was emptied after a
 * refused renewal, and JaiRA asked to sign in again — "Yes, add setup-token").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { AppService, type KeychainPort } from "@jaira/service";

const TOKEN = `sk-ant-oat01-${"Ab3_-x".repeat(16)}AA`;
const NAME = "CLAUDE_CODE_OAUTH_TOKEN";

interface Internals {
  signInRefusals: Map<string, string>;
  refreshAvailability: () => Promise<unknown>;
}

let kept: Map<string, string>;
let service: AppService;
let refreshed: number;

function start(keychain: KeychainPort | undefined): void {
  service = new AppService({ baseDir: testHome(), watchWorkflows: false, agentLogins: [], ...(keychain !== undefined ? { keychain } : {}) });
  refreshed = 0;
  // The check that follows would ask the real `claude` on this machine.
  (service as unknown as Internals).refreshAvailability = () => {
    refreshed += 1;
    return Promise.resolve(undefined);
  };
}

beforeEach(() => {
  kept = new Map();
  start({ available: () => true, get: (name) => kept.get(name), set: (name, value) => void kept.set(name, value), remove: (name) => void kept.delete(name), names: () => [...kept.keys()] });
});

afterEach(async () => {
  await service.close();
});

describe("a long-lived token for claude", () => {
  it("is kept in the keychain, ends a refusal a run saw, and is checked again", async () => {
    (service as unknown as Internals).signInRefusals.set("claude-cli", "OAuth session expired and could not be refreshed");

    expect(await service.saveAgentToken("claude-cli", `  ${TOKEN}\n`)).toEqual({ ok: true });

    expect(kept.get(NAME)).toBe(TOKEN);
    expect((service as unknown as Internals).signInRefusals.has("claude-cli")).toBe(false);
    expect(refreshed).toBe(1);
  });

  it("is refused when it is not one setup-token makes, and nothing is kept", async () => {
    const outcome = await service.saveAgentToken("claude-cli", "sk-ant-api03-not-this-kind");
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.reason).toContain("sk-ant-oat");
    expect(kept.has(NAME)).toBe(false);
  });

  it("is only claude's", async () => {
    await expect(service.saveAgentToken("codex-cli", TOKEN)).rejects.toThrow(/takes no long-lived token/);
  });

  it("is what Log out removes while there is one, without signing claude's own login out", async () => {
    kept.set(NAME, TOKEN);
    expect(await service.signOutExecutor("claude-cli")).toEqual({ ok: true });
    expect(kept.has(NAME)).toBe(false);
  });

  it("cannot be made where there is no keychain to keep it in", async () => {
    await service.close();
    start(undefined);
    expect(await service.setUpAgentToken("claude-cli")).toMatchObject({ ok: false });
  });
});
