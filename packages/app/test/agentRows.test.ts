/**
 * Connections → Agents, as the person asked for it on 2026-11-16 ("I like 2, but the rows should be able
 * to expand as well"): the agents on this machine are rows that open in place, and the ones it does not
 * have yet are tiles on a shelf under the card. A closed row is one line, one chip for who it runs as, and
 * the one button that would make it work (`connectionsModel.ts`).
 */
import { describe, expect, it } from "vitest";
import type { AgentInstall, ExecutorInfo, ProbeResult } from "@jaira/shared";
import { agentActionOf, agentChecksAgain, agentChipOf, agentLineOf, agentPlaceOf, keyTileOf, routePlaceOf, settingsGistOf, shelfTileOf } from "../src/renderer/connectionsModel";
import { agentProviders } from "../src/renderer/providerSpecs";

const NATIVE = { method: "native", via: "the native installer", display: "curl -fsSL https://claude.ai/install.sh | bash" } as const;
const NPM = { method: "npm", via: "npm", display: "npm install -g @anthropic-ai/claude-code" } as const;

const executor = (over: Partial<ExecutorInfo>): ExecutorInfo => ({ name: "claude-cli", kind: "cli", enabled: true, credentialUse: "none", policyEnforcement: "callback", ...over });
const probe = (over: Partial<ProbeResult>): ProbeResult => ({ name: "claude-cli", status: "ok", detail: "", ...over });

const CLI = agentProviders([executor({})])[0]!;
const SDK = agentProviders([executor({ name: "claude-code", kind: "sdk", credentialUse: "required" })])[0]!;

describe("where an agent is drawn", () => {
  it("puts an agent whose binary is nowhere on this machine on the shelf", () => {
    expect(agentPlaceOf(probe({ status: "failed", install: { install: [NATIVE, NPM] } }))).toBe("shelf");
    // Nothing here can install it either: still not on this machine.
    expect(agentPlaceOf(probe({ status: "failed", install: {} }))).toBe("shelf");
  });

  it("keeps a row for one that is here — running, half removed, or off the PATH", () => {
    expect(agentPlaceOf(probe({ install: { path: "/opt/homebrew/bin/claude", onPath: true, method: "homebrew" } }))).toBe("row");
    expect(agentPlaceOf(probe({ status: "failed", install: { path: "/usr/local/bin/codex", broken: true } }))).toBe("row");
    expect(agentPlaceOf(probe({ status: "failed", install: { path: "/Users/me/.local/bin/claude", onPath: false } }))).toBe("row");
  });

  it("puts an agent that cannot run without a key it has not got on the shelf, until it has one", () => {
    expect(agentPlaceOf(probe({ status: "failed", detail: "no API key is configured", keyNeeded: "ANTHROPIC_API_KEY" }))).toBe("shelf");
    expect(keyTileOf(probe({ status: "failed", keyNeeded: "ANTHROPIC_API_KEY" }))).toEqual({ sub: "needs an API key", title: "store ANTHROPIC_API_KEY" });
    // With its key, it is a row like any other.
    expect(agentPlaceOf(probe({ status: "ok", credential: { source: "keychain" } }))).toBe("row");
    expect(keyTileOf(probe({ status: "ok" }))).toBeUndefined();
  });

  it("keeps a row for one the check did not look for: a CLI it cannot install, one that fails for another reason, one turned off, one not checked", () => {
    expect(agentPlaceOf(probe({ status: "failed", detail: "'@anthropic-ai/claude-agent-sdk' is not installed" }))).toBe("row");
    expect(agentPlaceOf(probe({ status: "disabled" }))).toBe("row");
    expect(agentPlaceOf(undefined)).toBe("row");
  });
});

describe("where a model API is drawn", () => {
  it("puts one with no key on the shelf, and keeps a row for one with a key, turned off, or not checked", () => {
    expect(routePlaceOf(probe({ name: "anthropic", status: "failed", keyNeeded: "ANTHROPIC_API_KEY" }))).toBe("shelf");
    expect(routePlaceOf(probe({ name: "anthropic", status: "ok", credential: { source: "keychain" } }))).toBe("row");
    expect(routePlaceOf(probe({ name: "anthropic", status: "disabled" }))).toBe("row");
    expect(routePlaceOf(undefined)).toBe("row");
  });
});

describe("a shelf tile", () => {
  it("installs the recommended way, and lists every way", () => {
    const tile = shelfTileOf({ install: [NATIVE, NPM] });
    expect(tile.sub).toBe("installs with the native installer");
    expect(tile.ways.map((way) => [way.name, way.at, way.method])).toEqual([
      ["Native installer", NATIVE.display, "native"],
      ["npm", NPM.display, "npm"],
    ]);
  });

  it("says so when nothing on this machine installs it", () => {
    expect(shelfTileOf({})).toEqual({ sub: "nothing here installs it", ways: [] });
  });
});

