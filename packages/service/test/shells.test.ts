/**
 * The engine's side of the agent's shell (decision 0030): which agent's setting a call answers to, and
 * when the idle rule closes a live shell.
 */
import { describe, expect, it } from "vitest";
import { agentShellSetting, idleShellVerdict, SHELL_IDLE_MS } from "../src/shells";

describe("which agent's shell a call runs in", () => {
  const agents = { claudeCode: { shell: "/bin/zsh" }, claudeCli: { shell: "/bin/bash" }, codex: {}, genericCli: [{ name: "aider", command: "aider", shell: "/bin/sh" }] };
  it("reads the calling agent's own block, and none for an API route", () => {
    expect(agentShellSetting(agents, "claude-code")).toBe("/bin/zsh");
    expect(agentShellSetting(agents, "claude-cli")).toBe("/bin/bash");
    expect(agentShellSetting(agents, "codex-cli")).toBeUndefined();
    expect(agentShellSetting(agents, "aider")).toBe("/bin/sh");
    expect(agentShellSetting(agents, undefined)).toBeUndefined();
  });
});

describe("the idle rule", () => {
  const quiet = { running: false, quietSince: 0, now: SHELL_IDLE_MS, listens: false as boolean | undefined };
  it("closes a shell that is quiet, unused and listens on nothing, and says why", () => {
    expect(idleShellVerdict(quiet)).toMatch(/^was closed after 5 minutes/);
  });
  it("keeps a shell while its task runs, something listens, it is not yet quiet long enough, or ports cannot be checked", () => {
    expect(idleShellVerdict({ ...quiet, running: true })).toBeUndefined();
    expect(idleShellVerdict({ ...quiet, listens: true })).toBeUndefined();
    expect(idleShellVerdict({ ...quiet, now: SHELL_IDLE_MS - 1 })).toBeUndefined();
    expect(idleShellVerdict({ ...quiet, listens: undefined })).toBeUndefined();
  });
});