describe("a closed row's line", () => {
  it("says a ready agent's version and how it was installed", () => {
    const install: AgentInstall = { path: "/usr/local/bin/claude", onPath: true, method: "npm" };
    expect(agentLineOf(probe({ version: "2.1.900 (Claude Code)", install }), "available", install)).toEqual({ word: "ready", rest: "2.1.900 (Claude Code) · npm" });
    expect(agentLineOf(probe({}), "available", undefined)).toEqual({ word: "ready", rest: undefined });
  });

  it("says what the check found when it is not ready", () => {
    expect(agentLineOf(probe({ status: "failed", detail: "'/usr/local/bin/codex' is a link to a file that is gone" }), "unavailable", undefined)).toEqual({
      word: "not working",
      rest: "'/usr/local/bin/codex' is a link to a file that is gone",
    });
  });

  it("is the word alone for one turned off or not checked", () => {
    expect(agentLineOf(probe({ status: "disabled", detail: "turned off" }), "off", undefined)).toEqual({ word: "turned off", rest: undefined });
    expect(agentLineOf(undefined, "unchecked", undefined)).toEqual({ word: "not checked", rest: undefined });
  });
});

describe("a closed row's button", () => {
  it("reinstalls what is left of an install, with the command it runs", () => {
    const install: AgentInstall = { path: "/usr/local/bin/codex", broken: true, update: { method: "homebrew", via: "Homebrew", display: "brew reinstall --cask codex" } };
    expect(agentActionOf(CLI, probe({ status: "failed", install }), "unavailable", install, {})).toEqual({ kind: "install", label: "Reinstall", title: "runs brew reinstall --cask codex" });
  });

  it("uses the path an agent was found at where the PATH does not reach", () => {
    const install: AgentInstall = { path: "/Users/me/.local/bin/claude", onPath: false };
    expect(agentActionOf(CLI, probe({ status: "failed", install }), "unavailable", install, {})).toMatchObject({ kind: "install", label: "Use it", path: "/Users/me/.local/bin/claude" });
  });

  it("signs in an agent nobody is signed in to, and again one whose sign-in was refused", () => {
    expect(agentActionOf(CLI, probe({ status: "needs-sign-in", accounts: [] }), "needs-sign-in", undefined, {})).toEqual({ kind: "sign-in", label: "Sign in", title: "opens the sign-in page" });
    const refused = probe({ accounts: [{ label: "me@example.com", active: true, refused: "401" }] });
    expect(agentActionOf(CLI, refused, "available", undefined, {})?.label).toBe("Sign in again");
  });

  it("adds the key an agent cannot run without", () => {
    expect(agentActionOf(SDK, probe({ status: "failed", detail: "no API key is configured" }), "unavailable", undefined, {})).toEqual({ kind: "add-key", label: "Add a key", title: "store ANTHROPIC_API_KEY" });
  });

  it("has none for a row that works, is off, or was not checked", () => {
    expect(agentActionOf(CLI, probe({ accounts: [{ label: "me@example.com", active: true }] }), "available", undefined, {})).toBeUndefined();
    expect(agentActionOf(CLI, probe({ status: "disabled" }), "off", undefined, {})).toBeUndefined();
    expect(agentActionOf(CLI, undefined, "unchecked", undefined, {})).toBeUndefined();
  });
});

describe("a row's Check again", () => {
  it("is offered while an agent is signed out, its sign-in was refused, or it does not work", () => {
    expect(agentChecksAgain(probe({ status: "needs-sign-in", accounts: [] }), "needs-sign-in")).toBe(true);
    expect(agentChecksAgain(probe({ status: "needs-sign-in", accounts: [{ label: "me@example.com", active: true, refused: "OAuth session expired" }] }), "needs-sign-in")).toBe(true);
    expect(agentChecksAgain(probe({ status: "failed", detail: "its sign-in was refused when a run last used it: 401" }), "unavailable")).toBe(true);
  });

  it("is not offered for a row that works, is off, needs only a key, or was not checked", () => {
    expect(agentChecksAgain(probe({ accounts: [{ label: "me@example.com", active: true }] }), "available")).toBe(false);
    expect(agentChecksAgain(probe({ status: "disabled" }), "off")).toBe(false);
    expect(agentChecksAgain(probe({ status: "failed", detail: "no API key is configured" }), "unconfigured")).toBe(false);
    expect(agentChecksAgain(undefined, "unchecked")).toBe(false);
  });
});

describe("a closed row's chip", () => {
  it("is the login in use, its plan, and how many others there are", () => {
    const accounts = [
      { label: "old@example.com", active: false },
      { label: "me@example.com", plan: "max", active: true },
    ];
    expect(agentChipOf(probe({ accounts }), "available", {})).toEqual({ kind: "login", who: "me@example.com", fact: "Max plan", more: 1 });
  });

  it("is the key the agent names, and where it was found — or that it was not", () => {
    expect(agentChipOf(probe({ credential: { source: "keychain" } }), "available", { credential: "ANTHROPIC_API_KEY" })).toEqual({ kind: "key", name: "ANTHROPIC_API_KEY", where: "in OS keychain", missing: false });
    expect(agentChipOf(probe({ status: "failed", credentialMissing: "OPENAI_API_KEY" }), "unavailable", { credential: "OPENAI_API_KEY" })).toEqual({ kind: "key", name: "OPENAI_API_KEY", where: "not found anywhere", missing: true });
  });

  it("is nothing for an agent that names no key and has nobody signed in, or is off", () => {
    expect(agentChipOf(probe({}), "available", {})).toBeUndefined();
    expect(agentChipOf(probe({ accounts: [{ label: "me@example.com", active: true }] }), "off", {})).toBeUndefined();
  });
});

describe("the folded settings' line", () => {
  it("names the first fields an agent's settings hold", () => {
    expect(settingsGistOf(CLI)).toBe("Command");
    expect(settingsGistOf({ ...CLI, levels: [] })).toBeUndefined();
  });
});
